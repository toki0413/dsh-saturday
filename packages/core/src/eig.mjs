// @toki0413/core/eig —— 实对称矩阵特征分解（通用 n×n），全仓唯一实现。
// 循环 Jacobi（NR 稳定小根式），本征值升序；symmetricEigendecomposition 额外回标准正交特征向量
// （同一旋转累乘到 V，不另写一套循环）。此前 elasticity/phonon/lj 各有一份拷贝，
// elasticity 那份是较弱的 atan2 变体（强耦合/退化特征值不收敛，见 common_pitfalls），统一到这里。
// 边界：稠密小矩阵（n≤~30，成本可忽略）；近退化 3×3 声学张量另用 elasticity 闭式 eig3Symmetric。

function eigError(code, msg) { const e = new Error(`${msg} (${code})`); e.code = code; return e }

/**
 * 实对称矩阵的特征值与标准正交特征向量（循环 Jacobi，同一旋转累乘到 V）。
 * vectors[i] 是 values[i] 对应的单位特征向量（列存）；退化子空间内向量方向不唯一，
 * 可验收的是 VᵀV=I 与 VᵀAV=diag(values)，不是单条向量。
 * @param {number[][]} Ain n×n 实对称
 * @returns {{values:number[], vectors:number[][]}}
 */
export function symmetricEigendecomposition(Ain) {
  if (!Array.isArray(Ain) || Ain.length === 0) throw eigError('EIG_EMPTY', 'symmetricEigenvalues requires a non-empty square matrix')
  const n = Ain.length
  for (const r of Ain) if (!Array.isArray(r) || r.length !== n) throw eigError('EIG_NOT_SQUARE', `expected ${n}×${n}; got ragged row`)
  const A = Ain.map(r => [...r])
  const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))
  const scale = Math.max(...A.map((r, i) => Math.abs(r[i])), 1e-300)
  const offNorm = () => {
    let s = 0
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) s += A[i][j] * A[i][j]
    return Math.sqrt(2 * s)
  }
  for (let sweep = 0; sweep < 120; sweep++) {
    if (offNorm() < 1e-13 * scale) break
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-18 * scale) continue
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q])
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1), s = t * c
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
        for (let k = 0; k < n; k++) {          // 同一旋转累乘到 V（V ← V·J）
          const vkp = V[k][p], vkq = V[k][q]
          V[k][p] = c * vkp - s * vkq
          V[k][q] = s * vkp + c * vkq
        }
      }
    }
  }
  const order = A.map((r, i) => i).sort((i, j) => A[i][i] - A[j][j])
  const values = order.map(i => A[i][i])
  const vectors = order.map(i => V.map(r => r[i]))
  return { values, vectors }
}

/**
 * 实对称矩阵特征值，升序。scale 相对阈值 + NR 小根旋转（对强耦合/退化也收敛）。
 * @param {number[][]} Ain  n×n 实对称（仅用下三角，自动取对称）
 */
export function symmetricEigenvalues(Ain) {
  return symmetricEigendecomposition(Ain).values
}
