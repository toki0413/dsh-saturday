// @saturday/plugin-explore 测试（契约 §4.5 oracle 条款首个实证：采样 → 回算闭环）
// 纯层：经契约套件验证（形状与排序 / 逐变体事件 / 不吞错 / 缺依赖显式错）；
// 插件层：工具挂载与回收、缺服务显式报错、端到端闭环（排序非透传 / 谱系 / 确定性）。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Material, PrototypeLibResolver, PotentialRegistry } from '@saturday/core'
import { workflowContract } from '@saturday/contract-tests'
import { referencePerturbationSampler } from '@saturday/plugin-sampler-perturb'
import plugin, { exploreCandidates } from '../src/index.mjs'

// ── stub 核心插件：material / potential / sampler 三个服务 ──────────
// 回算能量由候选谱系决定：候选序号越大能量越低 → 排序必须反转生成顺序，
// 验证"排序"而非"透传"；参考结构无候选谱系 → 能量最高排最后（dE 基线）。
function stubCorePlugin(getRelaxImpl) {
  return {
    name: 'stub-core',
    async apply(ctx) {
      const relaxImpl = getRelaxImpl()
      const resolver = new PrototypeLibResolver()
      const store = new Map()
      const materialService = {
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
      }
      const rt = { on() {}, emit() {} }
      const potential = new PotentialRegistry(rt)
      potential.register({
        name: 'stub-engine',
        manifest: {
          capabilities: [{ type: 'relax', accuracy: 0.5, speed: 0.99, cost: 0.01, maxAtoms: 200 }],
          constraints: {},
          eventGranularity: 'job',
        },
        relax: relaxImpl,
      })
      await potential.activate('stub-engine')
      const events = []
      ctx.events.on('saturday/simulation/converged', e => events.push(e))
      ctx.reflect.provide('material', materialService)
      ctx.reflect.provide('potential', potential)
      ctx.reflect.provide('sampler/reference-perturbation', referencePerturbationSampler)
      ctx.fiber.store.stub = { materialService, events }
    },
  }
}

const indexedRelax = () => async (material) => {
  const cand = material.lineage.find(l => l.operation === 'sampled-candidate')
  const energy = cand ? -12.0 - 0.1 * (cand.detail.index + 1) : -12.0
  return {
    jobId: `job-${cand ? 'c' + cand.detail.index : 'ref'}`,
    engine: 'stub-engine', converged: true, energy, n_steps: 5,
  }
}

let ctx, exploreFiber, exploreRt

