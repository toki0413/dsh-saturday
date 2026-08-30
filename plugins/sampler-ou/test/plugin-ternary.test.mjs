// ㉒ 三元系端到端可扩展性实证：配额闭式与混合提案不为二元系特化——
// 目标组分 {Cu,Ag,Au} 与三锚点（各自组分各异，含一不可考）：
// 检索排序按 L1 距离如实呈现（三元组分点同样在概率单纯形上）；
// 配额最大余数法对三权重闭式成立；提案逐候选闭式似然可独立重算；
// 不可考锚点照常参与（⑳ 降级链在三元系下不回归）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/index.mjs'

// 三锚点：同拓扑（4 节点）不同组分；Zn(30) 顶替 Au(79) 仅作组分差异载体，
// 提案层的组分语义只经检索距离与配额消费，不进提议核（核是结构涨落，与元素无关）
function graphOf(numbers) {
  return {
    nodes: numbers.map((number, i) => ({ number, position: [i * 1.8, 0, 0] })),
    edges: [],
    periodic: true,
    cell: [[8, 0, 0], [0, 8, 0], [0, 0, 8]],
  }
}

async function mount() {
  const ctx = new Context()
  ctx.provide('material', { get: async () => { throw new Error('stub: material not needed') } })
  const fiber = await ctx.registry.plugin({ name: 'saturday-sampler-ou', apply: (ctx) => plugin.apply(ctx, {}) })
  return { fiber, handles: fiber.store.saturdaySamplerOu }
}

test('1. 三元系检索排序：三锚点按组分 L1 距离升序，不可考排尾', async () => {
  const { fiber, handles } = await mount()
  try {
    handles.anchorStore.add({ graph: graphOf([29, 29, 47, 79]), source: 'inline:exact', composition: { Cu: 2, Ag: 1, Au: 1 } })
    handles.anchorStore.add({ graph: graphOf([29, 29, 29, 79]), source: 'inline:off', composition: { Cu: 3, Au: 1 } })
    handles.anchorStore.add({ graph: graphOf([29, 30, 47, 79]), source: 'inline:unknown' })
    const result = await handles.rt.tools.call('sampler.mixture', {
      nAtoms: 4, composition: { Cu: 2, Ag: 1, Au: 1 }, n: 9, seed: 11,
    })
    assert.equal(result.anchors.length, 3)
    assert.equal(result.anchors[0].source, 'inline:exact', '组分重合锚点距离 0 在前')
    assert.equal(result.anchors[0].distance, 0)
    assert.ok(result.anchors[1].distance > 0 && Number.isFinite(result.anchors[1].distance),
      '组分偏移锚点距离为正有限值（三元组分点同在概率单纯形上）')
    assert.equal(result.anchors[2].source, 'inline:unknown')
    assert.equal(result.anchors[2].distance, null, '不可考锚点三元系下仍排尾（⑳ 降级链不回归）')
  } finally {
    await fiber.dispose()
  }
})

test('2. 三元系配额闭式：三权重最大余数法 + 总数守恒 + seed 无关', async () => {
  const { fiber, handles } = await mount()
  try {
    handles.anchorStore.add({ graph: graphOf([29, 29, 47, 79]), source: 'inline:a', composition: { Cu: 2, Ag: 1, Au: 1 } })
    handles.anchorStore.add({ graph: graphOf([29, 29, 29, 79]), source: 'inline:b', composition: { Cu: 3, Au: 1 } })
    handles.anchorStore.add({ graph: graphOf([29, 29, 29, 47]), source: 'inline:c', composition: { Cu: 3, Ag: 1 } })
    const weights = [0.5, 0.3, 0.2]
    const counts = {}
    for (const seed of [1, 2, 3, 4, 5]) {
      const result = await handles.rt.tools.call('sampler.mixture', {
        nAtoms: 4, composition: { Cu: 2, Ag: 1, Au: 1 }, weights, n: 9, seed,
      })
      assert.equal(result.candidates.length, 9, '总数守恒')
      const per = result.candidates.reduce((acc, c) => (acc[c.anchorIndex] = (acc[c.anchorIndex] ?? 0) + 1, acc), {})
      // 0.5/0.3/0.2 × 9 = 4.5/2.7/1.8 → 基数 4/2/1，余数 0.5/0.7/0.8 → 顺次补给余数最大者：
      // 补 0.8 的锚点 2 → 补 0.7 的锚点 1 → [4, 3, 2]
      assert.deepEqual([per[0] ?? 0, per[1] ?? 0, per[2] ?? 0], [4, 3, 2], `seed=${seed} 配额闭式`)
      if (seed === 1) Object.assign(counts, per)
    }
    assert.deepEqual([counts[0], counts[1], counts[2]], [4, 3, 2])
  } finally {
    await fiber.dispose()
  }
})

test('3. 三元系提案确定性复现：同参数两次调用逐候选严格一致（闭式可对账的前提）', async () => {
  const { fiber, handles } = await mount()
  try {
    handles.anchorStore.add({ graph: graphOf([29, 29, 47, 79]), source: 'inline:a', composition: { Cu: 2, Ag: 1, Au: 1 } })
    handles.anchorStore.add({ graph: graphOf([29, 29, 29, 79]), source: 'inline:b', composition: { Cu: 3, Au: 1 } })
    const args = {
      nAtoms: 4, composition: { Cu: 2, Ag: 1, Au: 1 }, weights: [0.5, 0.5], n: 6, seed: 9,
      uEq: 0.04, gammaDt: 1.0, temperatureK: 300,
    }
    const r1 = await handles.rt.tools.call('sampler.mixture', args)
    const r2 = await handles.rt.tools.call('sampler.mixture', args)
    assert.equal(r1.likelihood, 'exact')
    assert.deepEqual(r1.candidates, r2.candidates, '同参数两次提案逐候选严格一致（确定性）')
    for (const c of r1.candidates) {
      assert.ok(Number.isFinite(c.logProb), '候选闭式似然有限（可独立重算对账）')
      assert.ok(c.source.startsWith('generative:'), '生成谱系前缀纪律在三元系下延续')
    }
  } finally {
    await fiber.dispose()
  }
})
