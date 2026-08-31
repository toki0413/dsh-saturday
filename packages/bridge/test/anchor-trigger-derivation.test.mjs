// 判据对账谱系化：对账结论入推导登记簿——证据引用失效 → 对账结论沿推导图如实失效
//（结论依据可撤回）；无可追溯证据引用不伪登记（同提案登记纪律）。
// 泄漏防护（纪律）：挂载即拉起 Python sidecar，前置断言入 try，finally 保证 dispose。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('1. 对账结论入登记簿 + 证据引用失效 → 结论如实失效（结论依据可撤回）', async () => {
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
    // 证据引用归一化登记（取 # 前段，同提案登记归一规则）：内联/其他形态不冒充推导输入
    assert.deepEqual(assessment.derivation.evidenceRefs, ['material:ev-a', 'job:j-ev'])
    assert.equal(env.registry.status('result:trigger-trig-1').status, 'valid', '对账结论登记后活性在场')
    // 证据引用失效 → 对账结论沿推导图如实失效（结论依据可撤回，不是永久真理）
    await env.registry.invalidate('material:ev-a', '证据引用撤回')
    assert.equal(env.registry.status('result:trigger-trig-1').status, 'invalid',
      '证据引用失效传播到对账结论（结论依据可撤回）')
  } finally {
    await dispose(env)
  }
})

test('2. 无可追溯证据引用不伪登记（同  提案登记纪律）+ 未注入推导服务行为不变', async () => {
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
    // 未注入推导服务 → 行为不变（零依赖纪律，同 ）：交付不含 derivation 段
    const bare = trajectoryTriggerAssessment(stats, { minSize: 1, minCompositionCoverage: 0 })
    assert.equal(bare.derivation, undefined, '未注入推导服务：交付不含 derivation 段')
  } finally {
    await dispose(env)
  }
})

test('3. 51 证据链接线：快照携带推导引用 → 结论 ↔ 证据文件双向可追溯（回填后沿引用可查/可撤）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-snapshot-evidence-'))
  const env = await mount()
  try {
    const stats = await env.sampler.rt.tools.call('sampler.anchor.stats', {})
    const assessment = trajectoryTriggerAssessment(
      stats,
      { minSize: 1, minCompositionCoverage: 0 },
      { derivation: env.registry, evidenceRefs: ['material:ev-c'], batchId: 'trig-3' },
    )
    const triggerRef = assessment.derivation.triggerRef
    assert.equal(triggerRef, 'result:trigger-trig-3')
    // 快照携带推导引用：声明即原样落盘（结论 ↔ 证据文件双向可追溯）
    const snapPath = join(dir, 'snap.json')
    const saved = await env.sampler.rt.tools.call('sampler.trigger.snapshot.save', {
      path: snapPath, assessment, batchId: 'trig-3', triggerRef,
    })
    assert.equal(saved.triggerRef, triggerRef, '落盘交付如实回呈推导引用')
    // 回填后沿快照携带的引用可查：结论活性在场；证据失效 → 沿引用如实失效（可撤回跨会话在场）
    const restored = await env.sampler.rt.tools.call('sampler.trigger.snapshot.load', { path: snapPath })
    assert.equal(restored.triggerRef, triggerRef, '回填原样交付推导引用（证据文件指向结论）')
    assert.equal(env.registry.status(restored.triggerRef).status, 'valid', '沿快照引用可查：结论活性在场')
    await env.registry.invalidate('material:ev-c', '证据引用撤回')
    assert.equal(env.registry.status(restored.triggerRef).status, 'invalid',
      '证据失效沿快照携带的引用传播（结论可撤回，证据链不断）')
    // 未声明不伪造：不携带引用的快照回填后无 triggerRef 字段（不猜测推导引用）
    const barePath = join(dir, 'bare.json')
    await env.sampler.rt.tools.call('sampler.trigger.snapshot.save', { path: barePath, assessment, batchId: 'trig-3b' })
    const bare = await env.sampler.rt.tools.call('sampler.trigger.snapshot.load', { path: barePath })
    assert.equal(bare.triggerRef, undefined, '未声明 triggerRef → 快照不伪造引用')
    await assert.rejects(
      () => env.sampler.rt.tools.call('sampler.trigger.snapshot.save', { path: snapPath, assessment, batchId: 'trig-3c', triggerRef: '' }),
      /非空字符串/, '空字符串引用声明 → 拒绝（不伪造）')
  } finally {
    await dispose(env)
    await rm(dir, { recursive: true, force: true })
  }
})
