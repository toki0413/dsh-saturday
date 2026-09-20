// 全布里渊区声子热力学 —— 纯函数层（Born–von Kármán 插值 → 频率 → DOS → 热力学量）。
// 与 Γ 点声子（phonon.mjs）互补：那边列位移折叠只给 Γ；这里要求实空间力常数 Φ_{ij}(R)
// （块间含格矢 R），按 D(q)=(1/√m_im_j)Σ_R Φ_{ij}(R)e^{iq·R} 外推到任意 q，
// 在 q 网格上对角化得声子谱 ω(q)，再算态密度与热力学。
//
// 物理与数值纪律：
// - D(q) 是复 Hermitian（C 实对称 + iS，S 实反对称）；用 2n×2n 实对称嵌入
//   M=[[C,−S],[S,C]] 求解，其本征值是 D 本征值的两倍重数，排序后取偶下标即谱。
// - 频率换算复用 phonon.mjs 的 CODATA 推导因子（λ[eV/(Å²·amu)] → THz）。
// - ω=0 的声学零模（Γ 点三支）在热力学积分里按 <freqTol 过滤剔除（标准做法，
//   phonopy 同款；q→0 测度为零，不排除会让 F_vib/S 出现 ln0 发散）——过滤条数随交付报告，不静默。
// - Debye C_v(T) 作对照用连续介质 Debye 模型（3D，θ_D 由 ω_max 导出，显式声明），
//   与离散格点对账；两者一致是数值正确性的判据，不是把 Debye 当真实结果冒充格点。
// - 本模块不触碰引擎，Φ_{ij}(R) 由调用方（工具层）从超胞力响应提取后注入。

import { SQRT_EV_A2_AMU_TO_THZ, THZ_TO_MEV } from './phonon.mjs'
import { symmetricEigenvalues } from '@toki0413/core/eig'

/** k_B（meV/K，CODATA-2018：8.617333262e-5 eV/K） */
export const KB_MEV_PER_K = 8.617_333_262e-2
/** 气体常数 R = N_A·k_B（J/mol/K），热容/熵的摩尔换算 */
export const R_J_PER_MOL_K = 8.314_462_618

const bzError = (code, msg) => Object.assign(new Error(`${msg} (${code})`), { code })

// ── 实对称矩阵特征值：用 @toki0413/core/eig 的 symmetricEigenvalues（全仓唯一实现）──────

/**
 * 复 Hermitian C+iS（C 实对称、S 实反对称）的本征值（升序，实数）。
 * 用 2n×2n 实对称嵌入解，取每对重根之一。
 */
export function hermitianEigenvalues(C, S) {
  const n = C.length
  const M = Array.from({ length: 2 * n }, () => new Array(2 * n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      M[i][j] = C[i][j]
      M[n + i][n + j] = C[i][j]
      M[i][n + j] = -S[i][j]
      M[n + i][j] = S[i][j]
    }
  }
  const ev = symmetricEigenvalues(M)
  // 每个本征值出现两次（升序排列相邻成对）→ 取偶下标
  const out = []
  for (let i = 0; i < n; i++) out.push(ev[2 * i])
  return out
}

/**
 * 给定实空间力常数，在倒空间 q（分数坐标 [q1,q2,q3]）构造动力学矩阵并求频率。
 * @param {object} fc 实空间力常数集合：
 *   { nAtoms, masses:[amu], cell:[[a0],[a1],[a2]](Å), blocks:[ {i,j,R:[n1,n2,n3], phi:[[3×3] eV/Å²]} ] }
 *   其中 phi[iα,jβ](R) = 0 胞原子 i 因 R 胞原子 j 位移受到的力常数；
 *   调用方须保证牛顿第三与声学求和（Σ_R,j Φ_ij=0）已处理，本模块不擅自修正。
 * @param {number[]} qFrac 分数坐标（0..1 沿各倒格矢）
 * @returns { lambdas:number[](eV/(Å²·amu) 升序), frequenciesTHz:number[](升序，负=虚频) }
 */
