// plugin-xrd 纯函数层 —— 契约 §4.4 analysis seam：X 射线粉末衍射（运动学、单色）。
//
// 严格 vs 近似，边界写死（不粉饰）：
//  - 严格：倒格度规 G*、晶面间距 d(hkl)=1/√(Hᵀ G* H)、Bragg 2θ、几何结构因子
//    F(hkl)=Σ_j f_j·e^{2πi H·r_j} 的**相位**与由此决定的系统消光（bcc/fcc/金刚石
//    等）——这些只依赖点阵中心化的基矢几何，与 f 的具体数值无关，可闭式精确验证。
//  - 近似（显式声明，不冒充校准强度）：默认原子形状因子 f≈Z（前向散射，小角近似），
//    未含 Cromer-Mann 反常色散、Debye-Waller、Lorentz-偏振、吸收、织构、择优取向；
//    交付的相对强度 = |F(hkl)|² 按等 d 分组求和，仅供峰位与消光判读，非实验定量强度。
//  - 若要校准强度：注入自定义 formFactor(s, Z)（如真 Cromer-Mann 系数表，另置数据模块，
//    带来源标注），本层不内置可能记错的系数（诚实：宁缺毋滥）。
//
// 分层纪律同 phonon/eos：本模块不触碰引擎，纯几何/复数运算，确定性（无随机、无迭代不收敛风险）。

export function xrdError(code, message) {
  const e = new Error(`${message} (${code})`)
  e.code = code
  return e
}

// Cu Kα1 特征波长（Å，CODATA/NIST 常见值）——仅作默认演示辐射，非硬编码依赖
export const CU_KA_A = 1.54056
export const TWO_PI = 2 * Math.PI

// ── 3×3 矩阵工具（零依赖）──────────────────────────────────────
export function det3(m) {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}
export function inv3(m) {
  const d = det3(m)
  if (Math.abs(d) < 1e-18) throw xrdError('XRD_SINGULAR_CELL', `cell metric determinant ≈0; got ${d}`)
  const c = (i, j) => {
    const r = [0, 1, 2].filter(k => k !== i)
    const cc = [0, 1, 2].filter(k => k !== j)
    return ((i + j) % 2 ? -1 : 1) * (m[r[0]][cc[0]] * m[r[1]][cc[1]] - m[r[0]][cc[1]] * m[r[1]][cc[0]])
  }
  // 伴随矩阵转置后除以行列式：inv[j][i] = cofactor(i,j)/d
  return [[c(0, 0), c(1, 0), c(2, 0)], [c(0, 1), c(1, 1), c(2, 1)], [c(0, 2), c(1, 2), c(2, 2)]].map(row => row.map(v => v / d))
}

/** 实空间度规 g_ij = a_i·a_j（cell 行矢量为 a_i） */
export function realMetric(cell) {
  return [0, 1, 2].map(i => [0, 1, 2].map(j => cell[i][0] * cell[j][0] + cell[i][1] * cell[j][1] + cell[i][2] * cell[j][2]))
}

/** 倒格度规 G* = g⁻¹（晶体学约定 a_i*·a_j=δ_ij，不含 2π 因子） */
export function reciprocalMetric(cell) { return inv3(realMetric(cell)) }

/** 晶面间距 d(hkl) = 1/√(Hᵀ G* H) */
export function dSpacing(cell, hkl) {
  const G = reciprocalMetric(cell)
  let s = 0
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += hkl[i] * G[i][j] * hkl[j]
  if (s <= 0) throw xrdError('XRD_BAD_HKL', `H·G*·H must be > 0 for a valid reflection; got ${s}`)
  return 1 / Math.sqrt(s)
}

/** 笛卡尔 → 分数坐标：cart = Σ f_i a_i（cell 行矢量）⇒ f = cart · cell⁻¹ */
export function toFractional(cell, cart) {
  const Ainv = inv3(cell)
  return [0, 1, 2].map(a => cart[0] * Ainv[0][a] + cart[1] * Ainv[1][a] + cart[2] * Ainv[2][a])
}

