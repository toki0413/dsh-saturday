// 多证据源联合排序 —— Logits 组合律纯层。
//
// 背景：仓库既有四个孤立的 log 权重实例（ergodic 重要性重加权 log w = −βU − log q、
// sampler-ou 的 ouLogProb、自由能 βF = −log Z_conf、谐波锚点局部配分函数）。
// 本文件把"组合"本身立为纯层：当多个独立证据源指向同一候选集时，
// 联合 log 权重 = 各源 log 权重之和（log 域加法 = 权重域乘法 = 证据条件独立）。
//
// 诚实纪律（三条，全部显式强制而非约定俗成）：
//  1. 独立性声明必填：组合律只在证据（条件）独立时成立，声明缺失即拒绝组合；
//  2. 候选级证据掩码：某源对某候选无证据就是缺失（null），禁止零填充——
//     log 权重 0 = 权重 1 = "该源认为此候选中立"，那是伪造证据而非承认无知；
//  3. 全源缺失的候选不得参与排序：没有证据就没有权重，静默补零即静默造假。
//
// 归一化用 log-sum-exp：权重只有相对意义（配分函数未知时绝对值无定义）。

export function evidenceError(code, message) {
  const e = new Error(`${message} (${code})`)
  e.code = code
  return e
}

/**
 * 组合多个独立证据源的 log 权重 → 联合权重（归一）+ 覆盖声明。
 * @param {Object}   opts
 * @param {Array<{name: string, logWeights: Array<number|null>}>} opts.sources
 *        逐证据源：名字 + 逐候选 log 权重（null = 该源对此候选无证据）
 * @param {string}   opts.independence 独立性声明（证据为何可相乘；必填，不得静默假设）
 * @param {number}  [opts.maxCandidates] 候选数上限（组合爆炸门禁，默认 10000）
 * @returns {{ weights: Array<number|null>, logJointWeights: Array<number|null>,
 *             coverage: string[][], independence: string, sourceNames: string[] }}
 *          全源缺失候选的 weight/logJointWeight 为 null（不参与排序，不补零）
 */
export function combineEvidence({ sources, independence, maxCandidates = 10000 } = {}) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw evidenceError('EVIDENCE_INVALID_INPUT', 'sources must be a non-empty array')
  }
  if (typeof independence !== 'string' || independence.trim().length === 0) {
    throw evidenceError('EVIDENCE_INDEPENDENCE_UNDECLARED',
      'independence declaration is required: log-weight additivity assumes the sources ' +
      'are (conditionally) independent -- declare why, or refuse to combine')
  }
  const n = sources[0].logWeights?.length
  if (!Number.isInteger(n) || n < 1) {
    throw evidenceError('EVIDENCE_INVALID_INPUT', 'each source must provide a non-empty logWeights array')
  }
  if (n > maxCandidates) {
    throw evidenceError('EVIDENCE_TOO_MANY_CANDIDATES',
      `${n} candidates exceed the combination gate ${maxCandidates}; ` +
      'raise it explicitly instead of silently scaling up')
  }
  const names = new Set()
  for (const s of sources) {
    if (typeof s?.name !== 'string' || s.name.trim().length === 0) {
      throw evidenceError('EVIDENCE_INVALID_INPUT', 'each source must have a non-empty name')
    }
    if (names.has(s.name)) {
      throw evidenceError('EVIDENCE_INVALID_INPUT', `duplicate source name "${s.name}": double counting evidence`)
    }
    names.add(s.name)
    if (!Array.isArray(s.logWeights) || s.logWeights.length !== n) {
      throw evidenceError('EVIDENCE_INVALID_INPUT',
        `source "${s.name}" logWeights length must equal ${n} (candidate alignment)`)
    }
    for (let i = 0; i < n; i++) {
      const w = s.logWeights[i]
      if (w !== null && !Number.isFinite(w)) {
        throw evidenceError('EVIDENCE_INVALID_INPUT',
          `source "${s.name}" candidate ${i}: logWeight must be finite or null (missing), got ${w}`)
      }
    }
  }

  // 逐候选求和（只对覆盖该候选的源）+ 覆盖声明
  const logJoint = new Array(n).fill(null)
  const coverage = Array.from({ length: n }, () => [])
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (const s of sources) {
      const w = s.logWeights[i]
      if (w === null) continue
      sum += w
      coverage[i].push(s.name)
    }
    if (coverage[i].length === 0) {
      throw evidenceError('EVIDENCE_NO_COVERAGE',
        `candidate ${i} has no evidence from any source: refusing to rank on nothing ` +
        '(zero-filling would fabricate neutral evidence)')
    }
    logJoint[i] = sum
  }

  // log-sum-exp 归一（数值稳定：整体偏移不影响权重）
  let max = -Infinity
  for (const l of logJoint) if (l > max) max = l
  const shifted = logJoint.map(l => Math.exp(l - max))
  const z = shifted.reduce((a, b) => a + b, 0)
  const weights = shifted.map(s => s / z)

  return {
    weights,
    logJointWeights: logJoint,
    coverage,
    independence,
    sourceNames: [...names],
  }
}

/**
 * 有效样本数占比（ESS/n）：联合权重集中度的重叠度诊断。
 * ESS/n = 1 / (n · Σ wᵢ²)，单峰集中 → 1/n，均匀 → 1。诚实呈现，不隐藏。
 * 无证据候选（null）不计入。
 * @param {Array<number|null>} weights combineEvidence 的输出
 */
export function essFraction(weights) {
  const ws = (weights ?? []).filter(w => w !== null)
  if (ws.length === 0) {
    throw evidenceError('EVIDENCE_INVALID_INPUT', 'essFraction requires at least one weighted candidate')
  }
  const sumSq = ws.reduce((a, w) => a + w * w, 0)
  return 1 / (ws.length * sumSq)
}
