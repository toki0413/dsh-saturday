// ㊵ “足够轨迹”触发判据原型（纯层测试，无挂载）：
// 判据是声明式对账不是门禁——达标与否如实呈报，阈值必须由调用方显式声明（不设默认、不硬编码）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trajectoryTriggerAssessment, trajectoryTriggerReadiness } from '../src/anchor-trigger.mjs'

test('1. 达标：读数满足调用方声明的阈值 → met=true，理由为空', () => {
  const result = trajectoryTriggerAssessment(
    { size: 8, withComposition: 7 },
    { minSize: 5, minCompositionCoverage: 0.8 },
  )
  assert.equal(result.met, true)
  assert.deepEqual(result.reasons, [])
  assert.equal(result.readings.coverage, 7 / 8, '覆盖率如实计算')
  assert.deepEqual(result.thresholds, { minSize: 5, minCompositionCoverage: 0.8 }, '阈值随交付原样回呈（声明可审计）')
})

test('2. 不达标：逐项如实呈报缺口（两项缺口各自独立声明，不合并糊化）', () => {
  const result = trajectoryTriggerAssessment(
    { size: 2, withComposition: 0 },
    { minSize: 5, minCompositionCoverage: 0.5 },
  )
  assert.equal(result.met, false)
  assert.equal(result.reasons.length, 2, '两项缺口各自独立呈报')
  assert.ok(result.reasons[0].includes('条目数'), '缺口理由指向具体读数')
  assert.ok(result.reasons[1].includes('组分声明覆盖'), '覆盖率缺口独立声明')
  // 单项缺口：只呈报未达标项（达标项不冒名）
  const partial = trajectoryTriggerAssessment(
    { size: 6, withComposition: 1 },
    { minSize: 5, minCompositionCoverage: 0.5 },
  )
  assert.equal(partial.met, false)
  assert.equal(partial.reasons.length, 1)
})

test('3. 阈值未显式声明即拒绝（不替调用方猜测进场门槛）+ 空库读数诚实处理', () => {
  assert.throws(
    () => trajectoryTriggerAssessment({ size: 8, withComposition: 8 }, {}),
    /TRAJECTORY_TRIGGER_THRESHOLDS_REQUIRED/,
    '缺阈值 → 显式拒绝',
  )
  assert.throws(
    () => trajectoryTriggerAssessment(null, { minSize: 5, minCompositionCoverage: 0.5 }),
    /TRAJECTORY_TRIGGER_READINGS_REQUIRED/,
    '缺读数 → 显式拒绝',
  )
  // 空库：覆盖率定义为 0（不除零崩溃），缺口如实
  const empty = trajectoryTriggerAssessment({ size: 0 }, { minSize: 1, minCompositionCoverage: 0.5 })
  assert.equal(empty.met, false)
  assert.equal(empty.readings.coverage, 0)
})

test('4. ㊼ 谱系质量维：可选阈值 minTrackableRatio（未声明行为不变；声明后缺谱系读数即拒）', () => {
  // 声明且达标：可追溯占比如实计算并随交付回呈（“足够轨迹”不只够多，还要够可追溯）
  const met = trajectoryTriggerAssessment(
    { size: 8, withComposition: 7, lineage: { material: 6, job: 1, other: 1 } },
    { minSize: 5, minCompositionCoverage: 0.8, minTrackableRatio: 0.8 },
  )
  assert.equal(met.met, true)
  assert.equal(met.readings.trackableRatio, 7 / 8, '可追溯占比如实（material + job 除以条目数）')
  // 声明且不达标：缺口独立呈报（质量维不与数量维合并糊化）
  const unmet = trajectoryTriggerAssessment(
    { size: 8, withComposition: 7, lineage: { material: 1, job: 1, other: 6 } },
    { minSize: 5, minCompositionCoverage: 0.8, minTrackableRatio: 0.9 },
  )
  assert.equal(unmet.met, false)
  assert.equal(unmet.reasons.length, 1, '仅质量维缺口（数量/覆盖维达标不冒名）')
  assert.ok(unmet.reasons[0].includes('可追溯占比'), '缺口理由指向质量维读数')
  // 未声明质量维：行为不变（读数带谱系分布也不强制对账，不硬编码、不设默认）
  const undeclared = trajectoryTriggerAssessment(
    { size: 8, withComposition: 7, lineage: { material: 0, job: 0, other: 8 } },
    { minSize: 5, minCompositionCoverage: 0.8 },
  )
  assert.equal(undeclared.met, true, '未声明 minTrackableRatio → 质量维不参与对账')
  // 声明了但读数缺谱系分布维：显式拒绝（不替调用方猜测质量读数）
  assert.throws(
    () => trajectoryTriggerAssessment({ size: 8, withComposition: 7 },
      { minSize: 5, minCompositionCoverage: 0.8, minTrackableRatio: 0.5 }),
    /TRAJECTORY_TRIGGER_LINEAGE_REQUIRED/,
  )
  // 空库 + 声明质量维：占比定义为 0（不除零崩溃），缺口如实
  const emptyLineage = trajectoryTriggerAssessment({ size: 0, lineage: {} },
    { minSize: 1, minCompositionCoverage: 0.5, minTrackableRatio: 0.5 })
  assert.equal(emptyLineage.readings.trackableRatio, 0)
})

test('5. 52 触发条件就绪度报告：声明式盘点如实呈报在场/缺口（呈报不是门禁，缺失不是错误）', () => {
  // 五面全声明 → 就绪；在场凭据原样回呈（声明可审计）
  const all = trajectoryTriggerReadiness({
    observation: 'sampler.anchor.stats', criterion: 'trajectoryTriggerAssessment',
    snapshot: 'sampler.trigger.snapshot.save/load', repair: 'sampler.anchor.repair',
    derivation: 'result:trigger-<batchId>',
  })
  assert.equal(all.ready, true)
  assert.deepEqual(all.gaps, [])
  assert.equal(all.present.observation, 'sampler.anchor.stats', '在场凭据原样回呈')
  assert.ok(all.note.includes('不是门禁'), '报告如实声明呈报性质（机制进场仍由裁决者决定）')
  // 部分缺失 → 缺口逐项如实（缺失不是错误，只是未就位；各项独立不糊化）
  const partial = trajectoryTriggerReadiness({ observation: 'sampler.anchor.stats', criterion: 'trajectoryTriggerAssessment' })
  assert.equal(partial.ready, false)
  assert.deepEqual(partial.gaps, ['snapshot', 'repair', 'derivation'], '缺口逐项如实定位到面')
  // 空字符串/非字符串声明视同未声明（不冒名在场）
  const hollow = trajectoryTriggerReadiness({ observation: '', criterion: 42, snapshot: ' ', repair: 'r', derivation: 'd' })
  assert.deepEqual(hollow.gaps, ['observation', 'criterion', 'snapshot'])
  // 未显式声明即拒（不替调用方猜测在场状态）
  assert.throws(() => trajectoryTriggerReadiness(null), /TRAJECTORY_TRIGGER_READINESS_EVIDENCE_REQUIRED/)
})
