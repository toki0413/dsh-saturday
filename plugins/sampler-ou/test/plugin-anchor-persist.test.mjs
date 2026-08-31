// 持久化锚点库原型：库间搬运原语（导出/导入）——跨会话持久化的第一段。
// 导出交付无损 JSON 全量条目（含 graph 本体）；导入复用库层谱系/本体门禁，
// 同谱系幂等跳过（重放安全）；单条拒绝不中断整批（如实记录）。
// 诚实边界：库自身仍是会话级内存库，落盘与回填由调用方负责（不伪造库外数据）。
// 泄漏防护（纪律）：挂载即拉起 Python sidecar，前置断言入 try，finally 保证 dispose。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/index.mjs'

const graph4 = (n0 = 29) => ({
  nodes: Array.from({ length: 4 }, (_, i) => ({ number: i === 0 ? n0 : 29, position: [i * 1.8, 0, 0] })),
  edges: [],
  periodic: true,
  cell: [[8, 0, 0], [0, 8, 0], [0, 0, 8]],
})

async function mount() {
  const ctx = new Context()
  ctx.provide('material', { get: async () => { throw new Error('stub: material not needed') } })
  const fiber = await ctx.registry.plugin({ name: 'saturday-sampler-ou', apply: (ctx) => plugin.apply(ctx, {}) })
  return { fiber, handles: fiber.store.saturdaySamplerOu }
}

test('1. 导出/导入往返：无损 JSON 载荷，新库回填后逐字段一致（跨会话搬运原语成立）', async () => {
  const src = await mount()
  const dst = await mount()
  try {
    src.handles.anchorStore.add({ graph: graph4(), source: 'material:cu-a', composition: { Cu: 4 } })
    src.handles.anchorStore.add({ graph: graph4(47), source: 'job:j-7#engine=emt-mock', composition: { Ag: 1, Cu: 3 }, energy: -1.25 })
    const payload = await src.handles.rt.tools.call('sampler.anchor.export', {})
    assert.equal(payload.version, 'saturday-anchor-store/2')
    assert.equal(payload.size, 2)
    assert.ok(payload.entries.every(e => e.entryVersion === 'saturday-anchor-entry/1'), ' 条目版本戳随导出交付（损坏定位到条目级的载体）')
    // 无损 JSON 对账：序列化往返不丢信息（dsh 出口关卡同款要求的纯层预检）
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload, '导出载荷必须是无损 JSON')
    const r = await dst.handles.rt.tools.call('sampler.anchor.import', { entries: payload.entries })
    assert.equal(r.added, 2)
    assert.equal(r.skipped, 0)
    assert.equal(r.rejected.length, 0)
    // 新库状态逐字段一致：谱系、组分、能量、本体拓扑都在（不是残缺搬运）
    const restored = dst.handles.anchorStore.entries()
    assert.equal(restored.length, 2)
    assert.equal(restored[0].source, 'material:cu-a')
    assert.deepEqual(restored[0].composition, { Cu: 4 })
    assert.equal(restored[1].source, 'job:j-7#engine=emt-mock')
    assert.equal(restored[1].energy, -1.25, '能量随锚点搬运不丢')
    assert.equal(restored[1].graph.nodes.length, 4, 'graph 本体随锚点搬运不丢')
    // 回填的锚点即刻可参与混合提案（持久化的价值闭环：数据燃料跨会话续供）
    const mixture = await dst.handles.rt.tools.call('sampler.mixture', {
      nAtoms: 4, composition: { Cu: 4 }, n: 2, seed: 1,
    })
    assert.equal(mixture.anchors.length, 2, '回填锚点即刻进入检索面')
  } finally {
    await src.fiber.dispose()
    await dst.fiber.dispose()
  }
})

test('2. 导入幂等：同谱系重放跳过不重复累计（重放安全）', async () => {
  const env = await mount()
  try {
    env.handles.anchorStore.add({ graph: graph4(), source: 'material:cu-a', composition: { Cu: 4 } })
    const payload = await env.handles.rt.tools.call('sampler.anchor.export', {})
    const first = await env.handles.rt.tools.call('sampler.anchor.import', { entries: payload.entries })
    assert.equal(first.added, 0)
    assert.equal(first.skipped, 1, '同谱系已在库：跳过不重复累计')
    assert.equal(env.handles.anchorStore.size(), 1)
    const second = await env.handles.rt.tools.call('sampler.anchor.import', { entries: payload.entries })
    assert.equal(second.skipped, 1, '重复导入幂等（重放安全）')
    assert.equal(env.handles.anchorStore.size(), 1)
  } finally {
    await env.fiber.dispose()
  }
})

test('3. 导入门禁：无来源拒绝 + 缺 graph 拒绝（单条拒绝不中断整批，如实记录）', async () => {
  const env = await mount()
  try {
    const r = await env.handles.rt.tools.call('sampler.anchor.import', {
      entries: [
        { graph: graph4() },                                    // 无来源：谱系门禁拒绝
        { source: 'inline:no-graph' },                          // 缺 graph：库层本体门禁拒绝
        { graph: graph4(), source: 'material:ok', composition: { Cu: 4 } },   // 合法：照常入库
      ],
    })
    assert.equal(r.added, 1, '合法条目照常入库（不被坏条目连坐）')
    assert.equal(r.rejected.length, 2, '两条坏条目如实记录拒绝原因')
    assert.ok(r.rejected[0].reason.includes('来源'), '无来源拒绝原因可追溯')
    assert.ok(r.rejected[1].reason.includes('库层门禁'), '缺 graph 拒绝原因可追溯')
    assert.equal(env.handles.anchorStore.size(), 1)
    // entries 非数组：显式错（不静默）
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.import', {}),
      /entries/,
    )
  } finally {
    await env.fiber.dispose()
  }
})
