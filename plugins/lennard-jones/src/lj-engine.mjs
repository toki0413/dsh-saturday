// @saturday/plugin-lj 纯数值层 —— 零外部依赖的 Lennard-Jones 引擎
//
// 定位：开箱即用的数据面。物理档位是玩具势（声明在先，不为精度辩护）——
// 价值在于"任何装了 Node 的机器都能跑出真实数值结果"，让插件运行时
// 的全部链路（弛豫/筛选/自由能/遍历对账）在无 Python 环境同样闭环。
// 精度需求升级时换装 ASE/LAMMPS/MACE 引擎（契约 §4.1 能力路由），接口不变。
//
// 单位制：eV / Å / fs（与全仓引擎同款，M1 单位门禁登记在案）。
// 周期边界：显式镜像盒枚举（对任意截断半径精确，不做最小镜像近似）。
// 势的截断：force-shift（能量与力在截断处均连续，MD 无截断伪影）。

// ── 单位换算常数（闭式对账测试锚定）──────────────────────────
/** 玻尔兹曼常数（eV/K）——与 plugin-free-energy 纯层同一常量 */
export const KB_EV_PER_K = 8.617333262145e-5
/** 加速度换算：F[eV/Å]/m[amu] × ACC_CONV = a[Å/fs²] */
export const ACC_CONV = 9.648533212e-3
/** 动能换算：0.5·m[amu]·v²[Å²/fs²] × KV_TO_EV = K[eV] */
export const KV_TO_EV = 1 / ACC_CONV

// ── 元素参数表（ε/σ 与原子量）───────────────────────────────
// 金属取 Halicioglu/Pun-Mishin 通用 LJ 化参数族；Ar 为标准值；
// 其余为同族量级的估算值（诚实标注：玩具势档位，定性用途）。
// 不在表内的元素显式报错（LJ_ELEMENT_UNSUPPORTED），绝不静默给假参数。
export const LJ_PARAMS = {
  H:  { epsilon: 0.0031, sigma: 2.958, mass: 1.008, note: 'estimated' },
  Li: { epsilon: 0.1136, sigma: 2.360, mass: 6.94, note: 'estimated' },
  C:  { epsilon: 0.2844, sigma: 3.431, mass: 12.011, note: 'estimated' },
  O:  { epsilon: 0.0067, sigma: 3.166, mass: 15.999, note: 'estimated' },
  Al: { epsilon: 0.3920, sigma: 2.620, mass: 26.982, note: 'Halicioglu' },
  Si: { epsilon: 0.4730, sigma: 3.727, mass: 28.085, note: 'estimated' },
  Ar: { epsilon: 0.0104, sigma: 3.405, mass: 39.948, note: 'standard' },
  Ti: { epsilon: 0.1225, sigma: 2.900, mass: 47.867, note: 'estimated' },
  Fe: { epsilon: 0.4606, sigma: 2.229, mass: 55.845, note: 'Halicioglu' },
  Ni: { epsilon: 0.6947, sigma: 2.218, mass: 58.693, note: 'Halicioglu' },
  Cu: { epsilon: 0.4095, sigma: 2.338, mass: 63.546, note: 'Halicioglu' },
  Pd: { epsilon: 0.3889, sigma: 2.480, mass: 106.42, note: 'Halicioglu' },
  Ag: { epsilon: 0.3425, sigma: 2.555, mass: 107.868, note: 'Halicioglu' },
  Pt: { epsilon: 0.6458, sigma: 2.470, mass: 195.084, note: 'Halicioglu' },
  Au: { epsilon: 0.5292, sigma: 2.570, mass: 196.967, note: 'Halicioglu' },
}

export class LjElementUnsupportedError extends Error {
  constructor(symbol) {
    super(`lj-js has no Lennard-Jones parameters for element "${symbol}". ` +
          `Parameterized elements: ${Object.keys(LJ_PARAMS).join(', ')}. ` +
          'Saturday never fabricates parameters for unparameterized elements')
    this.code = 'LJ_ELEMENT_UNSUPPORTED'
  }
}

/** Lorentz-Berthelot 混合规则 + 逐对截断半径 */
export function mixParams(symA, symB, cutoffFactor = 2.5) {
  const pa = LJ_PARAMS[symA]
  const pb = LJ_PARAMS[symB]
  if (!pa) throw new LjElementUnsupportedError(symA)
  if (!pb) throw new LjElementUnsupportedError(symB)
  const sigma = 0.5 * (pa.sigma + pb.sigma)
  return {
    epsilon: Math.sqrt(pa.epsilon * pb.epsilon),
    sigma,
    cutoff: cutoffFactor * sigma,
  }
}

