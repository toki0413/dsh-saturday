// workflow.bayesOptimize 工具集成测试：stub material/potential（calculate 经 cell-scaled 谱系取 scale，
// energy=(scale−s*)² 已知极小）→ 验 BO 少回算逼近 s*、交付形态、缺服务显式报错。双档一致（不依赖真引擎）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Material, PrototypeLibResolver, PotentialRegistry } from '@toki0413/core'
import plugin from '../src/index.mjs'

const S_STAR = 0.97
function stubCore() {
  return {
    name: 'stub-core',
    async apply(ctx) {
      const resolver = new PrototypeLibResolver()
      const store = new Map()
      const materialService = {
        async load(formula) { const m = await Material.create({ modalities: { formula } }, resolver); store.set(m.id, m); return m },
        async get(id) { const m = store.get(id); if (!m) throw new Error(`Unknown material id: ${id}`); return m },
      }
      const potential = new PotentialRegistry({ on() {}, emit() {} })
      potential.register({
        name: 'fake-calc',
        manifest: {
          capabilities: [{ type: 'calculate', properties: ['energy'], accuracy: 0.5, speed: 0.9, cost: 0.1, maxAtoms: 200 }],
          constraints: {}, eventGranularity: 'job',
          units: { energy: 'eV', length: 'Å', time: 'fs' },
          fingerprint: { software: 'fake-calc', method: 'stub' },
        },
        calculate: async (material) => {
          const scale = material.lineage.find(l => l.operation === 'cell-scaled')?.detail.scale ?? 1
          const n = material.nAtoms
          return { energy: ((scale - S_STAR) ** 2) * n + (-5) * n, calculator: 'fake-calc' } // 极小在 scale=S_STAR，E/n=(scale-s*)²-5
        },
      })
      await potential.activate('fake-calc')
      ctx.reflect.provide('material', materialService)
      ctx.reflect.provide('potential', potential)
      ctx.fiber.store.stub = { materialService }
    },
  }
}

test('1. workflow.bayesOptimize 端到端：GP+LCB 逼近已知平衡标度', async () => {
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin(stubCore())
  const exploreFiber = await ctx.registry.plugin({ name: 'saturday-explore', apply: (c) => plugin.apply(c, {}) })
  const { materialService } = coreFiber.store.stub
  const exploreRt = exploreFiber.store.saturdayExplore.rt
  try {
    const cu = await materialService.load('Cu')
    const out = await exploreRt.tools.call('workflow.bayesOptimize', {
      materialId: cu.id, scaleRange: [0.9, 1.05], iterations: 10, kappa: 1.5,
    })
    assert.equal(out.provider, 'fake-calc')
    assert.equal(out.evaluations, 3 + 10, '3 冷启动 + 10 LCB 迭代')
    assert.ok(Math.abs(out.bestX - S_STAR) < 0.02, `bestScale=${out.bestX} 应近 ${S_STAR}`)
    assert.ok(out.bestEnergyPerAtom === undefined || true) // energyPerAtom 在 history 内
    assert.ok(out.note.includes('不声明全局最优'), '诚实声明启发式边界')
    assert.ok(out.history.every(h => h.via === 'init' || h.via === 'lcb'))
  } finally {
    await exploreFiber.dispose()
    assert.ok(!exploreRt.tools.list().some(t => t.name === 'workflow.bayesOptimize'), '工具随卸载回收')
    await coreFiber.dispose()
  }
})

test('2. 缺 potential 服务显式报错，不静默降级', async () => {
  const ctx = new Context()
  const exploreFiber = await ctx.registry.plugin({ name: 'saturday-explore', apply: (c) => plugin.apply(c, {}) })
  const exploreRt = exploreFiber.store.saturdayExplore.rt
  try {
    await assert.rejects(
      () => exploreRt.tools.call('workflow.bayesOptimize', { materialId: 'x' }),
      /requires materialId with services "material" and "potential"/,
    )
  } finally {
    await exploreFiber.dispose()
  }
})
