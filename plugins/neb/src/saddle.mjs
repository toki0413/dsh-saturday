// plugin-neb 纯函数层：鞍点搜索（Quick-Min-Max 方向 + trust region + index 核验）。
//
// 为什么不是 dimer、也不是修正牛顿：packages/bridge/docs/experiments/neb-optimizer-trials.md
// 与本轮诊断给出三条实测理由——
//  ① 半坡上"最软模"（用旋转猜出来的）与反应坐标差 83°，dimer 沿它上坡必然走偏；
//  ② 这个面存在 ‖∇E‖→0 的"逃向无穷远"通道（阱底 −1.27 < 鞍点 −0.126 < 无穷远 0），
//     无约束的 ‖g‖ 下降法会沿 x 逃走（实测 |x| 到 7.4~131 而 |g|~1e-12），所以必须有 trust region；
//  ③ λ 移位牛顿方向在 index-1 附近不是 ‖g‖² 的下坡方向，加 ‖g‖² 线搜索会在第 0 步全拒。
// 本模块因此用 QMM 方向（沿最小特征向量上坡、其余方向下坡）+ 步长受控 + 区域约束，
// 且软模直接取 Hessian 的最小特征向量（core/eig 的对称分解），不靠旋转去猜。
//
// 收敛判据是三件事，缺一不可，且分开报：
//   ‖∇E‖ < gtol（驻点）+ 恰有一个负特征值（index-1）+ 未越出 trust region；
// 收敛到极小（零个负特征值）不报成功——这正是上一轮五个方案里最容易被掩盖的失败形态。
//
// 验收基准用闭式可判的解析四次双阱 E = c(x⁴+y⁴) + x² − y²：鞍点精确 (0,0)、E=0、
// Hessian 精确 diag(2,−2)（四次项在原点不贡献二阶导），两极小精确 (0, ±1/√(2c))、
// E=−1/(4c)，势垒闭式 1/(4c)。Müller-Brown 曾考虑但放弃：本轮检索未取到可靠出处，
// 不凭记忆写系数与参考值。

import { symmetricEigendecomposition } from '@toki0413/core/eig'
import { analysisError, quench } from './neb.mjs'

export const SADDLE_DEFAULTS = Object.freeze({
  gtol: 1e-8, hessianStep: 1e-4,
  s0: 0.1, sMin: 1e-9, sMax: 0.5, alpha: 1.15, beta: 0.5,
  maxSteps: 400, radius: 1.5, backtracks: 40,
})

const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0)
const norm = (a) => Math.sqrt(dot(a, a))
const unit = (a) => { const n = norm(a); return n > 0 ? a.map(v => v / n) : null }

/**
 * 解析四次双阱（闭式验收基准）。
 * E = c(x⁴+y⁴) + x² − y² ⇒ ∇E = (4cx³+2x, 4cy³−2y)，H = diag(12cx²+2, 12cy²−2)
 * 鞍点 (0,0)：E=0、H=diag(2,−2)；极小 (0,±1/√(2c))：E=−1/(4c)。
 */
export const QUARTIC_DOUBLE_WELL_DEFAULTS = Object.freeze({ c: 1 })

export function quarticDoubleWell(opts = {}) {
  const { c } = { ...QUARTIC_DOUBLE_WELL_DEFAULTS, ...opts }
  if (!Number.isFinite(c) || c <= 0) throw analysisError('SADDLE_BAD_INPUT', `c 必须是正有限数；got ${c}`)
  const y0 = Math.sqrt(1 / (2 * c))
  return {
    dims: 2, c,
    energy: ([x, y]) => c * (x ** 4 + y ** 4) + x * x - y * y,
    gradient: ([x, y]) => [4 * c * x ** 3 + 2 * x, 4 * c * y ** 3 - 2 * y],
    hessian: ([x, y]) => [[12 * c * x * x + 2, 0], [0, 12 * c * y * y - 2]],
    saddleExact: [0, 0], minimaExact: [[0, y0], [0, -y0]], barrierExact: 1 / (4 * c),
    note: `闭式基准：鞍点 (0,0) E=0、H=diag(2,−2)；极小 (0,±${y0.toFixed(6)}) E=${(-1 / (4 * c)).toFixed(6)}；势垒 1/(4c)=${(1 / (4 * c)).toFixed(6)}`,
  }
}

