// 声子分析纯函数层 —— 契约 §4.4 analysis seam（力注入式，neb 先例同构）。
// 有限位移（每原子 × 3 笛卡尔方向 ± d）→ 力常数 Φ（3N×3N，eV/Å²）→
// 声学和规则投影 → Γ 点质量加权动力学矩阵 D → 对称特征分解（Jacobi，确定性）→ 频率。
// 物理与数值要点：
// - 周期性 Γ 点：位移一个原子及其全部周期像（原胞即位移超胞），近邻像贡献自动
//   进入 Φ_ij —— 小原胞下这是 Γ 点动力学的标准有限差分方案；不做对称性缩减，
//   成本 6N+1 次力调用，只适合小原胞（N ≲ 10）
// - 声学和规则（Σ_j Φ_ij = 0）不是近似而是平移不变性的物理要求：数值差分残余
//   显式投影掉（等价于修正自作用块 Φ_ii），投影前残余如实报告，不静默；
//   投影后 Γ 点声学三支精确为零频（均匀位移向量落在 D 的零空间）
// - 负特征值（ω² < 0）= 虚频，是物理结果不是错误：stability 判定按显式阈值
//   声明，判定与阈值一起交付（声明即对账，禁止把虚频粉饰成稳定）
// - 力对称残余 |F(+d) + F(−d)| 与平衡点残余力（零位移力）随结果交付：
//   前者度量非简谐强度，后者度量参考结构偏离平衡的程度——两者过大时
//   差分力常数不可信，由消费方（工作流层）决定是否升级为硬失败
// 分层纪律与 §4.3/§4.4 一致：本模块不触碰引擎，力由调用方注入；
// 不知道力来自哪个 provider。

export function phononError(code, message) {
  const e = new Error(`${message} (${code})`)
  e.code = code
  return e
}

// 频率换算因子（从 CODATA-2018 基本常数推导，不硬编码拍脑袋）：
//   ω² [eV/(Å²·amu)] → ω [rad/s]：ω = sqrt(λ · e / (Å² · amu))
//   其中 e = 1.602176634e-19 J，Å = 1e-10 m，amu = 1.66053906660e-27 kg
//   f [THz] = ω / (2π · 1e12) ≈ 15.6333 · sqrt(λ)
export const SQRT_EV_A2_AMU_TO_THZ =
  Math.sqrt(1.602176634e-19 / (1e-20 * 1.66053906660e-27)) / (2 * Math.PI * 1e12)

/** 1 THz ↔ meV（h·f，h = 4.135667696 meV/THz，同 CODATA-2018） */
export const THZ_TO_MEV = 4.135667696

/** 标准原子量（amu，IUPAC 2021），与 core/elements.mjs 的元素子集对齐。
 *  缺失元素显式报错而非默认质量（诚实纪律：错误质量产生错误的声子频率）。 */
export const MASS_AMU = {
  1: 1.008, 3: 6.94, 6: 12.011, 8: 15.999, 13: 26.982, 14: 28.085,
  18: 39.95, 22: 47.867, 26: 55.845, 28: 58.693, 29: 63.546,
  46: 106.42, 47: 107.868, 78: 195.084, 79: 196.967,
}

/** 有限位移作业表：每原子 × 3 笛卡尔方向 × ±，共 6N 项 */
export function displacementJobs(nAtoms) {
  const jobs = []
  for (let j = 0; j < nAtoms; j++) {
    for (let beta = 0; beta < 3; beta++) {
      jobs.push({ atomIndex: j, direction: beta, sign: 1 })
      jobs.push({ atomIndex: j, direction: beta, sign: -1 })
    }
  }
  return jobs
}

