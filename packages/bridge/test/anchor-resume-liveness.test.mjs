// 回填后的活性保持（持久化原语的活性侧验收）：
// 落盘载荷回填的锚点不只是"字段齐全的数据"——其谱系在推导登记簿中照常
// 归一化登记，锚点失效仍沿推导图传播到提案、再传播到排序（ 全链
// 活性跨会话不降级）；回填不产生任何降级的活性近似。
// 泄漏防护（纪律）：挂载即拉起 Python sidecar，前置断言入 try，finally 保证 dispose + 临时目录清理。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/saturday.plugin.mjs'
import derivationPlugin from '@toki0413/plugin-derivation'
import screeningPlugin from '@toki0413/plugin-screening'
import samplerOuPlugin from '@toki0413/plugin-sampler-ou'

const TRAJECTORY = fileURLToPath(new URL('../data/trajectory-resume-liveness.jsonl', import.meta.url))

async function mount() {
  await rm(TRAJECTORY, { force: true })
  const ctx = new Context()
  const fiber = await ctx.registry.plugin({
    name: 'saturday',
    apply: (ctx) => plugin.apply(ctx, { trajectoryPath: TRAJECTORY }),
  })
  const derivationFiber = await ctx.registry.plugin({
    name: 'saturday-derivation',
    apply: (ctx) => derivationPlugin.apply(ctx, {}),
  })
  const screenFiber = await ctx.registry.plugin({
    name: 'saturday-screening',
    apply: (ctx) => screeningPlugin.apply(ctx, {}),
  })
  const samplerFiber = await ctx.registry.plugin({
    name: 'saturday-sampler-ou',
    apply: (ctx) => samplerOuPlugin.apply(ctx, {}),
  })
  return {
    fiber, derivationFiber, screenFiber, samplerFiber,
    handles: fiber.store.saturday,
    registry: ctx.reflect.get('derivation'),
    screenRt: screenFiber.store.saturdayScreening.rt,
    sampler: samplerFiber.store.saturdaySamplerOu,
  }
}

async function dispose(env) {
  await env.samplerFiber.dispose()
  await env.screenFiber.dispose()
  await env.derivationFiber.dispose()
  await env.fiber.dispose()
}

test('1. 回填后全链活性不降级：锚点失效 → 提案失效 → 排序失效（跨会话）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-resume-live-'))
  const sessionA = await mount()
  const sessionB = await mount()
  try {
    // 会话 A：job 形态谱系锚点入库 → 落盘 → 会话终结
    const cu = await sessionA.handles.materialService.load('Cu')
    sessionA.sampler.anchorStore.add({ graph: cu.graph, source: 'job:j-resume#engine=emt-mock', composition: { Cu: 4 } })
    const path = join(dir, 'live.json')
    await sessionA.sampler.rt.tools.call('sampler.anchor.save', { path })
    await dispose(sessionA)

    // 会话 B：回填 → 提案登记→ 排序登记→ 失效沿推导图全链传播；
    // 基体在会话 B 内重新加载（材料会话级，跨会话引用不冒充在场）
    const cuB = await sessionB.handles.materialService.load('Cu')
    await sessionB.sampler.rt.tools.call('sampler.anchor.load', { path })
    const mixture = await sessionB.sampler.rt.tools.call('sampler.mixture', {
      nAtoms: 4, composition: { Cu: 4 }, n: 2, seed: 3, batchId: 'resume-live',
    })
    const proposalRef = mixture.derivation.proposalRef
    assert.equal(proposalRef, 'result:mixture-resume-live', '回填锚点的提案照常登记推导（活性不因持久化降级）')
    assert.deepEqual(mixture.derivation.anchorRefs, ['job:j-resume'],
      '自动入库谱系归一化（取 # 前段）跨落盘往返保留（归一规则不因回填改变）')

    const screen = await sessionB.screenRt.tools.call('workflow.screen', {
      materialId: cuB.id, dopants: ['Ag'],
      sampled: mixture.candidates.map(c => ({ graph: c.graph, source: c.source, logProb: c.logProb })),
      sampledSource: 'sampler.mixture', temperatureK: 300,
      proposalRef, batchId: 'resume-screen',
    })
    const rankRef = screen.derivation.rankRef
    assert.equal(sessionB.registry.status(rankRef).status, 'valid')

    await sessionB.registry.invalidate('job:j-resume', '锚点来源任务撤回（跨会话活性实证）')
    assert.equal(sessionB.registry.status(proposalRef).status, 'invalid', '第一级：回填锚点失效传播到提案')
    assert.equal(sessionB.registry.status(rankRef).status, 'invalid', '第二级：提案失效传播到排序（全链跨会话不降级）')
  } finally {
    await dispose(sessionB)
    await rm(dir, { recursive: true, force: true })
  }
})

test('2. 回填后谱系登记如实：来源层与归一引用与原会话一致（不冒充、不丢、不改写）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-resume-lineage-'))
  const sessionA = await mount()
  const sessionB = await mount()
  try {
    const cu = await sessionA.handles.materialService.load('Cu')
    sessionA.sampler.anchorStore.add({ graph: cu.graph, source: 'material:cu-live', composition: { Cu: 4 } })
    const before = await sessionA.sampler.rt.tools.call('sampler.mixture', {
      nAtoms: 4, composition: { Cu: 4 }, n: 2, seed: 4, batchId: 'lin-A',
    })
    const path = join(dir, 'lineage.json')
    await sessionA.sampler.rt.tools.call('sampler.anchor.save', { path })
    await dispose(sessionA)

    await sessionB.sampler.rt.tools.call('sampler.anchor.load', { path })
    const after = await sessionB.sampler.rt.tools.call('sampler.mixture', {
      nAtoms: 4, composition: { Cu: 4 }, n: 2, seed: 4, batchId: 'lin-B',
    })
    assert.deepEqual(after.derivation.anchorRefs, before.derivation.anchorRefs,
      '归一化推导输入跨会话一致（回填不改写谱系语义）')
    assert.deepEqual(after.anchors.map(a => a.source), before.anchors.map(a => a.source),
      '检索层锚点来源逐条一致（不冒充原会话锚点）')
    assert.equal(after.derivation.untrackedSources.length, 0, '可追溯来源不落入未追溯声明')
  } finally {
    await dispose(sessionB)
    await rm(dir, { recursive: true, force: true })
  }
})
