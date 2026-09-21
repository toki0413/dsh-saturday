// plugin-xrd 纯函数层：实测粉末峰位 → 点阵参数最小二乘精修（analysis.xrd.latticeFromPeaks 的算法核）。
//
// 数学：Bragg λ=2d sinθ ⇒ 记 y ≡ 1/d² = (2 sinθ/λ)²。三斜倒易度规 G*（6 个独立元）使
//   y = Hᵀ G* H = h²·G11 + k²·G22 + l²·G33 + 2hk·G12 + 2hl·G13 + 2kl·G23
// 对 G* 的六个分量**线性**，所以精修是一次普通最小二乘（不迭代、无收敛问题、确定性）：
//   法方程 N x = Aᵀy（N = AᵀA，6×6 SPD），走 @toki0413/core/gp 的 cholesky + 三角回代；
//   s² = RSS/(n−p)，参数协方差 cov = N⁻¹·s²（高斯-马尔可夫标准不确定度）。
// 立方约束同一形态：y = m·(1/a²)，m = h²+k²+l²，单参数解析解。
// 由 G* 回到实胞：g = G*⁻¹，取 g 的 Cholesky 因子行矢量为晶胞基矢（a 沿 x、b 落在 xy 平面——
// 与 @toki0413/core/codecs 的 cellFromParams/paramsFromCell 同一标准约定）→ 胞参数与体积。
//
// 不确定度传播：cov(G*) → 胞参数协方差用 G*→params 的有限差分雅可比（数值稳，不必展开长解析式）。
// 同时交付逐峰 2θ 残差（rms/max）与 y 空间 R²。
//
// 诚实边界（随交付呈现，不藏在注释里）：
//  - hkl 指派由调用方给定，本工具**不做指标化**——指派错了会得到自洽但无意义的胞（残差可暴露，不自动纠错）；
//  - 等权最小二乘：不含强度加权、仪器零点误差、样品位移、吸收/透明与 Kα2 剥离；系统误差须标准样校准，
//    这里只处理"已指派峰位 → 点阵参数"的几何部分；
//  - 峰数不足（n ≤ p）或指派几何退化（法方程奇异）显式报错，不给伪解；
//  - 拟合出的 G* 若非正定，则不存在对应实胞，显式拒绝（不硬凑正交胞、不静默截断）。

import { cholesky } from '@toki0413/core/gp'
import { paramsFromCell } from '@toki0413/core/codecs'
import { inv3, det3, xrdError, CU_KA_A } from './xrd.mjs'

const DEG = Math.PI / 180

/** 三斜设计矩阵行：y = [G11,G22,G33,G12,G13,G23]·[h²,k²,l²,2hk,2hl,2kl] */
export function latticeDesign(hkl) {
  const [h, k, l] = hkl
  return [h * h, k * k, l * l, 2 * h * k, 2 * h * l, 2 * k * l]
}

/** 6 参数向量 → 对称 3×3 倒易度规 */
export const gstarMatrix = ([g11, g22, g33, g12, g13, g23]) =>
  [[g11, g12, g13], [g12, g22, g23], [g13, g23, g33]]

/** 观测角 → y = 1/d²（Å⁻²） */
export function yFromTwoTheta(twoThetaDeg, lambdaA) {
  const s = Math.sin(twoThetaDeg * DEG / 2)
  return (2 * s / lambdaA) ** 2
}

// ── 线性代数小件（cholesky 复用 core/gp，这里只做回代与求逆）──
/** L 为下三角（A=LLᵀ）；lower=true 解 L x=b，false 解 Lᵀ x=b */
function solveTri(L, b, lower) {
  const n = L.length, x = new Array(n)
  if (lower) {
    for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * x[k]; x[i] = s / L[i][i] }
  } else {
    for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i] }
  }
  return x
}

/** A = L Lᵀ ⇒ A⁻¹ = BᵀB（B = L⁻¹），逐列回代取 B，再按 (i,j)=Σ_k B[k][i]B[k][j] 组装 */
function invViaCholesky(L) {
  const n = L.length
  const B = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let j = 0; j < n; j++) {
    const e = new Array(n).fill(0); e[j] = 1
    const col = solveTri(L, e, true)
    for (let i = 0; i < n; i++) B[i][j] = col[i]
  }
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) =>
    B.reduce((a, row, k) => a + row[i] * row[j], 0)))
}