/** LJ 对势与径向导数（未截断原始式）：E(r) = 4ε[(σ/r)¹² − (σ/r)⁶] */
function pairTerms(r, epsilon, sigma) {
  const sr6 = (sigma / r) ** 6
  const energy = 4 * epsilon * (sr6 * sr6 - sr6)
  const dEdr = 4 * epsilon * (6 * sr6 / r - 12 * sr6 * sr6 / r)
  return { energy, dEdr }
}

/**
 * 周期镜像枚举的能量 + 力。
 * structure: { positions: number[][], cell: number[][] }
 * symbols 由调用方从 numbers 映射（本层保持对核心包的零耦合）。
 * 镜像盒范围逐维取 ceil(rc_max / |cell_i|)，对任意截断半径精确。
 */
export function ljCalculate(structure, symbols, { cutoffFactor = 2.5 } = {}) {
  const { positions, cell } = structure
  const n = positions.length
  if (n === 0) throw new Error('lj-js: empty structure')

  // 预计算逐对参数与全局镜像范围
  let rcMax = 0
  const pairCache = new Map()
  const pairKey = (sa, sb) => sa < sb ? `${sa}|${sb}` : `${sb}|${sa}`
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const key = pairKey(symbols[i], symbols[j])
      if (!pairCache.has(key)) {
        const m = mixParams(symbols[i], symbols[j], cutoffFactor)
        pairCache.set(key, m)
        rcMax = Math.max(rcMax, m.cutoff)
      }
    }
  }
  const cellLens = [0, 1, 2].map(k => Math.hypot(cell[k][0], cell[k][1], cell[k][2]))
  const ranges = cellLens.map(L => Math.ceil(rcMax / L))

  const forces = positions.map(() => [0, 0, 0])
  let energy = 0

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const { epsilon, sigma, cutoff } = pairCache.get(pairKey(symbols[i], symbols[j]))
      for (let nx = -ranges[0]; nx <= ranges[0]; nx++) {
        for (let ny = -ranges[1]; ny <= ranges[1]; ny++) {
          for (let nz = -ranges[2]; nz <= ranges[2]; nz++) {
            if (i === j && nx === 0 && ny === 0 && nz === 0) continue
            // 镜像位移向量（晶格向量整数线性组合）
            const ox = nx * cell[0][0] + ny * cell[1][0] + nz * cell[2][0]
            const oy = nx * cell[0][1] + ny * cell[1][1] + nz * cell[2][1]
            const oz = nx * cell[0][2] + ny * cell[1][2] + nz * cell[2][2]
            const dx = positions[j][0] + ox - positions[i][0]
            const dy = positions[j][1] + oy - positions[i][1]
            const dz = positions[j][2] + oz - positions[i][2]
            const r = Math.hypot(dx, dy, dz)
            if (r < 1e-8 || r >= cutoff) continue
            // force-shift：能量与力在截断处连续
            const { energy: e, dEdr } = pairTerms(r, epsilon, sigma)
            const { energy: ec, dEdr: dEc } = pairTerms(cutoff, epsilon, sigma)
            energy += 0.5 * (e - ec - (r - cutoff) * dEc)
            const f = (dEdr - dEc) / r   // 径向力系数（含 1/r 归一）
            forces[i][0] += f * dx
            forces[i][1] += f * dy
            forces[i][2] += f * dz
          }
        }
      }
    }
  }
  return { energy, forces }
}

/** 原子序号 → 元素符号（供 provider 层用；与核心元素表独立维护，避免耦合） */
const NUMBER_TO_SYMBOL = Object.fromEntries(Object.entries({
  H: 1, Li: 3, C: 6, O: 8, Al: 13, Si: 14, Ar: 18,
  Ti: 22, Fe: 26, Ni: 28, Cu: 29, Pd: 46, Ag: 47, Pt: 78, Au: 79,
}).map(([s, z]) => [z, s]))

export function symbolsOf(numbers) {
  return numbers.map(z => {
    const s = NUMBER_TO_SYMBOL[z]
    if (!s) throw new LjElementUnsupportedError(`Z=${z}`)
    return s
  })
}

