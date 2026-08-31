// 故障注入：验收的是失败形态而不是成功路径——
// 截断载荷（中断写/断电模拟）→ 回填诚实拒绝且库零污染；截断快照 → 回填拒绝；
// 多载荷合并时一好一坏 → 整批拒绝（门禁先行：出错时库零污染，同合并门禁纪律）。
// 泄漏防护（纪律）：前置断言入 try，finally 保证 dispose + 临时目录清理。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
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

test('1. 截断载荷（中断写模拟）→ 回填诚实拒绝 + 库零污染（失败形态验收）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-failure-drill-'))
  const src = await mount()
  const dst = await mount()
  try {
    src.handles.anchorStore.add({ graph: graph4, source: 'material:cu-drill', composition: { Cu: 4 } })
    const goodPath = join(dir, 'good.json')
    await src.handles.rt.tools.call('sampler.anchor.save', { path: goodPath })
    const full = await readFile(goodPath, 'utf8')

    // 断电模拟 A：写一半就断（JSON 不完整）→ 回填拒绝，不静默吞掉半份数据
    const tornPath = join(dir, 'torn.json')
    await writeFile(tornPath, full.slice(0, Math.floor(full.length / 2)))
    await assert.rejects(
      () => dst.handles.rt.tools.call('sampler.anchor.load', { path: tornPath }),
      err => err instanceof Error, '截断载荷 → 回填显式拒绝（不静默冒充成功）')
    assert.equal(dst.handles.anchorStore.size(), 0, '截断回填失败后库零污染')

    // 断电模拟 B：尾部多写垃圾（撕裂写）→ 同样拒绝
    const garbagePath = join(dir, 'garbage.json')
    await writeFile(garbagePath, full + '\u0000GARBAGE')
    await assert.rejects(
      () => dst.handles.rt.tools.call('sampler.anchor.load', { path: garbagePath }),
      err => err instanceof Error, '尾部垃圾 → 回填显式拒绝')
    assert.equal(dst.handles.anchorStore.size(), 0, '撕裂写回填失败后库零污染')

    // 对照：原载荷完好可回填（故障注入不伤好数据）
    const loaded = await dst.handles.rt.tools.call('sampler.anchor.load', { path: goodPath })
    assert.equal(loaded.added, 1, '对照面：完好载荷照常回填')
  } finally {
    await src.fiber.dispose()
    await dst.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('2. 截断判据快照 → 回填拒绝（结论依据损坏不冒充可续供）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-snapshot-drill-'))
  const env = await mount()
  try {
    const assessment = { met: false, reasons: ['容量缺口'], readings: { size: 0 }, thresholds: { minSize: 1 } }
    const goodPath = join(dir, 'snap.json')
    await env.handles.rt.tools.call('sampler.trigger.snapshot.save', { path: goodPath, assessment, batchId: 'drill-b1' })
    const full = await readFile(goodPath, 'utf8')
    const tornPath = join(dir, 'snap-torn.json')
    await writeFile(tornPath, full.slice(0, Math.floor(full.length / 3)))
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.trigger.snapshot.load', { path: tornPath }),
      err => err instanceof Error, '截断快照 → 回填显式拒绝（损坏的结论依据不冒充可续供）')
  } finally {
    await env.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('3. 多载荷合并门禁先行：一好一坏 → 整批拒绝 + 库零污染（同合并门禁纪律）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-merge-drill-'))
  const src = await mount()
  const dst = await mount()
  try {
    src.handles.anchorStore.add({ graph: graph4, source: 'material:cu-ok', composition: { Cu: 4 } })
    const goodPath = join(dir, 'good.json')
    await src.handles.rt.tools.call('sampler.anchor.save', { path: goodPath })
    const full = await readFile(goodPath, 'utf8')
    const badPath = join(dir, 'bad.json')
    await writeFile(badPath, full.slice(0, 10))

    await assert.rejects(
      () => dst.handles.rt.tools.call('sampler.anchor.load', { paths: [goodPath, badPath] }),
      err => err instanceof Error, '任一文件损坏 → 整批拒绝（门禁先行）')
    assert.equal(dst.handles.anchorStore.size(), 0,
      '好文件不因坏文件同伴而先行入库（出错时库零污染——验收的是失败形态）')
  } finally {
    await src.fiber.dispose()
    await dst.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
