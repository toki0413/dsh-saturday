// plugin-free-energy 纯函数层 —— 热力学第二档（契约 §9 演进：从焓到自由能）
//
// 机制：构型自由能沿 β 的热力学积分（TI）——
//   β·F_conf(β) = β₀·F₀ + ∫_{β₀}^{β} ⟨U⟩(β') dβ'
// ⟨U⟩(β) 由同一能量函数的恒温 MD 势能轨迹时间平均给出（复用既有 `md` 原语）。
// 与第一档同一纪律：自由能零点（锚点）必须显式注入，不得静默假设为零
// （缺锚点抛 THERMO_REFERENCE_MISSING，与 thermo 纯层同一错误家族）。
//
// 诚实边界（写入交付，消费方必须连同呈现）：
//  - 交付的是**构型自由能**（不含动量部分）：MD 轨迹能量是势能，
//    恒等式 d(βF_conf)/dβ = ⟨U⟩ 对构型配分函数精确成立；
//  - 数值积分为梯形法：截断误差 ≤ (β₁−β₀)·h²/12·max|g″|（g = ⟨U⟩，h 网格步长）；
//  - 每个网格点的 ⟨U⟩ 带 MD 统计误差（标准误随结果呈现），不夸大精度；
//  - 锚点 F₀ 的物理含义由注入方声明（如谐波近似/实验值/上游计算），
//    工具只承诺从锚点出发的相对量 ΔF 的积分正确性。

export function thermoError(code, message) {
  const e = new Error(`${message} (${code})`)
  e.code = code
  return e
}

/** 玻尔兹曼常数（eV/K） */
export const KB_EV_PER_K = 8.617333262145e-5

/** 普朗克常数（eV·s）：1 THz 普通频率 ↔ 4.135667696e-3 eV 量子 */
export const H_EV_S = 4.135667696e-15

/**
 * 量子谐振子的振动自由能（谐波锚点闭式，纯统计不触碰引擎）。
 * 每模：F_i(T) = ℏω_i/2 + kT·ln(1 − e^{−ℏω_i/kT})；低频/高温极限 → kT·ln(ℏω/kT)，
 * 高频/低温极限 → 零点能 ℏω/2。虚频（f≤0）拒绝入包：谐波锚点对鞍点无物理意义，
 * 调用方必须先由 Hessian 诊断声明（同第一档"不静默假设零点"纪律）。
 * @param {Object}   opts
 * @param {number[]} opts.frequenciesTHz  简正模普通频率（THz，全正）
 * @param {number}   opts.temperatureK    温度（K，正有限）
 */
export function harmonicVibrationalFreeEnergy({ frequenciesTHz, temperatureK } = {}) {
  if (!Array.isArray(frequenciesTHz) || frequenciesTHz.length === 0) {
    throw thermoError('THERMO_INVALID_INPUT', 'frequenciesTHz must be a non-empty array')
  }
  if (!Number.isFinite(temperatureK) || temperatureK <= 0) {
    throw thermoError('THERMO_INVALID_INPUT', `temperatureK must be positive finite; got ${temperatureK}`)
  }
  const kT = KB_EV_PER_K * temperatureK
  let freeEnergyEV = 0
  let zeroPointEV = 0
  for (const f of frequenciesTHz) {
    if (!Number.isFinite(f) || f <= 0) {
      throw thermoError('THERMO_INVALID_INPUT',
        `imaginary or invalid mode ${f}: harmonic anchor requires all-real frequencies; ` +
        'declare the saddle point honestly instead of fabricating an anchor')
    }
    const quantaEV = H_EV_S * f * 1e12 // h·f = ℏω
    zeroPointEV += 0.5 * quantaEV
    freeEnergyEV += 0.5 * quantaEV + kT * Math.log1p(-Math.exp(-quantaEV / kT))
  }
  return {
    method: 'quantum-harmonic-oscillator',
    nModes: frequenciesTHz.length,
    temperatureK,
    vibrationalFreeEnergyEV: freeEnergyEV,
    zeroPointEnergyEV: zeroPointEV,
  }
}

/**
 * 构型自由能的热力学积分（纯统计，不触碰引擎）。
 * @param {Object}   opts
 * @param {number[]} opts.temperaturesK        温度网格（K，升序，≥2 个点）
 * @param {number[][]} opts.potentialEnergies  逐网格点的 MD 势能轨迹（eV）
 * @param {Object}   opts.anchor               锚点 { temperatureK, F0 }：零点显式声明
 * @param {string}  [opts.anchorSource]        锚点物理来源声明（随交付呈现）
 */
