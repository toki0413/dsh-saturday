// @saturday/plugin-sampler-ou 测试（契约 §4.5 sampler seam 第二实证）
// 纯层：经契约套件验证（采样语义/诚实声明/谱系前缀/确定性/显式失败/可回算）；
// 升档实证专属：精确似然自洽、平稳幅度闭式统计验证、均值回归语义、有效性窗口门禁；
// 插件层：工具挂载与回收、缺依赖显式报错、端到端采样、种子确定性。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Material, PrototypeLibResolver } from '@saturday/core'
import { samplerContract } from '@saturday/contract-tests'
import plugin, {
  ouSampler, ouStd, ouLogProb, uEqFromHarmonicTemperature, KB_EV_PER_K,
  ouMixtureLogProb, ouSampleMixture,
} from '../src/index.mjs'

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

// ── 温度标定与声明（③：σ² = k_B·T/k_eff，声明 ≠ 替换）────────────────

test('14. 谐波温度标定闭式：u_eq = √(k_B·T/k_eff)，力常数缺失即拒绝', async () => {
  // 手算：k_B·300/1.0 = 0.025851999786435 → √ = 0.160785570827842
  const u300 = uEqFromHarmonicTemperature({ temperatureK: 300, forceConstantEVPerA2: 1.0 })
  assert.ok(Math.abs(u300 - Math.sqrt(KB_EV_PER_K * 300)) < 1e-12, '闭式（300 K，k=1 eV/Å²）')
  assert.ok(Math.abs(u300 - 0.160785570827842) < 1e-9, '与独立手算值对账')
  // 温度翻倍 → 涨落能翻倍 → 幅度 ×√2；力常数翻倍 → 幅度 ÷√2（能量均分语义）
  const u600 = uEqFromHarmonicTemperature({ temperatureK: 600, forceConstantEVPerA2: 1.0 })
  assert.ok(Math.abs(u600 / u300 - Math.SQRT2) < 1e-12, '温度翻倍：幅度 ×√2')
  const uStiff = uEqFromHarmonicTemperature({ temperatureK: 300, forceConstantEVPerA2: 2.0 })
  assert.ok(Math.abs(uStiff * Math.SQRT2 - u300) < 1e-12, '力常数翻倍：幅度 ÷√2')
  // 门禁：力常数无来源时不静默假设；温度非法显式拒绝
  for (const bad of [
    { temperatureK: 300 },                              // 缺力常数：涨落幅度无来源
    { temperatureK: 300, forceConstantEVPerA2: 0 },
    { temperatureK: 300, forceConstantEVPerA2: -1 },
    { temperatureK: 0, forceConstantEVPerA2: 1.0 },
    { temperatureK: NaN, forceConstantEVPerA2: 1.0 },
  ]) {
    assert.throws(() => uEqFromHarmonicTemperature(bad),
      err => err.code === 'SAMPLER_UNAVAILABLE',
      `参数 ${JSON.stringify(bad)} 必须显式拒绝`)
  }
})

test('15. 采样器温度声明：随交付呈现且进谱系，但不改变采样行为（声明 ≠ 替换）', async () => {
  const reference = await cuRef()
  const params = { n: 4, seed: 7, uEq: 0.05, gammaDt: 1.0 }
  const declared = await ouSampler.sample({ reference }, { ...params, temperatureK: 300 })
  const undeclared = await ouSampler.sample({ reference }, params)
  // 声明随逐候选交付（筛选层采样入口读入 → 温差诚实声明 ⑳ 的消费源）
  for (const c of declared) assert.equal(c.samplerTemperatureK, 300)
  for (const c of undeclared) assert.equal(c.samplerTemperatureK, undefined)
  // 温度声明进谱系（同参数不同声明 = 不同批，不得混淆）
  assert.ok(declared[0].source.endsWith('&T=300K'))
  assert.ok(!undeclared[0].source.includes('&T='))
  // 声明 ≠ 替换：采样序列与似然完全不受温度声明影响（uEq 仍是直接参数）
  assert.deepEqual(declared.map(c => c.logProb), undeclared.map(c => c.logProb))
  assert.deepEqual(
    declared.map(c => c.graph.nodes.map(n => n.position)),
    undeclared.map(c => c.graph.nodes.map(n => n.position)),
  )
  // 非法温度声明显式拒绝（声明即承诺）
  await assert.rejects(
    () => ouSampler.sample({ reference }, { ...params, temperatureK: -10 }),
    err => err.code === 'SAMPLER_UNAVAILABLE',
  )
})

// ── 多锚点混合采样（④：跨盆地 = 编排层多锚点，混合似然仍闭式）────────

