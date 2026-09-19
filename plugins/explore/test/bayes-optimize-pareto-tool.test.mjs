// workflow.bayesOptimizePareto 工具集成测试：stub calculate 令能量极小在 0.9、最大力极小在 1.1
// （不同 x → 真权衡），验 BO 出非支配前沿、评估数、缺服务报错。双档一致（不依赖真引擎）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Material, PrototypeLibResolver, PotentialRegistry } from '@toki0413/core'
import plugin from '../src/index.mjs'

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
        name: 'fake',
        manifest: {
          capabilities: [{ type: 'calculate', properties: ['energy'], accuracy: 0.5, speed: 0.9, cost: 0.1, maxAtoms: 200 }],
          constraints: {}, eventGranularity: 'job',
          units: { energy: 'eV', length: 'Å', time: 'fs' },
          fingerprint: { software: 'fake', method: 'stub' },
        },
        calculate: async (material) => {
          const scale = material.lineage.find(l => l.operation === 'cell-scaled')?.detail.scale ?? 1
          const n = material.nAtoms
          const energy = (scale - 0.9) ** 2 * n
          const forces = material.graph.nodes.map(() => [scale - 1.1, 0, 0]) // max|F|=|scale-1.1|
          return { energy, forces, calculator: 'fake' }
        },
      })
      await potential.activate('fake')
      ctx.reflect.provide('material', materialService)
      ctx.reflect.provide('potential', potential)
      ctx.fiber.store.stub = { materialService }
    },
  }
}

test('1. workflow.bayesOptimizePareto 出非支配前沿（能量 vs 最大力权衡）', async () => {
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin(stubCore())
  const exploreFiber = await ctx.registry.plugin({ name: 'saturday-explore', apply: (c) => plugin.apply(c, {}) })
  const { materialService } = coreFiber.store.stub
  const exploreRt = exploreFiber.store.saturdayExplore.rt
  try {
    const cu = await materialService.load('Cu')
    const out = await exploreRt.tools.call('workflow.bayesOptimizePareto', {
      materialId: cu.id, scaleRange: [0.85, 1.15], iterations: 6,
    })
    assert.equal(out.evaluations, 3 + 6)
    assert.deepEqual(out.objectives, ['energyPerAtom', 'maxForce'])
    assert.ok(out.pareto.length >= 2, `Pareto 前沿应含多点，got ${out.pareto.length}`)
    // 非支配自反
    assert.equal(out.pareto.filter(p => !out.pareto.some(q => q !== p && q.obj[0] <= p.obj[0] && q.obj[1] <= p.obj[1] && (q.obj[0] < p.obj[0] || q.obj[1] < p.obj[1]))).length, out.pareto.length)
    assert.ok(out.hypervolume > 0)
    assert.ok(out.note.includes('Pareto'))
  } finally {
    await exploreFiber.dispose()
    assert.ok(!exploreRt.tools.list().some(t => t.name === 'workflow.bayesOptimizePareto'), '工具随卸载回收')
    await coreFiber.dispose()
  }
})

test('2. 缺服务显式报错', async () => {
  const ctx = new Context()
  const exploreFiber = await ctx.registry.plugin({ name: 'saturday-explore', apply: (c) => plugin.apply(c, {}) })
  const exploreRt = exploreFiber.store.saturdayExplore.rt
  try {
    await assert.rejects(() => exploreRt.tools.call('workflow.bayesOptimizePareto', { materialId: 'x' }),
      /requires materialId with services "material" and "potential"/)
  } finally { await exploreFiber.dispose() }
})
