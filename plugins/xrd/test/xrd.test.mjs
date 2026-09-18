// plugin-xrd 纯函数层测试 —— 闭式对账：d-spacing、系统消光、几何结构因子幅度、粉末峰序。
// 全部引擎无关（纯几何+复数相位），消光规律是晶体学教科书定论（bcc/fcc/金刚石/NaCl）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dSpacing, structureFactor, powderPeaks, toFractional, realMetric } from '../src/xrd.mjs'

const cell4 = [[4, 0, 0], [0, 4, 0], [0, 0, 4]]
const at = (frac, Z) => ({ fractional: frac, Z })
const close = (a, b, eps = 1e-6, msg = '') =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps}) ${msg}`)

test('1. 立方晶胞 d-spacing 对闭式：d(a00)=a、d(110)=a/√2、d(111)=a/√3', () => {
  const a = 4
  close(dSpacing(cell4, [1, 0, 0]), a)
  close(dSpacing(cell4, [1, 1, 0]), a / Math.SQRT2)
  close(dSpacing(cell4, [1, 1, 1]), a / Math.sqrt(3))
  close(dSpacing(cell4, [2, 2, 0]), a / (2 * Math.SQRT2))
  // 立方晶胞度规应为对角 a²（几何基元正确性）
  const g = realMetric(cell4)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) close(g[i][j], i === j ? 16 : 0, 1e-9)
})

test('2. bcc 消光（体心 I）：h+k+l 奇 → F=0；偶 → |F|²=4', () => {
  const bcc = [at([0, 0, 0], 1), at([0.5, 0.5, 0.5], 1)]
  close(structureFactor(bcc, [1, 0, 0]).abs2, 0, 1e-9, '100 奇和消光')
  close(structureFactor(bcc, [1, 1, 1]).abs2, 0, 1e-9, '111 奇和消光')
  close(structureFactor(bcc, [1, 1, 0]).abs2, 4, 1e-9, '110 偶和')
  close(structureFactor(bcc, [2, 0, 0]).abs2, 4, 1e-9, '200 偶和')
})

test('3. fcc 消光（面心 F）：奇偶混合 → F=0；全奇/全偶 → |F|²=16', () => {
  const fcc = [at([0, 0, 0], 1), at([0.5, 0.5, 0], 1), at([0, 0.5, 0.5], 1), at([0.5, 0, 0.5], 1)]
  close(structureFactor(fcc, [1, 0, 0]).abs2, 0, 1e-9, '100 混合消光')
  close(structureFactor(fcc, [1, 1, 0]).abs2, 0, 1e-9, '110 混合消光')
  close(structureFactor(fcc, [2, 1, 0]).abs2, 0, 1e-9, '210 混合消光')
  close(structureFactor(fcc, [1, 1, 1]).abs2, 16, 1e-9, '111 全奇')
  close(structureFactor(fcc, [2, 0, 0]).abs2, 16, 1e-9, '200 全偶')
})

test('4. 金刚石（fcc + 1/4,1/4,1/4 glide）：4n 强、4n+2 消光、全奇半强', () => {
  const fccPos = [[0, 0, 0], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]]
  const diamond = [...fccPos.map(f => at(f, 1)), ...fccPos.map(f => at([f[0] + 0.25, f[1] + 0.25, f[2] + 0.25], 1))]
  close(structureFactor(diamond, [2, 0, 0]).abs2, 0, 1e-9, '200=4n+2 消光')
  close(structureFactor(diamond, [2, 2, 2]).abs2, 0, 1e-9, '222=4n+2 消光')
  close(structureFactor(diamond, [2, 2, 0]).abs2, 64, 1e-9, '220=4n 强 (16×4)')
  close(structureFactor(diamond, [1, 1, 1]).abs2, 32, 1e-9, '111 全奇 (16×2)')
})

test('5. NaCl：f_Na≠f_Cl 时 (200)∝(Z+Z′)²、(111)∝(Z−Z′)²，结构因子相位差可分辨', () => {
  const fccPos = [[0, 0, 0], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]]
  const na = fccPos.map(f => at(f, 11))
  const cl = fccPos.map(f => at([f[0] + 0.5, f[1], f[2]], 17))
  const basis = [...na, ...cl]
  close(structureFactor(basis, [2, 0, 0]).abs2, 16 * (11 + 17) ** 2, 1e-6, '200 同相 (f+f′)²')
  close(structureFactor(basis, [1, 1, 1]).abs2, 16 * (11 - 17) ** 2, 1e-6, '111 反相 (f−f′)²')
  // 关键：若两物种 Z 相等则 111 消失；不等才出现 → 证明是相位/成分效应，非数值巧合
  const homo = [...fccPos.map(f => at(f, 11)), ...fccPos.map(f => at([f[0] + 0.5, f[1], f[2]], 11))]
  close(structureFactor(homo, [1, 1, 1]).abs2, 0, 1e-9, '同种 Z 则 111 消（对照）')
})

test('6. 粉末峰：bcc a=4 首峰为 {110}（d=2.828，多极 12），{100} 不出现', () => {
  const graph = {
    cell: cell4,
    nodes: [
      { number: 29, position: [0, 0, 0] },
      { number: 29, position: [2, 2, 2] },
    ],
  }
  const { peaks } = powderPeaks(graph, { lambdaA: 1.54056, hmax: 6, twoThetaMaxDeg: 140 })
  assert.ok(peaks.length > 0)
  close(peaks[0].d, 4 / Math.SQRT2, 1e-3, '首峰 d(110)')
  assert.equal(peaks[0].multiplicity, 12, 'bcc {110} 多极数 12')
  // 2θ 单调升
  for (let i = 1; i < peaks.length; i++) assert.ok(peaks[i].twoThetaDeg >= peaks[i - 1].twoThetaDeg - 1e-9)
  // 无任何峰落在 d(100)=4.0（消光）
  assert.ok(!peaks.some(p => Math.abs(p.d - 4.0) < 1e-3), '{100} 应消光，不出现')
})

test('7. 分数坐标往返 + 非法输入显式报错（不静默）', () => {
  const f = toFractional(cell4, [2, 2, 2])
  close(f[0], 0.5); close(f[1], 0.5); close(f[2], 0.5)
  assert.throws(() => dSpacing(cell4, [0, 0, 0]), e => e.code === 'XRD_BAD_HKL')
  assert.throws(() => powderPeaks({ cell: cell4, nodes: [] }), e => e.code === 'XRD_BAD_GRAPH')
  // 退化晶胞（共面）→ 奇异性显式抛
  assert.throws(() => dSpacing([[1, 0, 0], [2, 0, 0], [0, 0, 1]], [1, 0, 0]), e => e.code === 'XRD_SINGULAR_CELL')
})
