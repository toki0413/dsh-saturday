// @saturday/plugin-sampler-perturb 测试（契约 §4.5 sampler seam 首个实证）
// 纯层：经契约套件验证（采样语义/诚实声明/谱系前缀/确定性/显式失败/可回算）；
// 插件层：工具挂载与回收、缺依赖显式报错、端到端采样、种子确定性。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Material, PrototypeLibResolver } from '@saturday/core'
import { samplerContract, encodeLatent } from '@saturday/contract-tests'
import plugin, { referencePerturbationSampler } from '../src/index.mjs'

// ── 契约套件（§4.5）：纯层直接接入 ──────────────────────────
const cuRef = () => Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())

samplerContract({
  subject: 'reference-perturbation',
  createSampler: () => referencePerturbationSampler,
  createReference: cuRef,
})

// ── 插件层 ──────────────────────────────────────────────────

// 仅提供 material 服务的 stub 核心插件（采样本身不需要引擎）
function stubMaterialPlugin() {
  return {
    name: 'stub-material',
    async apply(ctx) {
      const resolver = new PrototypeLibResolver()
      const store = new Map()
      ctx.reflect.provide('material', {
        async load(formula) {
          const m = await Material.create({ modalities: { formula } }, resolver)
          store.set(m.id, m)
          return m
        },
        async get(id) {
          const m = store.get(id)
          if (!m) throw new Error(`Unknown material id: ${id}`)
          return m
        },
      })
    },
  }
}

test('5. 插件挂载：工具与服务注册，卸载回收', async () => {
  const ctx = new Context()
  const fiber = await ctx.registry.plugin({
    name: 'saturday-sampler-perturb',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdaySamplerPerturb
    assert.ok(rt.tools.list().some(t => t.name === 'sampler.perturb'))
    assert.ok(rt.getService('sampler/reference-perturbation'))
  } finally {
    // fiber.store 随 dispose 回收：先取引用再做回收断言（§4.5 诚实声明可验证）
    const { rt } = fiber.store.saturdaySamplerPerturb
    await fiber.dispose()
    assert.equal(rt.getService('sampler/reference-perturbation'), undefined, '服务随卸载消失')
    assert.ok(!rt.tools.list().some(t => t.name === 'sampler.perturb'), '工具随卸载回收')
  }
})

test('6. 缺 material 服务必须显式报错，不得静默降级（契约 §2）', async () => {
  const ctx = new Context()
  const fiber = await ctx.registry.plugin({
    name: 'saturday-sampler-perturb',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdaySamplerPerturb
    await assert.rejects(
      () => rt.tools.call('sampler.perturb', { referenceId: 'x' }),
      err => err.code === 'SAMPLER_UNAVAILABLE',
    )
  } finally {
    await fiber.dispose()
  }
})

test('7. 端到端：与 material 服务组合，返回带谱系前缀的候选 + 非唯一性声明', async () => {
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin(stubMaterialPlugin())
  const fiber = await ctx.registry.plugin({
    name: 'saturday-sampler-perturb',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdaySamplerPerturb
    // 载入参考结构
    const loaded = await rt.getService('material').load('Cu')
    const out = await rt.tools.call('sampler.perturb', {
      referenceId: loaded.id, n: 4, seed: 42,
    })
    assert.equal(out.semantics, 'sampling')
    assert.equal(out.likelihood, 'none')
    assert.equal(out.invertible, false)
    assert.equal(out.n, 4)
    assert.equal(out.candidates.length, 4)
    for (const c of out.candidates) {
      assert.ok(c.source.startsWith('generative:reference-perturbation'))
      assert.equal(c.graph.nodes.length, loaded.graph.nodes.length)
    }
    assert.ok(typeof out.note === 'string' && out.note.includes('不构成唯一解'),
      '消费方必须连同非唯一性一起呈现')
    // 候选偏离参考（确实在采样而非透传）
    const moved = out.candidates[0].graph.nodes[0].position
      .some((x, k) => Math.abs(x - loaded.graph.nodes[0].position[k]) > 1e-6)
    assert.ok(moved, '候选应是微扰采样点而非参考结构透传')
  } finally {
    await fiber.dispose()
    await coreFiber.dispose()
  }
})

test('8. 种子确定性：同种子同样本，异种子异样本', async () => {
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin(stubMaterialPlugin())
  const fiber = await ctx.registry.plugin({
    name: 'saturday-sampler-perturb',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdaySamplerPerturb
    const loaded = await rt.getService('material').load('Cu')
    const a = await rt.tools.call('sampler.perturb', { referenceId: loaded.id, n: 2, seed: 7 })
    const b = await rt.tools.call('sampler.perturb', { referenceId: loaded.id, n: 2, seed: 7 })
    assert.deepEqual(b.candidates.map(c => c.graph.nodes), a.candidates.map(c => c.graph.nodes))
    const c = await rt.tools.call('sampler.perturb', { referenceId: loaded.id, n: 2, seed: 8 })
    assert.notDeepEqual(c.candidates.map(x => x.graph.nodes), a.candidates.map(x => x.graph.nodes))
  } finally {
    await fiber.dispose()
    await coreFiber.dispose()
  }
})

test('9. 未声明可逆 → encodeLatent 守卫显式拒绝（INVERTIBILITY_UNDECLARED，声明是可执行条款）', async () => {
  const reference = await cuRef()
  await assert.rejects(
    () => encodeLatent(referencePerturbationSampler, reference.graph),
    err => err.code === 'INVERTIBILITY_UNDECLARED',
    '微扰非双射输运（invertible: false）：经执行原语调 encode 必须显式拒绝',
  )
})
