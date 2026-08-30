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

test('4. ㉜ 完整性校验：版本门禁 + size 声明对账（声明 ≠ 实质即拒，不静默接受）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-anchor-integrity-'))
  const env = await mount()
  try {
    // 版本门禁：未知版本形态不静默接受（不猜测兼容）
    const alien = join(dir, 'alien-version.json')
    await writeFile(alien, JSON.stringify({ version: 'saturday-anchor-store/9', size: 1,
      entries: [{ graph: graph4, source: 'material:cu-a', composition: { Cu: 4 } }] }))
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.load', { path: alien }),
      err => err.code === 'ANCHOR_PERSIST' && /版本不受支持/.test(err.message),
    )
    // 无版本声明同样拒（缺失不冒充合法形态）
    const noversion = join(dir, 'no-version.json')
    await writeFile(noversion, JSON.stringify({ size: 1,
      entries: [{ graph: graph4, source: 'material:cu-a', composition: { Cu: 4 } }] }))
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.load', { path: noversion }),
      err => err.code === 'ANCHOR_PERSIST' && /版本不受支持/.test(err.message),
    )
    // size 声明对账：声明 ≠ 实质即拒（不猜测补齐）
    const mismatch = join(dir, 'size-mismatch.json')
    await writeFile(mismatch, JSON.stringify({ version: 'saturday-anchor-store/2', size: 5,
      entries: [{ entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'material:cu-a', composition: { Cu: 4 } }] }))
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.load', { path: mismatch }),
      err => err.code === 'ANCHOR_PERSIST' && /完整性声明与实质不符/.test(err.message),
    )
    assert.equal(env.handles.anchorStore.size(), 0, '三条完整性门禁都不得污染库')
  } finally {
    await env.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('5. ㉜ 单条损坏不连坐：坏条目逐条拒绝，合法条目照常入库（完整性门禁不开旁路）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-anchor-partial-'))
  const env = await mount()
  try {
    const partial = join(dir, 'partial.json')
    await writeFile(partial, JSON.stringify({ version: 'saturday-anchor-store/2', size: 3, entries: [
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'material:cu-good', composition: { Cu: 4 } },
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4 },   // 坏条目：无谱系（由共享导入循环逐条拒绝，不连坐）
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'job:j-1#engine=emt-mock', composition: { Cu: 3, Ag: 1 } },
    ] }))
    const loaded = await env.handles.rt.tools.call('sampler.anchor.load', { path: partial })
    assert.equal(loaded.added, 2, '合法条目不因坏条目连坐')
    assert.equal(loaded.rejected.length, 1, '坏条目逐条如实拒绝')
    assert.equal(env.handles.anchorStore.size(), 2)
  } finally {
    await env.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('6. ㉝ 条目级版本戳：损坏定位到条目（含载荷原位索引），不连坐合法条目', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-anchor-stamp-'))
  const env = await mount()
  try {
    const stamped = join(dir, 'stamped.json')
    await writeFile(stamped, JSON.stringify({ version: 'saturday-anchor-store/2', size: 3, entries: [
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'material:cu-ok', composition: { Cu: 4 } },
      { graph: graph4, source: 'material:cu-nostamp', composition: { Cu: 4 } },   // 缺版本戳：条目级损坏，定位到索引 1
      { entryVersion: 'saturday-anchor-entry/9', graph: graph4, source: 'job:j-9', composition: { Cu: 4 } },   // 未知版本戳：定位到索引 2
    ] }))
    const loaded = await env.handles.rt.tools.call('sampler.anchor.load', { path: stamped })
    assert.equal(loaded.added, 1, '合法条目照常入库（不连坐）')
    assert.deepEqual(loaded.rejected.map(r => r.index).sort(), [1, 2], '损坏定位到载荷原位索引（过滤后不丢定位能力）')
    assert.ok(loaded.rejected.every(r => /条目版本戳/.test(r.reason)), '拒绝原因如实声明条目级损坏')
    assert.equal(env.handles.anchorStore.size(), 1)
  } finally {
    await env.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('7. ㉞ 多载荷合并回填：同谱系幂等兜底跨载荷重复 + 门禁先行（任一文件不过 → 整批拒绝、库零污染）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-anchor-multi-'))
  const env = await mount()
  try {
    const p1 = join(dir, 'p1.json')
    const p2 = join(dir, 'p2.json')
    const bad = join(dir, 'bad.json')
    await writeFile(p1, JSON.stringify({ version: 'saturday-anchor-store/2', size: 2, entries: [
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'material:cu-m', composition: { Cu: 4 } },
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'job:j-m#engine=emt-mock', composition: { Cu: 3, Ag: 1 } },
    ] }))
    await writeFile(p2, JSON.stringify({ version: 'saturday-anchor-store/2', size: 2, entries: [
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'material:cu-m', composition: { Cu: 4 } },   // 与 p1 同谱系：幂等跳过
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'material:ag-m', composition: { Ag: 4 } },
    ] }))
    // 合并回填：同谱系幂等门禁天然兜底跨载荷重复；逐文件明细随交付呈现
    const merged = await env.handles.rt.tools.call('sampler.anchor.load', { paths: [p1, p2] })
    assert.equal(merged.added, 3, '跨载荷合并去重后入库三条')
    assert.equal(merged.skipped, 1, '同谱系跨载荷重复幂等跳过')
    assert.equal(merged.files.length, 2, '逐文件明细随交付')
    assert.equal(merged.files[1].skipped, 1, '重复定位在第二份载荷')
    assert.deepEqual(merged.lineageRefs.sort(), ['job:j-m', 'material:ag-m', 'material:cu-m'], 'lineageRefs 跨载荷合并去重')
    assert.equal(env.handles.anchorStore.size(), 3)
    // 门禁先行：批次内含损坏文件 → 整批拒绝，已入库条目不受影响（库零污染）
    await writeFile(bad, 'not-json')
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.load', { paths: [p2, bad] }),
      err => err.code === 'ANCHOR_PERSIST' && /门禁先行/.test(err.message),
    )
    assert.equal(env.handles.anchorStore.size(), 3, '门禁先行：出错时未写入任何条目')
    // path 与 paths 二选一门禁（不静默猜测调用方意图）
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.load', { path: p1, paths: [p2] }),
      /必须且只能提供/,
    )
  } finally {
    await env.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('8. ㉟ 血缘审计（只读）：三态统计如实 + 审计不回填不污染库 + 异常文件如实入报告', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-anchor-audit-'))
  const env = await mount()
  try {
    const mixed = join(dir, 'mixed.json')
    const broken = join(dir, 'broken.json')
    await writeFile(mixed, JSON.stringify({ version: 'saturday-anchor-store/2', size: 4, entries: [
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'material:cu-t', composition: { Cu: 4 } },   // 可追溯
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'job:j-t#engine=emt-mock', composition: { Cu: 4 } },   // 可追溯（含引擎后缀）
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'inline:adhoc', composition: { Cu: 4 } },   // 不可追溯（有来源非可追溯形态）
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4 },   // 损坏（来源缺失，回填必拒）
    ] }))
    await writeFile(broken, 'not-json')
    const report = await env.handles.rt.tools.call('sampler.anchor.audit', { paths: [mixed, broken] })
    assert.equal(report.files[0].ok, true)
    assert.deepEqual(
      { t: report.files[0].traceable, u: report.files[0].untracked, c: report.files[0].corrupt },
      { t: 2, u: 1, c: 1 },
      '三态统计如实：可追溯/不可追溯/损坏',
    )
    assert.equal(report.files[1].ok, false, '异常文件如实入报告（不连坐其余文件，不冒充可审计）')
    assert.equal(env.handles.anchorStore.size(), 0, '审计为只读观测：不回填、库零污染')
  } finally {
    await env.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
