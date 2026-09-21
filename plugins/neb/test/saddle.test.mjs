// saddle.mjs（QMM 鞍点搜索）测试：全部锚在闭式已知值上。
// 基准一：解析四次双阱 E = c(x⁴+y⁴) + x² − y² —— 鞍点精确 (0,0)、H=diag(2,−2)、势垒 1/(4c)。
// 基准二：仓内 ljDoubleWell —— 鞍点由镜像对称性精确在原点，势垒用独立逐点求值当 oracle。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { saddleSearch, quarticDoubleWell, finiteDifferenceHessian, SADDLE_DEFAULTS } from '../src/saddle.mjs'
import { ljDoubleWell, quench } from '../src/neb.mjs'

const rot = (th) => { const c = Math.cos(th), s = Math.sin(th); return [[c, -s], [s, c]] }
const mul = (R, v) => R.map(r => r.reduce((a, x, i) => a + x * v[i], 0))

test('1. 四次双阱（c=1 与 c=0.5）：多初值收到闭式鞍点，本征值与势垒逐位对账', () => {
  for (const c of [1, 0.5]) {
    const m = quarticDoubleWell({ c })
    for (const s of [[0.1, 0.1], [0.5, 0.3], [-0.2, 0.4], [0.9, -0.6], [0.02, 0.02]]) {
      const r = saddleSearch({ energy: m.energy, gradient: m.gradient, hessian: m.hessian, start: s })
      assert.equal(r.converged, true, `start ${s} 应收敛，got ${r.reason}`)
      assert.equal(r.reason, 'converged-index1')
      assert.ok(Math.hypot(...r.x) < 1e-6, `鞍点位置偏差 ${Math.hypot(...r.x)}（闭式应为 0）`)
      assert.ok(Math.abs(r.energy) < 1e-12, `E(鞍点) 闭式为 0，got ${r.energy}`)
      // H 在原点精确 diag(2,−2)（四次项不贡献二阶导），与 c 无关
      assert.ok(Math.abs(r.eigenvalues[0] + 2) < 1e-9 && Math.abs(r.eigenvalues[1] - 2) < 1e-9,
          `本征值应 [−2, 2]，got ${r.eigenvalues}`)
      assert.equal(r.negativeCount, 1, 'index-1')
      // 势垒闭式 1/(4c)，由"沿软模下坡 quench 到极小"独立给出
      assert.ok(Math.abs(r.barriers.forward - 1 / (4 * c)) < 1e-9,
          `势垒 ${r.barriers.forward} vs 闭式 ${1 / (4 * c)}`)
      assert.equal(r.barriers.distinctMinima, true, '两侧极小必须是不同点（否则没连两条路径）')
      assert.equal(r.barriers.bothSidesQuenched, true)
      const y0 = Math.sqrt(1 / (2 * c))
      for (const q of r.barriers.minima) {
        assert.ok(Math.abs(q[0]) < 1e-6 && Math.abs(Math.abs(q[1]) - y0) < 1e-6,
            `极小应为 (0, ±${y0})，got (${q.map(z => z.toFixed(6))})`)
      }
    }
  }
})

test('2. 旋转坐标系同样收到原点（不依赖主轴对齐），软模随之旋转', () => {
  const m = quarticDoubleWell({ c: 1 })
  const th = Math.PI / 5                            // 把模型转 36°
  const R = rot(th), Rt = rot(-th)
  const product = (A, B) => A.map(r => B[0].map((_, j) => r.reduce((a, x, k) => a + x * B[k][j], 0)))
  const model = {
    energy: (u) => m.energy(mul(R, u)),
    gradient: (u) => mul(Rt, m.gradient(mul(R, u))),                 // 链式：∇_u = Rᵗ ∇E(Ru)
    hessian: (u) => product(Rt, product(m.hessian(mul(R, u)), R)),   // H_u = Rᵗ H R
  }
  for (const s of [[0.2, 0.1], [0.35, -0.25], [-0.3, 0.2]]) {
    const r = saddleSearch({ energy: model.energy, gradient: model.gradient, hessian: model.hessian, start: s })
    assert.equal(r.converged, true, `旋转系 start ${s} → ${r.reason}`)
    assert.ok(Math.hypot(...r.x) < 1e-6, `旋转系鞍点偏差 ${Math.hypot(...r.x)}`)
    assert.ok(Math.abs(r.eigenvalues[0] + 2) < 1e-9 && Math.abs(r.eigenvalues[1] - 2) < 1e-9)
    // 软模应是 y 轴旋转后的方向 ±Rᵗ(0,1)
    const expect = mul(Rt, [0, 1])
    assert.ok(Math.abs(Math.abs(r.softMode.reduce((a, v, i) => a + v * expect[i], 0)) - 1) < 1e-6,
        `软模方向应对齐旋转后的 y 轴，got ${r.softMode}`)
  }
})

test('3. ljDoubleWell：近鞍初值收到对称性原点，势垒与独立 oracle 一致', () => {
  const m = ljDoubleWell()
  const l = quench({ x0: m.wellGuesses[0], energy: m.energy, gradient: m.gradient })
  const oracle = m.energy([0, 0, 0]) - l.energy
  assert.ok(oracle > 0.8 && oracle < 1.0, `oracle 势垒 ${oracle}`)
  for (const s of [[0.3, 0.1, 0], [0.5, 0.2, 0], [0.15, 0.05, 0.05]]) {
    const r = saddleSearch({ energy: m.energy, gradient: m.gradient, start: s, opts: { radius: 1.2 } })
    assert.equal(r.converged, true, `start ${s} → ${r.reason}`)
    assert.ok(Math.hypot(...r.x) < 1e-6, `鞍点偏差 ${Math.hypot(...r.x)}（对称性给在原点）`)
    assert.equal(r.negativeCount, 1)
    assert.ok(Math.abs(r.barriers.forward - oracle) < 1e-6, `势垒 ${r.barriers.forward} vs oracle ${oracle}`)
    assert.equal(r.barriers.distinctMinima, true)
    // 两侧极小应对称（镜像），能量相等
    const eMin = r.barriers.minima.map(q => m.energy(q))
    assert.ok(Math.abs(eMin[0] - eMin[1]) < 1e-9, `两侧极小能量应相等：${eMin}`)
  }
})

