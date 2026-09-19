// core/gp 泛化验证：RBF 支持向量输入（各向同性，欧氏距离），GP 向量特征插值闭式。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rbf, gpTrain, gpPredict, paretoFront, hypervolume2d } from '../src/gp.mjs'

const close = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps}) ${msg}`)

test('1. rbf 向量输入 = 标量退化一致 + 各向同性欧氏', () => {
  // 标量 [a] 与标量 a 一致
  close(rbf([1], [4], { ls: 2, sf: 1 }), rbf(1, 4, { ls: 2, sf: 1 }), 1e-15)
  // 向量按欧氏距离：‖(0,0)-(3,4)‖=5 与 ‖0-5‖=5 同核值
  close(rbf([0, 0], [3, 4], { ls: 2 }), rbf(0, 5, { ls: 2 }), 1e-12)
  // 自相关 = sf²
  close(rbf([2, 7], [2, 7], { ls: 0.7, sf: 3 }), 9, 1e-12)
  assert.throws(() => rbf([1, 2], [1], { ls: 1 }), e => e.code === 'GP_BAD_INPUT')
})

test('2. GP 向量特征插值：训练点均值≈观测、远处方差→sf²', () => {
  const xs = [[0, 0], [1, 0], [0, 1], [1, 1]]
  const ys = [0, 1, 2, 3]
  const m = gpTrain(xs, ys, { ls: 0.8, sf: 1.0, noise: 1e-10 })
  for (let i = 0; i < xs.length; i++) {
    const p = gpPredict(m, xs[i])
    close(p.mean, ys[i], 1e-3, `训练点 ${i} 均值≈观测`)
    assert.ok(p.variance < 1e-3)
  }
  close(gpPredict(m, [50, 50]).variance, 1.0, 1e-3, '远处方差→先验 sf²')
})

test('3. paretoFront / hypervolume2d 通用（多目标前沿）', () => {
  const front = paretoFront([{ obj: [0, 2] }, { obj: [1, 1] }, { obj: [2, 0] }, { obj: [1.5, 1.5] }])
  assert.equal(front.length, 3)
  close(hypervolume2d(front, [3, 3]), 6, 1e-9)
})
