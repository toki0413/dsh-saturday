// NEB（Nudged Elastic Band）纯函数层 —— 契约 §4.4 analysis seam 的首个实证。
// 分层纪律与 §4.3 一致：分析逻辑保持纯函数，能量与梯度以注入 callable 进入
// （逐点 U，引擎无关），本模块不自带任何势。ljDoubleWell 是内置玩具体系：
// 一个可动吸附原子在两个固定吸附位之间的跳跃，y/z 方向谐波束缚模拟表面
// 束缚——双阱对称，鞍点由对称性恰在原点（便于独立测试 oracle）。
// 切向取 Henkelman-Uberuaga（2000）能量加权平分，避免鞍点附近切向翻转震荡。

export function analysisError(code, message) {
  const e = new Error(`${message} (${code})`)
  e.code = code
  return e
}

/** 像元间距摘要用的小统计量（min/max/mean） */
function stats(xs) {
  if (!xs.length) return { min: null, max: null, mean: null }
  return { min: Math.min(...xs), max: Math.max(...xs), mean: xs.reduce((a, b) => a + b, 0) / xs.length }
}

// ── LJ 双阱玩具体系 ──────────────────────────────────────────────
// E(x) = Σ_S LJ(|x − S|) + k(y² + z²)/2，S ∈ {−d/2, +d/2} 为固定吸附位。
// 默认 d = 4σ：阱心约在 ±(d/2 − 2^(1/6)σ)，鞍点在（对称）原点。

export const LJ_DOUBLE_WELL_DEFAULTS = Object.freeze({
  epsilon: 1, sigma: 1, separation: 4, confinementK: 0.5, cutoff: 6,
})

export function ljDoubleWell(opts = {}) {
  const { epsilon, sigma, separation, confinementK, cutoff } =
    { ...LJ_DOUBLE_WELL_DEFAULTS, ...opts }
  const ax = separation / 2
  const sites = [[-ax, 0, 0], [ax, 0, 0]]
  const r2cut = cutoff * cutoff

  const pairEnergy = (r2) => {
    if (r2 >= r2cut) return 0
    const s2 = (sigma * sigma) / r2
    const s6 = s2 * s2 * s2
    return 4 * epsilon * (s6 * s6 - s6)
  }
  // dE/dx_j = coeff · (x_j − site_j)
  const pairCoeff = (r2) => {
    if (r2 >= r2cut) return 0
    const s2 = (sigma * sigma) / r2
    const s6 = s2 * s2 * s2
    return (4 * epsilon * (-12 * s6 * s6 + 6 * s6)) / r2
  }

  const energy = (x) => {
    let e = 0.5 * confinementK * (x[1] * x[1] + x[2] * x[2])
    for (const s of sites) {
      const dx = x[0] - s[0], dy = x[1] - s[1], dz = x[2] - s[2]
      e += pairEnergy(dx * dx + dy * dy + dz * dz)
    }
    return e
  }

  const gradient = (x) => {
    const g = [0, confinementK * x[1], confinementK * x[2]]
    for (const s of sites) {
      const dx = x[0] - s[0], dy = x[1] - s[1], dz = x[2] - s[2]
      const c = pairCoeff(dx * dx + dy * dy + dz * dz)
      g[0] += c * dx; g[1] += c * dy; g[2] += c * dz
    }
    return g
  }

  const rMin = 2 ** (1 / 6) * sigma   // 单 LJ 阱平衡距离
  return {
    dims: 3,
    sites,
    energy,
    gradient,
    saddleGuess: [0, 0, 0],
    wellGuesses: [[-(ax - rMin), 0, 0], [ax - rMin, 0, 0]],
  }
}

// ── quench：单点弛豫到局部极小（最速下降 + 回溯，确定性） ──────────

export function quench({ x0, energy, gradient, ftol = 1e-8, maxSteps = 5000, dt0 = 0.05 } = {}) {
  if (!x0 || typeof energy !== 'function' || typeof gradient !== 'function') {
    throw analysisError('NEB_BAD_INPUT', 'quench requires x0 / energy / gradient')
  }
  let x = [...x0]
  let e = energy(x)
  let dt = dt0
  let nSteps = 0
  for (; nSteps < maxSteps; nSteps++) {
    const g = gradient(x)
    let maxG = 0
    for (const gi of g) maxG = Math.max(maxG, Math.abs(gi))
    if (maxG < ftol) return { x, energy: e, converged: true, nSteps }
    // 回溯：能量下降才接受，否则折半重试
    let accepted = false
    let dtTrial = dt
    for (let trial = 0; trial < 30 && !accepted; trial++) {
      const xn = x.map((xi, j) => xi - dtTrial * g[j])
      const en = energy(xn)
      if (en < e) { x = xn; e = en; accepted = true } else dtTrial *= 0.5
    }
    if (!accepted) return { x, energy: e, converged: true, nSteps }  // 驻点
    dt = Math.min(dtTrial * 1.05, dt0 * 2)
  }
  return { x, energy: e, converged: false, nSteps }
}