/** G*（6 参数）→ 胞参数（度）+ 体积；非正定即显式拒绝 */
export function cellFromGstar(x) {
  const G = gstarMatrix(x)
  let g
  try { g = inv3(G) } catch { throw xrdError('LP_NOT_PHYSICAL_CELL', '拟合出的倒易度规奇异，不存在对应实胞') }
  let L
  try { L = cholesky(g) } catch {
    throw xrdError('LP_NOT_PHYSICAL_CELL', '实空间度规非正定（G* 不正定或数值退化），不硬凑胞参数')
  }
  return { params: paramsFromCell(L), volume: det3(L) }   // L 的行矢量即标准约定下的基矢
}

const PARAM_KEYS = ['a', 'b', 'c', 'alpha', 'beta', 'gamma']

function validatePeaks(peaks) {
  if (!Array.isArray(peaks) || peaks.length === 0) {
    throw xrdError('LP_BAD_PEAKS', 'peaks must be a non-empty array of {twoThetaDeg, hkl:[h,k,l]}')
  }
  for (const [i, p] of peaks.entries()) {
    if (!Number.isFinite(p?.twoThetaDeg) || p.twoThetaDeg <= 0 || p.twoThetaDeg >= 180) {
      throw xrdError('LP_BAD_PEAKS', `peak ${i}: twoThetaDeg must be in (0,180); got ${p?.twoThetaDeg}`)
    }
    const hkl = p.hkl
    if (!Array.isArray(hkl) || hkl.length !== 3 || !hkl.every(v => Number.isInteger(v)) || hkl.every(v => v === 0)) {
      throw xrdError('LP_BAD_HKL', `peak ${i}: hkl must be three integers, not all zero; got ${JSON.stringify(hkl)}`)
    }
  }
}

/**
 * 点阵参数精修。
 * @param {{peaks:{twoThetaDeg:number,hkl:number[]}[], lambdaA?:number, system?:'triclinic'|'cubic'}} opts
 */
