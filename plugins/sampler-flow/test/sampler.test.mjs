// @toki0413/plugin-sampler-flow 测试（契约 §4.5 sampler seam 第三实证：invertible 首实证）
// 纯层：契约套件（采样语义/诚实声明/谱系前缀/确定性/显式失败/可回算 + 双射透传）；
// 流数学：双射往返（encode∘decode ≡ id）、换元公式独立重算、微分同胚窗口门禁；
// 插件层：工具挂载与回收、缺依赖显式报错、端到端采样 + encode 往返、种子确定性。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Material, PrototypeLibResolver } from '@toki0413/core'
import { samplerContract } from '@toki0413/contract-tests'
import plugin, {
  affineFlowSampler, createFlowSampler, flowForward, flowInverse, flowParams,
  baseLogProb, SAMPLER_NAME,
} from '../src/index.mjs'

// ── 契约套件（§4.5）：纯层直接接入（invertible: true 分支首跑）──────
const cuRef = () => Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())

samplerContract({
  subject: 'affine-flow',
  // 套件的可逆分支用参考绑定实例（encode 的位移空间相对参考定义）；其余断言用基础实例
  createSampler: reference => (reference ? createFlowSampler({ reference }) : affineFlowSampler),
  createReference: cuRef,
})

// ── 流数学：双射与换元公式 ──────────────────────────────────

test('1. 双射往返：flowInverse(flowForward(z)) ≡ z（逐坐标，数值精度内）', () => {
  const dims = 12
  const params = flowParams(42, 2, dims)
  const rngSeed = flowParams(7, 1, dims)   // 借参数生成器造确定性测试向量（非高斯也可：双射对任意 z 成立）
  const z = rngSeed[0].w.map(v => v * 0.6)
  const { d, logDet } = flowForward(z, params, 0.1)
  const inv = flowInverse(d, params, 0.1)
  inv.z.forEach((v, i) => assert.ok(Math.abs(v - z[i]) < 1e-9, `坐标 ${i} 往返漂移 ${Math.abs(v - z[i])}`))
  assert.ok(Math.abs(inv.logDet - logDet) < 1e-9, '正逆两向的 log|det J| 必须同值（同一映射的雅可比）')
})

test('2. 换元公式独立重算：logProb = log N(z) − log|det J|（交付可逐候选对账）', async () => {
  const reference = await cuRef()
  const sampler = createFlowSampler({ reference, seed: 5, sMax: 0.1 })
  const candidates = await sampler.sample({ reference }, { n: 4 })
  const dims = reference.graph.nodes.length * 3
  const params = flowParams(5, 2, dims)
  for (const c of candidates) {
    const { d, logDet } = flowForward(c.latent, params, 0.1)
    assert.ok(Number.isFinite(logDet))
    // 位移与交付 graph 逐坐标一致（正向输运就是交付的构造路径）
    reference.graph.nodes.forEach((node, i) => {
      node.position.forEach((x, k) => {
        assert.ok(Math.abs(c.graph.nodes[i].position[k] - (x + d[i * 3 + k])) < 1e-12)
      })
    })
    assert.ok(Math.abs(c.logProb - (baseLogProb(c.latent, 0.1) - logDet)) < 1e-9,
      'logProb 必须可由交付的 latent 独立重算（换元公式精确，非近似）')
  }
})

test('3. 微分同胚窗口：位移有界（tanh 饱和）且交付与正向输运逐坐标一致', async () => {
  const reference = await cuRef()
  const sMax = 0.08
  const sampler = createFlowSampler({ reference, seed: 3, sMax })
  const candidates = await sampler.sample({ reference }, { n: 6 })
  const dims = reference.graph.nodes.length * 3
  const params = flowParams(3, 2, dims)
  // 机械窗口界（参数界的闭式推论）：|d| ≤ max|b| + max(a)·sMax，
  // 其中 max(a) = exp(max Σ|w| + max|b|) ≤ exp(0.5·dims + 0.1)（tanh 有界 + 参数生成域）
  const maxAbsB = Math.max(...params.flatMap(p => p.b.map(Math.abs)))
  const maxAbsW = Math.max(...params.flatMap(p => p.w.map(Math.abs)))
  const window = maxAbsB + Math.exp(maxAbsW * Math.ceil(dims / 2) + maxAbsB) * sMax
  for (const c of candidates) {
    const { d } = flowForward(c.latent, params, sMax)
    for (const dv of d) assert.ok(Math.abs(dv) <= window + 1e-12, `位移 ${dv} 超出机械窗口界 ${window}`)
    // 交付 graph 与正向输运逐坐标一致（位移叠加参考位置，无额外自由度）
    reference.graph.nodes.forEach((node, i) => {
      node.position.forEach((x, k) => {
        assert.ok(Math.abs(c.graph.nodes[i].position[k] - (x + d[i * 3 + k])) < 1e-12)
      })
    })
  }
})

