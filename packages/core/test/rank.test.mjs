// @toki0413/core/rank —— 排序一致性统计纯测（对已知值 / 边界）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { averageRanks, spearman, topKOverlap, meanAbsDelta } from '../src/rank.mjs'

test('1. averageRanks 并列取均值（0 基）', () => {
  assert.deepEqual(averageRanks([10, 20, 20, 40]), [0, 1.5, 1.5, 3])
  assert.deepEqual(averageRanks([5, 5, 5]), [1, 1, 1])
})

test('2. spearman：完全同序=1、逆序=-1、教科书并列值≈0.9487', () => {
  assert.equal(spearman([1, 2, 3], [2, 4, 6]), 1)
  assert.equal(spearman([1, 2, 3], [6, 4, 2]), -1)
  assert.ok(Math.abs(spearman([10, 20, 20, 40], [1, 2, 3, 4]) - 0.948683) < 1e-4)
  assert.equal(spearman([3], [9]), 1)  // 长度 1 退化
})

test('3. topKOverlap：取 k 个最小值索引集交集/k', () => {
  assert.equal(topKOverlap([5, 1, 3, 2], [4, 1, 3, 2], 2).overlap, 1)   // 两个最小都同
  assert.equal(topKOverlap([3, 1, 2], [1, 2, 3], 1).overlap, 0)         // 最小者不同
  assert.equal(topKOverlap([3, 1, 2], [1, 2, 3], 2).overlap, 0.5)       // 2 小集合交 1
  assert.equal(topKOverlap([9, 8], [1, 2], 5).k, 2)                     // k 越界钳到 n
})

test('4. meanAbsDelta 同位绝对差均值', () => {
  assert.equal(meanAbsDelta([1, 2, 3], [2, 4, 6]), 2)
})

test('5. 长度不等 / 空 → 显式报错', () => {
  assert.throws(() => spearman([1, 2], [1]), e => e.code === 'RANK_LENGTH')
  assert.throws(() => topKOverlap([], []), e => e.code === 'RANK_LENGTH')
})
