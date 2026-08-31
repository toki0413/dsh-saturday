// 混合配额闭式对账补强：最大余数法在多 seed/权重组合下的确定性断言。
// 配额只依赖 (n, 归一权重)——与 seed 无关（seed 只影响候选坐标，不影响分配）；
// 余数按小数部分降序补一，平手取靠前锚点（确定性纪律的闭式实证，不靠数值巧合）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ouSampleMixture } from '../src/index.mjs'

// 最小同拓扑锚点对（4 节点，坐标错开保证两锚点可区分）
function makeGraph(offset = 0) {
  return {
    nodes: Array.from({ length: 4 }, (_, i) => ({ number: 29, position: [i * 1.8 + offset, 0, 0] })),
    edges: [],
    periodic: true,
    cell: [[8, 0, 0], [0, 8, 0], [0, 0, 8]],
  }
}

function target(weights) {
  return {
    references: weights.map((weight, i) => ({ reference: { graph: makeGraph(i * 0.1) }, weight })),
  }
}

function counts(candidates) {
  return candidates.reduce((acc, c) => (acc[c.anchorIndex] = (acc[c.anchorIndex] ?? 0) + 1, acc), {})
}

test('1. 双锚点配额闭式：余数按小数部分降序补一', async () => {
  // [0.6,0.4]：n=10 → 6/4 整除；n=8 → 4.8/3.2 → [5,3]；n=7 → 4.2/2.8 → 余数给小数大的锚点1 → [4,3]
  for (const [n, expect] of [[10, [6, 4]], [8, [5, 3]], [7, [4, 3]]]) {
    const c = await ouSampleMixture(target([0.6, 0.4]), { n, seed: 1 })
    const got = counts(c)
    assert.deepEqual([got[0] ?? 0, got[1] ?? 0], expect, `n=${n} 配额闭式`)
  }
  // [0.5,0.5] n=5 → [2.5,2.5]：小数平手（.5/.5）→ 取靠前锚点 → [3,2]
  const tied = counts(await ouSampleMixture(target([0.5, 0.5]), { n: 5, seed: 1 }))
  assert.deepEqual([tied[0] ?? 0, tied[1] ?? 0], [3, 2], '小数平手取靠前锚点（确定性）')
})

test('2. 权重未归一：配额只依赖归一后的相对权重', async () => {
  // [1,3] 归一 = [0.25,0.75]：n=6 → 1.5/4.5 → 小数平手 → 靠前锚点补一 → [2,4]
  const c = counts(await ouSampleMixture(target([1, 3]), { n: 6, seed: 1 }))
  assert.deepEqual([c[0] ?? 0, c[1] ?? 0], [2, 4], '未归一权重与归一形态同配额')
  const c2 = counts(await ouSampleMixture(target([0.25, 0.75]), { n: 6, seed: 1 }))
  assert.deepEqual([c2[0] ?? 0, c2[1] ?? 0], [2, 4])
})

test('3. 三锚点配额：余数顺次补给小数部分最大者，平手取靠前', async () => {
  // [1,1,1] n=10 → 10/3 = 3.333… → floor [3,3,3]，余数 1，小数全平手 → 锚点0 → [4,3,3]
  const uniform = counts(await ouSampleMixture(target([1, 1, 1]), { n: 10, seed: 1 }))
  assert.deepEqual([uniform[0] ?? 0, uniform[1] ?? 0, uniform[2] ?? 0], [4, 3, 3])
  // [0.5,0.3,0.2] n=9 → 4.5/2.7/1.8 → floor [4,2,1]，余数 2 → 小数 .7(锚点1) > .5(锚点0) > .8? 重算：
  // 精确值 4.5/2.7/1.8，小数部分 0.5/0.7/0.8 → 降序：锚点2(0.8)、锚点1(0.7) → [4,3,2]
  const skewed = counts(await ouSampleMixture(target([0.5, 0.3, 0.2]), { n: 9, seed: 1 }))
  assert.deepEqual([skewed[0] ?? 0, skewed[1] ?? 0, skewed[2] ?? 0], [4, 3, 2], '余数按小数降序顺次补一')
})

test('4. 配额与 seed 无关 + 总数守恒：多 seed 扫描', async () => {
  for (const seed of [1, 2, 7, 42, 2026]) {
    const c = await ouSampleMixture(target([0.6, 0.4]), { n: 8, seed })
    const got = counts(c)
    assert.deepEqual([got[0] ?? 0, got[1] ?? 0], [5, 3], `seed=${seed} 配额不变（seed 只影响坐标）`)
    assert.equal(c.length, 8, '配额总数守恒 = n')
  }
})
