// lattice-solve 纯函数层测试：合成峰位（由既有 dSpacing 正演）→ 精修回收点阵参数。
// 正向与逆向走两条独立数学路径（dSpacing 用 G*=inv3(realMetric)；精修解 G* 再 Cholesky 回实胞），
// 故"回收"不是自洽拟合，而是可判定的闭式对账。另检 σ 量级、退化与非法输入的显式报错。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cellFromParams } from '@toki0413/core/codecs'
import { dSpacing, CU_KA_A } from '../src/xrd.mjs'
import { latticeFromPeaks, latticeDesign, yFromTwoTheta, cellFromGstar } from '../src/lattice-solve.mjs'

const DEG = Math.PI / 180

/** 由胞参数生成峰位：hkl 列表 → 2θ（过滤该波长下不可反射的小 d 面） */
function peaksFromCell(params, hkls, lambdaA = CU_KA_A) {
  const cell = cellFromParams(params.a, params.b, params.c,
    params.alpha, params.beta, params.gamma)
  return hkls.map(hkl => {
    const d = dSpacing(cell, hkl)
    const arg = lambdaA / (2 * d)
    if (arg >= 1) return null
    return { hkl, twoThetaDeg: 2 * Math.asin(arg) / DEG, d }
  }).filter(Boolean)
}

const FCC_HKLS = [[1, 1, 1], [2, 0, 0], [2, 2, 0], [3, 1, 1], [2, 2, 2], [4, 0, 0], [3, 3, 1], [4, 2, 0]]
const SPREAD_HKLS = [
  [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1],
  [2, 0, 0], [0, 2, 0], [2, 1, 1], [1, 2, 1], [1, 1, 2], [2, 2, 1], [3, 1, 0], [1, 3, 2],
]

test('1. 立方：单参数约束解回 a=3.615，无噪声时 σ≈0、残差≈0', () => {
  const peaks = peaksFromCell({ a: 3.615, b: 3.615, c: 3.615, alpha: 90, beta: 90, gamma: 90 }, FCC_HKLS)
  assert.ok(peaks.length >= 6, 'fcc 允许反射应至少 6 根')
  const out = latticeFromPeaks({ peaks, system: 'cubic' })
  assert.ok(Math.abs(out.cell.a - 3.615) < 1e-9, `a 回收 ${out.cell.a}`)
  assert.equal(out.cell.gamma, 90, '立方约束下角固定')
  assert.ok(out.goodness.rss < 1e-24, `无噪声 rss 应为 0，got ${out.goodness.rss}`)
  assert.ok(out.cellSigma.a < 1e-9 && out.residualsDeg.max < 1e-9)
  assert.ok(Math.abs(out.volume_A3 - 3.615 ** 3) < 1e-9)
  assert.equal(out.nParams, 1)
  assert.match(out.declaration, /约束值而非独立测量/, 'σ=0 是约束不是测量，声明里说清')
})

test('2. 六方（γ=120 非正交）走三斜六参数：a=b、γ 精确回收', () => {
  const truth = { a: 4.913, b: 4.913, c: 5.405, alpha: 90, beta: 90, gamma: 120 }
  const peaks = peaksFromCell(truth, SPREAD_HKLS)
  const out = latticeFromPeaks({ peaks })
  for (const k of ['a', 'b', 'c', 'alpha', 'beta', 'gamma']) {
    assert.ok(Math.abs(out.cell[k] - truth[k]) < 1e-7, `${k}: ${out.cell[k]} vs ${truth[k]}`)
  }
  assert.ok(Math.abs(out.cell.a - out.cell.b) < 1e-9, '六方 a=b 由数据自己给出不被强制')
  assert.ok(out.goodness.r2 > 1 - 1e-12)
  assert.equal(out.nParams, 6)
})

test('3. 一般三斜（α=82、β=95、γ=101）：六参数全部回收，体积一致', () => {
  const truth = { a: 5, b: 6, c: 7, alpha: 82, beta: 95, gamma: 101 }
  const peaks = peaksFromCell(truth, SPREAD_HKLS)
  const out = latticeFromPeaks({ peaks })
  for (const k of ['a', 'b', 'c', 'alpha', 'beta', 'gamma']) {
    assert.ok(Math.abs(out.cell[k] - truth[k]) < 1e-7, `${k}: ${out.cell[k]} vs ${truth[k]}`)
  }
  // 回收的 G* 与既有几何同源：用拟合 G* 复算 d，与 dSpacing(cellFromParams(truth)) 逐峰一致
  const cell = cellFromParams(truth.a, truth.b, truth.c, truth.alpha, truth.beta, truth.gamma)
  for (const pk of peaks) {
    const hy = latticeDesign(pk.hkl).reduce((s, v, k) => s + v * out.reciprocalMetric[k], 0)
    assert.ok(Math.abs(1 / Math.sqrt(hy) - dSpacing(cell, pk.hkl)) < 1e-9, `${pk.hkl} d 与既有 dSpacing 一致`)
  }
})