// ── 超胞列位移法（簇边界伪影修复）────────────────────────────
// 背景：部分引擎（如 ASE EMT）忽略周期性——"原胞=超胞"差分只测到原胞内
// 近邻（fcc conventional 每原子 12 最近邻仅 3 个在簇内），声子大面积伪虚频。
// 方法：构建 N×N×N 超胞，把原胞原子 j 的全部超胞像同时位移（"列位移"），
// 力差分直接给出 Γ 点力常数列（Σ_R 合成已由列位移完成）；对原胞原子 i
// 取其全部像的响应平均（边界缺失像的贡献由对称平均降噪）。
// 作业数仍为 6N+1，代价只是单次力计算的原子数变大 N³ 倍。
// 适用前提：超胞半边长覆盖引擎力程（rep=3 时 cubic 金属充分；短程势安全）。

/**
 * 构建超胞。
 * @returns {{ graph: object, cellIndex: number[] }}
 *   cellIndex[k] = 超胞第 k 个原子对应的原胞原子下标（0..nAtoms-1）
 */
export function buildSupercell(graph, rep) {
  const [nx, ny, nz] = rep
  const cell = graph.cell
  if (!Array.isArray(rep) || rep.length !== 3 || [nx, ny, nz].some(r => !Number.isInteger(r) || r < 1)) {
    throw phononError('PHONON_BAD_SUPERCELL',
      `rep must be three positive integers; got ${JSON.stringify(rep)}`)
  }
  if (!Array.isArray(cell) || cell.length !== 3) {
    throw phononError('PHONON_BAD_GRAPH', 'graph.cell must be a 3×3 matrix')
  }
  const nodes = graph.nodes
  const cellIndex = []
  const positions = []
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        // 平移矢量 L = ix·A0 + iy·A1 + iz·A2（行矢量组合）
        const L = [0, 1, 2].map(a => ix * cell[0][a] + iy * cell[1][a] + iz * cell[2][a])
        for (let k = 0; k < nodes.length; k++) {
          const p = nodes[k].position
          positions.push([p[0] + L[0], p[1] + L[1], p[2] + L[2]])
          cellIndex.push(k)
        }
      }
    }
  }
  const superCell = [
    cell[0].map(x => x * nx),
    cell[1].map(x => x * ny),
    cell[2].map(x => x * nz),
  ]
  return {
    graph: {
      cell: superCell,
      nodes: positions.map((p, k) => ({ number: nodes[cellIndex[k]].number, position: p })),
    },
    cellIndex,
  }
}

/**
 * Γ 点声子分析主入口。
 * @param {object} graph Saturday AtomGraph（cell 3×3、nodes[].number / position）
 * @param {async (variantGraph) => { forces: number[][], calculator?: string }} forceProvider
 *   力注入：接收位移变体 graph，返回每原子 [fx, fy, fz]（eV/Å）。
 *   原胞模式 6N+1 次；超胞模式同样 6N+1 次（每次原子数 N³ 倍）。
 * @param {{ displacement?: number, applyAsr?: boolean, stableTolOmegaSq?: number,
 *           supercellRep?: [number, number, number] }} options
 *   displacement 有限位移步长（Å，默认 0.01）；applyAsr 声学和规则投影（默认 true）；
 *   stableTolOmegaSq 稳定性判定的 ω² 阈值（eV/Å²/amu，默认 1e-4 ≈ 0.16 THz）；
 *   supercellRep 超胞重复数（缺省 [1,1,1] = 原胞直接差分；力引擎忽略周期性时
 *   必须用 ≥[2,2,2]，推荐 [3,3,3]）
 */

/** 位移变体 graph（纯函数）：原子 atomIndex 沿笛卡尔 direction 移动 sign·displacement */
export function displacedGraph(graph, job, displacement) {
  const g = structuredClone(graph)
  const { atomIndex, direction, sign } = job
  g.nodes[atomIndex].position[direction] += sign * displacement
  return g
}

// ── 对称矩阵 Jacobi 特征分解（确定性，无随机重启）────────────────
// 经典旋转扫掠：非对角范数收敛即停。3N ≤ 30 量级成本可忽略。