export function phononFrequenciesAtQ(fc, qFrac) {
  const { nAtoms, masses, cell, blocks } = fc
  if (!Array.isArray(blocks)) throw bzError('BZ_BAD_FC', 'fc.blocks must be an array')
  const dim = 3 * nAtoms
  const C = Array.from({ length: dim }, () => new Array(dim).fill(0))
  const S = Array.from({ length: dim }, () => new Array(dim).fill(0))
  for (const { i, j, R, phi } of blocks) {
    const phase = 2 * Math.PI * (qFrac[0] * R[0] + qFrac[1] * R[1] + qFrac[2] * R[2])
    const w = Math.sqrt(masses[i] * masses[j])
    const cosP = Math.cos(phase) / w
    const sinP = Math.sin(phase) / w
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        const p = phi[a][b]
        C[i * 3 + a][j * 3 + b] += p * cosP
        S[i * 3 + a][j * 3 + b] += p * sinP
      }
    }
  }
  // D = (C_real + i S)/1，须 Hermitian：对称化实部、反对称化虚部（吸收数值残余）
  const Cs = C.map((r, i) => r.map((v, j) => (v + C[j][i]) / 2))
  const Sa = S.map((r, i) => r.map((v, j) => (v - S[j][i]) / 2))
  const lambdas = hermitianEigenvalues(Cs, Sa)
  const frequenciesTHz = lambdas.map((l) => Math.sign(l) * Math.sqrt(Math.abs(l)) * SQRT_EV_A2_AMU_TO_THZ + 0)
  return { lambdas, frequenciesTHz, cell }
}

/** Monkhorst–Pack 简化版：n×n×n Γ 心网格（分数坐标 q ∈ [0,1)），返回 {q, weight} 列表 */
export function gammaMesh(n) {
  if (!Number.isInteger(n) || n < 1) throw bzError('BZ_BAD_MESH', `mesh n must be positive integer; got ${n}`)
  const pts = []
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      for (let c = 0; c < n; c++) {
        // Γ 心：q = i/n（含 0），权重均等（对称约化略，诚实按全网格等权）
        pts.push({ q: [a / n, b / n, c / n], weight: 1 })
      }
    }
  }
  return pts
}

/**
 * 由 q 网格频率求高斯展宽态密度（每原胞，含全部 3N 支）。
 * @returns { omega:number[](THz 格点), dos:number[] }
 */
export function dosFromMesh(fc, { n = 8, emin = 0, emax = null, sigmaTHz = 0.05, points = 200 } = {}) {
  const mesh = gammaMesh(n)
  const all = []
  for (const { q } of mesh) {
    const { frequenciesTHz } = phononFrequenciesAtQ(fc, q)
    for (const f of frequenciesTHz) if (f > 1e-6) all.push(f) // 剔除声学零模与虚频（DOS 只对正频）
  }
  const hi = emax ?? Math.max(...all, sigmaTHz * 3)
  const grid = Array.from({ length: points }, (_, k) => emin + ((hi - emin) * k) / (points - 1))
  const dos = new Array(points).fill(0)
  const norm = 1 / (sigmaTHz * Math.sqrt(2 * Math.PI) * all.length)
  for (const f of all) {
    for (let k = 0; k < points; k++) {
      const d = (grid[k] - f) / sigmaTHz
      dos[k] += Math.exp(-0.5 * d * d) * norm
    }
  }
  return { omega: grid, dos, nModes: all.length }
}

/**
 * 一组频率（THz）在温度 T(K) 下的量子谐振子热力学（每模求和，Per 输入频率集）。
 * 返回（均已按传入 frequencies 全模求和）：
 *   cvKb        C_v / k_B（无量纲，每输入集的模数贡献）
 *   cvJmolK     C_v（J/mol/K，把输入集当作“每原胞全部支”再乘 R/k_B → 摩尔）
 *   energyMeV   振动内能 U_vib（meV，含零点能）
 *   zpeMeV      零点能（meV）
 *   freeMeV     振动亥姆霍兹自由能 F_vib（meV，不含平移/构型项，声明边界）
 *   sJmolK      振动熵 S_vib（J/mol/K）
 * 频率≤tol 的声学零模被剔除（不参与热力学；返回 filteredOut 条数）。
 */
