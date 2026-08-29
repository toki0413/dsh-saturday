// Trajectory replay —— 时间维可组合性的最小落地（契约 §3 双通道模型）
// 瀑布事件流是 append-only 的：不可改、但可回放。回放不重算物理——
// 重建的是"研究决策上下文"：谁算过什么、用哪个引擎、结果排序如何。
// 这正是"可逆的是决策不是物理"的读侧体现：从事件流重建任意时刻的索引。

/**
 * 解析轨迹文本为记录数组。
 * 纪律：单行坏数据跳过（带行号计数），不让一条脏记录毁掉整个回放。
 * @returns {{ records: Object[], skipped: number }}
 */
export function parseTrajectory(text) {
  const records = []
  let skipped = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const record = JSON.parse(trimmed)
      if (record && typeof record === 'object') records.push(record)
      else skipped++
    } catch { skipped++ }
  }
  return { records, skipped }
}

/**
 * 从轨迹记录重建材料计算索引（事件溯源的读模型）。
 * 记录形状以实际落盘为准：{ type, material:{id,formula}, result:{energy,...},
 * engine, workflow? }；变体因 Material fork 各有独立 id，天然可区分。
 * 排序与筛选都交给消费方——这里只做忠实累积。
 */
export function rebuildIndex(records) {
  const index = new Map()
  for (const record of records) {
    const materialId = record.materialId ?? record.material?.id
    if (!materialId) continue   // 非材料事件（如 lifecycle）不进索引
    let entry = index.get(materialId)
    if (!entry) {
      entry = {
        materialId,
        formula: record.formula ?? record.material?.formula ?? null,
        engines: new Set(),
        workflows: new Set(),
        calculations: [],
      }
      index.set(materialId, entry)
    }
    entry.formula ??= record.formula ?? record.material?.formula ?? null
    entry.calculations.push(record)
    if (record.engine) entry.engines.add(record.engine)
    if (record.workflow) entry.workflows.add(record.workflow)
  }
  return index
}

/** 索引的纯对象视图（工具返回值必须可序列化） */
export function indexToSummary(index) {
  return [...index.values()].map(e => ({
    materialId: e.materialId,
    formula: e.formula,
    engines: [...e.engines],
    workflows: [...e.workflows],
    calculationCount: e.calculations.length,
    // 最优能量：变体间比较的第一块积木（真实记录里能量在 result.energy）
    bestEnergy: e.calculations
      .map(c => c.result?.energy ?? c.energy)
      .filter(v => typeof v === 'number' && Number.isFinite(v))
      .reduce((min, v) => (min === null || v < min ? v : min), null),
  }))
}