/** 中心差分 Hessian（只用 gradient callable），对称化 */
export function finiteDifferenceHessian(gradient, x, h) {
  const n = x.length
  const H = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let j = 0; j < n; j++) {
    const gp = gradient(x.map((v, i) => v + (i === j ? h : 0)))
    const gm = gradient(x.map((v, i) => v - (i === j ? h : 0)))
    for (let i = 0; i < n; i++) H[i][j] = (gp[i] - gm[i]) / (2 * h)
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const v = 0.5 * (H[i][j] + H[j][i]); H[i][j] = v; H[j][i] = v
  }
  return H
}

/**
 * QMM 鞍点搜索。
 * @param {{energy:Function, gradient:Function, hessian?:Function, start:number[], opts?:object}} a
 */
export function saddleSearch({ energy, gradient, hessian, start, opts = {} } = {}) {
  if (typeof energy !== 'function' || typeof gradient !== 'function') {
    throw analysisError('ANALYSIS_INPUT_MISSING', 'saddleSearch requires pointwise energy() and gradient() callables')
  }
  if (!Array.isArray(start) || start.length < 2 || start.some(v => !Number.isFinite(v))) {
    throw analysisError('SADDLE_BAD_INPUT', 'start must be >=2 finite coordinates')
  }
  const p = { ...SADDLE_DEFAULTS, ...opts }
  if (hessian != null && typeof hessian !== 'function') throw analysisError('SADDLE_BAD_INPUT', 'hessian 必须是 callable 或省略')
  for (const k of ['gtol', 'hessianStep', 's0', 'sMin', 'sMax', 'radius']) {
    if (!Number.isFinite(p[k]) || p[k] <= 0) throw analysisError('SADDLE_BAD_INPUT', `saddle.${k} must be a positive finite number; got ${p[k]}`)
  }
  if (!(p.alpha > 1) || !(p.beta > 0 && p.beta < 1)) {
    throw analysisError('SADDLE_BAD_INPUT', `需 alpha>1 且 0<beta<1；got alpha=${p.alpha} beta=${p.beta}`)
  }
  for (const k of ['maxSteps', 'backtracks']) {
    if (!Number.isInteger(p[k]) || p[k] < 1) throw analysisError('SADDLE_BAD_INPUT', `saddle.${k} must be an integer >= 1; got ${p[k]}`)
  }
  const dims = start.length
  const x0 = [...start]

  let evals = 0
  const gOf = (y) => { evals++; const g = gradient(y); if (!Array.isArray(g) || g.length !== dims || g.some(v => !Number.isFinite(v))) throw analysisError('SADDLE_BAD_GRADIENT', 'gradient() 返回非有限或长度不符'); return g }
  const eOf = (y) => { evals++; const e = energy(y); if (!Number.isFinite(e)) throw analysisError('SADDLE_BAD_ENERGY', `energy() 返回非有限值 ${e}`); return e }
  // FD 路线的梯度求值也必须计入代价，否则省略 hessian 时会低估 energyGradientEvals
  const hess = hessian ?? ((y) => finiteDifferenceHessian(gOf, y, p.hessianStep))

  let x = [...x0], s = p.s0, prevDir = null, nSteps = 0
  let reason = 'maxSteps', gnorm = Infinity, eig = null, soft = null, negCount = null
  const history = []

  for (nSteps = 0; nSteps < p.maxSteps; nSteps++) {
    const g = gOf(x)
    gnorm = norm(g)
    const { values, vectors } = symmetricEigendecomposition(hess(x))
    eig = values; soft = vectors[0]; negCount = values.filter(v => v < 0).length
    if (nSteps % 20 === 0) history.push({ step: nSteps, gradNorm: gnorm, lambdaMin: values[0], stepSize: +s.toPrecision(6) })
    if (gnorm < p.gtol) {
      reason = negCount === 1 ? 'converged-index1'
        : negCount === 0 ? 'converged-to-minimum-not-saddle'
          : `converged-index-${negCount}-not-1`
      break
    }
    // QMM 方向：沿软模上坡、其余方向下坡   F_eff = −∇E + 2(ĉ·∇E)ĉ
    const gp = dot(soft, g)
    const fEff = g.map((v, i) => -v + 2 * gp * soft[i])
    const dir = unit(fEff)
    if (!dir) { reason = 'degenerate-effective-force'; break }
    if (prevDir) s = dot(prevDir, dir) > 0 ? Math.min(s * p.alpha, p.sMax) : Math.max(s * p.beta, p.sMin)

    let moved = false
    for (let k = 0; k < p.backtracks && !moved; k++) {
      const trial = x.map((v, i) => v + s * dir[i])
      if (norm(trial.map((v, i) => v - x0[i])) > p.radius) { s = Math.max(s * p.beta, p.sMin); continue }
      if (norm(gOf(trial)) < gnorm) { x = trial; moved = true } else s = Math.max(s * p.beta, p.sMin)
    }
    if (!moved) { reason = 'stalled-in-trust-region'; break }
    if (s <= p.sMin * 1.001) { reason = 'stepCollapse'; break }
    prevDir = dir
  }
  if (nSteps >= p.maxSteps && reason === 'maxSteps') reason = 'maxSteps-reached'

  const E = eOf(x)
  const finalG = gOf(x)
  const finalNorm = norm(finalG)
  const { values, vectors } = symmetricEigendecomposition(hess(x))
  const negFinal = values.filter(v => v < 0).length
  const converged = reason === 'converged-index1'
  const softFinal = vectors[0]

  // 势垒：从驻点沿 ±软模下坡 quench 到两侧极小（独立判据之外的产物）
  let barriers = null
  if (converged) {
    const eps = Math.max(p.hessianStep, 1e-3)
    const down = (sgn) => {
      const q = quench({ x0: x.map((v, i) => v + sgn * eps * softFinal[i]), energy, gradient })
      return { x: q.x, energy: q.energy, converged: q.converged }
    }
    const plus = down(1), minus = down(-1)
    barriers = {
      forward: E - Math.min(plus.energy, minus.energy),
      bothSidesQuenched: plus.converged && minus.converged,
      minima: [plus.x, minus.x],
      distinctMinima: norm(plus.x.map((v, i) => v - minus.x[i])) > 1e-6,
    }
  }
  history.push({ step: nSteps, gradNorm: finalNorm, lambdaMin: values[0], stepSize: +s.toPrecision(6) })

  return {
    x, energy: E, gradNorm: finalNorm,
    eigenvalues: values, negativeCount: negFinal, softMode: softFinal,
    converged, reason, nSteps, energyGradientEvals: evals,
    trustRadius: p.radius, stepSize: s, gtol: p.gtol, history,
    indexVerified: converged && negFinal === 1,
    barriers,
    costNote: 'energyGradientEvals 计入 energy/gradient 的全部求值（包括 FD Hessian 与回溯试探、'
      + '以及收敛后沿软模下坡 quench 的求值），不是“用户模型求值”的下界',
    report: {
      converged, reason,
      stationary: finalNorm < p.gtol,
      indexOne: negFinal === 1,
      insideTrustRegion: norm(x.map((v, i) => v - x0[i])) <= p.radius * 1.000001,
      note: '成功需三条同时成立：‖∇E‖<gtol、恰一个负特征值、未越出 trust region。'
        + '收敛到极小（零负特征值）按失败报，不当鞍点交付。',
    },
    note: 'QMM 方向（软模上坡、其余下坡）+ 步长受控 + 区域约束；软模取 Hessian 最小特征向量'
      + '（core/eig 对称分解），非旋转猜测。找的是离初值最近的 index-1 鞍点，不承诺全局最低势垒。',
  }
}