export function thermoFromFrequenciesTHz(frequenciesTHz, T, { freqTolTHz = 1e-6 } = {}) {
  if (!Number.isFinite(T) || T <= 0) throw bzError('BZ_BAD_TEMPERATURE', `T must be > 0 K; got ${T}`)
  let cv = 0, u = 0, f = 0, filtered = 0
  for (const thz of frequenciesTHz) {
    if (!Number.isFinite(thz) || thz <= freqTolTHz) { filtered++; continue }
    const E = thz * THZ_TO_MEV           // ħω (meV)
    const x = E / (KB_MEV_PER_K * T)     // 无量纲 ħω/kT
    const sh = Math.sinh(x / 2)
    cv += (x / (2 * sh)) ** 2            // C_v/k_B 每模
    const nbar = 1 / (Math.exp(x) - 1)   // Bose 占据
    u += E * (0.5 + nbar)                // U 每模（含零点能）
    f += KB_MEV_PER_K * T * Math.log(2 * sh) // F_vib 每模（meV）
  }
  const zpe = frequenciesTHz.reduce((s, thz) => (thz > freqTolTHz ? s + 0.5 * thz * THZ_TO_MEV : s), 0)
  // 熵：先算每模集在 k_B 单位的无量纲值 s/k_B=(U−F)/(k_B T)，再×R 得摩尔（与 cvJmolK 同一换算，杜绝魔法数）
  const sReduced = (u - f) / (KB_MEV_PER_K * T)
  return {
    cvKb: cv,
    cvJmolK: cv * R_J_PER_MOL_K,                 // 每输入模集 = 每原胞全部支 → J/mol/K
    energyMeV: u,
    zpeMeV: zpe,
    freeMeV: f,
    sJmolK: sReduced * R_J_PER_MOL_K,
    filteredOut: filtered,
    temperatureK: T,
  }
}

/** 3D Debye 模型每原子 C_v 的德拜热容 C_v=9Nk_B(T/θ)³∫₀^{θ/T} t⁴eᵗ/(eᵗ−1)²dt（对照用，Simpson 数值积分）
 *  高温 → 3N·R（Dulong–Petit）；低温 → (12π⁴/5)N·R·(T/θ)³ ∝ T³ */
export function debyeCv3D(thetaK, T, { atoms = 1 } = {}) {
  if (T <= 0) return 0
  const y = thetaK / T
  const integrand = (t) => {
    if (t < 1e-9) return t * t // t⁴eᵗ/(eᵗ−1)² → t² as t→0
    const et = Math.exp(t)
    return (t * t * t * t * et) / ((et - 1) * (et - 1))
  }
  const steps = Math.max(200, Math.ceil(y * 40))
  const h = y / steps
  let sum = integrand(0) + integrand(y)
  for (let k = 1; k < steps; k++) sum += integrand(k * h) * (k % 2 ? 4 : 2)
  const integral = (sum * h) / 3
  return 9 * atoms * R_J_PER_MOL_K * (integral / (y * y * y))
}

/** Debye 温度（从 ω_max 导出，显式声明为单截止近似，非拟合） */
export function debyeTemperatureFromMax(fMaxTHz) {
  return (fMaxTHz * THZ_TO_MEV) / KB_MEV_PER_K
}

/** 高斯展宽态密度（给定频率集 THz）：归一化到总模数=1 */
export function gaussianDosFromFreqs(freqsTHz, { emin = 0, emax = null, sigmaTHz = 0.05, points = 200 } = {}) {
  const pos = freqsTHz.filter(f => f > 0)
  const hi = emax ?? (pos.length ? Math.max(...pos) : sigmaTHz * 3)
  const grid = Array.from({ length: points }, (_, k) => emin + ((hi - emin) * k) / (points - 1))
  const dos = new Array(points).fill(0)
  if (!pos.length) return { omega: grid, dos, nModes: 0 }
  const norm = 1 / (sigmaTHz * Math.sqrt(2 * Math.PI) * pos.length)
  for (const fq of pos) {
    for (let k = 0; k < points; k++) {
      const d = (grid[k] - fq) / sigmaTHz
      dos[k] += Math.exp(-0.5 * d * d) * norm
    }
  }
  return { omega: grid, dos, nModes: pos.length }
}