function jacobiEigen(Ain, n) {
  const A = Ain.map(row => [...row])
  const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))
  const offNorm = () => {
    let s = 0
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) s += A[i][j] * A[i][j]
    return Math.sqrt(2 * s)
  }
  const scale = Math.max(...A.map((row, i) => Math.abs(row[i])), 1e-300)
  for (let sweep = 0; sweep < 100; sweep++) {
    if (offNorm() < 1e-14 * scale) break
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-18 * scale) continue
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q])
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
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
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q]
          V[k][p] = c * vkp - s * vkq
          V[k][q] = s * vkp + c * vkq
        }
      }
    }
  }
  const values = A.map((row, i) => row[i])
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i)
  return {
    values: order.map(i => values[i]),
    vectors: order.map(i => V.map(row => row[i])),
  }
}

/**
 * 声子 Γ 点分析主入口。
 * @param {object} graph Saturday AtomGraph（cell 3×3、nodes[].number / position）
 * @param {async (variantGraph) => { forces: number[][], calculator?: string }} forceProvider
 *   力注入：接收位移变体 graph，返回每原子 [fx, fy, fz]（eV/Å）。零位移调用一次 +
 *   每作业一次，共 6N+1 次。
 * @param {{ displacement?: number, applyAsr?: boolean, stableTolOmegaSq?: number }} options
 *   displacement 有限位移步长（Å，默认 0.01）；applyAsr 声学和规则投影（默认 true）；
 *   stableTolOmegaSq 稳定性判定的 ω² 阈值（eV/Å²/amu，默认 1e-4 ≈ 0.16 THz）
 * @returns {{
 *   nAtoms, displacement, calculator,
 *   frequencies: number[],            // THz，3N 支，升序，负值 = 虚频（声子界惯例）
 *   imaginary: { count: number, maxOmegaSq: number },
 *   stability: { verdict: 'stable'|'unstable', thresholdOmegaSq: number },
 *   forceResidualMax: number,         // |F(+d)+F(−d)|/2 的最大范数（非简谐指标，eV/Å）
 *   equilibriumForceMax: number,      // 零位移（参考结构）残余力范数最大值（eV/Å）
 *   asrResidualBefore: number,        // ASR 投影前的和规则残余（eV/Å²）
 *   asrApplied: boolean,
 * }}
 */
