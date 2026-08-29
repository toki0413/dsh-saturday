// CalculationRecord —— 计算产物记录（路线 Week 9 验收：electronicView 产生一条记录）
//
// 要点（修订 #9 的落地形态）：
//  - 电子结构等视图是"计算产物引用"，不是同步字段；记录是引用的落点
//  - 只收录引擎真实给出的性质（values）；未声明者进 unsupported，绝不静默补 null
//  - 记录经 Material 谱系的 'electronic-calculated' 条目反查（append-only 溯源）

import { randomUUID } from 'node:crypto'

/**
 * @param {Object} args
 * @param {Object} args.material   被计算的 Material（取 id / formula）
 * @param {string} args.engine     provider.name
 * @param {string[]} args.requested 请求的性质列表（如 ['bandgap','dos']）
 * @param {Object} args.result     provider.calculate 的返回（含 jobId / calculator）
 */
export function makeCalculationRecord({ material, engine, requested = [], result }) {
  const values = {}
  for (const p of requested) {
    if (result[p] !== undefined && result[p] !== null) values[p] = result[p]
  }
  return {
    id: result.jobId ?? randomUUID(),
    materialId: material.id,
    formula: material.formula,
    engine,
    calculator: result.calculator ?? null,
    requested,
    values,
    unsupported: requested.filter(p => !(p in values)),
    timestamp: Date.now(),
  }
}
