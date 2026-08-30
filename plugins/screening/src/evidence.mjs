// 多证据源联合排序 —— Logits 组合律纯层。
//
// 背景：仓库既有四个孤立的 log 权重实例（ergodic 重要性重加权 log w = −βU − log q、
// sampler-ou 的 ouLogProb、自由能 βF = −log Z_conf、谐波锚点局部配分函数）。
// 本文件把"组合"本身立为纯层：当多个独立证据源指向同一候选集时，
// 联合 log 权重 = 各源 log 权重之和（log 域加法 = 权重域乘法 = 证据条件独立）。
//
// 诚实纪律（五条，全部显式强制而非约定俗成）：
//  1. 独立性声明必填：组合律只在证据（条件）独立时成立，声明缺失即拒绝组合；
//  2. 候选级证据掩码：某源对某候选无证据就是缺失（null），禁止零填充——
//     log 权重 0 = 权重 1 = "该源认为此候选中立"，那是伪造证据而非承认无知；
//  3. 全源缺失的候选不得参与排序：没有证据就没有权重，静默补零即静默造假；
//  4. 变量依赖机器审计（⑤）：源可声明 variables（依赖变量词表），成对交集机械检出，
//     机械检出的共享变量必须在独立性声明文本中被解释，否则拒绝组合；
//  5. 掩码机械统计（⑤）：逐源 null 计数随交付呈现，消费方可机械复核"无零填充"。
//
// 归一化用 log-sum-exp：权重只有相对意义（配分函数未知时绝对值无定义）。

export function evidenceError(code, message) {
  const e = new Error(`${message} (${code})`)
  e.code = code
  return e
}

/**
 * 独立性机器审计（⑤）：对声明了变量依赖的证据源做两两交集机械检出。
 * 未声明 variables 的源 = 机器不可证（不拒绝，如实标记）——声明是能力不是义务，
 * 但一旦双方都声明且交集非空，共享变量必须在独立性声明文本中被解释（见 combineEvidence）。
 * @param {Array<{name: string, variables?: string[]}>} sources
 * @returns {{ status: 'independent'|'degenerate'|'unverifiable',
 *             pairs: Array<{a: string, b: string, shared: string[]}>,
 *             undeclared: string[] }}
 *          status：independent = 全部声明且两两不交（机械证明独立）；
 *          degenerate = 全部声明但存在共享变量（退化关联机械可见）；
 *          unverifiable = 存在未声明者（机器不可证，不冒充独立）
 */
export function auditEvidenceIndependence(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw evidenceError('EVIDENCE_INVALID_INPUT', 'auditEvidenceIndependence requires a non-empty sources array')
  }
  for (const s of sources) {
    if (s.variables !== undefined) {
      if (!Array.isArray(s.variables) || s.variables.some(v => typeof v !== 'string' || v.length === 0)) {
        throw evidenceError('EVIDENCE_INVALID_INPUT',
          `source "${s.name}" variables must be an array of non-empty strings (机械审计词表不接受空声明)`)
      }
    }
  }
  const declared = sources.filter(s => Array.isArray(s.variables))
  const undeclared = sources.filter(s => !Array.isArray(s.variables)).map(s => s.name)
  const pairs = []
  for (let i = 0; i < declared.length; i++) {
    for (let j = i + 1; j < declared.length; j++) {
      const shared = declared[i].variables.filter(v => declared[j].variables.includes(v))
      if (shared.length > 0) pairs.push({ a: declared[i].name, b: declared[j].name, shared })
    }
  }
  const status = undeclared.length > 0 ? 'unverifiable' : pairs.length > 0 ? 'degenerate' : 'independent'
  return { status, pairs, undeclared }
}

/**
 * 组合多个独立证据源的 log 权重 → 联合权重（归一）+ 覆盖声明 + 机器审计。
 * @param {Object}   opts
 * @param {Array<{name: string, logWeights: Array<number|null>, variables?: string[]}>} opts.sources
 *        逐证据源：名字 + 逐候选 log 权重（null = 该源对此候选无证据）；
 *        variables（可选，⑤）= 该源依赖的变量词表，供机器审计独立性（未声明 = 机器不可证）
 * @param {string}   opts.independence 独立性声明（证据为何可相乘；必填，不得静默假设）；
 *        机器检出共享变量时，文本必须解释每个共享变量（否则拒绝组合）
 * @param {number}  [opts.maxCandidates] 候选数上限（组合爆炸门禁，默认 10000）
 * @returns {{ weights: Array<number|null>, logJointWeights: Array<number|null>,
 *             coverage: string[][], independence: string, sourceNames: string[],
 *             maskCounts: Object<string, number>, correlationAudit: Object }}
 *          全源缺失候选的 weight/logJointWeight 为 null（不参与排序，不补零）；
 *          maskCounts = 逐源 null 计数（掩码机械统计）；correlationAudit = 变量依赖机器审计结果
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

  // 变量依赖机器审计（⑤）：机械检出的共享变量必须在独立性声明中被解释——
  // 声明文本是人写的，交集是机器算的，两者对不上即拒绝组合（不依赖人工自觉）
  const correlationAudit = auditEvidenceIndependence(sources)
  for (const p of correlationAudit.pairs) {
    for (const v of p.shared) {
      if (!independence.includes(v)) {
        throw evidenceError('EVIDENCE_INDEPENDENCE_UNDECLARED',
          `mechanically detected shared variable "${v}" between sources "${p.a}" and "${p.b}", ` +
          `but the independence declaration never mentions it——机械检出的退化关联必须在声明中被解释`)
      }
    }
  }

  // 逐候选求和（只对覆盖该候选的源）+ 覆盖声明 + 逐源掩码计数（⑤）
  const maskCounts = Object.fromEntries(sources.map(s => [s.name, 0]))
  const logJoint = new Array(n).fill(null)
  const coverage = Array.from({ length: n }, () => [])
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (const s of sources) {
      const w = s.logWeights[i]
      if (w === null) { maskCounts[s.name] += 1; continue }
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
    maskCounts,
    correlationAudit,
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
