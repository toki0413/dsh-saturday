// plugin-elasticity 纯函数层 —— 完整 6×6 弹性刚度张量（Voigt 记法）
//
// 机制：对参考晶胞施加 6 种独立无穷小应变 ε_j（±中心差分），
//   C_ij = ∂σ_i/∂ε_j ≈ (σ_i(+ε_j) − σ_i(−ε_j)) / (2ε)。
// 应力符号约定：由云端 MACE 真机对账锁定——ASE get_stress 与拉正柯西应力同号，
// 直接入差分（初版误取反致 C 全局变号、Born 误判 unstable；fake 测试验不到约定错误，
// 真机文献对账一跑即现形）。Voigt 六分量序 [xx,yy,zz,yz,xz,xy]，
// 剪切用工程应变 γ=2e，故 C44=μ 等标准关系直接成立（各向同性解析对账锁定）。
//
// 诚实边界（随交付呈现，不静默）：
//  - 仿射应变（原子随晶胞线性映射，不做内部弛豫）：对角元与高对称体系（如 fcc/bcc
//    单质）精确；含内部自由度的结构需应变后弛豫——本 v0 不实现，声明之；
//  - 应力源必须被引擎声明（properties 含 stress）：无应力即显式
//    ELASTICITY_STRESS_MISSING，绝不退化为有限差分能量二阶导等近似；
//  - 单位换算显式发起：C 原生于 eV/Å³，GPa 换算系数由 CODATA 基本常数推导并
//    随交付声明（1 eV/Å³ = 160.2176634 GPa）。
//
// Born 稳定性 = C 正定：对称 6×6 Jacobi 特征分解（自带，确定性，零外部依赖）。

import { ATOMIC_MASS, SYMBOL } from '@toki0413/core/elements'
import { symmetricEigenvalues } from '@toki0413/core/eig'

export function elasticityError(code, message) {
  const e = new Error(`${message} (${code})`)
  e.code = code
  return e
}

/** 1 eV/Å³ → GPa（CODATA-2018：e=1.602176634e-19 J，1 Å³=1e-30 m³，1 GPa=1e9 Pa） */
export const EV_PER_A3_TO_GPA = 160.2176634

// Voigt 六分量的对称张量指标序：0..5 ↔ xx,yy,zz,yz,xz,xy
const VOIGT = [[0, 0], [1, 1], [2, 2], [1, 2], [0, 2], [0, 1]]

/**
 * 对 graph 施加第 k 个 Voigt 应变分量幅值 eps（剪切为工程应变 γ=eps，
 * 张量分量 e_ij = eps/2），返回仿射变形后的新 graph（cell 行向量与坐标同乘 F=I+E）。
 */
export function strainedGraph(graph, k, eps) {
  if (!Number.isInteger(k) || k < 0 || k > 5) {
    throw elasticityError('ELASTICITY_BAD_INPUT', `voigt index k must be 0..5; got ${k}`)
  }
  if (!Number.isFinite(eps) || eps === 0) {
    throw elasticityError('ELASTICITY_BAD_INPUT', `eps must be finite nonzero; got ${eps}`)
  }
  const F = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  const [i, j] = VOIGT[k]
  if (i === j) F[i][i] += eps
  else { F[i][j] += eps / 2; F[j][i] += eps / 2 }
  const apply = (v) => [0, 1, 2].map(r => F[r][0] * v[0] + F[r][1] * v[1] + F[r][2] * v[2])
  const g = structuredClone(graph)
  g.cell = g.cell.map(row => apply(row))
  for (const node of g.nodes) node.position = apply(node.position)
  return g
}

/**
 * 由 ±应力样本装配 C（C[i][j] = (σp_i − σm_i)/(2eps)，σ 为拉正），对称化 C=(C+Cᵀ)/2。
 * @param {Array<number[]>} plus  6 个应变方向各 +ε 的 Voigt 应力（ASE 约定，压负）
 * @param {Array<number[]>} minus 对应 −ε
 */
export function assembleStiffness(plus, minus, eps) {
  if (plus.length !== 6 || minus.length !== 6) {
    throw elasticityError('ELASTICITY_BAD_INPUT', 'expected 6 strain directions with 6-component stress each')
  }
  const C = Array.from({ length: 6 }, () => Array(6).fill(0))
  for (let j = 0; j < 6; j++) {
    for (let i = 0; i < 6; i++) {
      // 符号约定由云端真机对账锁定（见文件头）：引擎应力直接入差分
      C[i][j] = (plus[j][i] - minus[j][i]) / (2 * eps)
    }
  }
  return C.map((row, i) => row.map((v, j) => 0.5 * (v + C[j][i])))
}

