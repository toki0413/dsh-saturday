// XRD 相鉴定/谱匹配纯函数层 —— 把实测粉末谱与候选结构的理论峰表做加权匹配打分。
//
// 方法（诚实、确定性）：两侧各把强度按其最大值归一（相对强度），保留 ≥ minRelativeIntensity
//   的峰（缺省 0.2，滤掉弱峰噪声）。匹配为"角窗口"：实测峰 m 与候选峰 c 当 |2θ_m−2θ_c|≤tolDeg
//   视为对应。打分对称：
//     recall    = 实测强度中"被候选覆盖"的比例（候选能否解释观测到的峰）
//     precision = 候选强度中"被实测证实"的比例（候选有没有预言多余峰）
//     score     = 0.5·recall + 0.5·precision ∈ [0,1]
//   再并列 reportedMatched（逐实测峰命中的候选角）。这是几何峰位匹配，不含择优取向/织构/
//   吸收/位移零点校正，也不拟合晶格常数到亚像素；给出的是"哪个候选相最吻合"的相对判据，
//   非 Rietveld 全谱精修意义上的置信度。tolDeg 与 minRelativeIntensity 由调用方给，随结果回报。

function pmError(code, msg) { const e = new Error(`${msg} (${code})`); e.code = code; return e }

/** 相对强度归一 + 弱峰阈值过滤 */
export function normalizePeaks(peaks, minRelativeIntensity) {
  if (!Array.isArray(peaks)) throw pmError('PM_BAD_INPUT', 'peaks must be an array of {twoTheta, intensity}')
  const withI = peaks.map(p => ({ twoTheta: p.twoTheta, intensity: Number(p.intensity ?? 0) }))
  const max = Math.max(...withI.map(p => p.intensity), 0)
  if (max <= 0) return []
  return withI
    .map(p => ({ ...p, rel: p.intensity / max }))
    .filter(p => p.rel >= minRelativeIntensity && Number.isFinite(p.twoTheta))
}

/** 一个峰是否被对侧峰集中任一峰在 tolDeg 内覆盖（返回覆盖它的对侧峰，取最近） */
function nearestWithin(peak, others, tolDeg) {
  let best = null
  for (const o of others) {
    const d = Math.abs(peak.twoTheta - o.twoTheta)
    if (d <= tolDeg && (!best || d < best.d)) best = { d, peak: o }
  }
  return best
}

/** 单候选打分 */
export function matchPattern({ measured, candidate, tolDeg = 0.5, minRelativeIntensity = 0.2 } = {}) {
  const m = normalizePeaks(measured, minRelativeIntensity)
  const c = normalizePeaks(candidate, minRelativeIntensity)
  if (m.length === 0 || c.length === 0) {
    return { score: 0, recall: 0, precision: 0, measuredMatched: [], note: '一侧无有效峰（低于弱峰阈值或空输入）' }
  }
  // recall：按实测强度加权，被候选覆盖的比例
  const sumM = m.reduce((s, p) => s + p.rel, 0)
  let matchedM = 0
  const measuredMatched = []
  for (const p of m) {
    const hit = nearestWithin(p, c, tolDeg)
    if (hit) { matchedM += p.rel; measuredMatched.push({ twoTheta: p.twoTheta, rel: +p.rel.toFixed(4), matchedAt: +hit.peak.twoTheta.toFixed(3), delta: +hit.d.toFixed(3) }) }
  }
  const recall = matchedM / sumM
  // precision：只统计落在实测覆盖角窗内的候选峰（仪器没测到的角不该算候选的“多余峰”）
  const mLo = Math.min(...m.map(p => p.twoTheta)) - tolDeg
  const mHi = Math.max(...m.map(p => p.twoTheta)) + tolDeg
  const cInWindow = c.filter(p => p.twoTheta >= mLo && p.twoTheta <= mHi)
  const sumC = cInWindow.reduce((s, p) => s + p.rel, 0)
  let matchedC = 0
  for (const p of cInWindow) if (nearestWithin(p, m, tolDeg)) matchedC += p.rel
  const precision = sumC > 0 ? matchedC / sumC : 0
  return {
    score: +(0.5 * recall + 0.5 * precision).toFixed(6),
    recall: +recall.toFixed(6),
    precision: +precision.toFixed(6),
    nMeasured: m.length, nCandidate: c.length, nCandidateInWindow: cInWindow.length,
    coverageWindow: [+mLo.toFixed(2), +mHi.toFixed(2)],
    unmatchedMeasured: m.filter(p => !nearestWithin(p, c, tolDeg)).map(p => +p.twoTheta.toFixed(3)),
    measuredMatched,
  }
}

/**
 * 相鉴定：对多候选理论峰表逐一匹配实测谱，按 score 降序（并列按两角 RMS 偏差升序）。
 * @param {{measuredPeaks, candidates:[{id,label?,peaks:[{twoTheta,intensity}]}], tolDeg, minRelativeIntensity}}
 */
export function identifyPhase({ measuredPeaks, candidates, tolDeg = 0.5, minRelativeIntensity = 0.2 } = {}) {
  if (!Array.isArray(measuredPeaks)) throw pmError('PM_BAD_INPUT', 'measuredPeaks must be an array')
  if (!Array.isArray(candidates) || candidates.length === 0) throw pmError('PM_BAD_INPUT', 'candidates must be a non-empty array')
  const ranked = candidates.map(cand => ({
    id: cand.id, label: cand.label ?? cand.id,
    ...matchPattern({ measured: measuredPeaks, candidate: cand.peaks, tolDeg, minRelativeIntensity }),
  })).sort((a, b) => b.score - a.score || a.recall - b.recall)
  return {
    best: ranked[0]?.id ?? null,
    ranked,
    params: { tolDeg, minRelativeIntensity },
    note: '几何峰位加权匹配（recall+precision 对称，相对强度归一，弱峰阈值过滤）；' +
      '非 Rietveld 全谱精修、不含择优取向/织构/峰形拟合，score 是相判读的相对吻合度非概率。',
  }
}