before(async () => {
  ctx = new Context()
  exploreFiber = await ctx.registry.plugin({
    name: 'saturday-explore',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  exploreRt = exploreFiber.store.saturdayExplore.rt
})

after(async () => {
  await exploreFiber.dispose()
})

test('1. 工作流插件独立挂载：工具注册且归属本插件，卸载回收', async () => {
  assert.deepEqual(exploreRt.tools.list().map(t => t.name), ['workflow.explore'])
})

test('2. 缺核心服务必须显式报错，不得静默降级（契约 §2）', async () => {
  await assert.rejects(
    () => exploreRt.tools.call('workflow.explore', { referenceId: 'x' }),
    /requires services "material", "potential" and "sampler\/reference-perturbation"/,
  )
})

test('3. 端到端闭环：候选回算 → 反转排序 → 参考基线 → 谱系事件（§4.5 oracle）', async () => {
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(indexedRelax))
  try {
    const { materialService, events } = coreFiber.store.stub
    const cu = await materialService.load('Cu')

    const result = await exploreRt.tools.call('workflow.explore', {
      referenceId: cu.id, n: 3, seed: 42,
    })
    assert.equal(result.failed.length, 0)
    assert.equal(result.ranked.length, 4, '3 候选 + 参考结构')
    // 排序非透传：能量随候选序号递减 → 排序后生成顺序反转
    assert.equal(result.ranked[0].label, 'Cu candidate #3')
    assert.equal(result.ranked.at(-1).kind, 'reference', '参考结构（能量最高）排最后')
    assert.equal(result.referenceEnergy, -12.0)
    // dE 基线诚实：候选相对参考为负，参考自身为 0
    for (const r of result.ranked) {
      assert.ok(Number.isFinite(r.dE), 'dE 必须可计算（基线存在时）')
      assert.ok(r.source.startsWith('generative:') || r.source === 'reference')
    }
    assert.equal(result.ranked.at(-1).dE, 0)
    // 逐变体事件：4 条，薄载荷含 jobId / 材料引用 / 谱系 source
    assert.equal(events.length, 4)
    assert.ok(events.every(e => e.payload.jobId && e.payload.material.id && e.payload.source))
    assert.equal(result.note.includes('引擎回算结果而非采样器自证'), true, '非唯一性 + oracle 声明')
  } finally {
    await coreFiber.dispose()
  }
})

test('4. 单候选回算失败计入 failed，不中断整体（不吞错）', async () => {
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => {
    const cand = material.lineage.find(l => l.operation === 'sampled-candidate')
    if (cand?.detail.index === 0) throw new Error('stub: 候选 #1 回算故意失败')
    return indexedRelax()(material)
  }))
  try {
    const { materialService } = coreFiber.store.stub
    const cu = await materialService.load('Cu')

    const result = await exploreRt.tools.call('workflow.explore', {
      referenceId: cu.id, n: 3, seed: 42,
    })
    assert.equal(result.ranked.length, 3, '成功候选 + 参考照常排序返回')
    assert.equal(result.failed.length, 1)
    assert.match(result.failed[0].error, /故意失败/)
    assert.ok(result.failed[0].source.startsWith('generative:'), '失败记录保留谱系')
  } finally {
    await coreFiber.dispose()
  }
})

test('5. 种子确定性：同种子同闭环结果，异种子异结果', async () => {
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(indexedRelax))
  try {
    const { materialService } = coreFiber.store.stub
    const cu = await materialService.load('Cu')
    const pick = r => r.ranked.map(e => ({ label: e.label, energy: e.energy, source: e.source }))

    const a = await exploreRt.tools.call('workflow.explore', { referenceId: cu.id, n: 2, seed: 7 })
    const b = await exploreRt.tools.call('workflow.explore', { referenceId: cu.id, n: 2, seed: 7 })
    assert.deepEqual(pick(b), pick(a))
    const c = await exploreRt.tools.call('workflow.explore', { referenceId: cu.id, n: 2, seed: 8 })
    assert.notDeepEqual(pick(c), pick(a))
  } finally {
    await coreFiber.dispose()
  }
})

// ── 接入契约套件（§8.3）：第三个接入者。同构变体（候选与参考同组分）：
//    能量经 formula 查表对候选与参考一致，排序/事件断言照常成立；
//    不吞错测试经 failWhen 按谱系标记选中第一个候选。──
workflowContract({
  subject: 'explore',
  formula: 'Cu',
  dopants: ['Ag', 'Ni'],
  runTest: async ({ relaxImpl, dopants, emit }) => {
    const reference = await Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())
    const candidates = await referencePerturbationSampler.sample(
      { reference }, { n: dopants.length, seed: 42 },
    )
    const potential = new PotentialRegistry({ on() {}, emit() {} })
    potential.register({
      name: 'contract-stub',
      manifest: {
        capabilities: [{ type: 'relax', accuracy: 0.5, speed: 0.99, cost: 0.01, maxAtoms: 200 }],
        constraints: {},
        eventGranularity: 'job',
      },
      relax: relaxImpl,
    })
    await potential.activate('contract-stub')
    return exploreCandidates({ reference, candidates, potential, emit })
  },
  missingDeps: () => exploreRt.tools.call('workflow.explore', { referenceId: 'x' }),
  failWhen: m => m.lineage.some(
    l => l.operation === 'sampled-candidate' && l.detail.index === 0,
  ),
})
