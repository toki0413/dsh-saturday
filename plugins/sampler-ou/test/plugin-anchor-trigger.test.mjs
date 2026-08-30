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