export function freeEnergyByIntegration({ temperaturesK, potentialEnergies, anchor, anchorSource } = {}) {
  if (!Array.isArray(temperaturesK) || temperaturesK.length < 2) {
    throw thermoError('THERMO_INVALID_INPUT', 'temperaturesK must be an array of at least 2 grid points')
  }
  if (!Array.isArray(potentialEnergies) || potentialEnergies.length !== temperaturesK.length) {
    throw thermoError('THERMO_INVALID_INPUT', 'potentialEnergies must align with temperaturesK (one MD series per grid point)')
  }
  if (!anchor || !Number.isFinite(anchor.temperatureK) || !Number.isFinite(anchor.F0)) {
    // 第一档纪律延续：能量/自由能零点必须显式计算或声明，绝不静默假设为零
    throw thermoError('THERMO_REFERENCE_MISSING',
      'anchor { temperatureK, F0 } is required: the free-energy zero must be declared explicitly, never assumed')
  }
  for (const t of temperaturesK) {
    if (!Number.isFinite(t) || t <= 0) {
      throw thermoError('THERMO_INVALID_INPUT', `temperatures must be positive finite numbers; got ${t}`)
    }
  }
  for (let i = 1; i < temperaturesK.length; i++) {
    if (temperaturesK[i] <= temperaturesK[i - 1]) {
      throw thermoError('THERMO_INVALID_INPUT', 'temperaturesK must be strictly ascending')
    }
  }
  if (!temperaturesK.includes(anchor.temperatureK)) {
    throw thermoError('THERMO_INVALID_INPUT',
      `anchor temperature ${anchor.temperatureK} K must be one of the grid points`)
  }

  // 逐网格点：势能均值 + 标准误（诚实呈现统计不确定性）
  const points = temperaturesK.map((t, i) => {
    const series = potentialEnergies[i]
    if (!Array.isArray(series) || series.length === 0) {
      throw thermoError('THERMO_INVALID_INPUT', `potentialEnergies[${i}] is empty or missing`)
    }
    let sum = 0
    for (const u of series) {
      if (!Number.isFinite(u)) {
        throw thermoError('THERMO_INVALID_INPUT', `potentialEnergies[${i}] contains non-finite value: ${u}`)
      }
      sum += u
    }
    const n = series.length
    const mean = sum / n
    const variance = series.reduce((s, u) => s + (u - mean) ** 2, 0) / Math.max(n - 1, 1)
    return { temperatureK: t, beta: 1 / (KB_EV_PER_K * t), meanU: mean, sem: Math.sqrt(variance / n) }
  })

  // 积分核：g(β) = ⟨U⟩(β)；用相邻网格均值线性插值出锚点处的 g，再分段梯形
  const anchorIdx = points.findIndex(p => p.temperatureK === anchor.temperatureK)
  const meanUs = points.map(p => p.meanU)
  const gAt = (beta) => {
    const betas = points.map(p => p.beta) // 降序（T 升序）
    for (let i = 0; i < betas.length - 1; i++) {
      const [b0, b1] = [betas[i], betas[i + 1]]
      if ((beta <= b0 && beta >= b1) || beta === b0) {
        const frac = (b0 - beta) / (b0 - b1)
        return meanUs[i] + frac * (meanUs[i + 1] - meanUs[i])
      }
    }
    throw thermoError('THERMO_INVALID_INPUT', `beta ${beta} outside the integration grid`)
  }
  const integralBetween = (betaA, betaB) => {
    // 梯形法：把区间按网格 β 切段，逐段 (g(a)+g(b))/2·Δβ；
    // 方向敏感：βB < βA（升温侧）时返回带负号的定向积分，不得取绝对值。
    const orientation = betaB >= betaA ? 1 : -1
    const lo = Math.min(betaA, betaB)
    const hi = Math.max(betaA, betaB)
    const knots = [lo,
      ...points.map(p => p.beta).filter(b => lo < b && b < hi),
      hi].sort((a, b) => a - b)
    let acc = 0
    for (let i = 0; i < knots.length - 1; i++) {
      const [a, b] = [knots[i], knots[i + 1]]
      acc += 0.5 * (gAt(a) + gAt(b)) * (b - a)
    }
    return orientation * acc
  }

  const anchorBeta = points[anchorIdx].beta
  // 逐点：βF(β) = β₀F₀ + ∫_{β₀}^{β} g dβ'；交付换算回 F 与 ΔF
  const result = points.map(p => {
    const betaF = anchorBeta * anchor.F0 + integralBetween(anchorBeta, p.beta)
    return {
      temperatureK: p.temperatureK,
      meanU: p.meanU,
      sem: p.sem,
      F: betaF / p.beta,
      dF: betaF / p.beta - anchor.F0,
    }
  })

  return {
    method: 'thermodynamic-integration',
    quantity: 'configurational-free-energy',
    anchor: { ...anchor, source: anchorSource ?? 'undeclared' },
    curve: result,
    note: '构型自由能（不含动量部分）：d(βF_conf)/dβ = ⟨U⟩，梯形积分；' +
          '锚点以外的 F 值只承诺从锚点出发的相对量 ΔF 的积分正确性；' +
          '逐点 sem 为 ⟨U⟩ 的 MD 统计标准误，不夸大精度',
  }
}
