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

/** 对称矩阵 Jacobi 特征值（旋转扫掠，确定性；6×6 成本可忽略） */
export function jacobiEigenvalues(Ain) {
  const n = Ain.length
  const A = Ain.map(r => [...r])
  const off = () => {
    let s = 0
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) s += A[i][j] * A[i][j]
    return Math.sqrt(2 * s)
  }
  const scale = Math.max(...A.map((r, i) => Math.abs(r[i])), 1e-300)
  for (let sweep = 0; sweep < 100; sweep++) {
    if (off() < 1e-12 * scale) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue
        const theta = 0.5 * Math.atan2(2 * A[p][q], A[p][p] - A[q][q])
        const c = Math.cos(theta), s = Math.sin(theta)
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q]
          A[k][p] = c * akp - s * akq
          A[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k]
          A[p][k] = c * apk - s * aqk
          A[q][k] = s * apk + c * aqk
        }
      }
    }
  }
  return Array.from({ length: n }, (_, i) => A[i][i]).sort((a, b) => a - b)
}

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
