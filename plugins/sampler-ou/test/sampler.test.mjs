// @saturday/plugin-sampler-ou 测试（契约 §4.5 sampler seam 第二实证）
// 纯层：经契约套件验证（采样语义/诚实声明/谱系前缀/确定性/显式失败/可回算）；
// 升档实证专属：精确似然自洽、平稳幅度闭式统计验证、均值回归语义、有效性窗口门禁；
// 插件层：工具挂载与回收、缺依赖显式报错、端到端采样、种子确定性。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Material, PrototypeLibResolver } from '@saturday/core'
import { samplerContract } from '@saturday/contract-tests'
import plugin, { ouSampler, ouStd, ouLogProb } from '../src/index.mjs'

// ── 契约套件（§4.5）：纯层直接接入（第三个接入者）────────────
const cuRef = () => Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())

samplerContract({
  subject: 'ou-perturbation',
  createSampler: () => ouSampler,
  createReference: cuRef,
})

// ── 升档实证专属断言 ────────────────────────────────────────

/** 候选相对参考的逐坐标位移（扁平） */
function displacements(reference, candidate) {
  const out = []
  candidate.graph.nodes.forEach((node, i) => {
    const ref = reference.graph.nodes[i].position
    node.position.forEach((x, k) => out.push(x - ref[k]))
  })
  return out
}

test('6. 精确似然自洽：候选 logProb 与独立重算的闭式高斯一致', async () => {
  const reference = await cuRef()
  const params = { uEq: 0.08, gammaDt: 1.5 }
  const samples = await ouSampler.sample({ reference }, { n: 5, seed: 11, ...params })
  for (const s of samples) {
    assert.ok(Number.isFinite(s.logProb))
    const recomputed = ouLogProb(displacements(reference, s), params)
    assert.ok(Math.abs(s.logProb - recomputed) < 1e-9, '交付似然必须可被独立重算（非黑箱）')
  }
})

test('7. 统计验证：平稳幅度落闭式 u_eq·√(1−e^{−2γΔ})（确定性种子）', async () => {
  const reference = await cuRef()
  const uEq = 0.05
  const gammaDt = 1.0
  const samples = await ouSampler.sample({ reference }, { n: 4000, seed: 42, uEq, gammaDt })
  const all = []
  for (const s of samples) all.push(...displacements(reference, s))
  const mean = all.reduce((a, b) => a + b, 0) / all.length
  const variance = all.reduce((a, b) => a + (b - mean) ** 2, 0) / all.length
  const expected = ouStd(uEq, gammaDt)
  assert.ok(Math.abs(mean) < 4 * expected / Math.sqrt(all.length), '均值应锚定参考（均值回归）')
  assert.ok(Math.abs(Math.sqrt(variance) - expected) / expected < 0.03,
    `经验标准差应落闭式值 ±3%（理论 ${expected}，实测 ${Math.sqrt(variance)}）`)
})

test('8. 均值回归语义：γΔ 小贴近参考、γΔ 大近平稳（幅度单调且符合闭式）', async () => {
  const reference = await cuRef()
  const msd = async (gammaDt) => {
    const samples = await ouSampler.sample({ reference }, { n: 1200, seed: 7, uEq: 0.05, gammaDt })
    const all = samples.flatMap(s => displacements(reference, s))
    return all.reduce((a, b) => a + b * b, 0) / all.length
  }
  const [small, large] = [await msd(0.2), await msd(2.0)]
  assert.ok(small < large, 'γΔ 越大，候选越远离参考（受控扩散推进）')
  const ratio = large / small
  const expectedRatio = ouStd(0.05, 2.0) ** 2 / ouStd(0.05, 0.2) ** 2
  assert.ok(Math.abs(ratio - expectedRatio) / expectedRatio < 0.1,
    `MSD 比值应符闭式（理论 ${expectedRatio}，实测 ${ratio}）`)
})