// ── 3×3 矩阵求逆与周期回绕 ──────────────────────────────────
function inv3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (Math.abs(det) < 1e-12) throw new Error('lj-js: singular cell matrix')
  const id = 1 / det
  return [
    [(e * i - f * h) * id, (c * h - b * i) * id, (b * f - c * e) * id],
    [(f * g - d * i) * id, (a * i - c * g) * id, (c * d - a * f) * id],
    [(d * h - e * g) * id, (b * g - a * h) * id, (a * e - b * d) * id],
  ]
}

function wrapIntoCell(positions, cell) {
  // 分数坐标取整回绕（正交与非正交通用）
  const inv = inv3(cell)
  return positions.map(p => {
    const g = [0, 1, 2].map(k => {
      const fk = inv[k][0] * p[0] + inv[k][1] * p[1] + inv[k][2] * p[2]
      return fk - Math.round(fk)
    })
    return [
      g[0] * cell[0][0] + g[1] * cell[1][0] + g[2] * cell[2][0],
      g[0] * cell[0][1] + g[1] * cell[1][1] + g[2] * cell[2][1],
      g[0] * cell[0][2] + g[1] * cell[1][2] + g[2] * cell[2][2],
    ]
  })
}

// ── 弛豫：FIRE（Bitzek 2006），解析力驱动，确定性 ────────────
/**
 * FIRE 弛豫（固定晶胞，原子自由度）。收敛判据：最大受力 < fmax（eV/Å）。
 * 对称结构受力恒零时即刻收敛——这是固定胞弛豫语义的如实结果（驻点即收敛）。
 */
export function ljRelax(structure, symbols, {
  fmax = 0.05, maxSteps = 200, dtStart = 0.2, dtMax = 1.0,
} = {}) {
  const n = structure.positions.length
  const masses = symbols.map(s => LJ_PARAMS[s].mass)
  const maxForce = fs => Math.max(...fs.map(f => Math.hypot(f[0], f[1], f[2])))

  let positions = structure.positions.map(p => [...p])
  let { energy, forces } = ljCalculate({ ...structure, positions }, symbols)
  const energyInitial = energy
  if (maxForce(forces) < fmax) {
    return { converged: true, energy, energy_initial: energyInitial, n_steps: 0, positions, cell: structure.cell }
  }

  let velocities = positions.map(() => [0, 0, 0])
  let dt = dtStart
  let alpha = 0.1
  let nSincePower = 0
  let steps = 0
  let converged = false

  while (steps < maxSteps) {
    // velocity Verlet：半步力加速 → 全步漂移 → 新力半步加速
    for (let i = 0; i < n; i++) {
      const invM = ACC_CONV / masses[i]
      for (let k = 0; k < 3; k++) velocities[i][k] += 0.5 * dt * forces[i][k] * invM
    }
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) positions[i][k] += dt * velocities[i][k]
    }
    positions = wrapIntoCell(positions, structure.cell)
    ;({ energy, forces } = ljCalculate({ ...structure, positions }, symbols))
    for (let i = 0; i < n; i++) {
      const invM = ACC_CONV / masses[i]
      for (let k = 0; k < 3; k++) velocities[i][k] += 0.5 * dt * forces[i][k] * invM
    }
    steps++

    if (maxForce(forces) < fmax) { converged = true; break }

    // FIRE 功率判据：沿力方向混合速度，功率为正时增大步长
    let power = 0
    let vNorm = 0
    let fNorm = 0
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        power += forces[i][k] * velocities[i][k]
        vNorm += velocities[i][k] ** 2
        fNorm += forces[i][k] ** 2
      }
    }
    vNorm = Math.sqrt(vNorm)
    fNorm = Math.sqrt(fNorm)
    if (fNorm > 0 && vNorm > 0) {
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) {
          velocities[i][k] = (1 - alpha) * velocities[i][k] + alpha * (vNorm / fNorm) * forces[i][k]
        }
      }
    }
    if (power > 0) {
      nSincePower++
      if (nSincePower > 5) {
        dt = Math.min(dt * 1.1, dtMax)
        alpha *= 0.99
      }
    } else {
      dt *= 0.5
      alpha = 0.1
      nSincePower = 0
      velocities = positions.map(() => [0, 0, 0])
    }
  }

  return {
    converged,
    energy,
    energy_initial: energyInitial,
    n_steps: steps,
    positions,
    cell: structure.cell,
  }
}

// ── Langevin 恒温 MD：BAOAB 分裂（确定性种子）────────────────
/** mulberry32 种子随机源 + Box-Muller 标准正态（确定性复现） */
function makeRng(seed) {
  let s = seed >>> 0
  const next = () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  let spare = null
  return () => {
    if (spare !== null) { const v = spare; spare = null; return v }
    const u1 = Math.max(next(), 1e-12)
    const u2 = next()
    const r = Math.sqrt(-2 * Math.log(u1))
    spare = r * Math.sin(2 * Math.PI * u2)
    return r * Math.cos(2 * Math.PI * u2)
  }
}

