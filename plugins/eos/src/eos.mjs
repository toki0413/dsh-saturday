// EOS（状态方程拟合）纯函数层 —— 契约 §4.4 analysis seam 第二个实证。
// 三阶 Birch-Murnaghan：E(V) = E0 + (9·V0·B0/16)·{ B0′·ξ³ + ξ²·(6 − 4·(V0/V)^(2/3)) }，
// ξ = (V0/V)^(2/3) − 1。四参数 {E0, V0, B0, B0′} 用 Levenberg-Marquardt
// （数值 Jacobian，n×n Gauss-Jordan）拟合——确定性，无随机重启。
// 数值要点（两条）：
// - JᵀJ 对角跨 8 个数量级（E0/V0/B0/B0′ 量级悬殊），必须在参数缩放空间求解；
// - 模型失配或达机器精度时梯度停在小非零平台，收敛判据需绝对阈值+停滞检测，
//    纯步长判据（如 step < 1e-12）在缩放空间永远达不到。
// 分层纪律与 §4.3/§4.4 一致：拟合逻辑纯函数，(V, E) 序列由调用方提供；
// 本模块不触碰引擎，不知道数据来自哪个 provider。

export function analysisError(code, message) {
  const e = new Error(`${message} (${code})`)
  e.code = code
  return e
}

/** 三阶 Birch-Murnaghan 能量（eV），V 单位 Å³，B0 单位 eV/Å³ */
export function birchMurnaghan(V, { E0, V0, B0, B0p }) {
  const eta = (V0 / V) ** (2 / 3)
  const xi = eta - 1
  return E0 + ((9 * V0 * B0) / 16) * (B0p * xi ** 3 + xi ** 2 * (6 - 4 * eta))
}

/**
 * Vinet（普适）状态方程，E(V0)=E0；四参数 {E0,V0,B0,B0p}，B0 单位 eV/Å³。
 * 由 P(V)=3B0(1−x)/x²·exp[η(1−x)]、η=1.5(B0p−1)、E=E0−∫P dV 积分得：
 *   E = E0 + (9·B0·V0/η²)·[ 1 − (1 − η·s)·exp(η·s) ]，s = 1 − (V/V0)^(1/3)。
 * V0 处二阶导满 V0·d²E/dV²=B0（已由测固定）。宽体积域常比 BM 拟合更稳。
 */
export function vinet(V, { E0, V0, B0, B0p }) {
  const eta = 1.5 * (B0p - 1)
  const s = 1 - (V / V0) ** (1 / 3)
  return E0 + (9 * B0 * V0 / (eta * eta)) * (1 - (1 - eta * s) * Math.exp(eta * s))
}

/** eV/Å³ → GPa */
export const EV_PER_A3_TO_GPA = 160.21766208

/** 晶胞体积：|det(cell)|，cell 为 3×3 行向量 */
export function cellVolume(cell) {
  const [[a1, a2, a3], [b1, b2, b3], [c1, c2, c3]] = cell
  const det =
    a1 * (b2 * c3 - b3 * c2) -
    a2 * (b1 * c3 - b3 * c1) +
    a3 * (b1 * c2 - b2 * c1)
  return Math.abs(det)
}

// ── n×n 线性求解（Gauss-Jordan + 列主元，确定性）────────────────
// 主元阈值相对矩阵自身尺度设定：法方程范数趋零（接近最优）时不误判奇异。

function solveLinear(A, b) {
  const n = A.length
  const M = A.map((row, i) => [...row, b[i]])
  const diagMax = Math.max(...A.map((row, i) => Math.abs(row[i])), 1e-300)
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    if (Math.abs(M[piv][col]) < 1e-12 * diagMax) return null
    if (piv !== col) [M[col], M[piv]] = [M[piv], M[col]]
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = M[r][col] / M[col][col]
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]
    }
  }
  // row 已是 M[i]（消元后只剩对角元）：对角线在 row[i]，增广列在 row[n]
  return M.map((row, i) => row[n] / row[i])
}

// ── 初猜：能量最低点 + 三点抛物线曲率 ──────────────────────────

function initialGuess(series) {
  const sorted = [...series].sort((a, b) => a.volume - b.volume)
  let iMin = 0
  for (let i = 1; i < sorted.length; i++) if (sorted[i].energy < sorted[iMin].energy) iMin = i
  const E0 = sorted[iMin].energy
  const V0 = sorted[iMin].volume

  // 三点抛物线：E ≈ a(V−V0)² + E0 → B0 = V0·d²E/dV² = 2a·V0
  let B0 = 1.0
  if (iMin > 0 && iMin < sorted.length - 1) {
    const [p, q, r] = [sorted[iMin - 1], sorted[iMin], sorted[iMin + 1]]
    const denom =
      (p.volume - q.volume) * (p.volume - r.volume) * (q.volume - r.volume)
    if (Math.abs(denom) > 1e-12) {
      const a =
        (r.volume * (q.energy - p.energy) +
          q.volume * (p.energy - r.energy) +
          p.volume * (r.energy - q.energy)) /
        denom
      if (Number.isFinite(a) && a > 0) B0 = 2 * a * V0
    }
  }
  if (!(B0 > 0) || !Number.isFinite(B0)) B0 = 1.0
  return { E0, V0, B0, B0p: 4 }   // B0′ = 4 是常见初值（常见区间 4–6）
}

