// ㊵ “足够轨迹”触发判据原型（自监督进场条件 ㉘ 的机器化第一步）：
// 把 ㊳ 库内容量观测的读数与调用方显式声明的阈值对账——判据是声明式对账，
// 不是门禁：读数不足只如实呈报，机制是否进场仍由裁决者决定（先见数据再谈机制，同 ⑬/⑱/㉘）。
// 阈值不硬编码、不设默认：未显式声明即拒绝（不替调用方猜测进场门槛）。

export function trajectoryTriggerAssessment(readings, thresholds) {
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
  return {
    met: reasons.length === 0,
    reasons,
    readings: { size, withComposition, coverage },
    thresholds,
    note: '触发判据原型（㊵）：读数对阈值为声明式对账，不是门禁——达标与否只如实呈报，机制进场仍由裁决者决定（㉘ 先见数据再谈机制）',
  }
}
