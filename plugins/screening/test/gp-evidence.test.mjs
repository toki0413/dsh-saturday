// GP 能量证据源测试：compositionFeatureVector 闭式 + gp-energy LOO 权重 + 机器审计 + 缺数据报错。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compositionFeatureVector, EN, Z } from '@toki0413/core/elements'
import { gpEnergyEvidenceSource } from '../src/evidence-sources.mjs'
import { combineEvidence } from '../src/evidence.mjs'

const close = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps}) ${msg}`)

test('1. compositionFeatureVector 闭式（[meanEN, stdEN, meanZ]）', () => {
  const pure = compositionFeatureVector({ Cu: 1 })
  close(pure[0], EN.Cu, 1e-12); close(pure[1], 0, 1e-12); close(pure[2], Z.Cu, 1e-12)
  const alloy = compositionFeatureVector({ Cu: 3, Ag: 1 })
  close(alloy[0], (3 * EN.Cu + EN.Ag) / 4, 1e-12)
  close(alloy[2], (3 * Z.Cu + Z.Ag) / 4, 1e-12)
  assert.ok(alloy[1] > 0, 'Cu/Ag 电负性不同 → std>0')
})

test('2. 缺元素数据显式报错，不默认', () => {
  assert.throws(() => compositionFeatureVector({ Xx: 1 }), /ELEMENT_DATA_MISSING/)
  assert.throws(() => compositionFeatureVector({}), /COMPOSITION_EMPTY/)
})

// 造一批带 energyPerAtom 的候选（组分用表内元素，能量随 meanEN 单调，好检验近邻平滑方向）
function fakeRanked() {
  const comps = [{ Cu: 4 }, { Cu: 3, Ni: 1 }, { Cu: 2, Ni: 2 }, { Cu: 1, Ni: 3 }, { Ni: 4 }, { Cu: 3, Au: 1 }, { Au: 4 }, { Cu: 2, Au: 2 }]
  return comps.map((c, i) => ({ label: `c${i}`, composition: c, energyPerAtom: -3 + 0.1 * i, formationEnthalpy: 0.1 * i, energyAboveHull: 0 }))
}

test('3. gp-energy logWeights：逐候选有限、与低能方向一致', () => {
  const ranked = fakeRanked()
  gpEnergyEvidenceSource.requires({ ranked })
  const w = gpEnergyEvidenceSource.logWeights({ ranked, betaEVInv: 40 })
  assert.equal(w.length, ranked.length)
  assert.ok(w.every(Number.isFinite), '全部候选有有限 log 权重')
  // 能量最低的 c0 其 LOO 预测也应偏低 → 权重最高（−β·(pred−min)）
  assert.equal(w[0], Math.max(...w), '最低能候选权重最高')
})

test('4. 候选过少 / 缺组分 / 缺能量 显式抛错', () => {
  assert.throws(() => gpEnergyEvidenceSource.requires({ ranked: fakeRanked().slice(0, 4) }), e => e.code === 'EVIDENCE_INVALID_INPUT')
  assert.throws(() => gpEnergyEvidenceSource.requires({ ranked: [{ composition: {} }] }), e => e.code === 'EVIDENCE_INVALID_INPUT')
  const bad = fakeRanked(); bad[0].energyPerAtom = NaN
  assert.throws(() => gpEnergyEvidenceSource.logWeights({ ranked: bad, betaEVInv: 40 }), e => e.code === 'EVIDENCE_INVALID_INPUT')
})

test('5. 与焓/混合熵组合：共享能量+组分级机器审计通过（因 note 已解释）', () => {
  const ranked = fakeRanked()
  const betaE = 40
  const sources = [
    { name: 'boltzmann:stub', logWeights: ranked.map(r => -betaE * r.formationEnthalpy), variables: ['能量'] },
    { name: 'mixing-entropy:builtin', logWeights: gpEnergyEvidenceSource.logWeights({ ranked, betaEVInv: betaE }), variables: gpEnergyEvidenceSource.variables },
  ]
  // combineEvidence 要求机械检出的共享变量在 independence 文本中被解释；gp note 含 能量/组分
  const combined = combineEvidence({ sources, independence: '焓证据 −βΔH_f 逐候选单点；' + gpEnergyEvidenceSource.independenceNote })
  assert.equal(combined.sources === undefined, true) // 输出无 sources 字段
  assert.ok(combined.correlationAudit.pairs.length >= 1, '应机械检出共享变量（degenerate）')
  assert.ok(combined.weights.every(w => Number.isFinite(w) && w > 0))
})
