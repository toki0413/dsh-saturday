// ㉔ 持久化落盘侧：库间搬运原语的文件端（导出载荷 ↔ 磁盘）——
// save 落盘（无损 JSON，路径调用方显式声明）→ 新会话 load 回填（门禁与导入工具同款）；
// 错误路径如实：文件缺失/损坏/非载荷形态显式报错（不静默返回空库冒充成功）。
// 泄漏防护（纪律）：挂载即拉起 Python sidecar，前置断言入 try，finally 保证 dispose + 临时目录清理。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/index.mjs'

const graph4 = {
  nodes: Array.from({ length: 4 }, (_, i) => ({ number: 29, position: [i * 1.8, 0, 0] })),
  edges: [],
  periodic: true,
  cell: [[8, 0, 0], [0, 8, 0], [0, 0, 8]],
}

async function mount() {
  const ctx = new Context()
  ctx.provide('material', { get: async () => { throw new Error('stub: material not needed') } })
  const fiber = await ctx.registry.plugin({ name: 'saturday-sampler-ou', apply: (ctx) => plugin.apply(ctx, {}) })
  return { fiber, handles: fiber.store.saturdaySamplerOu }
}

test('1. 落盘→跨会话回填：新库 load 后逐字段一致且即刻可提案', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-anchor-save-'))
  const src = await mount()
  const dst = await mount()
  try {
    src.handles.anchorStore.add({ graph: graph4, source: 'material:cu-a', composition: { Cu: 4 } })
    src.handles.anchorStore.add({ graph: graph4, source: 'job:j-9#engine=emt-mock', composition: { Cu: 3, Ag: 1 }, energy: -0.75 })
    const path = join(dir, 'anchors.json')
    const saved = await src.handles.rt.tools.call('sampler.anchor.save', { path })
    assert.equal(saved.saved, true)
    assert.equal(saved.size, 2)

    const loaded = await dst.handles.rt.tools.call('sampler.anchor.load', { path })
    assert.equal(loaded.loaded, true)
    assert.equal(loaded.added, 2)
    const restored = dst.handles.anchorStore.entries()
    assert.equal(restored[0].source, 'material:cu-a')
    assert.equal(restored[1].energy, -0.75, '能量随落盘载荷回填不丢')
    assert.equal(restored[1].graph.nodes.length, 4, 'graph 本体随落盘载荷回填不丢')
    // 回填锚点即刻可提案（跨会话数据燃料续供的价值闭环）
    const mixture = await dst.handles.rt.tools.call('sampler.mixture', {
      nAtoms: 4, composition: { Cu: 4 }, n: 2, seed: 1,
    })
    assert.equal(mixture.anchors.length, 2)
  } finally {
    await src.fiber.dispose()
    await dst.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('2. 错误路径如实：文件缺失/损坏/非载荷形态显式报错（不静默冒充成功）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-anchor-load-'))
  const env = await mount()
  try {
    // 文件缺失：显式错（不静默返回空库冒充成功）
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.load', { path: join(dir, 'missing.json') }),
      err => err.code === 'ANCHOR_PERSIST' && /不可读/.test(err.message),
    )
    // 损坏 JSON：显式错
    const corrupt = join(dir, 'corrupt.json')
    await writeFile(corrupt, '{not-json')
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.load', { path: corrupt }),
      err => err.code === 'ANCHOR_PERSIST' && /合法 JSON/.test(err.message),
    )
    // 合法 JSON 但非载荷形态（缺 entries）：显式错（不猜测冒充）
    const alien = join(dir, 'alien.json')
    await writeFile(alien, JSON.stringify({ hello: 'world' }))
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.load', { path: alien }),
      err => err.code === 'ANCHOR_PERSIST' && /entries/.test(err.message),
    )
    assert.equal(env.handles.anchorStore.size(), 0, '三条错误路径都不得污染库')
  } finally {
    await env.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('3. 会话内重载幂等 + 路径显式声明门禁', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-anchor-idem-'))
  const env = await mount()
  try {
    env.handles.anchorStore.add({ graph: graph4, source: 'material:cu-a', composition: { Cu: 4 } })
    const path = join(dir, 'anchors.json')
    await env.handles.rt.tools.call('sampler.anchor.save', { path })
    const again = await env.handles.rt.tools.call('sampler.anchor.load', { path })
    assert.equal(again.added, 0)
    assert.equal(again.skipped, 1, '同库重载：同谱系幂等跳过（重放安全）')
    assert.equal(env.handles.anchorStore.size(), 1)
    // 路径缺省：显式错（库不自作主张读写文件系统）
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.save', {}),
      err => err.code === 'ANCHOR_PERSIST',
    )
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.load', {}),
      err => err.code === 'ANCHOR_PERSIST',
    )
  } finally {
    await env.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
