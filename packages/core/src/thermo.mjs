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

// ── 多组分推广（第 1.5 档）：成分空间维度 d = 元素数 − 1 ─────────────
// 机制：穷举 ≤ d+1 点的子集构造仿射单形（simplex）下包络——每个子集若重心坐标可解且全非负，
// 即定义一片包络；能量包络 = 各单形插值的最小值。**显式穷举是 v0 诚实选择**：
// 组合上限显式门禁（超限报 THERMO_TOO_MANY_COMBINATIONS，不静默换近似算法）；
// 每端点（纯元素）必须显式在场，缺失即成分空间不完整，不外推不静默。
// 二元（d=1）时与上方 convexHull/energyAboveHull 数值一致（测试对账）。
// 坐标约定：成分以分数计数表给出（如 { Cu: 0.5, Ni: 0.25, Zn: 0.25 }，和必须为 1），
// 内部取前 d 个元素为独立坐标（字典序固定，确定性）。

/** 凸包子集枚举上限（C(n, ≤ d+1)，诚实声明：超限请用分块/降维策略，不在本函数内静默近似） */
export const MULTI_HULL_MAX_SUBSETS = 50000

function compositionToVector(composition, elements, what) {
  const total = elements.reduce((s, el) => s + (composition[el] ?? 0), 0)
  if (!Number.isFinite(total) || Math.abs(total - 1) > 1e-9) {
    throw thermoError('THERMO_INVALID_INPUT', `${what} 的成分必须是归一分数（和 = 1）`)
  }
  for (const el of elements) {
    const f = composition[el] ?? 0
    if (!Number.isFinite(f) || f < -1e-12) {
      throw thermoError('THERMO_INVALID_INPUT', `${what} 的成分分数必须是有限非负数`)
    }
  }
  return elements.map(el => composition[el] ?? 0)
}

function solveLinear(A, b) {
  // 高斯消元（部分主元）；奇异返回 null（该子集不构成单形）
  const n = A.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null
    if (pivot !== col) [M[pivot], M[col]] = [M[col], M[pivot]]
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = M[r][col] / M[col][col]
      if (f === 0) continue
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]
    }
  }
  // 回代：第 col 行主元在列 col（前面列已被消为 0），x[col] = M[col][n] / M[col][col]
  return Array.from({ length: n }, (_, col) => M[col][n] / M[col][col])
}

/**
 * 多组分凸包（成分空间下包络，显式穷举单形）。
 * @param {Array<{composition: Object<string, number>, energy: number}>} points
 *        成分为归一分数计数表；能量为每原子（严格形成焓空间）
 * @returns {{ d, elements, vertices, simplices, nSubsets }}
 *          vertices：包上点（索引 + 成分 + 能量）；simplices：单形的原索引列表；
 *          nSubsets：实际枚举的子集数（诚实量，随结果呈现）
 */