export async function runPhononAnalysis(graph, forceProvider, options = {}) {
  const {
    displacement = 0.01,
    applyAsr = true,
    stableTolOmegaSq = 1e-4,
    supercellRep = [1, 1, 1],
  } = options

  if (typeof forceProvider !== 'function') {
    throw phononError('PHONON_FORCE_PROVIDER_MISSING',
      'runPhononAnalysis requires a forceProvider (variantGraph) => { forces }')
  }
  if (!Number.isFinite(displacement) || displacement <= 0) {
    throw phononError('PHONON_BAD_DISPLACEMENT',
      `displacement must be a positive finite number (Å); got ${displacement}`)
  }
  const nodes = graph?.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw phononError('PHONON_BAD_GRAPH', 'graph.nodes must be a non-empty array')
  }
  if (!Array.isArray(graph?.cell) || graph.cell.length !== 3) {
    throw phononError('PHONON_BAD_GRAPH', 'graph.cell must be a 3×3 matrix')
  }
  const nAtoms = nodes.length
  const masses = nodes.map(n => {
    const m = MASS_AMU[n?.number]
    if (!Number.isFinite(m)) {
      throw phononError('PHONON_MASS_MISSING',
        `no standard atomic mass for Z=${n?.number}; extend MASS_AMU explicitly`)
    }
    return m
  })

  // 工作体系：原胞（直接差分）或超胞（列位移，簇边界伪影修复）
  if (!Array.isArray(supercellRep) || supercellRep.length !== 3
    || supercellRep.some(r => !Number.isInteger(r) || r < 1)) {
    throw phononError('PHONON_BAD_SUPERCELL',
      `supercellRep must be three positive integers; got ${JSON.stringify(supercellRep)}`)
  }
  const useSupercell = supercellRep.some(r => r > 1)
  let workGraph = graph
  let cellIndex = null
  if (useSupercell) {
    const sc = buildSupercell(graph, supercellRep)
    workGraph = sc.graph
    cellIndex = sc.cellIndex
  }

  // 列位移：原胞模式位移单原子；超胞模式位移原胞原子 j 的全部超胞像
  const displace = (job, sign) => {
    if (!cellIndex) return displacedGraph(graph, job, displacement)
    const g = structuredClone(workGraph)
    for (let k = 0; k < cellIndex.length; k++) {
      if (cellIndex[k] === job.atomIndex) {
        g.nodes[k].position[job.direction] += sign * displacement
      }
    }
    return g
  }
  // 响应折算：原胞模式逐行直通；超胞模式按原胞指标取全部像平均
  const fold = (rows) => {
    if (!cellIndex) return rows
    const out = Array.from({ length: nAtoms }, () => [0, 0, 0])
    const counts = new Array(nAtoms).fill(0)
    for (let k = 0; k < cellIndex.length; k++) {
      const i = cellIndex[k]
      for (let a = 0; a < 3; a++) out[i][a] += rows[k][a]
      counts[i]++
    }
    for (let i = 0; i < nAtoms; i++) {
      if (counts[i] === 0) throw phononError('PHONON_BAD_SUPERCELL', `supercell missing images of atom ${i}`)
      for (let a = 0; a < 3; a++) out[i][a] /= counts[i]
    }
    return out
  }

  // 零位移力：平衡点残余，随结果交付（差分可信度指标）
  const eq = await forceProvider(workGraph)
  const eqForces = eq?.forces
  let equilibriumForceMax = 0
  if (!Array.isArray(eqForces) || eqForces.length !== workGraph.nodes.length) {
    throw phononError('PHONON_BAD_FORCE',
      `forceProvider returned forces with wrong shape at equilibrium (expected ${workGraph.nodes.length} rows)`)
  }
  for (const f of eqForces) {
    if (!Array.isArray(f) || f.length !== 3 || f.some(v => !Number.isFinite(v))) {
      throw phononError('PHONON_BAD_FORCE', 'equilibrium force contains non-finite components')
    }
    equilibriumForceMax = Math.max(equilibriumForceMax, Math.hypot(...f))
  }

  // 有限位移差分：Φ[i][j*3+β] 块由原子 j 沿 β 的 ±位移力差给出
  // （超胞模式下 j 的整列像同时位移，力折算为原胞指标像平均）
  const dim = 3 * nAtoms
  const phi = Array.from({ length: dim }, () => new Array(dim).fill(0))
  let forceResidualMax = 0
  let calculator = eq?.calculator ?? 'injected'
  for (let j = 0; j < nAtoms; j++) {
    for (let beta = 0; beta < 3; beta++) {
      const col = j * 3 + beta
      const plus = await forceProvider(displace({ atomIndex: j, direction: beta, sign: 1 }, 1))
      const minus = await forceProvider(displace({ atomIndex: j, direction: beta, sign: -1 }, -1))
      const fpRaw = plus?.forces, fmRaw = minus?.forces
      if (!Array.isArray(fpRaw) || fpRaw.length !== workGraph.nodes.length
        || !Array.isArray(fmRaw) || fmRaw.length !== workGraph.nodes.length) {
        throw phononError('PHONON_BAD_FORCE',
          `forceProvider returned forces with wrong shape at job (atom ${j}, dir ${beta})`)
      }
      const fp = fold(fpRaw), fm = fold(fmRaw)
      for (let i = 0; i < nAtoms; i++) {
        for (let alpha = 0; alpha < 3; alpha++) {
          const a = fp[i][alpha], b = fm[i][alpha]
          if (!Number.isFinite(a) || !Number.isFinite(b)) {
            throw phononError('PHONON_BAD_FORCE',
              `force contains non-finite components at job (atom ${j}, dir ${beta})`)
          }
          // 中心差分：Φ = −dF/dd；力对称残余 = |F(+) + F(−)|/2（偶阶非简谐指标）
          phi[i * 3 + alpha][col] = -(a - b) / (2 * displacement)
          forceResidualMax = Math.max(
            forceResidualMax,
            Math.abs(a + b) / 2,
          )
        }
      }
      if (typeof plus?.calculator === 'string') calculator = plus.calculator
    }
  }

  let asrResidualBefore = 0
  if (applyAsr) {
    // 投影前残余：每个原子块行 Σ_j Φ_ij^αβ 的最大绝对值（平移不变性破坏量）
    for (let i = 0; i < nAtoms; i++) {
      for (let alpha = 0; alpha < 3; alpha++) {
        for (let beta = 0; beta < 3; beta++) {
          let s = 0
          for (let j = 0; j < nAtoms; j++) s += phi[i * 3 + alpha][j * 3 + beta]
          asrResidualBefore = Math.max(asrResidualBefore, Math.abs(s))
        }
      }
    }
    // 自作用块修正：Φ_ii ← −Σ_{j≠i} Φ_ij（等价于把行块残余归零）
    for (let i = 0; i < nAtoms; i++) {
      for (let alpha = 0; alpha < 3; alpha++) {
        for (let beta = 0; beta < 3; beta++) {
          let s = 0
          for (let j = 0; j < nAtoms; j++) if (j !== i) s += phi[i * 3 + alpha][j * 3 + beta]
          phi[i * 3 + alpha][i * 3 + beta] = -s
        }
      }
    }
  }

  // 对称化 + 质量加权：D_ij = Φ_ij / sqrt(m_i m_j)（Φ 先做 (Φ+Φᵀ)/2）
  const D = Array.from({ length: dim }, () => new Array(dim).fill(0))
  for (let a = 0; a < dim; a++) {
    for (let b = 0; b < dim; b++) {
      const sym = (phi[a][b] + phi[b][a]) / 2
      D[a][b] = sym / Math.sqrt(masses[Math.floor(a / 3)] * masses[Math.floor(b / 3)])
    }
  }

  const { values: lambdas } = jacobiEigen(D, dim)
  // + 0 归一化：-0 会从 ASR 投影（-s，s=0）与 sign(-0) 路径渗入频率，统一归为 +0
  const freqs = lambdas.map(l => Math.sign(l) * Math.sqrt(Math.abs(l)) * SQRT_EV_A2_AMU_TO_THZ + 0)

  // 虚频语义分两层：显著虚频（|λ| > 阈值，物理不稳定）与数值噪声负值
  // （Γ 点声学支在差分精度内的微负 λ，非物理虚频）——两者都如实报告，不静默
  const negLambdas = lambdas.filter(l => l < 0)
  const significantNeg = negLambdas.filter(l => -l > stableTolOmegaSq)
  const maxImag = significantNeg.length > 0 ? Math.max(...significantNeg.map(l => -l)) : 0
  const verdict = maxImag > 0 ? 'unstable' : 'stable'

  return {
    nAtoms,
    displacement,
    calculator,
    supercell: { rep: supercellRep, mode: useSupercell ? 'column-displacement' : 'primitive' },
    frequencies: freqs,
    imaginary: {
      count: significantNeg.length,
      maxOmegaSq: maxImag,
      numericalNegativeCount: negLambdas.length,
    },
    stability: { verdict, thresholdOmegaSq: stableTolOmegaSq },
    forceResidualMax,
    equilibriumForceMax,
    asrResidualBefore,
    asrApplied: applyAsr,
  }
}