test('9. 有效性窗口门禁：非正/非有限参数显式报错（声明即承诺）', async () => {
  const reference = await cuRef()
  for (const bad of [
    { uEq: 0, gammaDt: 1 }, { uEq: -0.1, gammaDt: 1 }, { uEq: NaN, gammaDt: 1 },
    { uEq: 0.05, gammaDt: 0 }, { uEq: 0.05, gammaDt: -2 }, { uEq: 0.05, gammaDt: Infinity },
  ]) {
    await assert.rejects(
      () => ouSampler.sample({ reference }, { n: 2, seed: 1, ...bad }),
      err => err.code === 'SAMPLER_UNAVAILABLE',
      `参数 ${JSON.stringify(bad)} 必须显式拒绝`,
    )
  }
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

test('10. 插件挂载：工具与服务注册，卸载回收', async () => {
  const ctx = new Context()
  const fiber = await ctx.registry.plugin({
    name: 'saturday-sampler-ou',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdaySamplerOu
    assert.ok(rt.tools.list().some(t => t.name === 'sampler.ou'))
    assert.ok(rt.getService('sampler/ou-perturbation'))
  } finally {
    // fiber.store 随 dispose 回收：先取引用再做回收断言
    const { rt } = fiber.store.saturdaySamplerOu
    await fiber.dispose()
    assert.equal(rt.getService('sampler/ou-perturbation'), undefined, '服务随卸载消失')
    assert.ok(!rt.tools.list().some(t => t.name === 'sampler.ou'), '工具随卸载回收')
  }
})

test('11. 缺 material 服务必须显式报错，不得静默降级（契约 §2）', async () => {
  const ctx = new Context()
  const fiber = await ctx.registry.plugin({
    name: 'saturday-sampler-ou',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdaySamplerOu
    await assert.rejects(
      () => rt.tools.call('sampler.ou', { referenceId: 'x' }),
      err => err.code === 'SAMPLER_UNAVAILABLE',
    )
  } finally {
    await fiber.dispose()
  }
})

test('12. 端到端：候选附精确似然 + 诚实边界声明（提议核 ≠ 玻尔兹曼）', async () => {
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin(stubMaterialPlugin())
  const fiber = await ctx.registry.plugin({
    name: 'saturday-sampler-ou',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdaySamplerOu
    const loaded = await rt.getService('material').load('Cu')
    const out = await rt.tools.call('sampler.ou', {
      referenceId: loaded.id, n: 4, seed: 42, uEq: 0.06, gammaDt: 1.2,
    })
    assert.equal(out.semantics, 'sampling')
    assert.equal(out.likelihood, 'exact', '升档实证：似然声明必须是 exact')
    assert.equal(out.invertible, false)
    assert.equal(out.n, 4)
    for (const c of out.candidates) {
      assert.ok(c.source.startsWith('generative:ou-perturbation'))
      assert.ok(Number.isFinite(c.logProb), 'exact 声明下每个候选必须附可求值似然')
      assert.equal(c.graph.nodes.length, loaded.graph.nodes.length)
    }
    assert.ok(out.note.includes('不构成唯一解'), '消费方必须连同非唯一性一起呈现')
    assert.ok(out.note.includes('不是能量面上的玻尔兹曼似然'),
      '诚实边界必须写进交付：提议核似然 ≠ 玻尔兹曼似然')
    // 候选偏离参考（确实在采样而非透传）
    const moved = out.candidates[0].graph.nodes[0].position
      .some((x, k) => Math.abs(x - loaded.graph.nodes[0].position[k]) > 1e-6)
    assert.ok(moved, '候选应是 OU 采样点而非参考结构透传')
  } finally {
    await fiber.dispose()
    await coreFiber.dispose()
  }
})

test('13. 种子确定性：同种子同样本，异种子异样本', async () => {
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin(stubMaterialPlugin())
  const fiber = await ctx.registry.plugin({
    name: 'saturday-sampler-ou',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdaySamplerOu
    const loaded = await rt.getService('material').load('Cu')
    const a = await rt.tools.call('sampler.ou', { referenceId: loaded.id, n: 2, seed: 7 })
    const b = await rt.tools.call('sampler.ou', { referenceId: loaded.id, n: 2, seed: 7 })
    assert.deepEqual(b.candidates.map(c => c.graph.nodes), a.candidates.map(c => c.graph.nodes))
    const c = await rt.tools.call('sampler.ou', { referenceId: loaded.id, n: 2, seed: 8 })
    assert.notDeepEqual(c.candidates.map(x => x.graph.nodes), a.candidates.map(x => x.graph.nodes))
  } finally {
    await fiber.dispose()
    await coreFiber.dispose()
  }
})
