// thermo.mjs —— 热力学第一档：严格形成焓 + 凸包稳定性（纯函数，零依赖）
//
// 诚实边界：
//  - 形成焓必须基于显式注入的元素参考态能量（每原子），缺参考态显式报错，
//    绝不静默假设零点（“近似”必须升级为“显式计算”才是严格量）；
//  - 凸包是给定能量函数精度下的凸包（level 声明），不冒充更高精度的凸包；
//  - 二元系凸包：x = 第二元素摩尔分数，y = 每原子能量；端点（纯元素）必入包。

import { SYMBOL } from './elements.mjs'

export function thermoError(code, message) {
  const e = new Error(`${message} (${code})`)
  e.code = code
  return e
}

/** 由原子序数序列合成元素计数表（如 [29,29,29,28] → { Cu: 3, Ni: 1 }）；未知原子序数显式报错 */
export function compositionFromNumbers(numbers) {
  const composition = {}
  for (const z of numbers) {
    const s = SYMBOL[z]
    if (!s) throw thermoError('THERMO_INVALID_INPUT', `未知原子序数 ${z}（元素表子集之外）`)
    composition[s] = (composition[s] ?? 0) + 1
  }
  return composition
}

/**
 * 严格形成焓：ΔH_f = E/N − Σᵢ xᵢ·Eᵢ(ref)，全部按每原子归一。
 * @param {Object}  opts
 * @param {number}  opts.energy        结构总能量（引擎原样给出）
 * @param {Object}  opts.composition   元素计数，如 { Cu: 3, Ni: 1 }
 * @param {Object}  opts.references    元素参考态每原子能量，如 { Cu: -0.001, Ni: 0.0 }
 * @returns {number} 每原子形成焓
 */
export function formationEnthalpy({ energy, composition, references }) {
  if (typeof energy !== 'number' || !Number.isFinite(energy)) {
    throw thermoError('THERMO_INVALID_INPUT', 'energy 必须是有限数')
  }
  const elements = Object.keys(composition ?? {})
  if (elements.length === 0) {
    throw thermoError('THERMO_INVALID_INPUT', 'composition 必须是非空元素计数表')
  }
  const n = elements.reduce((s, el) => {
    const c = composition[el]
    if (!Number.isInteger(c) || c <= 0) {
      throw thermoError('THERMO_INVALID_INPUT', `composition['${el}'] 必须是正整数`)
    }
    return s + c
  }, 0)
  const missing = elements.filter(el => !(el in (references ?? {})))
  if (missing.length > 0) {
    throw thermoError(
      'THERMO_REFERENCE_MISSING',
      `元素 [${missing.join(', ')}] 缺参考态能量：形成焓的能量零点必须显式计算，` +
      '不得静默假设为零',
    )
  }
  const referenceTotal = elements.reduce((s, el) => s + composition[el] * references[el], 0)
  return (energy - referenceTotal) / n
}

/**
 * 二元系凸包（Andrew 单调链，下包络）。
 * @param {Array<{x: number, y: number}>} points x=第二元素摩尔分数，y=每原子能量
 * @returns {{ hull: Array<{x,y}>, hullIndices: number[] }} 按 x 升序；同 x 只留最低点
 */
export function convexHull(points) {
  if (!Array.isArray(points) || points.length < 2) {
    throw thermoError('THERMO_INVALID_INPUT', '凸包至少需要 2 个点（两个元素端点）')
  }
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw thermoError('THERMO_INVALID_INPUT', '凸包点坐标必须是有限数')
    }
  }
  // 同 x 竞争相：只留能量最低者（其余点天然在包上方）
  const byX = new Map()
  points.forEach((p, i) => {
    const cur = byX.get(p.x)
    if (!cur || p.y < cur.p.y) byX.set(p.x, { p, i })
  })
  const sorted = [...byX.values()].sort((a, b) => a.p.x - b.p.x)
  if (sorted.length < 2) {
    throw thermoError('THERMO_INVALID_INPUT', '凸包需要至少两个不同成分（二元系两个端点）')
  }
  // 下凸包（能量包络朝下）：叉积 = z 分量，>0 为“谷”（保留），≤ 0 为“峰”或共线（弹出）
  const stack = []
  for (const item of sorted) {
    while (stack.length >= 2) {
      const a = stack[stack.length - 2]
      const b = stack[stack.length - 1]
      const cross = (b.p.x - a.p.x) * (item.p.y - a.p.y) - (b.p.y - a.p.y) * (item.p.x - a.p.x)
      if (cross <= 0) stack.pop()
      else break
    }
    stack.push(item)
  }
  return {
    hull: stack.map(s => ({ x: s.p.x, y: s.p.y })),
    hullIndices: stack.map(s => s.i),
  }
}

/**
 * 凸包上方能量（稳定性判据：0 = 在包上/热力学基态候选，>0 = 亚稳/不稳定）。
 * @param {{x: number, y: number}} point
 * @param {{hull: Array<{x,y}>}} hullResult convexHull 的返回
 * @returns {number} 相对包络线段的竖直距离（负值钳到 0：数值误差容忍 1e-12）
 */
export function energyAboveHull(point, hullResult) {
  const { hull } = hullResult
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw thermoError('THERMO_INVALID_INPUT', '查询点坐标必须是有限数')
  }
  if (point.x < hull[0].x - 1e-12 || point.x > hull[hull.length - 1].x + 1e-12) {
    throw thermoError(
      'THERMO_OUT_OF_RANGE',
      `查询点 x=${point.x} 超出凸包成分范围 [${hull[0].x}, ${hull[hull.length - 1].x}]`,
    )
  }
  for (let i = 0; i < hull.length - 1; i++) {
    const a = hull[i]
    const b = hull[i + 1]
    if (point.x >= a.x - 1e-12 && point.x <= b.x + 1e-12) {
      const t = b.x === a.x ? 0 : (point.x - a.x) / (b.x - a.x)
      const yLine = a.y + t * (b.y - a.y)
      return Math.max(0, point.y - yLine)
    }
  }
  /* c8 ignore next —— 上面区间覆盖已含端点，理论不可达 */
  throw thermoError('THERMO_OUT_OF_RANGE', '查询点未落入任何凸包区间')
}
