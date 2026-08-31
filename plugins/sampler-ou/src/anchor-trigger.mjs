// “足够轨迹”触发判据：把锚点库容量观测的读数与调用方显式声明的阈值对账。
// 判据是声明式对账，不是门禁：读数不足只如实呈报，机制是否启用由使用者决定。
// 阈值不硬编码、不设默认：未显式声明即拒绝（不替调用方猜测进场门槛）。
// 对账结论可选登记为推导（输入 = 调用方声明的可追溯证据引用）——
// 证据引用失效 → 对账结论沿推导图如实失效（结论依据可撤回；
// 无可追溯证据引用不伪登记）。
// 谱系质量维：“足够轨迹”不只是够多，还要够可追溯——可选阈值 `minTrackableRatio`
// （material:/job: 占比）由调用方显式声明；未声明行为不变（不硬编码、不设默认），
// 声明了但读数缺谱系分布维 → 显式拒绝（不替调用方猜测质量读数）。
// 触发条件就绪度报告（声明式盘点，不是门禁）：触发条件的基础设施面（观测/判据/
// 快照/修复/推导）由调用方逐项显式声明，报告如实汇总在场/缺口——缺失只呈报为缺口不是错误。

import { randomUUID } from 'node:crypto'

export function trajectoryTriggerAssessment(readings, thresholds, context = {}) {
  if (!readings || typeof readings !== 'object') {
    throw new Error('TRAJECTORY_TRIGGER_READINGS_REQUIRED：判据对账需要库内容量观测读数（如 sampler.anchor.stats 交付）')
  }
  if (!thresholds || typeof thresholds !== 'object'
      || typeof thresholds.minSize !== 'number'
      || typeof thresholds.minCompositionCoverage !== 'number') {
    throw new Error('TRAJECTORY_TRIGGER_THRESHOLDS_REQUIRED：判据阈值必须由调用方显式声明（minSize / minCompositionCoverage），不设默认、不硬编码')
  }
  const size = readings.size ?? 0
  const withComposition = readings.withComposition ?? 0
  const coverage = size > 0 ? withComposition / size : 0
  // 谱系质量维：可追溯占比（读数需带谱系形态分布，如容量观测交付的 lineage 段）
  const lineage = readings.lineage ?? null
  const trackableRatio = lineage === null
    ? null
    : (size > 0 ? ((lineage.material ?? 0) + (lineage.job ?? 0)) / size : 0)
  const reasons = []
  if (size < thresholds.minSize) {
    reasons.push(`条目数 ${size} 低于 minSize ${thresholds.minSize}`)
  }
  if (coverage < thresholds.minCompositionCoverage) {
    reasons.push(`组分声明覆盖 ${coverage} 低于 minCompositionCoverage ${thresholds.minCompositionCoverage}`)
  }
  if (typeof thresholds.minTrackableRatio === 'number') {
    if (trackableRatio === null) {
      throw new Error('TRAJECTORY_TRIGGER_LINEAGE_REQUIRED：声明了 minTrackableRatio 但读数缺谱系形态分布（lineage 段，如容量观测交付）——不替调用方猜测质量读数')
    }
    if (trackableRatio < thresholds.minTrackableRatio) {
      reasons.push(`可追溯占比 ${trackableRatio} 低于 minTrackableRatio ${thresholds.minTrackableRatio}`)
    }
  }
  // 对账结论入推导登记簿（可选：未注入推导服务行为不变，零依赖）
  const { derivation = null, evidenceRefs = [], batchId = null } = context ?? {}
  let derivationRecord = null
  if (derivation) {
    const refs = [...new Set((Array.isArray(evidenceRefs) ? evidenceRefs : [])
      .filter(ref => typeof ref === 'string' && (ref.startsWith('material:') || ref.startsWith('job:')))
      .map(ref => ref.split('#')[0]))]   // 归一化取 # 前段
    if (refs.length > 0) {
      const bid = batchId ?? randomUUID()
      const triggerRef = `result:trigger-${bid}`
      derivation.record({ inputs: refs, output: triggerRef, producer: 'trajectoryTriggerAssessment' })
      derivationRecord = { batchId: bid, triggerRef, evidenceRefs: refs }
    } else {
      derivationRecord = { batchId: null, triggerRef: null, evidenceRefs: [],
        note: '无可追溯证据引用（非 material:/job: 形态）：不伪登记' }
    }
  }
  return {
    met: reasons.length === 0,
    reasons,
    readings: { size, withComposition, coverage, ...(trackableRatio !== null ? { trackableRatio } : {}) },
    thresholds,
    ...(derivationRecord ? { derivation: derivationRecord } : {}),
    note: '触发判据：读数对阈值为声明式对账，不是门禁——达标与否只如实呈报，机制是否启用由使用者决定',
  }
}

// 触发条件就绪度报告：触发条件的基础设施盘点（观测/判据/快照/修复/推导五面）。
// 每一面必须由调用方显式声明在场凭据（非空字符串）；缺失呈报为缺口（缺失不是错误，只是未就位）。
// 报告是呈报不是门禁：ready 只如实反映声明完备度。
export function trajectoryTriggerReadiness(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    throw new Error('TRAJECTORY_TRIGGER_READINESS_EVIDENCE_REQUIRED：就绪度报告需要调用方显式声明（evidence），不替调用方猜测在场状态')
  }
  const surfaces = ['observation', 'criterion', 'snapshot', 'repair', 'derivation']
  const present = {}
  const gaps = []
  for (const s of surfaces) {
    const v = evidence[s]
    if (typeof v === 'string' && v.trim().length > 0) present[s] = v
    else gaps.push(s)
  }
  return {
    ready: gaps.length === 0,
    present, gaps,
    note: '触发条件就绪度报告：声明式盘点不是门禁——就绪只反映基础设施在场状态，' +
          '“足够轨迹”与“探索效率瓶颈”仍需数据实证，机制是否启用由使用者决定',
  }
}
