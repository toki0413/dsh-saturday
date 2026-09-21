// @toki0413/core/eig —— 通用 n×n 实对称特征值测试（全仓唯一实现；含强耦合退化锚点）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { symmetricEigenvalues, symmetricEigendecomposition } from '../src/eig.mjs'

test('1. 已知对称阵升序 + 迹不变', () => {
  assert.deepEqual(symmetricEigenvalues([[2, 0], [0, 5]]), [2, 5])
  const A = [[4, 1], [1, 3]]   // 解析 eig = 3.5 ∓ √(0.25+1) → {2.382, 4.618}
  const ev = symmetricEigenvalues(A)
  assert.ok(Math.abs(ev[0] - (3.5 - Math.sqrt(1.25))) < 1e-9 && Math.abs(ev[1] - (3.5 + Math.sqrt(1.25))) < 1e-9)
  assert.ok(Math.abs(ev.reduce((a, b) => a + b, 0) - 7) < 1e-9, '迹=对角和')
})

test('2. 强耦合/退化对称阵必须收敛（旧 atan2 变体在此失败）', () => {
  const strong = [[0.8667, 0.4667, 0.4667], [0.4667, 0.8667, 0.4667], [0.4667, 0.4667, 0.8667]]
  assert.deepEqual(symmetricEigenvalues(strong).map(v => +v.toFixed(3)), [0.4, 0.4, 1.8])
  // 全 1 矩阵 3×3 → {0,0,3}（二重零根；用容差避开 -0 与 0 的 strict 比较陷阱）
  const ones = [[1, 1, 1], [1, 1, 1], [1, 1, 1]]
  const e2 = symmetricEigenvalues(ones)
  assert.ok(Math.abs(e2[0]) < 1e-9 && Math.abs(e2[1]) < 1e-9 && Math.abs(e2[2] - 3) < 1e-9, `二重零根+3 got ${JSON.stringify(e2)}`)
})

test('3. 入参不变量 + 非方阵/空 显式报错', () => {
  const src = [[2, 1], [1, 2]]
  symmetricEigenvalues(src)
  assert.deepEqual(src, [[2, 1], [1, 2]], '不改动入参')
  assert.throws(() => symmetricEigenvalues([]), e => e.code === 'EIG_EMPTY')
  assert.throws(() => symmetricEigenvalues([[1, 2], [3]]), e => e.code === 'EIG_NOT_SQUARE')
})

test('4. 6×6 Born 型近对角 + 强耦合混排：与逐块 2×2 已知解一致', () => {
  const C = [
    [3, 1, 0, 0, 0, 0], [1, 3, 0, 0, 0, 0], [0, 0, 2, 0.5, 0, 0],
    [0, 0, 0.5, 2, 0, 0], [0, 0, 0, 0, 5, 0], [0, 0, 0, 0, 0, 6],
  ]
  const ev = symmetricEigenvalues(C).map(v => +v.toFixed(6))
  // 两个 2×2 块：{3∓1}={2,4}、{2∓0.5}={1.5,2.5}，加 5、6 → 升序
  assert.deepEqual(ev, [1.5, 2, 2.5, 4, 5, 6])
})

test('5. symmetricEigendecomposition：特征向量满足残差方 A·v=λ·v（不测单条向量方向）', () => {
  const A = [[2, 1], [1, 2]]
  const { values, vectors } = symmetricEigendecomposition(A)
  assert.deepEqual(values.map(v => +v.toFixed(9)), [1, 3])
  const n = A.length
  for (let i = 0; i < n; i++) {
    const v = vectors[i]
    const Av = A.map(r => r.reduce((a, x, j) => a + x * v[j], 0))
    const res = Math.hypot(...Av.map((x, k) => x - values[i] * v[k]))
    assert.ok(res < 1e-12, `第 ${i} 条特征向量残差 ${res}`)
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-12, '特征向量单位长')
  }
  // 正交：两向量点积为 0
  assert.ok(Math.abs(vectors[0].reduce((a, x, i) => a + x * vectors[1][i], 0)) < 1e-12)
})

test('6. 退化情形与重构：VᵀV=I、VᵀAV=diag(values)，并与只读本征值的出口一致', () => {
  const cases = [
    [[2, 0, 0], [0, 2, 0], [0, 0, 2]],                                   // 三重退化
    [[3, 1, 0], [1, 3, 0], [0, 0, 3]],                                   // 二重退化（子空间仍不唯一）
    [[5, 1, 2], [1, 3, 0.5], [2, 0.5, 4]],                               // 一般满阵
  ]
  for (const A of cases) {
    const { values, vectors } = symmetricEigendecomposition(A)
    const n = A.length
    assert.deepEqual(values, symmetricEigenvalues(A), '两个出口的本征值一致（委托同一循环）')
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const d = vectors[i].reduce((a, x, k) => a + x * vectors[j][k], 0)
      assert.ok(Math.abs(d - (i === j ? 1 : 0)) < 1e-9, `VᵀV 元 (${i},${j}) = ${d}`)
    }
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const m = vectors[i].reduce((a, x, p) => a + x * A[p].reduce((b, y, q) => b + y * vectors[j][q], 0), 0)
      assert.ok(Math.abs(m - (i === j ? values[i] : 0)) < 1e-9, `VᵀAV 元 (${i},${j}) = ${m}`)
    }
  }
  assert.throws(() => symmetricEigendecomposition([]), e => e.code === 'EIG_EMPTY')
})
