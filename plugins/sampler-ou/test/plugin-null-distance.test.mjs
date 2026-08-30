// ⑳ 组分不可考（distance: null）诚实降级链端到端：
// 锚点缺组分信息 → 检索距离声明不可考（null）排尾（不冒充可比）→
// 混合提案不因不可考拒绝（排尾不是排除：诚实降级 ≠ 静默丢弃）→
// 交付随呈现（距离声明在工具层如实透传）。
// 泄漏防护（纪律）：挂载即拉起 Python sidecar，前置断言入 try，finally 保证 dispose。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/index.mjs'

const graph4 = {
  nodes: Array.from({ length: 4 }, (_, i) => ({ number: 29, position: [i * 1.8, 0, 0] })),
  edges: [],
  periodic: true,
  cell: [[8, 0, 0], [0, 8, 0], [0, 0, 8]],
}

async function mountSampler() {
  const ctx = new Context()
  ctx.provide('material', { get: async () => { throw new Error('stub: material not needed') } })
  const fiber = await ctx.registry.plugin({ name: 'saturday-sampler-ou', apply: (ctx) => plugin.apply(ctx, {}) })
  return { fiber, handles: fiber.store.saturdaySamplerOu }
}

test('1. 纯层降级链：缺组分锚点距离 null 排尾，目标构造照常（排尾不是排除）', async () => {
  const { createAnchorStore, mixtureTargetFromRetrieved } = await import('../src/anchor-store.mjs')
  const store = createAnchorStore()
  store.add({ graph: graph4, source: 'inline:known', composition: { Cu: 3, Ag: 1 } })
  store.add({ graph: graph4, source: 'inline:unknown' })   // 无组分：不可考
  const hits = store.retrieve({ nAtoms: 4, composition: { Cu: 3, Ag: 1 } })
  assert.equal(hits.length, 2, '不可考锚点参与检索（排尾不是排除）')
  assert.equal(hits[0].anchor.source, 'inline:known', '可比锚点按距离升序在前')
  assert.equal(hits[0].distance, 0)
  assert.equal(hits[1].anchor.source, 'inline:unknown', '不可考锚点排尾')
  assert.equal(hits[1].distance, null, '距离声明不可考（不冒充可比，不编造数值）')
  // 目标构造照常：不可考 ≠ 不可用（结构本体仍是合法锚点）
  const target = mixtureTargetFromRetrieved(hits)
  assert.equal(target.references.length, 2)
})

test('2. 工具层降级链：不可考锚点随交付呈现（距离声明如实透传）', async () => {
  const { fiber, handles } = await mountSampler()
  try {
    await handles.rt.tools.call('sampler.anchor.add', {
      graph: graph4, source: 'inline:known', composition: { Cu: 3, Ag: 1 },
    })
    await handles.rt.tools.call('sampler.anchor.add', {
      graph: graph4, source: 'inline:unknown', composition: undefined,
    })
    const result = await handles.rt.tools.call('sampler.mixture', {
      nAtoms: 4, composition: { Cu: 3, Ag: 1 }, n: 4, seed: 5,
    })
    assert.equal(result.anchors.length, 2, '不可考锚点参与混合提案（诚实降级不静默丢弃）')
    assert.equal(result.anchors[0].distance, 0, '可比锚点在前')
    assert.equal(result.anchors[1].distance, null, '不可考锚点距离随交付呈现（null = 组分不可考）')
    assert.equal(result.candidates.length, 4, '混合提案照常交付（缺省均匀权重）')
    // 两锚点都有候选：排尾锚点确实参与了混合（不是陪跑）
    const per = result.candidates.reduce((acc, c) => (acc[c.anchorIndex] = (acc[c.anchorIndex] ?? 0) + 1, acc), {})
    assert.equal(per[0], 2, '均匀权重下可比锚点配额 2')
    assert.equal(per[1], 2, '均匀权重下不可考锚点配额 2（参与混合的实证）')
  } finally {
    await fiber.dispose()
  }
})
