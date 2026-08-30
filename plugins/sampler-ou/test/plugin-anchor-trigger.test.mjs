// ㊵ “足够轨迹”触发判据原型（纯层测试，无挂载）：
// 判据是声明式对账不是门禁——达标与否如实呈报，阈值必须由调用方显式声明（不设默认、不硬编码）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trajectoryTriggerAssessment } from '../src/anchor-trigger.mjs'

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