test('4. encode 门禁：窗口外/跨拓扑/坏形态显式拒绝，未绑定实例拒绝 encode', async () => {
  const reference = await cuRef()
  const sampler = createFlowSampler({ reference, seed: 1, sMax: 0.05 })
  // 窗口外：位移 10·sMax → arctanh 无定义 → 显式拒绝（不外推冒充覆盖）
  const outside = structuredClone(reference.graph)
  outside.nodes.forEach(n => { n.position = n.position.map(x => x + 10 * 0.05) })
  await assert.rejects(() => sampler.encode(outside),
    err => err.code === 'SAMPLER_UNAVAILABLE' && err.message.includes('微分同胚窗口'))
  // 跨拓扑：位移无定义 → 显式拒绝（不静默截断/补零）
  const extraNode = structuredClone(reference.graph)
  extraNode.nodes.push({ ...structuredClone(extraNode.nodes[0]), id: extraNode.nodes.length })
  await assert.rejects(() => sampler.encode(extraNode),
    err => err.code === 'SAMPLER_UNAVAILABLE' && err.message.includes('同拓扑'))
  // 坏形态：position 非有限三元组
  const bad = structuredClone(reference.graph)
  bad.nodes[0].position = [1, NaN, 0]
  await assert.rejects(() => sampler.encode(bad), err => err.code === 'SAMPLER_UNAVAILABLE')
  // 未绑定实例：位移空间无定义 → 拒绝（不猜测参考冒充可逆）
  await assert.rejects(() => affineFlowSampler.encode(reference.graph),
    err => err.code === 'SAMPLER_UNAVAILABLE' && err.message.includes('参考绑定'))
})

test('5. encode∘sample 往返：候选 graph 映回潜变量与交付 latent 逐坐标一致', async () => {
  const reference = await cuRef()
  const sampler = createFlowSampler({ reference, seed: 11, sMax: 0.1 })
  const [c] = await sampler.sample({ reference }, { n: 1 })
  const encoded = await sampler.encode(c.graph)
  encoded.latent.forEach((v, i) => assert.ok(Math.abs(v - c.latent[i]) < 1e-6,
    `潜变量坐标 ${i} 往返漂移 ${Math.abs(v - c.latent[i])}`))
  assert.ok(encoded.reference.startsWith('material:'), '谱系随 encode 交付回传（reference 绑定可追溯）')
})

