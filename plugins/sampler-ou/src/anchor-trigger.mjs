// ㊵ “足够轨迹”触发判据原型（自监督进场条件 ㉘ 的机器化第一步）：
// 把 ㊳ 库内容量观测的读数与调用方显式声明的阈值对账——判据是声明式对账，
// 不是门禁：读数不足只如实呈报，机制是否进场仍由裁决者决定（先见数据再谈机制，同 ⑬/⑱/㉘）。
// 阈值不硬编码、不设默认：未显式声明即拒绝（不替调用方猜测进场门槛）。
// ㊹ 判据对账谱系化：对账结论可选登记为推导（输入 = 调用方声明的可追溯证据引用）——
// 证据引用失效 → 对账结论沿推导图如实失效（裁决依据可撤回，与 ㉑ 提案登记同款纪律：
// 无可追溯证据引用不伪登记）。

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
  const reasons = []
  if (size < thresholds.minSize) {
    reasons.push(`条目数 ${size} 低于 minSize ${thresholds.minSize}`)
  }
  if (coverage < thresholds.minCompositionCoverage) {
    reasons.push(`组分声明覆盖 ${coverage} 低于 minCompositionCoverage ${thresholds.minCompositionCoverage}`)
  }
  // ㊹ 对账结论入推导登记簿（可选：未注入推导服务行为不变，与 ㉑ 同款零依赖纪律）
  const { derivation = null, evidenceRefs = [], batchId = null } = context ?? {}
  let derivationRecord = null
  if (derivation) {
    const refs = [...new Set((Array.isArray(evidenceRefs) ? evidenceRefs : [])
      .filter(ref => typeof ref === 'string' && (ref.startsWith('material:') || ref.startsWith('job:')))
      .map(ref => ref.split('#')[0]))]   // 归一化取 # 前段（同 ㉑ 归一规则）
    if (refs.length > 0) {
      const bid = batchId ?? randomUUID()
      const triggerRef = `result:trigger-${bid}`
      derivation.record({ inputs: refs, output: triggerRef, producer: 'trajectoryTriggerAssessment' })
      derivationRecord = { batchId: bid, triggerRef, evidenceRefs: refs }
    } else {
      derivationRecord = { batchId: null, triggerRef: null, evidenceRefs: [],
        note: '无可追溯证据引用（非 material:/job: 形态）：不伪登记，同 ㉑ 提案登记纪律' }
    }
  }
  return {
    met: reasons.length === 0,
    reasons,
    readings: { size, withComposition, coverage },
    thresholds,
    ...(derivationRecord ? { derivation: derivationRecord } : {}),
    note: '触发判据原型（㊵）：读数对阈值为声明式对账，不是门禁——达标与否只如实呈报，机制进场仍由裁决者决定（㉘ 先见数据再谈机制）',
  }
}
