// 54 性能基线（发布前演练批次）：纯层量级读数——入库/检索/提案/落盘往返在千级
// 规模下的耗时如实呈报。读数即事实，不设阈值不做门禁（同 ㊵/52 纪律：呈报不是门禁）；
// 量级读数不可行即诚实呈现（断言只保证读数存在且有限，不断言快慢）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import plugin, { createAnchorStore, ouSampleMixture } from '../src/index.mjs'

const mkGraph = (n) => ({
  cell: [[8, 0, 0], [0, 8, 0], [0, 0, 8]],
  nodes: Array.from({ length: n }, (_, i) => ({ number: 29, position: [(i % 4) * 1.8, Math.floor(i / 4) * 1.8, 0] })),
})

const ms = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6 }
const msAsync = async (fn) => { const t = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t) / 1e6 }

test('1. 纯层量级读数：入库/检索/提案（千级锚点，读数如实不门禁）', async () => {
  const N = 2000
  const store = createAnchorStore()
  const graph4 = mkGraph(4)

  const addMs = ms(() => {
    for (let i = 0; i < N; i++) {
      store.add({ graph: graph4, source: `job:perf-${i}#engine=emt-mock`, composition: { Cu: 4 - (i % 2), Ag: i % 2 } })
    }
  })
  assert.equal(store.size(), N)

  const retrieveMs = ms(() => store.retrieve({ nAtoms: 4, composition: { Cu: 3, Ag: 1 }, topK: 8 }))
  const hits = store.retrieve({ nAtoms: 4, composition: { Cu: 3, Ag: 1 }, topK: 8 })
  const target = store.toMixtureTarget(hits, { weights: hits.map(() => 1 / hits.length) })
  const mixtureMs = await msAsync(() => ouSampleMixture(target, { n: 64, seed: 7, uEq: 0.05, gammaDt: 1.0 }))

  const readings = { N, addMs, retrieveMs, mixtureMs }
  console.log(`性能基线（54，纯层）: 入库 ${N} 锚点 = ${addMs.toFixed(1)} ms；检索 = ${retrieveMs.toFixed(2)} ms；混合提案 n=64 = ${mixtureMs.toFixed(1)} ms`)
  for (const [k, v] of Object.entries(readings)) {
    assert.ok(Number.isFinite(v) && v >= 0, `读数 ${k} 必须为有限非负数（读数即事实）`)
  }
})

test('2. 落盘→回填往返量级读数（工具层，千级条目无损往返）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-perf-roundtrip-'))
  const ctx = new Context()
  ctx.provide('material', { get: async () => { throw new Error('stub: material not needed') } })
  const fiber = await ctx.registry.plugin({ name: 'saturday-sampler-ou', apply: (ctx) => plugin.apply(ctx, {}) })
  const handles = fiber.store.saturdaySamplerOu
  try {
    const N = 500
    const graph4 = mkGraph(4)
    for (let i = 0; i < N; i++) {
      handles.anchorStore.add({ graph: graph4, source: `job:rt-${i}#engine=emt-mock`, composition: { Cu: 4 } })
    }
    const path = join(dir, 'perf.json')
    const saveMs = await msAsync(() => handles.rt.tools.call('sampler.anchor.save', { path }))

    // 新挂载回填：库随会话回收后从磁盘续供（同 ㉗ 形态）
    const ctx2 = new Context()
    ctx2.provide('material', { get: async () => { throw new Error('stub: material not needed') } })
    const fiber2 = await ctx2.registry.plugin({ name: 'saturday-sampler-ou', apply: (ctx) => plugin.apply(ctx, {}) })
    try {
      const loadMs = await msAsync(() => fiber2.store.saturdaySamplerOu.rt.tools.call('sampler.anchor.load', { path }))
      assert.equal(fiber2.store.saturdaySamplerOu.anchorStore.size(), N, '往返不丢条目（无损）')
      console.log(`性能基线（54，往返）: 落盘 ${N} 条 = ${saveMs.toFixed(1)} ms；回填 = ${loadMs.toFixed(1)} ms`)
      assert.ok(Number.isFinite(saveMs) && saveMs >= 0 && Number.isFinite(loadMs) && loadMs >= 0, '读数即事实')
    } finally {
      await fiber2.dispose()
    }
  } finally {
    await fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