/**
 * Langevin 恒温 MD（BAOAB）：与 ase_calc.md 同款入参与返回形态。
 * friction 语义：每步无量纲摩擦系数（与 ASE Langevin 用法一致，0.01 量级）。
 */
export function ljMd(structure, symbols, {
  temperatureK = 300, steps = 200, dtFs = 1, sampleEvery = 5,
  friction = 0.01, seed = 1,
} = {}) {
  const n = structure.positions.length
  const masses = symbols.map(s => LJ_PARAMS[s].mass)
  const rng = makeRng(seed)
  const kT = KB_EV_PER_K * temperatureK
  const c = Math.exp(-friction)   // O 步速度衰减因子
  let positions = structure.positions.map(p => [...p])

  // 初始速度：按温度抽样（Maxwell），并去除质心漂移
  let velocities = positions.map((_, i) => {
    const vSig = Math.sqrt(kT / (masses[i] * KV_TO_EV))
    return [rng() * vSig, rng() * vSig, rng() * vSig]
  })
  const totalMass = masses.reduce((s, m) => s + m, 0)
  const cmv = [0, 1, 2].map(k => velocities.reduce((s, v, i) => s + masses[i] * v[k], 0) / totalMass)
  velocities = velocities.map(v => [v[0] - cmv[0], v[1] - cmv[1], v[2] - cmv[2]])

  let { forces } = ljCalculate({ ...structure, positions }, symbols)

  const kinetic = v => 0.5 * KV_TO_EV * v.reduce((s, vi, i) =>
    s + masses[i] * (vi[0] ** 2 + vi[1] ** 2 + vi[2] ** 2), 0)
  const potential = () => ljCalculate({ ...structure, positions }, symbols).energy

  const energies = []
  const kinetics = []
  const temperatures = []
  const sample = () => {
    const K = kinetic(velocities)
    energies.push(potential())
    kinetics.push(K)
    temperatures.push(2 * K / (3 * n * KB_EV_PER_K))
  }
  sample()

  for (let step = 0; step < steps; step++) {
    const halfDt = 0.5 * dtFs
    // B：半步力加速
    for (let i = 0; i < n; i++) {
      const invM = ACC_CONV / masses[i]
      for (let k = 0; k < 3; k++) velocities[i][k] += halfDt * forces[i][k] * invM
    }
    // A：半步漂移
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) positions[i][k] += halfDt * velocities[i][k]
    }
    // O：恒温（摩擦 + 涨落，噪声幅度与质量/温度闭式一致）
    for (let i = 0; i < n; i++) {
      const noise = Math.sqrt(kT * (1 - c * c) / (masses[i] * KV_TO_EV))
      for (let k = 0; k < 3; k++) velocities[i][k] = c * velocities[i][k] + noise * rng()
    }
    // A：半步漂移 + 周期回绕
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) positions[i][k] += halfDt * velocities[i][k]
    }
    positions = wrapIntoCell(positions, structure.cell)
    // B：新力半步加速
    ;({ forces } = ljCalculate({ ...structure, positions }, symbols))
    for (let i = 0; i < n; i++) {
      const invM = ACC_CONV / masses[i]
      for (let k = 0; k < 3; k++) velocities[i][k] += halfDt * forces[i][k] * invM
    }
    if ((step + 1) % sampleEvery === 0) sample()
  }

  return {
    energies,
    kinetic: kinetics,
    temperatures,
    temperature_K: temperatureK,
    n_steps: steps,
  }
}

// ── 谐波锚点：弛豫 + 有限差分 Hessian + Jacobi 对角化 ────────
function jacobiEigenvalues(matrix) {
  // 对称矩阵特征值（循环 Jacobi 旋转）；n ≤ 30 量级，性能充裕
  const a = matrix.map(row => [...row])
  const n = a.length
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] ** 2
    if (off < 1e-20) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-14) continue
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k++) {
          const akp = a[k][p]
          const akq = a[k][q]
          a[k][p] = c * akp - s * akq
          a[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k]
          const aqk = a[q][k]
          a[p][k] = c * apk - s * aqk
          a[q][k] = s * apk + c * aqk
        }
      }
    }
  }
  return Array.from({ length: n }, (_, i) => a[i][i])
}