test('4. 含噪数据：偏差不超容差，σ 随噪声放大而同阶放大', () => {
  const truth = { a: 3.615, b: 3.615, c: 3.615, alpha: 90, beta: 90, gamma: 90 }
  const base = peaksFromCell(truth, FCC_HKLS)
  const jitter = (amp, seed) => {
    let s = seed >>> 0
    const rnd = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
    return base.map(p => ({ hkl: p.hkl, twoThetaDeg: p.twoThetaDeg + (rnd() - 0.5) * 2 * amp }))
  }
  const small = latticeFromPeaks({ peaks: jitter(0.01, 7), system: 'cubic' })
  const big = latticeFromPeaks({ peaks: jitter(0.05, 7), system: 'cubic' })
  assert.ok(Math.abs(small.cell.a - 3.615) < 5e-3, `噪声 0.01° 下 a 偏 ${small.cell.a - 3.615}`)
  assert.ok(small.cellSigma.a > 0 && small.cellSigma.a < 0.05)
  assert.ok(small.residualsDeg.max <= 0.012, `残差不应超过注入噪声量级，got ${small.residualsDeg.max}`)
  const ratio = big.cellSigma.a / small.cellSigma.a
  assert.ok(ratio > 2.5 && ratio < 8, `噪声×5 后 σ 比应为个数量级内，got ${ratio.toFixed(2)}`)
  assert.ok(big.cellSigma.a > small.cellSigma.a, 'σ 随噪声单调')
})

test('5. 退化与不足的峰集显式报错，不给伪解', () => {
  const truth = { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 }
  const few = peaksFromCell(truth, [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1], [2, 0, 0]])
  assert.throws(() => latticeFromPeaks({ peaks: few.slice(0, 6) }), e => e.code === 'LP_UNDERDETERMINED')
  // 全部 l=0：设计矩阵秩不足（G33/G13/G23 不可定），且峰数 >6 → 应报退化而非法输入
  const planar = peaksFromCell(truth, [[1, 0, 0], [0, 1, 0], [1, 1, 0], [2, 0, 0], [0, 2, 0], [2, 1, 0], [1, 2, 0], [2, 2, 0]])
  assert.ok(planar.length > 6, '平面峰集需 >6 根才走 cholesky 分支')
  assert.throws(() => latticeFromPeaks({ peaks: planar }), e => e.code === 'LP_DEGENERATE_PEAKS')
})

test('6. 非法输入逐项报错；非正定 G* 被 cellFromGstar 拒绝', () => {
  assert.throws(() => latticeFromPeaks({ peaks: [] }), e => e.code === 'LP_BAD_PEAKS')
  assert.throws(() => latticeFromPeaks({ peaks: [{ twoThetaDeg: 0, hkl: [1, 0, 0] }] }), e => e.code === 'LP_BAD_PEAKS')
  assert.throws(() => latticeFromPeaks({ peaks: [{ twoThetaDeg: 40.1, hkl: [1.5, 0, 0] }] }), e => e.code === 'LP_BAD_HKL')
  assert.throws(() => latticeFromPeaks({ peaks: [{ twoThetaDeg: 40.1, hkl: [0, 0, 0] }] }), e => e.code === 'LP_BAD_HKL')
  assert.throws(() => latticeFromPeaks({ peaks: [{ twoThetaDeg: 40.1, hkl: [1, 0, 0] }], lambdaA: 0 }), e => e.code === 'LP_BAD_WAVELENGTH')
  assert.throws(() => latticeFromPeaks({ peaks: [{ twoThetaDeg: 40.1, hkl: [1, 0, 0] }, { twoThetaDeg: 41, hkl: [0, 1, 0] }], system: 'hexagonal' }),
      e => e.code === 'LP_SYSTEM_UNSUPPORTED')
  assert.throws(() => cellFromGstar([-1, 1, 1, 0, 0, 0]), e => e.code === 'LP_NOT_PHYSICAL_CELL', '非正定 G* 无实胞')
})

test('7. 出口形态：单位、逐峰残差、不可反射计数与声明随交付', () => {
  const peaks = peaksFromCell({ a: 5.431, b: 5.431, c: 5.431, alpha: 90, beta: 90, gamma: 90 }, FCC_HKLS)
  const out = latticeFromPeaks({ peaks, system: 'cubic' })
  assert.equal(out.units.length, 'Å')
  assert.equal(out.lambdaA, CU_KA_A)
  assert.equal(out.residualsDeg.nReported, peaks.length)
  assert.equal(out.residualsDeg.nUnreachable, 0)
  assert.ok(out.perPeak.every(r => Number.isFinite(r.twoThetaCalcDeg) && Math.abs(r.deltaDeg) < 1e-9))
  assert.match(out.note, /高斯-马尔可夫/, 'σ 的口径写明')
  // 无噪声时法方程应精确复现 y（y_obs = 设计行·G*），且 y 与出口同式
  for (const r of out.perPeak) {
    assert.ok(Math.abs(r.yObs - yFromTwoTheta(r.twoThetaDeg, CU_KA_A)) < 1e-15)
    const fit = latticeDesign(r.hkl).reduce((s, v, k) => s + v * out.reciprocalMetric[k], 0)
    assert.ok(Math.abs(fit - r.yObs) < 1e-12, `${r.hkl} 精确拟合：${fit} vs ${r.yObs}`)   // 双精度量级容差（1e-18 低于舍入噪声）
  }
  assert.ok(Array.isArray(out.reciprocalMetricSigma) && out.reciprocalMetricSigma.length === 6)
})