// ── NEB 主算法 ──────────────────────────────────────────────────
// 端点固定；自由像元受"弹力沿切向 + 真力取垂直分量"的 nudged 力驱动，
// 收敛判据为自由像元最大受力 < ftol。势垒取内部像元的最高能量。

export function neb({
  energy, gradient, start, end,
  nImages = 7, springK = 1.0, ftol = 1e-6, maxSteps = 3000, dt0 = 0.05, dtMax = 0.2,
  climb = false, historyEvery = 10, initialBand = null,
} = {}) {
  if (typeof energy !== 'function' || typeof gradient !== 'function') {
    throw analysisError('ANALYSIS_INPUT_MISSING',
      'neb requires pointwise energy() and gradient() callables')
  }
  if (!start || !end || start.length === 0 || start.length !== end.length) {
    throw analysisError('NEB_BAD_INPUT', 'start/end must be equal-length non-empty coordinates')
  }
  if (!Number.isInteger(nImages) || nImages < 3) {
    throw analysisError('NEB_BAD_INPUT', 'nImages must be an integer >= 3')
  }
  // 收敛判据本身也是输入：容差/步数/弹簧常数/抽样间隔非法时显式拒，不静默给"永不收敛"的循环
  if (!Number.isFinite(ftol) || ftol <= 0) {
    throw analysisError('NEB_BAD_INPUT', `ftol must be a positive finite number; got ${ftol}`)
  }
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw analysisError('NEB_BAD_INPUT', `maxSteps must be an integer >= 1; got ${maxSteps}`)
  }
  if (!Number.isFinite(springK) || springK <= 0) {
    throw analysisError('NEB_BAD_INPUT', `springK must be a positive finite number; got ${springK}`)
  }
  if (!Number.isInteger(historyEvery) || historyEvery < 1) {
    throw analysisError('NEB_BAD_INPUT', `historyEvery must be a positive integer; got ${historyEvery}`)
  }

  const dims = start.length
  const images = []
  if (initialBand != null) {
    // 真实 NEB 需要聪明的初始路径；线性插值是最弱默认（共线均匀带会直接落在驻定解上）
    if (!Array.isArray(initialBand) || initialBand.length !== nImages) {
      throw analysisError('NEB_BAD_INPUT', `initialBand must be an array of nImages (${nImages}) coordinates`)
    }
    const near = (a, b) => a.length === b.length && a.every((v, j) => Math.abs(v - b[j]) < 1e-8)
    if (!near(initialBand[0], start) || !near(initialBand[nImages - 1], end)) {
      throw analysisError('NEB_BAD_INPUT', 'initialBand endpoints must coincide with start/end (端点固定是 NEB 的定义部分)')
    }
    for (const x of initialBand) {
      if (!Array.isArray(x) || x.length !== dims || x.some(v => !Number.isFinite(v))) {
        throw analysisError('NEB_BAD_INPUT', `initialBand 每项必须是 ${dims} 个有限数`)
      }
    }
    images.push(...initialBand.map(x => [...x]))
  } else {
    for (let i = 0; i < nImages; i++) {
      const t = i / (nImages - 1)
      images.push(start.map((s, j) => s + t * (end[j] - s)))
    }
  }

  let converged = false
  let nSteps = 0
  let dt = dt0
  let prevMaxF = Infinity
  let maxF = 0
  let climbIndex = 0
  let perImage = []
  const history = []

  for (; nSteps < maxSteps; nSteps++) {
    const energies = images.map(energy)
    const forces = []
    maxF = 0
    // 带内最高能的自由像元（climbing image 候选）
    climbIndex = 1
    for (let i = 2; i < nImages - 1; i++) if (energies[i] > energies[climbIndex]) climbIndex = i
    perImage = new Array(nImages - 2).fill(0)

    for (let i = 1; i < nImages - 1; i++) {
      const xp = images[i - 1], xi = images[i], xn = images[i + 1]

      // HU 平分切向（避免鞍点附近切向翻转）
      const dEplus = energies[i + 1] - energies[i]
      const dEminus = energies[i - 1] - energies[i]
      const dmax = Math.max(Math.abs(dEplus), Math.abs(dEminus))
      const dmin = Math.min(Math.abs(dEplus), Math.abs(dEminus))
      const tau = new Array(dims)
      if (energies[i + 1] > energies[i - 1]) {
        for (let j = 0; j < dims; j++) tau[j] = (xn[j] - xi[j]) * dmax - (xi[j] - xp[j]) * dmin
      } else if (energies[i + 1] < energies[i - 1]) {
        for (let j = 0; j < dims; j++) tau[j] = (xn[j] - xi[j]) * dmin - (xi[j] - xp[j]) * dmax
      } else {
        for (let j = 0; j < dims; j++) tau[j] = xn[j] - xp[j]
      }
      let tn = 0
      for (const t of tau) tn += t * t
      tn = Math.sqrt(tn) || 1
      for (let j = 0; j < dims; j++) tau[j] /= tn

      // 相邻像元间距 → 切向弹力
      let d2p = 0, d2n = 0
      for (let j = 0; j < dims; j++) {
        d2p += (xi[j] - xp[j]) ** 2
        d2n += (xn[j] - xi[j]) ** 2
      }
      const fSpring = springK * (Math.sqrt(d2n) - Math.sqrt(d2p))

      // nudged 力：弹力沿切向 + 真力垂直分量（F = kΔd·τ̂ − ∇E + (∇E·τ̂)τ̂）；
      // climbing 像元：取消弹力，切向梯度反向（F = −∇E + 2(∇E·τ̂)τ̂）——沿带向上坡走
      const g = gradient(xi)
      let gTau = 0
      for (let j = 0; j < dims; j++) gTau += g[j] * tau[j]
      const isClimb = climb === true && i === climbIndex
      const f = new Array(dims)
      let f2 = 0
      for (let j = 0; j < dims; j++) {
        f[j] = isClimb
          ? -g[j] + 2 * gTau * tau[j]
          : fSpring * tau[j] - g[j] + gTau * tau[j]
        f2 += f[j] * f[j]
      }
      const ff = Math.sqrt(f2)
      if (ff > maxF) maxF = ff
      perImage[i - 1] = ff
      forces.push(f)
    }

    if (nSteps % historyEvery === 0) history.push({ step: nSteps, maxForce: maxF })

    if (maxF < ftol) { converged = true; break }

    // 步长自适应：力增大折半，持续下降温和加速——保持确定性
    if (maxF > prevMaxF) dt = Math.max(dt * 0.5, 1e-5)
    else dt = Math.min(dt * 1.02, dtMax)
    prevMaxF = maxF

    for (let i = 1; i < nImages - 1; i++) {
      const f = forces[i - 1]
      for (let j = 0; j < dims; j++) images[i][j] += dt * f[j]
    }
  }

  const energies = images.map(energy)
  // 末次 maxF 一定进历史（抽样不丢收敛时刻那一帧）
  if (history.length === 0 || history[history.length - 1].step !== nSteps) {
    history.push({ step: nSteps, maxForce: maxF })
  }
  // 鞍点：climb 模式用 climbing 像元（已沿带上坡推到位），否则用带内最高点
  const saddleIndex = climb === true ? climbIndex : (() => {
    let best = 1
    for (let i = 2; i < nImages - 1; i++) if (energies[i] > energies[best]) best = i
    return best
  })()
  const saddleEnergy = energies[saddleIndex]

  return {
    converged,
    nSteps,
    nImages,
    images,
    energies,
    saddleIndex,
    saddle: images[saddleIndex],
    barrierForward: saddleEnergy - energies[0],
    barrierReverse: saddleEnergy - energies[nImages - 1],
    method: climb === true ? 'neb+climbing-image' : 'neb',
    saddleSource: climb === true ? 'climbing-image' : 'band-max-image',
    convergence: {
      ftol,
      maxForce: maxF,
      maxForcePerImage: perImage,
      stepLimitReached: !converged,
      // 初帧就满足判据：一步优化也没做（典型成因：共线等距带的 nudged 力恒为零）。
      // 与"跑了 N 步收敛到驻定"分开报，不把未发生优化说成已弛豫。
      trivialStationary: converged && nSteps === 0,
      maxForceAtStart: history[0]?.maxForce ?? maxF,
      forceDrop: history[0]?.maxForce > 0 ? maxF / history[0].maxForce : null,
      spacing: (() => {
        const sp = []
        for (let i = 1; i < nImages; i++) sp.push(Math.hypot(...images[i].map((v, j) => v - images[i - 1][j])))
        return { ...stats(sp), uniform: sp.every(v => Math.abs(v - sp[0]) < 1e-12) }
      })(),
      maxSteps,
      historyEvery,
      history,          // [{step, maxForce}] 抽样（含末帧）
      forceCriterion: '收敛判据：自由像元（含 climbing 像元）的 nudged/CI 力模长最大值 < ftol',
    },
    note: '势垒为鞍点像元能量与两端像元能量之差；未收敛（stepLimitReached=true）时'
      + '带内最高点只是真实势垒的上界估计（climb 模式下仍可能未到位），不作过渡态结论。',
  }
}
