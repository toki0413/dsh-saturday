// ⑦ 混合提案锚点库：自监督进场的管道铺路（数据地基，不是学习本身）。
// 闭式对账：组分距离是概率单纯形上的 L1，手算可验；拓扑门禁与混合采样同款（双重诚实）。
// 端到端：检索 → toMixtureTarget → ouSampleMixture，锚点归属随谱系 #anchor=k 可追溯。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAnchorStore, ouSampleMixture } from '../src/index.mjs'

/** 最小结构图：节点数 = 元素数，位置按序号展开（拓扑门禁只认节点数） */
const mkGraph = (elements) => ({
  cell: [[4, 0, 0], [0, 4, 0], [0, 0, 4]],
  nodes: elements.map((el, i) => ({ element: el, position: [i * 1.8, (i % 2) * 1.8, 0] })),
})

test('1. add 门禁：无谱系数据不入库；入库即附入库序（确定性）', () => {
  const store = createAnchorStore()
  assert.throws(() => store.add({ source: 's' }), err => err.code === 'ANCHOR_INVALID', '缺 graph 即拒')
  assert.throws(() => store.add({ graph: { nodes: [] }, source: 's' }), err => err.code === 'ANCHOR_INVALID', '空 nodes 即拒')
  assert.throws(() => store.add({ graph: mkGraph(['Cu']) }), err => err.code === 'ANCHOR_INVALID' && /source/.test(err.message),
    '缺来源声明即拒（锚点来自闭环轨迹，出处必须可追溯）')
  const e0 = store.add({ graph: mkGraph(['Cu', 'Cu']), source: 'trajectory:job-1', composition: { Cu: 2 } })
  const e1 = store.add({ graph: mkGraph(['Cu', 'Ag']), source: 'trajectory:job-2', composition: { Cu: 1, Ag: 1 }, energy: -7.1 })
  assert.equal(store.size(), 2)
  assert.deepEqual([e0.addedAt, e1.addedAt], [0, 1])
  assert.equal(e1.energy, -7.1, '回算能量随锚点入库（闭环数据的物理载荷）')
  assert.throws(() => store.retrieve({}), err => err.code === 'ANCHOR_INVALID', '缺 nAtoms 即拒（拓扑门禁是前置）')
})

test('2. retrieve：拓扑硬门禁 + 组分 L1 距离闭式排序（不可考排尾，平手按入库序）', () => {
  const store = createAnchorStore()
  // 4 原子锚点 ×3 + 2 原子锚点 ×1（拓扑不同，应被过滤）
  store.add({ graph: mkGraph(['Cu', 'Cu', 'Cu', 'Cu']), source: 'a', composition: { Cu: 4 } })
  store.add({ graph: mkGraph(['Cu', 'Cu', 'Cu', 'Ag']), source: 'b', composition: { Cu: 3, Ag: 1 } })
  store.add({ graph: mkGraph(['Cu', 'Cu', 'Cu', 'Cu']), source: 'c' })   // 缺组分：距离不可考
  store.add({ graph: mkGraph(['Cu', 'Cu']), source: 'd', composition: { Cu: 2 } })

  // 查询 Cu3Ag（分数 {Cu:0.75, Ag:0.25}）：
  //   b 距离 = 0（同成分）；a 距离 = |1−0.75| + |0−0.25| = 0.5（闭式）；c 不可考排尾
  const hits = store.retrieve({ nAtoms: 4, composition: { Cu: 3, Ag: 1 } })
  assert.equal(hits.length, 3, '2 原子锚点被拓扑门禁过滤（不近似，直接不匹配）')
  assert.deepEqual(hits.map(h => h.anchor.source), ['b', 'a', 'c'])
  assert.ok(Math.abs(hits[0].distance - 0) < 1e-12)
  assert.ok(Math.abs(hits[1].distance - 0.5) < 1e-12, 'L1 分数距离闭式（手算 0.5）')
  assert.equal(hits[2].distance, null, '锚点缺组分 = 距离不可考（诚实声明，不冒充可比）')

  // topK 截断 + 无组分查询（只按拓扑过滤，距离全部不可考，按入库序确定性呈现）
  assert.deepEqual(store.retrieve({ nAtoms: 4, composition: { Cu: 3, Ag: 1 }, topK: 1 }).map(h => h.anchor.source), ['b'])
  const topoOnly = store.retrieve({ nAtoms: 2 })
  assert.deepEqual(topoOnly.map(h => h.anchor.source), ['d'])

  assert.throws(() => store.retrieve({ nAtoms: 4, composition: {} }),
    err => err.code === 'ANCHOR_INVALID', '空组分查询 = 无法构成成分点（不外推）')
})