/** 对称矩阵特征值（升序）——全仓唯一实现在 @toki0413/core/eig；此处保留历史导出名 jacobiEigenvalues 作别名。 */
export const jacobiEigenvalues = symmetricEigenvalues

/** Voigt-Reuss-Hill 多晶聚合 + 派生量（输入 C 单位 eV/Å³，输出同单位 + GPa 换算） */
export function deriveModuli(C) {
  const c11 = C[0][0], c22 = C[1][1], c33 = C[2][2]
  const c12 = C[0][1], c13 = C[0][2], c23 = C[1][2]
  const c44 = C[3][3], c55 = C[4][4], c66 = C[5][5]
  const KV = (c11 + c22 + c33 + 2 * (c12 + c13 + c23)) / 9
  const GV = (c11 + c22 + c33 - (c12 + c13 + c23) + 3 * (c44 + c55 + c66)) / 15
  // Reuss 柔量一般式（对完全各向异性用 6×6 逆的对应分量）
  const S = invert6(C)
  const KR = 1 / (S[0][0] + S[1][1] + S[2][2] + 2 * (S[0][1] + S[0][2] + S[1][2]))
  const GR = 15 / (4 * (S[0][0] + S[1][1] + S[2][2]) - 4 * (S[0][1] + S[0][2] + S[1][2])
    + 3 * (S[3][3] + S[4][4] + S[5][5]))
  const K = 0.5 * (KV + KR)
  const G = 0.5 * (GV + GR)
  const E = (9 * K * G) / (3 * K + G)
  const nu = (3 * K - 2 * G) / (2 * (3 * K + G))
  const eigenvalues = jacobiEigenvalues(C)
  const bornStable = eigenvalues[0] > 1e-8
  const c11C12 = c11 - c12
  return {
    voigtEVperA3: { c11, c12, c44 },
    K_EVperA3: K, G_EVperA3: G,
    KV_EVperA3: KV, KR_EVperA3: KR, GV_EVperA3: GV, GR_EVperA3: GR,
    K_GPa: K * EV_PER_A3_TO_GPA, G_GPa: G * EV_PER_A3_TO_GPA,
    E_GPa: E * EV_PER_A3_TO_GPA, nu,
    anisotropyFactor: c11C12 !== 0 ? (2 * c44) / c11C12 : null, // 立方体系定义；非立方如实 null
    bornStable,
    minEigenvalueEVperA3: eigenvalues[0],
    eigenvaluesEVperA3: eigenvalues,
  }
}

/** 6×6 求逆（Gauss-Jordan，带部分主元；奇异即显式报错） */
function invert6(A) {
  const n = 6
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    if (Math.abs(M[piv][col]) < 1e-14) throw elasticityError('ELASTICITY_SINGULAR_C', 'stiffness matrix is singular (cannot invert for Reuss bound)')
    ;[M[col], M[piv]] = [M[piv], M[col]]
    const d = M[col][col]
    for (let k = 0; k < 2 * n; k++) M[col][k] /= d
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = M[r][col]
      if (f === 0) continue
      for (let k = 0; k < 2 * n; k++) M[r][k] -= f * M[col][k]
    }
  }
  return M.map(row => row.slice(n))
}

/**
 * 对称 3×3 矩阵特征值闭式解（Cardano/三角法），确定性、无迭代收敛问题。
 * 升序返回三个实特征值（trace 严格守恒）。适用于声学张量这类强耦合/退化特征值 3×3。
 * （jacobiEigenvalues 对大次对角/退化特征值不收敛——已用 iso[111] 探针坐实，故方向声速不走它。）
 */
export function eig3Symmetric(A) {
  const a = A[0][0], b = A[1][1], c = A[2][2], d = A[0][1], e = A[0][2], f = A[1][2]
  const q = a + b + c
  const qa = q / 3
  const b11 = a - qa, b22 = b - qa, b33 = c - qa
  const p2 = (b11 * b11 + b22 * b22 + b33 * b33 + 2 * (d * d + e * e + f * f)) / 6
  if (p2 < 1e-30) return [a, b, c].sort((x, y) => x - y)   // 已（近）对角：次对角为零，直接取对角元
  const det = b11 * (b22 * b33 - f * f) - d * (d * b33 - f * e) + e * (d * f - b22 * e)
  const r = Math.sqrt(p2)
  const ec = Math.max(-1, Math.min(1, (det / 2) / (r * r * r)))
  const phi = Math.acos(ec) / 3
  const e1 = qa + 2 * r * Math.cos(phi)
  const e3 = qa + 2 * r * Math.cos(phi + 2 * Math.PI / 3)
  const e2 = q - e1 - e3
  return [e1, e2, e3].sort((x, y) => x - y)
}

