// band-to-saddle 组合层测试：带只当初值，势垒由 QMM 复核。全部对独立 oracle 逐位判。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { neb, nebRefined, quench, ljDoubleWell } from '../src/index.mjs'

const m = ljDoubleWell()
const N = 7
const left = quench({ x0: m.wellGuesses[0], energy: m.energy, gradient: m.gradient })
const right = quench({ x0: m.wellGuesses[1], energy: m.energy, gradient: m.gradient })
const oracle = m.energy([0, 0, 0]) - left.energy        // 鞍点由镜像对称性精确在原点
const bent = (k) => Array.from({ length: N }, (_, i) => {
  const t = i / (N - 1)
  return [left.x[0] + t * (right.x[0] - left.x[0]), (i > 0 && i < N - 1) ? k * Math.sin(Math.PI * t) : 0, 0]
})
const run = (k, extra = {}) => {
  const b = bent(k)
  return nebRefined({ energy: m.energy, gradient: m.gradient, start: b[0], end: b[N - 1], nImages: N, initialBand: b, ...extra })
}

test('1. 三种弯带复核后势垒都等于 oracle，带自身估读原样保留', () => {
  assert.ok(oracle > 0.88 && oracle < 0.89, `oracle ${oracle}`)
  const rows = [0, 0.4, 1.2].map(k => ({ k, o: run(k) }))
  for (const { k, o } of rows) {
    assert.equal(o.refined, true, `kink=${k} 复核应成功，got ${o.refinement?.reason}`)
    assert.equal(o.saddleVerified, true, `kink=${k} 应判 index-1`)
    assert.ok(Math.abs(o.barrierForward - oracle) < 1e-6,
        `kink=${k} 复核势垒 ${o.barrierForward} vs oracle ${oracle}`)
    assert.ok(Math.abs(o.barrierForward - o.barrierReverse) < 1e-9, '对称体系正反向势垒相等')
    assert.equal(o.report.barrierSource, 'QMM 复核的鞍点能量')
    assert.ok(Math.hypot(...o.refinedSaddle) < 1e-6, `复核鞍点应落在对称性原点，got ${o.refinedSaddle}`)
  }
  // 带自身确实偏：kink=0.4 偏 5e-2 量级、kink=1.2 偏 4e-1 量级（复核前后可比较）
  const [straight, mild, strong] = rows
  assert.ok(Math.abs(mild.o.bandBarrierForward - oracle) > 5e-2, `弯带 0.4 应明显偏高，got ${mild.o.bandBarrierForward}`)
  assert.ok(Math.abs(strong.o.bandBarrierForward - oracle) > 4e-1, `弯带 1.2 应明显偏高，got ${strong.o.bandBarrierForward}`)
  assert.ok(Math.abs(straight.o.bandBarrierForward - oracle) < 1e-6, '直带（默认路径）本就等于 oracle')
  // 复核确实做了工作：弯带要移动、直带无需移动
  assert.ok(mild.o.refinement.bandTopToSaddle > 0.3 && strong.o.refinement.bandTopToSaddle > 1.0)
  assert.equal(straight.o.refinement.nSteps, 0)
  assert.equal(straight.o.refinement.startedAtStationary, true)
  assert.ok(mild.o.refinement.nSteps > 5 && mild.o.refinement.energyGradientEvals > 0)
})

test('2. 带未收敛与复核成功是两件事，不合并成一个布尔', () => {
  const o = run(0.4)
  assert.equal(o.converged, false, '带未收敛（既有步长方案的实测老问题）')
  assert.equal(o.report.bandConverged, false)
  assert.equal(o.refined, true, '但复核成功')
  assert.equal(o.report.saddleConverged, true)
  assert.match(o.report.note, /带未收敛不代表复核失败/, '分工写进报告')
  assert.equal(typeof o.convergence.stepLimitReached === 'boolean' && typeof o.convergence.trivialStationary === 'boolean',
      true, '带自己的收敛状态字段仍在（#128 那套）')
  assert.match(o.note, /带只当鞍点初值|势垒口径/, 'note 说清势垒来源')
})

test('3. refine=false 完全退回 #128 的纯带行为（向后兼容）', () => {
  const b = bent(0.4)
  const plain = neb({ energy: m.energy, gradient: m.gradient, start: b[0], end: b[N - 1], nImages: N, initialBand: b })
  const off = run(0.4, { refine: false })
  assert.equal(off.refined, false)
  assert.equal(off.refinement, null)
  assert.equal(off.barrierForward, plain.barrierForward, '关复核时势垒即带估读')
  assert.equal(off.barrierReverse, plain.barrierReverse)
  assert.deepEqual(off.convergence, plain.convergence, '收敛报告字段一致')
  assert.equal('refinedSaddle' in off, false, '关复核时不产生复核坐标')
})

test('4. 省略 hessian（走中心差分）与给出解析 hessian 得到同一势垒', () => {
  const b = bent(1.2)
  const withH = nebRefined({ energy: m.energy, gradient: m.gradient, start: b[0], end: b[N - 1], nImages: N, initialBand: b })
  const model = { energy: m.energy, gradient: m.gradient }                          // 无 hessian → FD
  const fd = nebRefined({ ...model, start: b[0], end: b[N - 1], nImages: N, initialBand: b })
  assert.ok(withH.refined && fd.refined)
  assert.ok(Math.abs(withH.barrierForward - fd.barrierForward) < 1e-6,
      `${withH.barrierForward} vs ${fd.barrierForward}`)
  assert.ok(Math.abs(fd.barrierForward - oracle) < 1e-6)
})

test('5. 输入缺失仍显式报错；结果确定性', () => {
  const b = bent(0.4)
  assert.throws(() => nebRefined({ gradient: m.gradient, start: b[0], end: b[N - 1], nImages: N }),
      e => e.code === 'ANALYSIS_INPUT_MISSING')
  assert.throws(() => nebRefined({ energy: m.energy, gradient: m.gradient, start: b[0], end: b[N - 1], nImages: 2 }),
      e => e.code === 'NEB_BAD_INPUT')
  assert.deepEqual(run(0.4), run(0.4), '同输入两次结果完全一致')
})
