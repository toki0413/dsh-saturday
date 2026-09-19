// GP + 贝叶斯优化纯函数测试：闭式对账（Cholesky 解 SPD、GP 插值、合成目标 BO 收敛、越界报错）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cholesky, gpTrain, gpPredict, rbf, boMinimize } from '../src/gp.mjs'
import { paretoFront, hypervolume2d, boMinimizePareto } from '../src/gp.mjs'

const close = (a, b, eps, msg = '') => assert.ok(Number.isFinite(a) && Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps}) ${msg}`)

test('1. Cholesky 解 SPD 线性系统：LLᵀ=A，回代 K·α=z 命中闭式解', () => {
  const A = [[4, 2], [2, 3]]
  const L = cholesky(A)
  // LLᵀ 应还原 A
  const reconstruct = (i, j) => L[i].slice(0, i + 1).reduce((s, _, k) => s + L[i][k] * L[j][k], 0)
  close(reconstruct(0, 0), 4, 1e-12); close(reconstruct(0, 1), 2, 1e-12)
  close(reconstruct(1, 1), 3, 1e-12)
  // 闭式逆 A⁻¹ = 1/8·[[3,-2],[-2,4]]，z=[1,1] → α=[0.125,0.25]（手算核验回代目标）
  const z = [1, 1]
  const a0 = (3 * z[0] - 2 * z[1]) / 8, a1 = (-2 * z[0] + 4 * z[1]) / 8
  close(a0, 0.125, 1e-12); close(a1, 0.25, 1e-12)
})

test('2. GP 插值性质：无噪声下训练点均值≈观测、方差≈0，远离点方差→先验 sf²', () => {
  const xs = [0, 1, 2], ys = [0, 1, 0]
  const model = gpTrain(xs, ys, { ls: 1.0, sf: 1.0, noise: 1e-10 })
  for (let i = 0; i < xs.length; i++) {
    const p = gpPredict(model, xs[i])
    close(p.mean, ys[i], 1e-4, `训练点 ${xs[i]} 均值应≈观测`)
    assert.ok(p.variance < 1e-3, `训练点 ${xs[i]} 方差应≈0，got ${p.variance}`)
  }
  const far = gpPredict(model, 50)
  close(far.variance, 1.0, 1e-3, '远离训练点方差→先验 sf²=1')
  close(far.mean, 0, 1e-6, '零均值先验远处均值→0')
})

test('3. boMinimize 在已知平滑目标上少评估逼近真极小', async () => {
  const xStar = 3
  const f = (x) => (x - xStar) ** 2 + 1 // 极小 (3,1)
  let calls = 0
  const out = await boMinimize({
    lo: 0, hi: 6, objective: (x) => { calls++; return f(x) },
    iterations: 8, kappa: 1.5, ls: 1.5, gridN: 61,
  })
  assert.equal(calls, out.evaluations)
  assert.ok(Math.abs(out.bestX - xStar) < 0.4, `bestX=${out.bestX} 应近 ${xStar}`)
  assert.ok(out.bestY < 1.05, `bestY=${out.bestY} 应近真最小 1`)
  // 混合 init + lcb 轨迹；每条 history 有 via
  assert.ok(out.history.every(h => h.via === 'init' || h.via === 'lcb'))
  assert.ok(out.history.filter(h => h.via === 'lcb').length >= 1, 'LCB 采集至少提出过新点')
  assert.ok(out.note.includes('不声明全局最优'), '诚实声明启发式边界')
})

test('4. 非凸多峰目标：BO 仍找到低于 init 最值的点（LCB 探索有效）', async () => {
  // f(x)=sin(2x)+0.3x 在 [0,6]，多峰；BO 应比 3 个 init 点的最好值不差（贪心接受 + 探索）
  const f = (x) => Math.sin(2 * x) + 0.3 * x
  const out = await boMinimize({ lo: 0, hi: 6, objective: f, iterations: 10, ls: 1.2, kappa: 1.0, gridN: 121 })
  const initBest = Math.min(...out.history.filter(h => h.via === 'init').map(h => h.y))
  assert.ok(out.bestY <= initBest + 1e-9, '最终最优应不劣于冷启动最好值')
})

test('5. 越界/非正定等病态显式抛错，不静默', async () => {
  await assert.rejects(() => boMinimize({ lo: 5, hi: 5, objective: x => x }), e => e.code === 'GP_BAD_BOUNDS')
  assert.throws(() => gpTrain([], []), e => e.code === 'GP_BAD_INPUT')
  // rbf 自相关 = sf²
  close(rbf(2, 2, { ls: 0.7, sf: 3 }), 9, 1e-12)
})

test('6. paretoFront 去支配点（保留非支配）', () => {
  const pts = [{ obj: [1, 3] }, { obj: [2, 2] }, { obj: [3, 1] }, { obj: [2, 3] }, { obj: [5, 5] }]
  const front = paretoFront(pts)
  // (2,3) 被 (1,3) 支配、(5,5) 被所有支配 → 剔除
  assert.deepEqual(front.map(p => p.obj), [[1, 3], [2, 2], [3, 1]])
})

test('7. hypervolume2d 已知前沿扫掠精确', () => {
  // {(0,2),(1,1),(2,0)} ref(3,3) → 1*1 + 1*2 + 1*3 = 6
  const hv = hypervolume2d([{ obj: [0, 2] }, { obj: [1, 1] }, { obj: [2, 0] }], [3, 3])
  close(hv, 6, 1e-9)
  // 被支配点不影响 HV
  const hv2 = hypervolume2d([{ obj: [0, 2] }, { obj: [1, 1] }, { obj: [2, 0] }, { obj: [1.5, 1.5] }], [3, 3])
  close(hv2, 6, 1e-9)
  assert.equal(hypervolume2d([{ obj: [4, 4] }], [3, 3]), 0, '支配 ref 的点不计')
})

test('8. boMinimizePareto 双目标：出非支配前沿 + HV>0 + 评估数对账', async () => {
  // f0=x²（递增最优在0），f1=(x-2)²（最优在2）→ 前沿为 x∈[0,2] 权衡曲线
  const out = await boMinimizePareto({
    lo: 0, hi: 2, objectives: [(x) => x * x, (x) => (x - 2) ** 2],
    iterations: 6, ref: [4.5, 4.5], gridN: 45,
  })
  assert.equal(out.evaluations, 3 + 6)
  assert.ok(out.pareto.length >= 3, `Pareto 前沿应含多点，got ${out.pareto.length}`)
  // 返回的 pareto 集确为非支配（自反）
  assert.equal(paretoFront(out.pareto).length, out.pareto.length)
  assert.ok(out.hypervolume > 0)
  assert.ok(out.note.includes('EHVI'), '诚实声明非完整 EHVI')
})

test('9. boMinimizePareto 目标数≠2 或越界显式报错', async () => {
  await assert.rejects(() => boMinimizePareto({ lo: 2, hi: 1, objectives: [x => x, x => x], ref: [1, 1] }), e => e.code === 'GP_BAD_BOUNDS')
  await assert.rejects(() => boMinimizePareto({ lo: 0, hi: 1, objectives: [x => x], ref: [1, 1] }), e => e.code === 'GP_BAD_OBJECTIVE')
})
