// @toki0413/plugin-rss 测试（契约 §4.5 sampler seam 第二个生成式实现，非 flow 路线）
// 纯层：经契约套件验证（采样语义/诚实声明/谱系前缀/确定性/显式失败/可回算/可逆性守卫）；
// 插件层：工具挂载与回收、成分双来源（composition/referenceId）、缺依赖显式报错、
// 最小间距门禁（满足与显式失败两分支）、端到端采样、种子确定性。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Material, PrototypeLibResolver } from '@toki0413/core'
import { samplerContract, encodeLatent } from '@toki0413/contract-tests'
import plugin, { rssSampler } from '../src/index.mjs'
import { periodicDistance } from '../src/rss.mjs'

// ── 契约套件（§4.5）：纯层直接接入 ──────────────────────────
// RSS 的 composition target 为显式主路径，但契约套件固定传 reference——
// RSS 支持 reference 成分继承（supportedTargets: ['composition', 'reference']），两路均通
const cuRef = () => Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())

samplerContract({
  subject: 'rss',
  createSampler: () => rssSampler,
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

async function mount(ctx, extra = []) {
  const fibers = []
  for (const p of [stubMaterialPlugin(), ...extra]) {
    fibers.push(await ctx.registry.plugin(p))
  }
  fibers.push(await ctx.registry.plugin({
    name: 'saturday-sampler-rss',
    apply: (ctx) => plugin.apply(ctx, {}),
  }))
  return fibers
}

test('1. 插件挂载：工具与服务注册，卸载回收', async () => {
  const ctx = new Context()
  const fiber = await ctx.registry.plugin({
    name: 'saturday-sampler-rss',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdaySamplerRss
    assert.ok(rt.tools.list().some(t => t.name === 'sampler.rss'))
    assert.ok(rt.getService('sampler/rss'))
  } finally {
    const { rt } = fiber.store.saturdaySamplerRss
    await fiber.dispose()
    assert.equal(rt.getService('sampler/rss'), undefined, '服务随卸载消失')
    assert.ok(!rt.tools.list().some(t => t.name === 'sampler.rss'), '工具随卸载回收')
  }
})

test('2. 成分显式路径：elements+counts → 候选形状/谱系前缀/成分守恒', async () => {
  const ctx = new Context()
  const fibers = await mount(ctx)
  try {
    const { rt } = fibers[fibers.length - 1].store.saturdaySamplerRss
    const out = await rt.tools.call('sampler.rss', {
      elements: ['Cu', 'Pt'], counts: [3, 1], n: 4, seed: 42,
    })
    assert.equal(out.semantics, 'sampling')
    assert.equal(out.likelihood, 'none', '门禁截断分布：诚实声明 none，不伪造 exact')
    assert.equal(out.invertible, false)
    assert.equal(out.n, 4)
    assert.equal(out.formula, 'Cu3Pt')
    for (const c of out.candidates) {
      assert.ok(c.source.startsWith('generative:rss'), '谱系前缀 generative:rss')
      assert.equal(c.graph.nodes.length, 4)
      assert.equal(c.graph.periodic, true)
      assert.equal(c.graph.cell.length, 3)
      // 成分守恒：3×Cu(Z=29) + 1×Pt(Z=78)
      const numbers = c.graph.nodes.map(n => n.number).sort((a, b) => a - b)
      assert.deepEqual(numbers, [29, 29, 29, 78])
      // 似然诚实：声明 none 时不得伪造 logProb
      assert.equal(c.logProb, undefined, 'likelihood: none 禁止伪造伪似然')
    }
    assert.ok(typeof out.note === 'string' && out.note.includes('不构成唯一解'),
      '消费方必须连同非唯一性一起呈现')
  } finally {
    for (const f of fibers.reverse()) await f.dispose()
  }
})

test('3. referenceId 路径：成分自参考结构继承（结构本身不参考）', async () => {
  const ctx = new Context()
  const fibers = await mount(ctx)
  try {
    const { rt } = fibers[fibers.length - 1].store.saturdaySamplerRss
    const loaded = await rt.getService('material').load('Cu')
    const out = await rt.tools.call('sampler.rss', { referenceId: loaded.id, n: 2, seed: 7 })
    assert.equal(out.n, 2)
    for (const c of out.candidates) {
      // 成分继承：Cu fcc 4 原子 → 候选同为 4×Z(29)，但坐标/晶胞独立随机（非参考拓扑）
      assert.equal(c.graph.nodes.length, loaded.graph.nodes.length)
      assert.deepEqual(
        c.graph.nodes.map(n => n.number), loaded.graph.nodes.map(n => n.number))
      const sameCell = JSON.stringify(c.graph.cell) === JSON.stringify(loaded.graph.cell)
      assert.ok(!sameCell || c.graph.nodes[0].position[0] !== loaded.graph.nodes[0].position[0],
        '候选是随机生成而非参考结构透传')
    }
  } finally {
    for (const f of fibers.reverse()) await f.dispose()
  }
})

test('4. 缺依赖/缺成分显式报错，不静默降级（契约 §2）', async () => {
  // 无 material 服务时 referenceId 路径显式报错
  const ctx = new Context()
  const fiber = await ctx.registry.plugin({
    name: 'saturday-sampler-rss',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdaySamplerRss
    await assert.rejects(
      () => rt.tools.call('sampler.rss', { referenceId: 'x' }),
      err => err.code === 'SAMPLER_UNAVAILABLE',
    )
    // 成分与参考都缺：显式报错
    await assert.rejects(
      () => rt.tools.call('sampler.rss', { n: 2 }),
      err => err.code === 'SAMPLER_UNAVAILABLE',
    )
    // elements 与 counts 必须成对
    await assert.rejects(
      () => rt.tools.call('sampler.rss', { elements: ['Cu'] }),
      err => err.code === 'SAMPLER_UNAVAILABLE',
    )
    // 未知元素显式报错并列出支持集
    await assert.rejects(
      () => rt.tools.call('sampler.rss', { elements: ['Xx'], counts: [1] }),
      err => err.code === 'SAMPLER_UNAVAILABLE' && /unknown element/.test(err.message),
    )
  } finally {
    await fiber.dispose()
  }
})

test('5. 最小间距门禁：满足分支全对验算 + 不可行分支显式 SAMPLE_NOT_FOUND', async () => {
  const ctx = new Context()
  const fibers = await mount(ctx)
  try {
    const { rt } = fibers[fibers.length - 1].store.saturdaySamplerRss
    // 满足分支：逐候选、逐原子对验算周期性最小像距离
    const out = await rt.tools.call('sampler.rss', {
      elements: ['Cu'], counts: [4], n: 3, seed: 11, aMin: 3.0, aMax: 5.0, minDistance: 1.2,
    })
    for (const c of out.candidates) {
      const [a, b, cc] = c.graph.cell.map(row => row.filter(x => x !== 0)[0])
      const lengths = [a, b, cc]
      const pos = c.graph.nodes.map(n => n.position)
      for (let i = 0; i < pos.length; i++) {
        for (let j = i + 1; j < pos.length; j++) {
          const d = periodicDistance(pos[i], pos[j], lengths)
          assert.ok(d >= 1.2 - 1e-9, `pair (${i},${j}) distance ${d} violates minDistance 1.2`)
        }
      }
    }
    // 不可行分支：8 原子 + 10 Å 最小间距在 ≤6 Å 晶胞内物理不可行 → 显式报错而非静默放宽
    await assert.rejects(
      () => rt.tools.call('sampler.rss', {
        elements: ['Cu'], counts: [8], n: 1, seed: 1, minDistance: 10.0,
      }),
      err => err.code === 'SAMPLE_NOT_FOUND' && /minDistance/.test(err.message),
      '按判据产不出候选必须显式报错，不静默放宽门禁',
    )
  } finally {
    for (const f of fibers.reverse()) await f.dispose()
  }
})

test('6. 种子确定性：同种子同样本，异种子异样本', async () => {
  const ctx = new Context()
  const fibers = await mount(ctx)
  try {
    const { rt } = fibers[fibers.length - 1].store.saturdaySamplerRss
    const a = await rt.tools.call('sampler.rss', { elements: ['Cu'], counts: [4], n: 2, seed: 7 })
    const b = await rt.tools.call('sampler.rss', { elements: ['Cu'], counts: [4], n: 2, seed: 7 })
    assert.deepEqual(b.candidates.map(c => c.graph.nodes), a.candidates.map(c => c.graph.nodes))
    const c = await rt.tools.call('sampler.rss', { elements: ['Cu'], counts: [4], n: 2, seed: 8 })
    assert.notDeepEqual(c.candidates.map(x => x.graph.nodes), a.candidates.map(x => x.graph.nodes))
  } finally {
    for (const f of fibers.reverse()) await f.dispose()
  }
})

test('7. 未声明可逆 → encodeLatent 守卫显式拒绝（INVERTIBILITY_UNDECLARED，声明是可执行条款）', async () => {
  const refGraph = (await cuRef()).graph
  await assert.rejects(
    () => encodeLatent(rssSampler, refGraph),
    err => err.code === 'INVERTIBILITY_UNDECLARED',
    '随机生成非双射输运（invertible: false）：经执行原语调 encode 必须显式拒绝',
  )
})