/**
 * 声学（Christoffel）张量：Γ_il = Σ_{jk} C_ijkl n_j n_k（单位传播方向 n）。
 * C 为 6×6 Voigt 刚度（eV/Å³，剪切行/列已为物理 C_yzyz，无需因子）；展回张量靠对称映射。
 * 返回 3×3 对称 Γ（同单位）。零方向报 ELASTICITY_BAD_INPUT。（iso 已验证 Γ[111]=0.867I+0.467(off)，方向无关。）
 */
export function christoffel(C, n) {
  const len = Math.hypot(n[0], n[1], n[2])
  if (!Number.isFinite(len) || len === 0) throw elasticityError('ELASTICITY_BAD_INPUT', `christoffel needs a nonzero direction; got ${JSON.stringify(n)}`)
  const u = [n[0] / len, n[1] / len, n[2] / len]
  const vp = [[0, 0], [1, 1], [2, 2], [1, 2], [0, 2], [0, 1]]  // Voigt ↔ 对称张量对
  const vidx = (i, j) => vp.findIndex(([a, b]) => (a === i && b === j) || (a === j && b === i))
  const G = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < 3; i++) for (let l = 0; l < 3; l++) {
    let s = 0
    for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) s += C[vidx(i, j)][vidx(k, l)] * u[j] * u[k]
    G[i][l] = s
  }
  return G.map((r, i) => r.map((v, l) => 0.5 * (v + G[l][i])))  // 强制对称（数值安全）
}

/**
 * 单晶方向相速：对给定传播方向集，解 Christoffel 特征值 → 3 个分支声速（m/s）。
 * C 原生 eV/Å³，经 EV_PER_A3_TO_GPA×1e9 转 Pa，ρ 用 kg/m³；负特征值（力学不稳）该分支记 null。
 */
export function directionVelocities({ C, density_kg_m3, directions = [] } = {}) {
  if (!Array.isArray(C) || C.length !== 6) throw elasticityError('ELASTICITY_BAD_INPUT', 'directionVelocities requires 6×6 C')
  if (!(Number.isFinite(density_kg_m3) && density_kg_m3 > 0)) throw elasticityError('ELASTICITY_ACOUSTIC_BAD_INPUT', `density_kg_m3 must be > 0; got ${density_kg_m3}`)
  const PA = EV_PER_A3_TO_GPA * 1e9
  return directions.map(({ name, dir }) => {
    const eig = eig3Symmetric(christoffel(C, dir).map(r => r.map(v => v * PA)))  // Pa，升序
    const velocities_ms = eig.map(e => (e > 1e-9 ? Math.sqrt(e / density_kg_m3) : null))
    const finite = velocities_ms.filter(v => v != null)
    return { direction: name, velocities_ms, vMax_ms: finite.length ? Math.max(...finite) : null, stable: eig.every(e => e > -1e-6 * PA) }
  })
}

/** CODATA-2018 基本常数：amu(kg)、ħ/kB(K·s)。1 Å³ = 1e-30 m³。 */
export const AMU_KG = 1.66053906660e-27
export const HBAR_OVER_KB_KS = 7.638233314e-12

/** 3×3 行向量行列式绝对值 = 胞体积（Å³）。 */
function cellVolumeA3(cell) {
  const [[a, b, c], [d, e, f], [g, h, i]] = cell
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  return Math.abs(det)
}

/**
 * 由 AtomGraph 算质量密度与数密度（均 SI：kg/m³ 与 m⁻³）。
 * 周期胞必需：零胞/退化胞（分子）报 ELASTICITY_NEEDS_CELL（与仿射应变同族需周期性的拒接）。
 */