export function multiConvexHull(points) {
  if (!Array.isArray(points) || points.length === 0) {
    throw thermoError('THERMO_INVALID_INPUT', '多组分凸包至少需要 1 个点')
  }
  const elementSet = new Set()
  for (const p of points) {
    if (!Number.isFinite(p.energy)) {
      throw thermoError('THERMO_INVALID_INPUT', '凸包点能量必须是有限数')
    }
    for (const [el, f] of Object.entries(p.composition ?? {})) {
      if (!Number.isFinite(f)) throw thermoError('THERMO_INVALID_INPUT', `成分分数 '${el}' 必须是有限数`)
      if (f > 1e-12) elementSet.add(el)
    }
  }
  const elements = [...elementSet].sort()
  const d = elements.length - 1
  if (d < 1) {
    throw thermoError('THERMO_INVALID_INPUT', '凸包至少需要两个元素（单元素无成分空间）')
  }
  if (elements.length > 8) {
    throw thermoError('THERMO_OUT_OF_RANGE', `元素数 ${elements.length} 超出 v0 支持上限 8（组合爆炸诚实门禁）`)
  }
  const vectors = points.map((p, i) => compositionToVector(p.composition, elements, `点 ${i}`))
  // 端点显式在场：每个元素必须有纯元素点（除该元素外分数全零）
  for (const el of elements) {
    const present = points.some((p, i) => {
      const v = vectors[i]
      const othersZero = elements.every((el2, k) => el2 === el || v[k] < 1e-9)
      return othersZero && (p.composition[el] ?? 0) > 1 - 1e-9
    })
    if (!present) {
      throw thermoError(
        'THERMO_REFERENCE_MISSING',
        `元素 ${el} 的端点缺失：成分空间不完整，不外推不静默（延续第一档零点显式纪律）`,
      )
    }
  }
  // 子集枚举门禁（诚实声明组合规模：只枚举 d-单形，即 d+1 点子集）
  const n = points.length
  const nSubsets = comb(n, d + 1)
  if (nSubsets > MULTI_HULL_MAX_SUBSETS) {
    throw thermoError(
      'THERMO_TOO_MANY_COMBINATIONS',
      `单形枚举 ${nSubsets} 超过上限 ${MULTI_HULL_MAX_SUBSETS}：` +
      '请分块或降维，不在本函数内静默换近似算法',
    )
  }
  if (nSubsets < 1) {
    throw thermoError('THERMO_INVALID_INPUT', `点数 ${n} 不足以构成 ${d} 维单形（需 ≥ ${d + 1} 点）`)
  }
  // 穷举 d-单形：d+1 个仿射无关顶点定义一片仿射包络（奇异子集跳过）。
  // 未知数 λ（d+1 个）：前 d 行为坐标方程 Σⱼ λⱼ xⱼᵢ = qᵢ，末行归一化 Σ λ = 1 → 方阵。
  const idx = Array.from({ length: n }, (_, i) => i)
  const buildSimplex = (subset) => {
    const M = []
    for (let i = 0; i < d; i++) M.push(subset.map(j => vectors[j][i]))
    M.push(new Array(d + 1).fill(1))
    const B = subset.map(j => points[j].energy)
    // 非退化 ⇔ 方阵可解（单形顶点仿射无关）；任意右端探测即可。
    const probe = solveLinear(M, [...new Array(d).fill(0), 1])
    if (!probe || !probe.every(Number.isFinite)) return null
    return { subset, M, B }
  }
  const allSimplices = []
  for (const subset of combinations(idx, d + 1)) {
    const s = buildSimplex(subset)
    if (s) allSimplices.push(s)
  }
  // 包上点：无任何单形的插值在其下方（严格判定，容忍 1e-9）
  const vertexIndices = []
  for (let i = 0; i < n; i++) {
    const qv = vectors[i].slice(0, d)
    let below = false
    for (const s of allSimplices) {
      const lambda = solveLinear(s.M, [...qv, 1])
      if (!lambda || lambda.some(l => !Number.isFinite(l) || l < -1e-9)) continue
      const interp = lambda.reduce((acc, l, r) => acc + l * s.B[r], 0)
      if (interp < points[i].energy - 1e-9) { below = true; break }
    }
    if (!below) vertexIndices.push(i)
  }
  // 包络单形只用包上点构造：含包外点的单形会把包络抬到包外点自身（查询与输入点重合时距离恒 0），
  // 这是“包外点不得参与包络”的几何要求，与二元实现（先构包再查询）对齐。
  const simplices = []
  for (const subset of combinations(vertexIndices, d + 1)) {
    const s = buildSimplex(subset)
    if (s) simplices.push(s)
  }
  const vertices = vertexIndices.map(i => ({ index: i, composition: points[i].composition, energy: points[i].energy }))
  return {
    d,
    elements,
    vertices,
    simplices: simplices.map(s => s.subset),
    nSubsets,
    _internals: { vectors, simplexData: simplices }, // 供 energyAboveHullMulti 复用，不承诺稳定形状
  }
}

function comb(n, k) {
  if (k < 0 || k > n) return 0
  let r = 1
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1)
  return Math.round(r)
}

function* combinations(items, k) {
  const n = items.length
  if (k === 0) { yield []; return }
  for (let i = 0; i <= n - k; i++) {
    for (const rest of combinations(items.slice(i + 1), k - 1)) {
      yield [items[i], ...rest]
    }
  }
}

/**
 * 多组分凸包上方能量：查询点相对单形下包络的竖直距离。
 * @param {{composition: Object<string, number>, energy: number}} query 归一分数成分 + 每原子能量
 * @param {ReturnType<typeof multiConvexHull>} hullResult
 * @returns {number} ≥0；在包上（含数值容忍 1e-12）钳为 0；包内点插值无解时显式报错不外推
 */
export function energyAboveHullMulti(query, hullResult) {
  const { elements, _internals } = hullResult
  const d = hullResult.d
  if (!Number.isFinite(query.energy)) {
    throw thermoError('THERMO_INVALID_INPUT', '查询点能量必须是有限数')
  }
  const qv = compositionToVector(query.composition, elements, '查询点')
  const qd = qv.slice(0, d)
  let envelope = Infinity // 下包络 = 各单形插值的最小值（先取小再算距离）
  let anyInside = false
  for (const s of _internals.simplexData) {
    const lambda = solveLinear(s.M, [...qd, 1])
    if (!lambda || lambda.some(l => !Number.isFinite(l) || l < -1e-9)) continue
    anyInside = true
    const interp = lambda.reduce((acc, l, r) => acc + l * s.B[r], 0)
    if (interp < envelope) envelope = interp
  }
  if (!anyInside) {
    throw thermoError('THERMO_OUT_OF_RANGE',
      `查询点成分 {${Object.entries(query.composition).map(([k, v]) => `${k}:${v}`).join(', ')}} 不在凸包成分空间内，不外推`)
  }
  return Math.max(0, query.energy - envelope)
}
