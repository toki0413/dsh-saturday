// evidence 纯层契约测试：Logits 组合律的闭式对账与诚实纪律门禁。
// 不依赖任何引擎/采样器：组合律是纯统计，测试全部可用手算闭式断言。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { combineEvidence, essFraction, evidenceError, auditEvidenceIndependence } from '../src/evidence.mjs'

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

// ──  变量依赖机器审计 + 掩码机械统计：声明是人写的，交集是机器算的，对不上即拒绝 ──
test('9. 机器审计三态：independent（全声明且两两不交）/ degenerate（检出共享）/ unverifiable（存在未声明者）', () => {
  const ind = auditEvidenceIndependence([
    { name: 'A', variables: ['能量'] }, { name: 'B', variables: ['组分'] },
  ])
  assert.equal(ind.status, 'independent')
  assert.deepEqual(ind.pairs, [])

  const deg = auditEvidenceIndependence([
    { name: 'A', variables: ['能量', '组分'] }, { name: 'B', variables: ['组分'] },
  ])
  assert.equal(deg.status, 'degenerate')
  assert.deepEqual(deg.pairs, [{ a: 'A', b: 'B', shared: ['组分'] }])

  const unv = auditEvidenceIndependence([
    { name: 'A', variables: ['能量'] }, { name: 'B' },
  ])
  assert.equal(unv.status, 'unverifiable', '未声明者存在 = 机器不可证，不冒充独立')
  assert.deepEqual(unv.undeclared, ['B'])

  assert.throws(() => auditEvidenceIndependence([{ name: 'A', variables: [''] }]),
    err => err.code === 'EVIDENCE_INVALID_INPUT', '词表不接受空声明')
})

test('10. 机器审计入组合门禁：检出共享变量未被声明文本解释 → 拒绝；解释则放行（权重不变）', () => {
  const sources = [
    { name: 'A', logWeights: [0, LN2], variables: ['组分'] },
    { name: 'B', logWeights: [LN3, 0], variables: ['组分'] },
  ]
  // 声明文本不提共享变量：机械检出组分共享但无人解释 → 拒绝（不依赖人工自觉）
  assert.throws(
    () => combineEvidence({ sources, independence: '测试构造：A、B 独立' }),
    err => err.code === 'EVIDENCE_INDEPENDENCE_UNDECLARED' && /组分/.test(err.message),
  )
  // 文本解释了共享变量：放行，权重仍 = 测试 1 闭式 [3/5, 2/5]（审计不改数学）
  const out = combineEvidence({ sources, independence: '测试构造：共享组分变量，给定组分下条件独立' })
  assert.ok(Math.abs(out.weights[0] - 3 / 5) < 1e-12)
  assert.equal(out.correlationAudit.status, 'degenerate')
  assert.deepEqual(out.correlationAudit.pairs[0].shared, ['组分'])
  // 未声明 variables 的源：审计如实标记 unverifiable，不拒绝（声明是能力不是义务）
  const unv = combineEvidence({
    sources: [{ name: 'A', logWeights: [0] }], independence: '单源',
  })
  assert.equal(unv.correlationAudit.status, 'unverifiable')
})

test('11. 掩码机械统计：逐源 null 计数随交付呈现（消费方可机械复核无零填充）', () => {
  // 构造满足纪律 3：每个候选至少一源覆盖（A 缺候选 1，B 缺候选 0）
  const out = combineEvidence({
    sources: [
      { name: 'A', logWeights: [0, null, 1] },
      { name: 'B', logWeights: [null, LN3, 0] },
    ],
    independence: '测试构造',
  })
  assert.deepEqual(out.maskCounts, { A: 1, B: 1 }, '逐源 null 计数 = 掩码的机械可见形态')
  const full = combineEvidence({ sources: [{ name: 'A', logWeights: [0, 1] }], independence: '测试构造' })
  assert.deepEqual(full.maskCounts, { A: 0 }, '全覆盖源计数为 0（不是缺字段）')
})