test('3. 空库纪律：检索返回空集，不得据此构造混合目标（不伪造锚点）', () => {
  const store = createAnchorStore()
  assert.deepEqual(store.retrieve({ nAtoms: 4 }), [], '空库检索 = 空集（如实）')
  assert.throws(() => store.toMixtureTarget([]), err => err.code === 'ANCHOR_EMPTY')
  // 库非空但拓扑全不匹配：同样空集（宁可无提案，不拿错拓扑锚点凑数）
  store.add({ graph: mkGraph(['Cu', 'Cu']), source: 's' })
  assert.deepEqual(store.retrieve({ nAtoms: 4 }), [])
})

test('4. toMixtureTarget：权重显式声明门禁 + 默认均匀', () => {
  const store = createAnchorStore()
  store.add({ graph: mkGraph(['Cu', 'Cu']), source: 'a', composition: { Cu: 2 } })
  store.add({ graph: mkGraph(['Cu', 'Ag']), source: 'b', composition: { Cu: 1, Ag: 1 } })
  const hits = store.retrieve({ nAtoms: 2 })
  assert.throws(() => store.toMixtureTarget(hits, { weights: [1] }),
    err => err.code === 'ANCHOR_INVALID', '权重长度与检索结果不一致即拒（不静默补全）')
  const uniform = store.toMixtureTarget(hits)
  assert.deepEqual(uniform.references.map(r => r.weight), [1, 1], '缺省均匀权重')
  const weighted = store.toMixtureTarget(hits, { weights: [0.6, 0.4] })
  assert.deepEqual(weighted.references.map(r => r.weight), [0.6, 0.4])
})

test('5. 端到端：检索 → 混合目标 → ouSampleMixture（锚点归属随谱系可追溯，似然不降档）', async () => {
  const store = createAnchorStore()
  store.add({ graph: mkGraph(['Cu', 'Cu', 'Cu', 'Cu']), source: 'trajectory:seed-basin', composition: { Cu: 4 } })
  store.add({ graph: mkGraph(['Cu', 'Cu', 'Cu', 'Ag']), source: 'trajectory:doped-basin', composition: { Cu: 3, Ag: 1 } })

  const hits = store.retrieve({ nAtoms: 4, composition: { Cu: 3, Ag: 1 }, topK: 2 })
  const target = store.toMixtureTarget(hits, { weights: [0.4, 0.6] })
  const candidates = await ouSampleMixture(target, { n: 10, seed: 3, uEq: 0.05, gammaDt: 1.0 })

  assert.equal(candidates.length, 10)
  // 配额 = 最大余数法：权重 [0.4, 0.6] × 10 → 锚点配额 [4, 6]（配额正比于混合权重）
  const per = candidates.reduce((acc, c) => (acc[c.anchorIndex] = (acc[c.anchorIndex] ?? 0) + 1, acc), {})
  assert.deepEqual([per[0] ?? 0, per[1] ?? 0], [4, 6], '配额闭式：配额正比于混合权重（检索序即锚点序）')
  for (const c of candidates) {
    assert.ok(Number.isFinite(c.logProb), '混合似然逐候选有限（exact 不降档）')
    assert.match(c.source, /#mixture#/, '谱系含混合标记')
  }
  assert.ok(candidates.some(c => c.anchorIndex === 0) && candidates.some(c => c.anchorIndex === 1),
    '两盆地都有候选（跨盆地探索 = 检索驱动的多锚点）')
})