test('4. 失败模式如实报：壁上/半坡/远处初值不得报 converged', () => {
  const m = ljDoubleWell()
  const cases = [[[1.0, 0, 0]], [[0.9, 0.35, 0]], [[2.5, 1.5, 0.7]]]
  for (const [s] of cases) {
    const r = saddleSearch({ energy: m.energy, gradient: m.gradient, start: s, opts: { radius: 1.2 } })
    assert.equal(r.converged, false, `start ${s} 不该报收敛（got ${r.reason}）`)
    assert.equal(r.indexVerified, false)
    assert.match(r.reason, /stepCollapse|stalled-in-trust-region|maxSteps|converged-to-minimum|stalled/)
    assert.equal(r.report.converged, false)
    assert.ok(typeof r.report.stationary === 'boolean' && typeof r.report.indexOne === 'boolean',
        '三态分开报：驻点 / index-1 / 区域内')
    assert.equal(r.barriers, null, '未收敛就不给势垒（不交付未验证的数）')
    assert.ok(r.history.length >= 2 && r.history[0].step < r.history[r.history.length - 1].step, '历史可查')
  }
  // 壁上的那条：它把 |∇E| 压下去了但落在极小（零个负特征值）——必须靠 index 核验拦下
  const wall = saddleSearch({ energy: m.energy, gradient: m.gradient, start: [1.0, 0, 0], opts: { radius: 1.2 } })
  assert.equal(wall.negativeCount, 0, '壁上初值落到极小一侧（负特征值 0），所以不能算鞍点')
  assert.ok(wall.gradNorm < 1e-4, '‖∇E‖ 已经很小——只看梯度就会误判为成功')
})

test('5. FD Hessian 与解析 Hessian 等价；省略 hessian 也能收到同一鞍点', () => {
  const m = quarticDoubleWell({ c: 1 })
  const x = [0.3, -0.2]
  const fd = finiteDifferenceHessian(m.gradient, x, SADDLE_DEFAULTS.hessianStep)
  const an = m.hessian(x)
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    assert.ok(Math.abs(fd[i][j] - an[i][j]) < 1e-6, `(${i},${j}) FD ${fd[i][j]} vs 解析 ${an[i][j]}`)
  }
  const a = saddleSearch({ energy: m.energy, gradient: m.gradient, hessian: m.hessian, start: [0.4, 0.25] })
  const b = saddleSearch({ energy: m.energy, gradient: m.gradient, start: [0.4, 0.25] })   // FD 路线
  assert.ok(a.converged && b.converged)
  assert.ok(Math.hypot(...a.x.map((v, i) => v - b.x[i])) < 1e-7, '两条 Hessian 路线应给同一鞍点')
  assert.ok(Math.abs(a.energyGradientEvals - b.energyGradientEvals) > 0, 'FD 路线求值次数更多（代价如实可查）')
})

test('6. 输入校验全部显式；结果确定性', () => {
  const m = quarticDoubleWell({ c: 1 })
  const ok = { energy: m.energy, gradient: m.gradient, start: [0.2, 0.2] }
  assert.throws(() => saddleSearch({ ...ok, energy: undefined }), e => e.code === 'ANALYSIS_INPUT_MISSING')
  assert.throws(() => saddleSearch({ ...ok, gradient: 'x' }), e => e.code === 'ANALYSIS_INPUT_MISSING')
  assert.throws(() => saddleSearch({ ...ok, start: [0.2] }), e => e.code === 'SADDLE_BAD_INPUT')
  assert.throws(() => saddleSearch({ ...ok, start: [0.2, NaN] }), e => e.code === 'SADDLE_BAD_INPUT')
  assert.throws(() => saddleSearch({ ...ok, opts: { alpha: 1 } }), e => e.code === 'SADDLE_BAD_INPUT')
  assert.throws(() => saddleSearch({ ...ok, opts: { beta: 1.2 } }), e => e.code === 'SADDLE_BAD_INPUT')
  assert.throws(() => saddleSearch({ ...ok, opts: { radius: 0 } }), e => e.code === 'SADDLE_BAD_INPUT')
  assert.throws(() => saddleSearch({ ...ok, opts: { maxSteps: 0 } }), e => e.code === 'SADDLE_BAD_INPUT')
  assert.throws(() => saddleSearch({ ...ok, hessian: 'nope' }), e => e.code === 'SADDLE_BAD_INPUT')
  assert.throws(() => quarticDoubleWell({ c: 0 }), e => e.code === 'SADDLE_BAD_INPUT')
  // gradient 给非有限值 → 显式报错，不静默 NaN
  assert.throws(() => saddleSearch({ energy: m.energy, gradient: () => [NaN, 0], start: [0.2, 0.2] }),
      e => e.code === 'SADDLE_BAD_GRADIENT')
  const a = saddleSearch(ok), b = saddleSearch(ok)
  assert.deepEqual(a, b, '同输入两次结果完全一致（确定性）')
})
