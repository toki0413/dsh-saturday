// ㊹ 判据对账谱系化：对账结论入推导登记簿——证据引用失效 → 对账结论沿推导图如实失效
//（裁决依据可撤回）；无可追溯证据引用不伪登记（同 ㉑ 提案登记纪律）。
// 泄漏防护（纪律）：挂载即拉起 Python sidecar，前置断言入 try，finally 保证 dispose。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/saturday.plugin.mjs'
import derivationPlugin from '@saturday/plugin-derivation'
import samplerOuPlugin, { trajectoryTriggerAssessment } from '@saturday/plugin-sampler-ou'

const TRAJECTORY = fileURLToPath(new URL('../data/trajectory-trigger-derivation.jsonl', import.meta.url))

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
  const samplerFiber = await ctx.registry.plugin({
    name: 'saturday-sampler-ou',
    apply: (ctx) => samplerOuPlugin.apply(ctx, {}),
  })
  return {
    fiber, derivationFiber, samplerFiber,
    registry: ctx.reflect.get('derivation'),
    sampler: samplerFiber.store.saturdaySamplerOu,
  }
}

async function dispose(env) {
  await env.samplerFiber.dispose()
  await env.derivationFiber.dispose()
  await env.fiber.dispose()
}

test('1. 对账结论入登记簿 + 证据引用失效 → 结论如实失效（裁决依据可撤回）', async () => {
  const env = await mount()
  try {
    const stats = await env.sampler.rt.tools.call('sampler.anchor.stats', {})
    const assessment = trajectoryTriggerAssessment(
      stats,
      { minSize: 1, minCompositionCoverage: 0 },
      { derivation: env.registry, evidenceRefs: ['material:ev-a', 'job:j-ev#engine=emt-mock'], batchId: 'trig-1' },
    )
    assert.equal(assessment.derivation.batchId, 'trig-1')
    assert.equal(assessment.derivation.triggerRef, 'result:trigger-trig-1')
    // 证据引用归一化登记（取 # 前段，同 ㉑ 归一规则）：内联/其他形态不冒充推导输入
    assert.deepEqual(assessment.derivation.evidenceRefs, ['material:ev-a', 'job:j-ev'])
    assert.equal(env.registry.status('result:trigger-trig-1').status, 'valid', '对账结论登记后活性在场')
    // 证据引用失效 → 对账结论沿推导图如实失效（裁决依据可撤回，不是永久真理）
    await env.registry.invalidate('material:ev-a', '证据引用撤回')
    assert.equal(env.registry.status('result:trigger-trig-1').status, 'invalid',
      '证据引用失效传播到对账结论（裁决依据可撤回）')
  } finally {
    await dispose(env)
  }
})

test('2. 无可追溯证据引用不伪登记（同 ㉑ 提案登记纪律）+ 未注入推导服务行为不变', async () => {
  const env = await mount()
  try {
    const stats = await env.sampler.rt.tools.call('sampler.anchor.stats', {})
    // 证据引用全不可追溯 → 不伪登记（没有可声明的输入就不登记），结论照常如实呈报
    const untracked = trajectoryTriggerAssessment(
      stats,
      { minSize: 1, minCompositionCoverage: 0 },
      { derivation: env.registry, evidenceRefs: ['inline:adhoc-ev'], batchId: 'trig-2' },
    )
    assert.equal(untracked.derivation.triggerRef, null, '无可追溯证据引用 → 不伪登记')
    assert.ok(untracked.derivation.note.includes('不伪登记'), '不登记的理由如实声明')
    assert.equal(typeof untracked.met, 'boolean', '对账结论不受登记与否影响（判据与谱系正交）')
    // 未注入推导服务 → 行为不变（零依赖纪律，同 ㉑）：交付不含 derivation 段
    const bare = trajectoryTriggerAssessment(stats, { minSize: 1, minCompositionCoverage: 0 })
    assert.equal(bare.derivation, undefined, '未注入推导服务：交付不含 derivation 段')
  } finally {
    await dispose(env)
  }
})