/**
 * 全布里渊区声子热力学编排：在 Γ 心 n×n×n 网格采全部声子支 → 每原胞归一的
 * C_v(T)/熵/振动自由能 + Debye 对照 + 态密度。虚频（动力学不稳定）如实计数并置 validity。
 * @param {object} fc 实空间力常数（runForceConstants 产物）
 * @param {{mesh?:number, temperatureGrid?:number[], freqTolTHz?:number}} opts
 */
export function runPhononThermo(fc, { mesh = 12, temperatureGrid = [50, 100, 150, 200, 300], freqTolTHz = 1e-6 } = {}) {
  if (!fc || !Array.isArray(fc.blocks)) throw bzError('BZ_BAD_FC', 'runPhononThermo requires fc.blocks (from runForceConstants)')
  if (!Array.isArray(temperatureGrid) || temperatureGrid.length === 0) throw bzError('BZ_BAD_TEMPERATURE', 'temperatureGrid must be a non-empty array')
  for (const T of temperatureGrid) if (!Number.isFinite(T) || T <= 0) throw bzError('BZ_BAD_TEMPERATURE', `each T must be > 0 K; got ${T}`)
  const meshPts = gammaMesh(mesh)
  const Nq = meshPts.length
  const allFreqs = []
  let acousticZero = 0, imaginary = 0
  for (const { q } of meshPts) {
    for (const f of phononFrequenciesAtQ(fc, q).frequenciesTHz) {
      if (f > freqTolTHz) allFreqs.push(f)
      else if (f < -freqTolTHz) imaginary++
      else acousticZero++
    }
  }
  const fMax = allFreqs.length ? Math.max(...allFreqs) : 0
  const thetaDK = fMax > 0 ? debyeTemperatureFromMax(fMax) : 0
  const nAtoms = fc.nAtoms
  const perCell = (v) => v / Nq // 每原胞（对全部 q 点平均）
  const zeroPointMeVPerCell = perCell(allFreqs.reduce((s, f) => s + 0.5 * f * THZ_TO_MEV, 0))
  const series = temperatureGrid.map((T) => {
    const agg = thermoFromFrequenciesTHz(allFreqs, T, { freqTolTHz })
    return {
      T,
      cvJmolK: perCell(agg.cvKb) * R_J_PER_MOL_K,
      sJmolK: perCell(agg.sJmolK),
      uVibMeV: perCell(agg.energyMeV),
      fVibMeV: perCell(agg.freeMeV),
      debyeCvJmolK: debyeCv3D(thetaDK, T, { atoms: nAtoms }),
    }
  })
  return {
    mesh: { n: mesh, nPoints: Nq, modesPerCell: nAtoms * 3 },
    series,
    dos: gaussianDosFromFreqs(allFreqs),
    summary: {
      maxFrequencyTHz: fMax,
      thetaDK,
      zeroPointEnergyMeVPerCell: zeroPointMeVPerCell,
      acousticZeroModesFiltered: acousticZero,
      imaginaryModes: imaginary,
      valid: imaginary === 0, // 有虚频 → 参考结构偏离平衡或真不稳定，热力学量不可信
    },
    units: {
      cv: 'J/mol/K（每化学式单位 = 每原胞，网格平均）',
      entropy: 'J/mol/K',
      energy: 'meV/原胞（含零点能）',
      frequency: 'THz',
      debye: '连续介质 Debye 模型（3D, θ_D=ħω_max/k_B）作数值对照，非格点结果冒充',
    },
    note: 'C_v/S/F 由 q 网格上玻尔兹曼谐振子求和（每支一个模式）；声学零模（Γ 三支）q→0 测度为零已剔除；'
      + '虚频计数如实交付，>0 则 valid=false 不假装热力学可信。',
  }
}
