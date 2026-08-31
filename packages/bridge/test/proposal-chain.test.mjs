// 提案→筛选推导链接通（活性上下文 §8.2 全链）：
// 锚点→提案→排序的谱系不只是字符串——`workflow.screen` 接受 `proposalRef`
// （来自 `sampler.mixture` 交付）登记为排序层推导输入后，锚点失效沿推导图
// 传播到提案、再传播到排序（三级链全活性）；未声明时行为不变（不伪造推导输入）；
// 非法引用由登记簿显式拒绝（不静默）。
// 泄漏防护（纪律）：挂载即拉起 Python sidecar，前置断言入 try，finally 保证 dispose。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/saturday.plugin.mjs'
import derivationPlugin from '@saturday/plugin-derivation'
import screeningPlugin from '@saturday/plugin-screening'
import samplerOuPlugin from '@saturday/plugin-sampler-ou'

const TRAJECTORY = fileURLToPath(new URL('../data/trajectory-proposal-chain.jsonl', import.meta.url))

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

test('1. 全链活性：锚点失效 → 提案失效 → 排序失效（三级传播）', async () => {
  const env = await mount()
  try {
    const cu = await env.handles.materialService.load('Cu')
    env.sampler.anchorStore.add({ graph: cu.graph, source: 'material:cu-anchor', composition: { Cu: 4 } })
    const mixture = await env.sampler.rt.tools.call('sampler.mixture', {
      nAtoms: 4, composition: { Cu: 4 }, n: 2, seed: 1, batchId: 'chain-1',
    })
    const proposalRef = mixture.derivation.proposalRef
    assert.equal(proposalRef, 'result:mixture-chain-1', '提案推导引用随交付呈现')

    const screen = await env.screenRt.tools.call('workflow.screen', {
      materialId: cu.id, dopants: ['Ag'],
      sampled: mixture.candidates.map(c => ({ graph: c.graph, source: c.source, logProb: c.logProb })),
      sampledSource: 'sampler.mixture', temperatureK: 300,
      proposalRef, batchId: 'chain-screen-1',
    })
    assert.equal(screen.derivation.proposalRef, proposalRef, '声明的提案引用随排序交付回呈')
    const rankRef = screen.derivation.rankRef
    assert.equal(env.registry.status(rankRef).status, 'valid', '排序登记初始 valid')

    // 全链失效传播：锚点材料撤回 → 提案失效 → 排序失效（活性推导图，不是字符串谱系）
    await env.registry.invalidate('material:cu-anchor', '锚点材料撤回（全链活性实证）')
    assert.equal(env.registry.status(proposalRef).status, 'invalid', '第一级：锚点失效传播到提案')
    assert.equal(env.registry.status(rankRef).status, 'invalid', '第二级：提案失效传播到排序（全链接通）')
  } finally {
    await dispose(env)
  }
})

test('2. 未声明提案引用：行为不变（排序照常登记，不伪造推导输入）', async () => {
  const env = await mount()
  try {
    const cu = await env.handles.materialService.load('Cu')
    const screen = await env.screenRt.tools.call('workflow.screen', {
      materialId: cu.id, dopants: ['Ag'], batchId: 'chain-screen-2',
    })
    assert.ok(screen.derivation, '未注入提案引用时排序推导照常登记')
    assert.ok(!('proposalRef' in screen.derivation), '未声明不得携带提案引用（不伪造推导输入）')
    assert.equal(env.registry.status(screen.derivation.rankRef).status, 'valid')
  } finally {
    await dispose(env)
  }
})

test('3. 非法提案引用：登记簿显式拒绝（不静默吞错）', async () => {
  const env = await mount()
  try {
    const cu = await env.handles.materialService.load('Cu')
    await assert.rejects(
      () => env.screenRt.tools.call('workflow.screen', {
        materialId: cu.id, dopants: ['Ag'], batchId: 'chain-screen-3',
        proposalRef: 'bogus-format',
      }),
      err => err.code === 'INVALID_REF',
      '非法引用形如 <kind>:<id>，由登记簿 parseRef 显式拒绝',
    )
  } finally {
    await dispose(env)
  }
})