/**
 * 拟合 (V, E) 序列到三阶 Birch-Murnaghan。
 * 四参数 {E0, V0, B0, B0′} 联合辨识；窄体积范围下 B0 与 B0′ 强相关，
 * 拟合质量由 rmse/r² 如实报告。
 * @param {Array<{volume: number, energy: number}>} series 至少 4 点（4 参数）
 * @param {{B0p0?: number, maxIterations?: number, tol?: number}} options B0p0 为 B0′ 初值
 * @returns {{converged, params: {E0,V0,B0,B0p}, B0GPa, rmse, r2, nPoints, nIterations}}
 */
/**
 * 拟合 (V,E) 序列到任意四参数 EOS 模型（共享 Levenberg-Marquardt 核）。
 * @param {Array<{volume,energy}>} series 至少 4 点
 * @param {(V:number,p:{E0,V0,B0,B0p})=>number} model 能量模型（birchMurnaghan / vinet）
 * @param {{B0p0?:number,maxIterations?:number,tol?:number}} options
 */
export function fitEOS(series, model, { B0p0 = 4, maxIterations = 300, tol = 1e-12 } = {}) {
  if (!Number.isFinite(B0p0)) {
    throw analysisError('EOS_BAD_POINT', `B0p0 must be a finite number; got ${B0p0}`)
  }
  if (!Array.isArray(series) || series.length < 4) {
    throw analysisError('EOS_UNDERDETERMINED',
      `EOS fit requires at least 4 (V, E) points for 4 parameters; got ${series?.length ?? 0}`)
  }
  for (const [i, p] of series.entries()) {
    if (!Number.isFinite(p?.volume) || !(p.volume > 0)) {
      throw analysisError('EOS_BAD_POINT', `point ${i}: volume must be a positive finite number`)
    }
    if (!Number.isFinite(p?.energy)) {
      throw analysisError('EOS_BAD_POINT', `point ${i}: energy must be finite`)
    }
  }

  const Vs = series.map(p => p.volume)
  const Es = series.map(p => p.energy)
  const eMean = Es.reduce((s, e) => s + e, 0) / Es.length
  const ssTot = Es.reduce((s, e) => s + (e - eMean) ** 2, 0)

  const g = initialGuess(series)
  let params = [g.E0, g.V0, g.B0, B0p0]
  const scale = params.map(p => Math.max(Math.abs(p), 1e-8))

  const residuals = (prm) => Vs.map((V, i) =>
    model(V, { E0: prm[0], V0: prm[1], B0: prm[2], B0p: prm[3] }) - Es[i])
  const sse = (r) => r.reduce((s, x) => s + x * x, 0)

  let r = residuals(params)
  let best = sse(r)
  let lambda = 1e-3
  let converged = false
  let nIterations = 0
  let prevGrad = Infinity
  let gradStalls = 0

  for (; nIterations < maxIterations; nIterations++) {
    const J = Vs.map(() => new Array(4).fill(0))
    for (let k = 0; k < 4; k++) {
      const h = Math.max(Math.abs(params[k]) * 1e-6, 1e-8)
      const pp = [...params]; pp[k] += h
      const pm = [...params]; pm[k] -= h
      const rp = residuals(pp), rm = residuals(pm)
      for (let i = 0; i < Vs.length; i++) J[i][k] = ((rp[i] - rm[i]) / (2 * h)) * scale[k]
    }
    const JtJ = Array.from({ length: 4 }, () => new Array(4).fill(0))
    const Jtr = new Array(4).fill(0)
    for (let i = 0; i < Vs.length; i++) {
      for (let a = 0; a < 4; a++) {
        Jtr[a] += J[i][a] * r[i]
        for (let b = 0; b < 4; b++) JtJ[a][b] += J[i][a] * J[i][b]
      }
    }
    const gradNorm = Math.hypot(...Jtr)
    if (gradNorm >= prevGrad) gradStalls++
    else gradStalls = 0
    prevGrad = gradNorm
    if (gradNorm < 1e-10 || gradStalls >= 3) { converged = true; break }
    const delta = solveLinear(
      JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) : v))),
      Jtr.map(x => -x),
    )
    if (!delta || delta.some(d => !Number.isFinite(d))) {
      lambda *= 10
      if (lambda > 1e12) break
      continue
    }
    const cand = params.map((p, k) => p + delta[k] * scale[k])
    if (!(cand[1] > 0) || !(cand[2] > 0)) {
      lambda *= 10
      if (lambda > 1e12) break
      continue
    }
    const rc = residuals(cand)
    const sc = sse(rc)
    if (sc < best) {
      params = cand; r = rc; best = sc
      lambda = Math.max(lambda * 0.5, 1e-10)
      const step = Math.max(...delta.map(Math.abs))
      if (step < tol) { converged = true; break }
    } else {
      lambda *= 10
      if (lambda > 1e12) break
    }
  }

  const rmse = Math.sqrt(best / Vs.length)
  return {
    converged,
    nIterations,
    params: { E0: params[0], V0: params[1], B0: params[2], B0p: params[3] },
    B0GPa: params[2] * EV_PER_A3_TO_GPA,
    rmse,
    r2: ssTot > 0 ? 1 - best / ssTot : 1,
    nPoints: series.length,
  }
}

/**
 * 拟合 (V, E) 序列到三阶 Birch-Murnaghan（fitEOS 的 BM 特化）。
 */
export function fitBirchMurnaghan(series, options = {}) {
  return fitEOS(series, birchMurnaghan, options)
}

/** 拟合 (V, E) 序列到 Vinet 状态方程（fitEOS 的 Vinet 特化）。 */
export function fitVinet(series, options = {}) {
  return fitEOS(series, vinet, options)
}