test('6. 构造门禁：缺参考/坏 sMax/坏 layers 显式拒绝', async () => {
  const reference = await cuRef()
  assert.throws(() => createFlowSampler({}), err => err.code === 'SAMPLER_UNAVAILABLE')
  assert.throws(() => createFlowSampler({ reference, sMax: 0 }), err => err.code === 'SAMPLER_UNAVAILABLE')
  assert.throws(() => createFlowSampler({ reference, sMax: -1 }), err => err.code === 'SAMPLER_UNAVAILABLE')
  assert.throws(() => createFlowSampler({ reference, layers: 0 }), err => err.code === 'SAMPLER_UNAVAILABLE')
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

test('7. 插件挂载：工具与服务注册，卸载回收', async () => {
  const ctx = new Context()
  const fiber = await ctx.registry.plugin({
    name: 'saturday-sampler-flow',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdaySamplerFlow
    assert.ok(rt.tools.list().some(t => t.name === 'sampler.flow'))
    assert.ok(rt.tools.list().some(t => t.name === 'sampler.flow.encode'))
    assert.ok(rt.getService('sampler/affine-flow'))
  } finally {
    const { rt } = fiber.store.saturdaySamplerFlow
    await fiber.dispose()
    assert.equal(rt.getService('sampler/affine-flow'), undefined, '服务随卸载消失')
    assert.ok(!rt.tools.list().some(t => t.name === 'sampler.flow'), '工具随卸载回收')
    assert.ok(!rt.tools.list().some(t => t.name === 'sampler.flow.encode'), 'encode 工具随卸载回收')
  }
})

test('8. 缺 material 服务必须显式报错，不得静默降级（契约 §2）', async () => {
  const ctx = new Context()
  const fiber = await ctx.registry.plugin({
    name: 'saturday-sampler-flow',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdaySamplerFlow
    await assert.rejects(
      () => rt.tools.call('sampler.flow', { referenceId: 'x' }),
      err => err.code === 'SAMPLER_UNAVAILABLE',
    )
    await assert.rejects(
      () => rt.tools.call('sampler.flow.encode', { referenceId: 'x', graph: { nodes: [{ position: [0, 0, 0] }] } }),
      err => err.code === 'SAMPLER_UNAVAILABLE',
    )
  } finally {
    await fiber.dispose()
  }
})

test('9. 端到端：采样 → encode 工具往返（双射声明在工具层可执行）', async () => {
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin(stubMaterialPlugin())
  const fiber = await ctx.registry.plugin({
    name: 'saturday-sampler-flow',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdaySamplerFlow
    const loaded = await rt.getService('material').load('Cu')
    const out = await rt.tools.call('sampler.flow', { referenceId: loaded.id, n: 3, seed: 42, sMax: 0.08 })
    assert.equal(out.semantics, 'sampling')
    assert.equal(out.likelihood, 'exact')
    assert.equal(out.invertible, true)
    assert.equal(out.n, 3)
    for (const c of out.candidates) {
      assert.ok(c.source.startsWith(`generative:${SAMPLER_NAME}`))
      assert.ok(Number.isFinite(c.logProb))
      assert.ok(Array.isArray(c.latent) && c.latent.length === loaded.graph.nodes.length * 3)
    }
    assert.ok(out.note.includes('不构成唯一解'), '消费方必须连同非唯一性一起呈现')
    assert.ok(out.note.includes('seed 派生'), '流参数来源如实声明（非训练产物）')
    // encode 工具往返：候选 graph 映回潜变量，与采样交付的 latent 一致（双射可执行）
    const enc = await rt.tools.call('sampler.flow.encode', {
      referenceId: loaded.id, graph: out.candidates[0].graph, seed: 42, sMax: 0.08,
    })
    assert.equal(enc.invertible, true)
    enc.latent.forEach((v, i) => assert.ok(Math.abs(v - out.candidates[0].latent[i]) < 1e-6))
    // seed 不一致 = 不同映射：encode 拒绝或漂移都属显式行为，这里断言不静默通过往返
    const wrongSeed = await rt.tools.call('sampler.flow.encode', {
      referenceId: loaded.id, graph: out.candidates[0].graph, seed: 43, sMax: 0.08,
    }).catch(err => err)
    if (!(wrongSeed instanceof Error)) {
      const drifted = wrongSeed.latent.some((v, i) => Math.abs(v - out.candidates[0].latent[i]) > 1e-6)
      assert.ok(drifted, '异 seed（异映射）不得复原原潜变量')
    }
  } finally {
    await fiber.dispose()
    await coreFiber.dispose()
  }
})

test('10. 种子确定性：同种子同样本，异种子异样本', async () => {
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin(stubMaterialPlugin())
  const fiber = await ctx.registry.plugin({
    name: 'saturday-sampler-flow',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdaySamplerFlow
    const loaded = await rt.getService('material').load('Cu')
    const a = await rt.tools.call('sampler.flow', { referenceId: loaded.id, n: 2, seed: 7 })
    const b = await rt.tools.call('sampler.flow', { referenceId: loaded.id, n: 2, seed: 7 })
    assert.deepEqual(b.candidates.map(c => c.graph.nodes), a.candidates.map(c => c.graph.nodes))
    assert.deepEqual(b.candidates.map(c => c.logProb), a.candidates.map(c => c.logProb))
    const c = await rt.tools.call('sampler.flow', { referenceId: loaded.id, n: 2, seed: 8 })
    assert.notDeepEqual(c.candidates.map(x => x.graph.nodes), a.candidates.map(x => x.graph.nodes))
  } finally {
    await fiber.dispose()
    await coreFiber.dispose()
  }
})
