// 套件自检：用完全满足契约的内存 mock 跑一遍两条套件。
// 若套件断言本身有缺陷（漏检/误检），这里先行暴露。

import { structureResolverContract, potentialProviderContract } from '../src/index.mjs'

// ── 合规 mock：structure-resolver（§4.1）──
const mockResolver = {
  name: 'mock-resolver',
  async resolve(formula) {
    if (formula !== 'Cu') {
      const err = new Error('mock resolver cannot resolve: ' + formula)
      err.code = 'STRUCTURE_NOT_FOUND'
      throw err
    }
    return [{
      polymorphRank: 0,
      source: 'mock://cu',
      graph: {
        nodes: [{ id: 0, number: 29, position: [0, 0, 0] }],
        edges: [],
        periodic: true,
        cell: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      },
    }]
  },
}

structureResolverContract({
  subject: 'mock-resolver',
  createResolver: () => mockResolver,
  knownFormula: 'Cu',
})

// ── 合规 mock：potential-provider（§4.2 + §5.2，iteration 粒度）──
const mockProvider = {
  name: 'mock-engine',
  version: '0.0.1',
  manifest: {
    capabilities: [{ type: 'relax', accuracy: 0.5, speed: 0.9, cost: 0.1, maxAtoms: 10 }],
    constraints: { requiresLicense: false },
    eventGranularity: 'iteration',
  },
  async relax(material, params = {}) {
    return { jobId: 'mock-job', engine: 'mock-engine', converged: true, energy: -1.234, n_steps: 3 }
  },
}

potentialProviderContract({
  subject: 'mock-engine',
  createProvider: () => mockProvider,
  runnable: true,
  unavailable: {
    createProvider: () => ({
      ...mockProvider,
      relax: async () => { throw Object.assign(new Error('mock unavailable'), { code: 'ENGINE_UNAVAILABLE' }) },
    }),
    code: 'ENGINE_UNAVAILABLE',
  },
})