/**
 * 几何结构因子 F(hkl) = Σ_j f_j e^{2πi (h x_j + k y_j + l z_j)}。
 * @param {Array<{fractional:number[], Z:number}>} atoms 基内原子（分数坐标）
 * @param {number[]} hkl
 * @param {(Z:number, s:number)=>number} [formFactor] s=sinθ/λ（Å⁻¹）；默认 f≈Z（前向近似，与 s 无关）
 * @param {number} [s] 传给 formFactor 的 sinθ/λ；缺省 0（默认近似下无影响）
 */
export function structureFactor(atoms, hkl, formFactor = (Z) => Z, s = 0) {
  let re = 0, im = 0
  for (const { fractional: r, Z } of atoms) {
    const phase = TWO_PI * (hkl[0] * r[0] + hkl[1] * r[1] + hkl[2] * r[2])
    const f = formFactor(Z, s)
    re += f * Math.cos(phase)
    im += f * Math.sin(phase)
  }
  return { re, im, abs2: re * re + im * im }
}

/** Bragg 半角 θ（弧度）：sinθ=λ/(2d)；λ/(2d)>1 无解返回 null（该反射不出现） */
export function braggTheta(d, lambdaA) {
  const sinT = lambdaA / (2 * d)
  if (sinT > 1) return null
  return Math.asin(sinT)
}

/**
 * 粉末衍射峰表：枚举 hkl → d → 2θ，按等 d 分组合并等强度反射（多晶等效），
 * 剔除系统消光（|F|²≈0）。强度为 |F|² 相对值（见文件头近似声明）。
 * @param {object} graph Saturday AtomGraph（cell 行矢量 Å、nodes[].number/position 笛卡尔）
 * @param {{lambdaA?:number, hmax?:number, twoThetaMaxDeg?:number, extinctTol?:number, formFactor?}} opts
 */
export function powderPeaks(graph, { lambdaA = CU_KA_A, hmax = 6, twoThetaMaxDeg = 120, extinctTol = 1e-8, formFactor } = {}) {
  if (!Array.isArray(graph?.nodes) || graph.nodes.length === 0) throw xrdError('XRD_BAD_GRAPH', 'graph.nodes must be non-empty')
  if (!Array.isArray(graph.cell) || graph.cell.length !== 3) throw xrdError('XRD_BAD_GRAPH', 'graph.cell must be 3×3')
  const atoms = graph.nodes.map(n => ({ fractional: toFractional(graph.cell, n.position), Z: n.number }))
  const groups = new Map() // key=d(rounded) → {d, hkl:代表, abs2Sum, multiplicity}
  for (let h = -hmax; h <= hmax; h++) {
    for (let k = -hmax; k <= hmax; k++) {
      for (let l = -hmax; l <= hmax; l++) {
        if (h === 0 && k === 0 && l === 0) continue
        const d = dSpacing(graph.cell, [h, k, l])
        const theta = braggTheta(d, lambdaA)
        if (theta === null) continue
        const twoThetaDeg = (2 * theta * 180) / Math.PI
        if (twoThetaDeg > twoThetaMaxDeg) continue
        const F = structureFactor(atoms, [h, k, l], formFactor, 1 / (2 * d))
        if (F.abs2 <= extinctTol) continue // 系统消光
        const key = d.toFixed(4)
        const g = groups.get(key) || { d, hkl: [h, k, l], abs2Sum: 0, multiplicity: 0, twoThetaDeg }
        g.abs2Sum += F.abs2
        g.multiplicity += 1
        groups.set(key, g)
      }
    }
  }
  const peaks = [...groups.values()]
    .map(g => ({
      hkl: g.hkl, d: g.d, twoThetaDeg: g.twoThetaDeg,
      intensityRel: g.abs2Sum, multiplicity: g.multiplicity,
    }))
    .sort((a, b) => a.twoThetaDeg - b.twoThetaDeg)
  return {
    radiation: { lambdaA, label: lambdaA === CU_KA_A ? 'Cu Kα' : 'custom' },
    peaks,
    note: '峰位/消光精确（几何结构因子相位决定）；强度为 |F|² 相对值，f≈Z 前向近似，未含 LP/温度/吸收/织构因子（非实验定量强度）。',
  }
}
