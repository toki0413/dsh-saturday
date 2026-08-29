// 套件自检：用完全满足契约的内存 mock 跑一遍四条套件。
// 若套件断言本身有缺陷（漏检/误检），这里先行暴露。

import { workflowContract, samplerContract, structureResolverContract, potentialProviderContract } from '../src/index.mjs'
import { Material, PrototypeLibResolver } from '@saturday/core'

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

// ── 合规 mock：workflow（§4.3，纯编排：逐变体事件 + 排序 + 不吞错）──
async function mockScreen({ material, dopants, relaxImpl, emit }) {
  const variants = [
    { kind: 'pristine', dopant: null, material },
    ...dopants.map(d => ({ kind: 'doped', dopant: d, material: material.substitute(0, d) })),
  ]
  const results = []
  for (const v of variants) {
    const label = v.kind === 'pristine'
      ? `${material.formula} (pristine)`
      : `${material.formula} → ${v.material.formula}`
    try {
      const r = await relaxImpl(v.material)
      results.push({
        label, kind: v.kind, dopant: v.dopant, formula: v.material.formula, status: 'ok',
        energy: r.energy, energyPerAtom: r.energy / v.material.nAtoms,
      })
      await emit?.('saturday/simulation/converged', {
        type: 'saturday/simulation/converged',
        payload: {
          jobId: r.jobId,
          material: { id: v.material.id, formula: v.material.formula },
          result: { energy: r.energy },
        },
      })
    } catch (err) {
      results.push({ label, kind: v.kind, dopant: v.dopant, formula: v.material.formula, status: 'failed', error: err.message })
    }
  }
  return {
    ranked: results.filter(r => r.status === 'ok').sort((a, b) => a.energyPerAtom - b.energyPerAtom),
    failed: results.filter(r => r.status === 'failed'),
    note: 'mock workflow: 排序值仅验证编排语义',
  }
}

workflowContract({
  subject: 'mock-screen',
  formula: 'Cu',
  dopants: ['Ag', 'Ni'],
  runTest: async ({ relaxImpl, dopants, emit }) => {
    const material = await Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())
    return mockScreen({ material, dopants, relaxImpl, emit })
  },
  missingDeps: async () => { throw new Error('workflow.mock requires services "material" and "potential"') },
})

// ── 合规 mock：sampler（§4.5，采样语义 + 似然诚实 + 谱系前缀 + 确定性）──
function mockPrng(seed) {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const mockSampler = {
  name: 'mock-sampler',
  manifest: {
    semantics: 'sampling',
    likelihood: 'none',
    invertible: false,
    supportedTargets: ['reference'],
  },
  async sample(target, opts = {}) {
    if (!target?.reference?.graph) {
      const err = new Error('mock sampler requires a reference structure')
      err.code = 'SAMPLER_UNAVAILABLE'
      throw err
    }
    const n = opts.n ?? 4
    if (!Number.isInteger(n) || n <= 0) {
      const err = new Error('mock sampler cannot produce ' + n + ' candidates')
      err.code = 'SAMPLE_NOT_FOUND'
      throw err
    }
    const rng = mockPrng(opts.seed ?? 1)
    const base = target.reference.graph
    return Array.from({ length: n }, () => ({
      source: 'generative:mock-sampler#seed=' + (opts.seed ?? 1),
      graph: {
        ...base,
        nodes: base.nodes.map(node => ({
          ...node,
          position: node.position.map(x => x + (rng() - 0.5) * 0.1),
        })),
      },
    }))
  },
}

samplerContract({
  subject: 'mock-sampler',
  createSampler: () => mockSampler,
  createReference: () => Material.create(
    { modalities: { formula: 'Cu' } }, new PrototypeLibResolver(),
  ),
})
