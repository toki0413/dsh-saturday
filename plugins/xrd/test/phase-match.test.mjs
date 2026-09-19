// XRD 相鉴定纯函数测试：闭式对账（完全匹配、缺峰、多余峰、容差边界、排序、非法输入）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchPattern, identifyPhase, normalizePeaks } from '../src/phase-match.mjs'

const P = (twoTheta, intensity) => ({ twoTheta, intensity })
const close = (a, b, eps = 1e-9, msg = '') => assert.ok(Number.isFinite(a) && Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps}) ${msg}`)

test('1. 完全吻合 → score/recall/precision=1', () => {
  const measured = [P(30, 100), P(40, 60), P(50, 30)]
  const r = matchPattern({ measured, candidate: [...measured], tolDeg: 0.3 })
  close(r.score, 1); close(r.recall, 1); close(r.precision, 1)
  assert.equal(r.unmatchedMeasured.length, 0)
})

test('2. 候选缺峰 → recall 掉、precision 仍 1', () => {
  const measured = [P(30, 100), P(40, 100)]          // 两峰等强
  const candidate = [P(30, 100)]                       // 候选只解释一个
  const r = matchPattern({ measured, candidate, tolDeg: 0.3 })
  close(r.recall, 0.5, 1e-6, '实测强度一半没被覆盖')
  close(r.precision, 1, 1e-6, '候选峰都被实测证实')
  assert.ok(r.score < 1)
})

test('3. 候选在实测区间内多预言峰 → precision 掉、recall 仍 1', () => {
  const measured = [P(30, 100), P(50, 100)]           // 覆盖 30–50
  const candidate = [P(30, 100), P(40, 100), P(50, 100)]  // 40 在实测区间内但无对应实测峰
  const r = matchPattern({ measured, candidate, tolDeg: 0.5 })
  close(r.recall, 1)
  close(r.precision, 2 / 3, 1e-6, '候选强度 1/3（40 处）无实测佐证')
  assert.ok(r.score < 1)
})

test('3b. 候选峰在实测覆盖窗外（未测量角区）→ 不罚 precision', () => {
  const measured = [P(30, 100)]                          // 只测到 30 附近
  const candidate = [P(30, 100), P(90, 100)]             // 90 远超实测窗
  const r = matchPattern({ measured, candidate, tolDeg: 0.5 })
  close(r.precision, 1, 1e-6, '90 在窗外，不计入 precision 分母')
  assert.equal(r.nCandidateInWindow, 1)
})

test('4. 容差边界：偏移 ≤tol 匹配、>tol 不匹配', () => {
  const measured = [P(30.0, 100)]
  assert.equal(matchPattern({ measured, candidate: [P(30.4, 100)], tolDeg: 0.5 }).recall, 1)
  assert.equal(matchPattern({ measured, candidate: [P(30.6, 100)], tolDeg: 0.5 }).recall, 0)
})

test('5. 弱峰阈值过滤 + identifyPhase 排序选对相', () => {
  const measured = [P(30, 100), P(40, 20)]            // 40 处强度 20（相对 0.2）
  const strongOnly = normalizePeaks(measured, 0.3)     // 阈值 0.3 → 只剩 30
  assert.equal(strongOnly.length, 1)
  const phaseA = { id: 'A', peaks: [P(30, 100), P(40, 100)] }   // 覆盖两峰
  const phaseB = { id: 'B', peaks: [P(31, 100)] }                // 都不在容差内
  const out = identifyPhase({ measuredPeaks: measured, candidates: [phaseB, phaseA], tolDeg: 0.3, minRelativeIntensity: 0.1 })
  assert.equal(out.best, 'A', 'A 应最吻合')
  assert.ok(out.ranked[0].score > out.ranked[1].score)
  assert.ok(out.note.includes('非 Rietveld'))
})

test('6. 空/非法输入显式报错，不静默', () => {
  assert.throws(() => identifyPhase({ measuredPeaks: 'x', candidates: [] }), e => e.code === 'PM_BAD_INPUT')
  assert.throws(() => identifyPhase({ measuredPeaks: [], candidates: [] }), e => e.code === 'PM_BAD_INPUT')
  // 一侧空峰 → score 0，不抛（有效但无匹配）
  const r = matchPattern({ measured: [], candidate: [P(30, 1)], tolDeg: 0.3 })
  assert.equal(r.score, 0)
})