test('16. 混合似然闭式：一维双锚点手算对账（独立公式，非实现重跑）', () => {
  const params = { uEq: 0.08, gammaDt: 1.5 }
  const s = ouStd(params.uEq, params.gammaDt)
  const g = (d) => Math.exp(-0.5 * d * d / (s * s)) / (s * Math.sqrt(2 * Math.PI))
  // 手算：log( (2·g(0.03) + 3·g(0.10)) / 5 )（权重未归一，内部归一）
  const expected = Math.log((2 * g(0.03) + 3 * g(0.1)) / 5)
  const actual = ouMixtureLogProb([[0.03], [0.1]], [2, 3], params)
  assert.ok(Math.abs(actual - expected) < 1e-12, `混合 log 密度闭式（理论 ${expected}，实测 ${actual}）`)
  // 单锚点退化 = 单核：混合不得改变单锚点语义（'exact' 声明不降档的退化一致性）
  assert.ok(Math.abs(ouMixtureLogProb([[0.03]], [1], params) - ouLogProb([0.03], params)) < 1e-12)
  // 门禁：权重非正/长度不齐显式拒绝（零权重锚点不得参与混合）
  assert.throws(() => ouMixtureLogProb([[0.1]], [0], params), err => err.code === 'SAMPLER_UNAVAILABLE')
  assert.throws(() => ouMixtureLogProb([[0.1], [0.2]], [1], params), err => err.code === 'SAMPLER_UNAVAILABLE')
})

test('17. 多锚点混合采样：配额闭式 + 似然自洽 + 谱系 + 门禁（纯层）', async () => {
  const reference = await cuRef()
  // 锚点 2：同拓扑平移 0.1 Å（构造第二个盆地中心）；只克隆 graph，避开 Material 实例的可克隆性边界
  const shifted = { graph: structuredClone(reference.graph) }
  for (const node of shifted.graph.nodes) {
    node.position = node.position.map((x, c) => (c === 0 ? x + 0.1 : x))
  }
  const params = { uEq: 0.05, gammaDt: 1.0 }

  // 配额闭式：[0.6, 0.4]·5 → [3, 2]；[1, 1]·5 平手取靠前 → [3, 2]（最大余数法确定性）
  const mixed = await ouSampleMixture(
    { references: [{ reference, weight: 0.6 }, { reference: shifted, weight: 0.4 }] },
    { n: 5, seed: 9, ...params })
  assert.equal(mixed.length, 5)
  assert.equal(mixed.filter(c => c.anchorIndex === 0).length, 3, '配额闭式：锚点 0 得 3 个')
  assert.equal(mixed.filter(c => c.anchorIndex === 1).length, 2)
  const tied = await ouSampleMixture(
    { references: [{ reference, weight: 1 }, { reference: shifted, weight: 1 }] },
    { n: 5, seed: 9, ...params })
  assert.equal(tied.filter(c => c.anchorIndex === 0).length, 3, '平手取靠前锚点（确定性）')
  assert.deepEqual(mixed[0].mixtureWeights, [0.6, 0.4], '归一混合权重随交付呈现（诚实声明的输入）')
  // 谱系：混合标记 + 所属锚点（谱系不断，可追到具体盆地）
  assert.ok(mixed[0].source.includes('#mixture#seed=9#anchor=0'))
  assert.ok(mixed[3].source.includes('#anchor=1'))
  // 似然自洽：交付的 logProb 可被独立重算（从交付 graph 重提逐锚点位移）
  for (const c of mixed) {
    const dispsAll = [reference, shifted].map(ref => {
      const out = []
      c.graph.nodes.forEach((node, i) => {
        const refPos = ref.graph.nodes[i].position
        node.position.forEach((x, k) => out.push(x - refPos[k]))
      })
      return out
    })
    const recomputed = ouMixtureLogProb(dispsAll, [0.6, 0.4], params)
    assert.ok(Math.abs(c.logProb - recomputed) < 1e-9, '混合似然必须可独立重算（非单锚点似然冒充）')
    assert.ok(Number.isFinite(c.logProb))
  }
  // 单锚点退化：与单核采样同序列同似然（混合是严格推广，无隐式行为变化；
  // 容差 1e-9：log-sum-exp 与单核路径的浮点运算顺序尾差，非语义差异）
  const degenerate = await ouSampleMixture(
    { references: [{ reference, weight: 1 }] }, { n: 3, seed: 5, ...params })
  const direct = await ouSampler.sample({ reference }, { n: 3, seed: 5, ...params })
  degenerate.forEach((c, i) => {
    assert.ok(Math.abs(c.logProb - direct[i].logProb) < 1e-9, `退化似然一致（候选 ${i}）`)
  })
  assert.deepEqual(
    degenerate.map(c => c.graph.nodes.map(n2 => n2.position)),
    direct.map(c => c.graph.nodes.map(n2 => n2.position)),
    '同种子同 PRNG 消费序：退化混合与单核采样逐坐标一致')
  // 门禁：缺锚点 / 拓扑不一致 / 零权重 / 非法 n 均显式拒绝（不静默近似）
  await assert.rejects(() => ouSampleMixture({}, { n: 2 }),
    err => err.code === 'SAMPLER_UNAVAILABLE')
  const broken = { graph: structuredClone(reference.graph) }
  broken.graph.nodes.pop()
  await assert.rejects(() => ouSampleMixture(
    { references: [{ reference, weight: 1 }, { reference: broken, weight: 1 }] }, { n: 2 }),
    err => err.code === 'SAMPLER_UNAVAILABLE' && /同拓扑/.test(err.message),
    '跨锚点位移无定义时不得静默近似')
  await assert.rejects(() => ouSampleMixture(
    { references: [{ reference, weight: 1 }, { reference: shifted, weight: 0 }] }, { n: 2 }),
    err => err.code === 'SAMPLER_UNAVAILABLE')
  await assert.rejects(() => ouSampleMixture(
    { references: [{ reference, weight: 1 }] }, { n: 0 }),
    err => err.code === 'SAMPLE_NOT_FOUND')
})

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