/** 质量加权 Hessian 特征值 → 普通频率（THz）；与 ase_calc.harmonic 同款换算闭式 */
export const FREQ_FACTOR_THZ = Math.sqrt(16.02176634 / 1.66053906892e-27) / (2 * Math.PI * 1e12)

/**
 * 谐波锚点数据面：与 ase_calc.harmonic 同规格——
 * 弛豫到局部极小 → 中心差分 Hessian → 质量加权简正模。
 * 零模/虚频如实计数，绝不静默修正（同参考态纪律）。
 */
export function ljHarmonic(structure, symbols, {
  fmax = 0.05, maxSteps = 200, displacementAngstrom = 0.01, zeroModeTol = 1e-4,
} = {}) {
  const relaxed = ljRelax(structure, symbols, { fmax, maxSteps })
  const u0 = relaxed.energy
  const positions = relaxed.positions
  const n = positions.length
  const n3 = 3 * n
  const masses = symbols.map(s => LJ_PARAMS[s].mass)
  const h = displacementAngstrom

  // 中心差分 Hessian：H_{ia,jb} = -dF_{ia}/dx_{jb}
  const hess = Array.from({ length: n3 }, () => new Array(n3).fill(0))
  for (let j = 0; j < n3; j++) {
    let fPlus = null
    let fMinus = null
    for (const sign of [1, -1]) {
      const displaced = positions.map(p => [...p])
      displaced[Math.floor(j / 3)][j % 3] += sign * h
      const { forces } = ljCalculate({ ...structure, positions: displaced }, symbols)
      const flat = forces.flat()
      if (sign === 1) fPlus = flat
      else fMinus = flat
    }
    for (let ia = 0; ia < n3; ia++) hess[ia][j] = -(fPlus[ia] - fMinus[ia]) / (2 * h)
  }
  for (let ia = 0; ia < n3; ia++) {
    for (let jb = ia + 1; jb < n3; jb++) {
      const sym = 0.5 * (hess[ia][jb] + hess[jb][ia])
      hess[ia][jb] = sym
      hess[jb][ia] = sym
    }
  }

  // 质量加权：H' = H / sqrt(m_i m_j)
  const mw = hess.map((row, ia) => row.map((v, jb) =>
    v / Math.sqrt(masses[Math.floor(ia / 3)] * masses[Math.floor(jb / 3)])))
  const eigvals = jacobiEigenvalues(mw)

  let zeroModes = 0
  let nImag = 0
  const realFreqs = []
  for (const lam of eigvals) {
    if (lam > zeroModeTol) realFreqs.push(Math.sqrt(lam) * FREQ_FACTOR_THZ)
    else if (lam >= -zeroModeTol) zeroModes++
    else nImag++
  }
  realFreqs.sort((a, b) => a - b)

  return {
    converged: relaxed.converged,
    u0_eV: u0,
    n_atoms: n,
    n_modes: n3,
    frequencies_thz: realFreqs,
    zero_modes: zeroModes,
    imaginary_modes: nImag,
    displacement_angstrom: h,
  }
}

// ── 元素参考态（热力学第一档）：本引擎自洽的 fcc 平衡态 ───────
/**
 * 元素参考态每原子能量：fcc 原胞（4 原子）置于本势自身的平衡近邻距离
 * 2^(1/6)σ 后真实弛豫验证。如实标注"本引擎自洽参考态"——不是实验值，
 * 也不冒充其他引擎的零点（第一档纪律：零点显式计算，绝不假设为零）。
 */
export function ljReferenceEnergy(symbol, params = {}) {
  const p = LJ_PARAMS[symbol]
  if (!p) throw new LjElementUnsupportedError(symbol)
  const nn = Math.cbrt(2) * p.sigma          // LJ 平衡近邻距离 2^(1/6)σ
  const a = nn * Math.SQRT2                  // fcc 晶格常数
  const structure = {
    cell: [[a, 0, 0], [0, a, 0], [0, 0, a]],
    positions: [
      [0, 0, 0], [0, a / 2, a / 2], [a / 2, 0, a / 2], [a / 2, a / 2, 0],
    ],
  }
  const relaxed = ljRelax(structure, [symbol, symbol, symbol, symbol], params)
  return {
    symbol,
    energy_per_atom: relaxed.energy / 4,
    converged: relaxed.converged,
    n_steps: relaxed.n_steps,
    calculator: 'lj-js',
    source: 'lj-self-consistent',
    note: '本引擎自洽参考态（LJ fcc 平衡态），非实验值；跨引擎比较须先对指纹',
  }
}