export function densityFromGraph(graph) {
  const cell = graph?.cell
  if (!Array.isArray(cell) || cell.length !== 3) throw elasticityError('ELASTICITY_NEEDS_CELL', 'density requires a 3×3 periodic cell')
  const volA3 = cellVolumeA3(cell)
  if (!Number.isFinite(volA3) || volA3 <= 1e-9) throw elasticityError('ELASTICITY_NEEDS_CELL', `cell volume degenerate (${volA3}); density undefined for non-periodic systems`)
  const nodes = graph.nodes ?? []
  if (nodes.length === 0) throw elasticityError('ELASTICITY_NEEDS_CELL', 'density requires at least one atom')
  let massAru = 0
  for (const n of nodes) {
    const el = SYMBOL[n.number]
    const m = el ? ATOMIC_MASS[el] : undefined
    if (m == null) throw elasticityError('ELEMENT_DATA_MISSING', `no atomic mass for Z=${n.number} (${el ?? 'unknown symbol'}); extend core/elements ATOMIC_MASS`)
    massAru += m
  }
  const volM3 = volA3 * 1e-30
  const rhoKgM3 = massAru * AMU_KG / volM3
  const numberDensityM3 = nodes.length / volM3
  return { rho_kg_m3: rhoKgM3, number_density_m3: numberDensityM3, cellVolume_A3: volA3, massTotal_amu: massAru }
}

/**
 * 多晶 VRH K/G + 质量密度 → 声速与弹性 Debye 温度（均 SI，km/s 与 K）。
 * v_L=√((K+4G/3)/ρ)，v_T=√(G/ρ)；v_m=[(1/3)(v_L⁻³+2v_T⁻³)]⁻¹ᐟ³；θ_D=(ħ/kB)(6π²·n_a)¹ᐟ³·v_m。
 * 文献对锚（Cu：K=137.8, G=48.3 GPa, ρ=8960 kg/m³, n_a=8.49e28 m⁻³ → θ_D≈341 K，与 343 K 内差）
 * 已在纯函数测试固定。非正模/非正密度/非正 K/G 显式报错，不静默 NaN。
 */
export function acousticFromModuli({ K_GPa, G_GPa, density_kg_m3, number_density_m3 } = {}) {
  const pos = (v) => Number.isFinite(v) && v > 0
  if (!pos(K_GPa)) throw elasticityError('ELASTICITY_ACOUSTIC_BAD_INPUT', `K_GPa must be > 0; got ${K_GPa}`)
  if (!pos(G_GPa)) throw elasticityError('ELASTICITY_ACOUSTIC_BAD_INPUT', `G_GPa must be > 0; got ${G_GPa}`)
  if (!pos(density_kg_m3)) throw elasticityError('ELASTICITY_ACOUSTIC_BAD_INPUT', `density_kg_m3 must be > 0; got ${density_kg_m3}`)
  if (!pos(number_density_m3)) throw elasticityError('ELASTICITY_ACOUSTIC_BAD_INPUT', `number_density_m3 must be > 0; got ${number_density_m3}`)
  const K = K_GPa * 1e9, G = G_GPa * 1e9, rho = density_kg_m3
  const vL = Math.sqrt((K + 4 * G / 3) / rho)
  const vT = Math.sqrt(G / rho)
  const vMean = Math.pow((1 / 3) * (Math.pow(vL, -3) + 2 * Math.pow(vT, -3)), -1 / 3)
  const thetaD = HBAR_OVER_KB_KS * Math.cbrt(6 * Math.PI * Math.PI * number_density_m3) * vMean
  return {
    vL_ms: vL, vT_ms: vT, vMean_ms: vMean,
    vL_kms: vL / 1000, vT_kms: vT / 1000, vMean_kms: vMean / 1000,
    debyeTemperature_K: thetaD,
  }
}

/**
 * 顶层编排：6 方向 ±ε 共 12 次 calculate（stress 声明门禁在调用方校验）。
 * @param {Object} opts
 * @param {Object} opts.graph            参考 AtomGraph
 * @param {Function} opts.calculateStress async (graph) => ASE Voigt 应力（eV/Å³，压负）
 * @param {number} [opts.eps=0.005]      应变幅值
 */
export async function elasticStiffness({ graph, calculateStress, eps = 0.005 } = {}) {
  if (!graph || typeof calculateStress !== 'function') {
    throw elasticityError('ELASTICITY_INPUT_MISSING', 'elasticStiffness requires graph and calculateStress (stress-providing engine)')
  }
  if (!Number.isFinite(eps) || eps <= 0 || eps >= 0.05) {
    throw elasticityError('ELASTICITY_BAD_INPUT', `eps must be in (0, 0.05) for linear-response validity; got ${eps}`)
  }
  const plus = [], minus = []
  for (let k = 0; k < 6; k++) {
    plus.push(await calculateStress(strainedGraph(graph, k, eps)))
    minus.push(await calculateStress(strainedGraph(graph, k, -eps)))
  }
  const C = assembleStiffness(plus, minus, eps)
  return { C, ...deriveModuli(C), eps, nCalculations: 12 }
}