export function latticeFromPeaks({ peaks, lambdaA = CU_KA_A, system = 'triclinic' } = {}) {
  validatePeaks(peaks)
  if (!Number.isFinite(lambdaA) || lambdaA <= 0) {
    throw xrdError('LP_BAD_WAVELENGTH', `lambdaA must be a positive finite number (Å); got ${lambdaA}`)
  }
  if (system !== 'triclinic' && system !== 'cubic') {
    throw xrdError('LP_SYSTEM_UNSUPPORTED', `system must be 'triclinic'（6 参数）| 'cubic'（1 参数）；got "${system}"`)
  }

  const y = peaks.map(p => yFromTwoTheta(p.twoThetaDeg, lambdaA))
  const meanY = y.reduce((a, b) => a + b, 0) / y.length
  const tss = y.reduce((a, v) => a + (v - meanY) ** 2, 0)
  const n = peaks.length

  let gstar, gstarCov, cell, cellSigma, volume, p, rss = 0

  if (system === 'cubic') {
    p = 1
    if (n <= p) throw xrdError('LP_UNDERDETERMINED', `cubic 精修需 >1 根峰（n=${n}）`)
    const m = peaks.map(pk => pk.hkl.reduce((a, v) => a + v * v, 0))
    const N = m.reduce((a, v) => a + v * v, 0)
    const x1 = m.reduce((a, v, i) => a + v * y[i], 0) / N
    if (!(x1 > 0)) throw xrdError('LP_NOT_PHYSICAL_CELL', `拟合得到 1/a²=${x1} 非正——峰位与波长或指派不一致`)
    rss = m.reduce((a, v, i) => a + (y[i] - v * x1) ** 2, 0)
    const s2 = rss / (n - p)
    const sigX = Math.sqrt(s2 / N)
    const a = 1 / Math.sqrt(x1)
    gstar = [x1, x1, x1, 0, 0, 0]
    gstarCov = [[s2 / N, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]]
    cell = { a, b: a, c: a, alpha: 90, beta: 90, gamma: 90 }
    const sa = 0.5 * x1 ** -1.5 * sigX                 // a = x^(-1/2) 的解析传播
    cellSigma = { a: sa, b: sa, c: sa, alpha: 0, beta: 0, gamma: 0 }
    volume = a ** 3
  } else {
    p = 6
    if (n <= p) throw xrdError('LP_UNDERDETERMINED', `三斜精修需 >6 根独立峰（n=${n}，p=6；自由度不足则无法估不确定度）`)
    const A = peaks.map(pk => latticeDesign(pk.hkl))
    const N = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => A.reduce((a, r) => a + r[i] * r[j], 0)))
    const rhs = Array.from({ length: p }, (_, i) => A.reduce((a, r, k) => a + r[i] * y[k], 0))
    let L
    try { L = cholesky(N) } catch {
      throw xrdError('LP_DEGENERATE_PEAKS', '法方程奇异：峰指派几何退化（例如只有同一 h²+k²+l² 家族），六参数不可定')
    }
    const Ninv = invViaCholesky(L)
    const x = Ninv.map(row => row.reduce((a, v, i) => a + v * rhs[i], 0))
    rss = y.reduce((a, yi, i) => a + (yi - A[i].reduce((s, v, k) => s + v * x[k], 0)) ** 2, 0)
    const s2 = rss / (n - p)
    gstar = x
    gstarCov = Ninv.map(r => r.map(v => v * s2))
    const derived = cellFromGstar(x)
    cell = derived.params
    volume = derived.volume
    // Σ_cell = J cov(G*) Jᵀ，J 为 G*→胞参数的有限差分雅可比
    const J = PARAM_KEYS.map(() => new Array(p).fill(0))
    for (let k = 0; k < p; k++) {
      const h = Math.max(Math.abs(x[k]) * 1e-6, 1e-12)
      const xp = x.slice(); xp[k] += h
      const pp = cellFromGstar(xp).params
      PARAM_KEYS.forEach((o, i) => { J[i][k] = (pp[o] - cell[o]) / h })
    }
    cellSigma = {}
    PARAM_KEYS.forEach((o, i) => {
      let v = 0
      for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) v += J[i][a] * gstarCov[a][b] * J[i][b]
      cellSigma[o] = Math.sqrt(Math.max(v, 0))
    })
  }

  const gstarSigma = gstarCov.map((row, i) => Math.sqrt(Math.max(row[i], 0)))
  const perPeak = peaks.map((pk, i) => {
    const hy = latticeDesign(pk.hkl).reduce((s, v, k) => s + v * gstar[k], 0)
    const out = { hkl: pk.hkl, twoThetaDeg: pk.twoThetaDeg, yObs: y[i] }
    const arg = hy > 0 ? lambdaA * Math.sqrt(hy) / 2 : Infinity      // = λ/(2d)
    if (arg <= 1) {
      const calc = 2 * Math.asin(arg) / DEG
      out.twoThetaCalcDeg = calc
      out.deltaDeg = pk.twoThetaDeg - calc
    } else out.unreachable = true      // 该波长下此面不可反射（指派/波长不一致的信号）
    return out
  })
  const abs = perPeak.filter(r => Number.isFinite(r.deltaDeg)).map(r => Math.abs(r.deltaDeg))
  const dof = n - p

  return {
    system, lambdaA, nPeaks: n, nParams: p,
    cell, cellSigma, volume_A3: volume,
    reciprocalMetric: gstar, reciprocalMetricSigma: gstarSigma,
    residualsDeg: {
      rms: abs.length ? Math.sqrt(abs.reduce((a, v) => a + v * v, 0) / abs.length) : null,
      max: abs.length ? Math.max(...abs) : null,
      nReported: abs.length, nUnreachable: perPeak.filter(r => r.unreachable).length,
    },
    goodness: { rss, dof, r2: tss > 0 ? 1 - rss / tss : 1 },
    perPeak,
    units: { length: 'Å', angle: 'deg', y: 'Å⁻²' },
    declaration: '等权最小二乘（不依强度加权）；未含仪器零点/样品位移/吸收/Kα2 剥离等系统误差，'
      + '标准样校准不在本工具内。hkl 指派由调用方给定，本法不自动指标化——错指派可由残差暴露但不被纠正。'
      + (system === 'cubic'
        ? '立方约束：b=a、c=a、三角固定 90°，其 σ=0 是约束值而非独立测量；仅 1/a² 一个自由参数。'
        : '三斜六参数：G* 非正定即拒绝，不硬凑胞；峰数需 >6 才有自由度估 σ。'),
    note: '1/d²=(2sinθ/λ)² 对三斜倒易度规 G* 的六个独立元线性，故精修为一次法方程求解'
      + '（cholesky 走 core/gp，回代与求逆在本模块）；σ 为高斯-马尔可夫标准不确定度并经有限差分雅可比传播到胞参数',
  }
}
