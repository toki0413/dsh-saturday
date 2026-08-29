// evidence 纯层契约测试：Logits 组合律的闭式对账与诚实纪律门禁。
// 不依赖任何引擎/采样器：组合律是纯统计，测试全部可用手算闭式断言。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { combineEvidence, essFraction, evidenceError } from '../src/evidence.mjs'

const LN2 = Math.log(2)
const LN3 = Math.log(3)

test('1. 组合律闭式：两独立源 log 权重相加 → 权重比 = exp 之比（手算 3:2）', () => {
  // 源 A：[0, ln2]（候选 1 权重是候选 0 的 2 倍）
  // 源 B：[ln3, 0]（候选 0 权重是候选 1 的 3 倍）
  // 联合：[ln3, ln2] → 归一 = [3/5, 2/5]（闭式，不靠数值巧合）
  const out = combineEvidence({
    sources: [
      { name: 'A', logWeights: [0, LN2] },
      { name: 'B', logWeights: [LN3, 0] },
    ],
    independence: '测试构造：A、B 为手工指定的独立权重表',
  })
  assert.ok(Math.abs(out.weights[0] - 3 / 5) < 1e-12)
  assert.ok(Math.abs(out.weights[1] - 2 / 5) < 1e-12)
  assert.deepEqual(out.logJointWeights, [LN3, LN2])
  assert.deepEqual(out.coverage, [['A', 'B'], ['A', 'B']])
  assert.deepEqual(out.sourceNames, ['A', 'B'])
})

test('2. log-sum-exp 数值稳定：整体偏移 1000 不改变权重', () => {
  const base = combineEvidence({
    sources: [{ name: 'A', logWeights: [0, LN2, LN3] }],
    independence: '单源无独立性假设',
  })
  const shifted = combineEvidence({
    sources: [{ name: 'A', logWeights: [1000, 1000 + LN2, 1000 + LN3] }],
    independence: '单源无独立性假设',
  })
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(base.weights[i] - shifted.weights[i]) < 1e-12)
  }
  // 归一闭式：权重 = [1, 2, 3]/6
  assert.ok(Math.abs(base.weights[2] - 3 / 6) < 1e-12)
})

test('3. 证据掩码：缺失源按覆盖子集组合，覆盖声明逐候选呈现', () => {
  // 候选 1 缺源 B → 联合 = A 单独 = 0；候选 0 双源 = ln3
  // 权重 = [3/4, 1/4]；若误将缺失零填充则候选 1 联合仍 0 —— 数值相同，
  // 但覆盖声明必须如实区分（纪律断言在 coverage，不在数值）
  const out = combineEvidence({
    sources: [
      { name: 'A', logWeights: [0, 0] },
      { name: 'B', logWeights: [LN3, null] },
    ],
    independence: '测试构造：A 全覆盖，B 只覆盖候选 0',
  })
  assert.ok(Math.abs(out.weights[0] - 3 / 4) < 1e-12)
  assert.ok(Math.abs(out.weights[1] - 1 / 4) < 1e-12)
  assert.deepEqual(out.coverage, [['A', 'B'], ['A']])
})

test('4. 独立性声明缺失即拒绝组合（不得静默假设）', () => {
  assert.throws(
    () => combineEvidence({ sources: [{ name: 'A', logWeights: [0, 1] }] }),
    err => err.code === 'EVIDENCE_INDEPENDENCE_UNDECLARED',
  )
  assert.throws(
    () => combineEvidence({ sources: [{ name: 'A', logWeights: [0] }], independence: '   ' }),
    err => err.code === 'EVIDENCE_INDEPENDENCE_UNDECLARED',
  )
})

test('5. 全源缺失候选拒绝参与排序（无证据 = 无权重，禁止补零）', () => {
  assert.throws(
    () => combineEvidence({
      sources: [{ name: 'A', logWeights: [0, null, 1] }],
      independence: '测试构造',
    }),
    err => err.code === 'EVIDENCE_NO_COVERAGE' && /candidate 1/.test(err.message),
  )
})

test('6. 结构门禁：源名重复（证据重复计数）/ 长度不齐 / 非有限值 / 候选超限', () => {
  const ind = '测试构造'
  assert.throws(
    () => combineEvidence({
      sources: [{ name: 'A', logWeights: [0] }, { name: 'A', logWeights: [1] }],
      independence: ind,
    }),
    /double counting/,
  )
  assert.throws(
    () => combineEvidence({
      sources: [{ name: 'A', logWeights: [0, 1] }, { name: 'B', logWeights: [0] }],
      independence: ind,
    }),
    /candidate alignment/,
  )
  assert.throws(
    () => combineEvidence({
      sources: [{ name: 'A', logWeights: [0, Infinity] }],
      independence: ind,
    }),
    err => err.code === 'EVIDENCE_INVALID_INPUT',
  )
  assert.throws(
    () => combineEvidence({
      sources: [{ name: 'A', logWeights: [0, 1, 2] }],
      independence: ind,
      maxCandidates: 2,
    }),
    err => err.code === 'EVIDENCE_TOO_MANY_CANDIDATES',
  )
})

test('7. ESS 占比闭式：均匀 = 1，单峰集中 = 1/n，null 不计入', () => {
  assert.ok(Math.abs(essFraction([0.25, 0.25, 0.25, 0.25]) - 1) < 1e-12)
  assert.ok(Math.abs(essFraction([1, 0, 0, 0]) - 1 / 4) < 1e-12)
  // [0.6, 0.4, null]：有效候选 2 个，ESS/2 = 1/(2·(0.36+0.16)) = 1/1.04
  assert.ok(Math.abs(essFraction([0.6, 0.4, null]) - 1 / 1.04) < 1e-12)
  assert.throws(() => essFraction([null]), err => err.code === 'EVIDENCE_INVALID_INPUT')
})

test('8. evidenceError 携带错误码（调用方可按码分流，不靠字符串匹配）', () => {
  const e = evidenceError('EVIDENCE_INVALID_INPUT', 'x')
  assert.equal(e.code, 'EVIDENCE_INVALID_INPUT')
  assert.match(e.message, /\(EVIDENCE_INVALID_INPUT\)$/)
})
