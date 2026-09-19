// workflow.activeLearning 工具级集成测试：stub-core（material + Σ|pos|² 假 relax oracle
// + 真 referencePerturbationSampler）+ explore 插件，经工具出口跑 basin-hopping 闭环。
// 断言按能力（单调不升、评估数、事件、方法边界），双档一致（不依赖真引擎）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Material, PrototypeLibResolver, PotentialRegistry } from '@toki0413/core'
import { referencePerturbationSampler } from '@toki0413/plugin-sampler-perturb'
import plugin from '../src/index.mjs'

const posEnergy = (material) => material.graph.nodes.reduce(
  (s, nd) => s + nd.position[0] ** 2 + nd.position[1] ** 2 + nd.position[2] ** 2, 0)

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
      const rt = { on() {}, emit() {} }
      const potential = new PotentialRegistry(rt)
      potential.register({
        name: 'fake-relax',
        manifest: {
          capabilities: [{ type: 'relax', accuracy: 0.5, speed: 0.99, cost: 0.01, maxAtoms: 200 }],
          constraints: {}, eventGranularity: 'job',
          units: { energy: 'eV', length: 'Å', time: 'fs' },
          fingerprint: { software: 'fake-relax', method: 'stub' },
        },
        relax: async (material) => ({ energy: posEnergy(material), converged: true, jobId: `job-${material.id}`, engine: 'fake-relax' }),
      })
      await potential.activate('fake-relax')
      const events = []
      ctx.events.on('saturday/simulation/converged', e => events.push(e))
      ctx.reflect.provide('material', materialService)
      ctx.reflect.provide('potential', potential)
      ctx.reflect.provide('sampler/reference-perturbation', referencePerturbationSampler)
      ctx.fiber.store.stub = { materialService, events }
    },
  }
}

test('1. workflow.activeLearning 工具端到端：单调不升 + 评估数 + 事件 workflow 标记', async () => {
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin(stubCore())
  const exploreFiber = await ctx.registry.plugin({ name: 'saturday-explore', apply: (c) => plugin.apply(c, {}) })
  const { materialService, events } = coreFiber.store.stub
  const exploreRt = exploreFiber.store.saturdayExplore.rt
  try {
    const cu = await materialService.load('Cu')
    const out = await exploreRt.tools.call('workflow.activeLearning', {
      referenceId: cu.id, rounds: 3, candidatesPerRound: 6, seed: 5, sigma: 0.3,
    })
    assert.equal(out.provider, 'fake-relax')
    assert.equal(out.evaluations, 1 + 3 * 6)
    assert.equal(out.history.length, 4)
    for (let i = 1; i < out.history.length; i++) {
      assert.ok(out.history[i].bestEnergyPerAtom <= out.history[i - 1].bestEnergyPerAtom + 1e-12,
        `单调不升：${out.history[i - 1].bestEnergyPerAtom} → ${out.history[i].bestEnergyPerAtom}`)
    }
    assert.ok(out.note.includes('basin-hopping'), '方法边界随交付声明')
    assert.ok(events.every(e => e.payload.workflow === 'active-learning'), '每条回算事件标 active-learning')
    assert.equal(events.length, out.evaluations)
  } finally {
    await exploreFiber.dispose()
    assert.ok(!exploreRt.tools.list().some(t => t.name === 'workflow.activeLearning'), '工具随卸载回收')
    await coreFiber.dispose()
  }
})

test('2. 缺服务显式报错，不静默降级', async () => {
  const ctx = new Context()
  // 只挂 explore，不挂 core（material/potential/sampler 全缺）
  const exploreFiber = await ctx.registry.plugin({ name: 'saturday-explore', apply: (c) => plugin.apply(c, {}) })
  const exploreRt = exploreFiber.store.saturdayExplore.rt
  try {
    await assert.rejects(
      () => exploreRt.tools.call('workflow.activeLearning', { referenceId: 'x' }),
      /requires services "material", "potential" and "sampler\/reference-perturbation"/,
    )
  } finally {
    await exploreFiber.dispose()
  }
})
