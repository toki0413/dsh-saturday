// ㊲ 多载荷合并后的失效传播端到端（汇聚不糊化谱系边界）：
// 两份不同来源的载荷经 ㉞ 合并回填后——跨载荷汇聚的谱系各自独立可撤回
//（沿某一来源失效，提案推导如实失效，另一来源照常在场）；
// 合并后提案的锚点归属与载荷谱系逐条一致（汇聚不改写谱系）。
// 泄漏防护（纪律）：挂载即拉起 Python sidecar，前置断言入 try，finally 保证 dispose + 临时目录清理。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/saturday.plugin.mjs'
import derivationPlugin from '@saturday/plugin-derivation'
import samplerOuPlugin from '@saturday/plugin-sampler-ou'

const TRAJECTORY = fileURLToPath(new URL('../data/trajectory-merge-liveness.jsonl', import.meta.url))

const ENTRY_VERSION = 'saturday-anchor-entry/1'
const STORE_VERSION = 'saturday-anchor-store/2'

async function mount() {
  await rm(TRAJECTORY, { force: true })
  const ctx = new Context()
  const fiber = await ctx.registry.plugin({
    name: 'saturday',
    apply: (ctx) => plugin.apply(ctx, { trajectoryPath: TRAJECTORY }),
  })
  const derivationFiber = await ctx.registry.plugin({
    name: 'saturday-derivation',
    apply: (ctx) => derivationPlugin.apply(ctx, {}),
  })
  const samplerFiber = await ctx.registry.plugin({
    name: 'saturday-sampler-ou',
    apply: (ctx) => samplerOuPlugin.apply(ctx, {}),
  })
  return {
    fiber, derivationFiber, samplerFiber,
    handles: fiber.store.saturday,
    registry: ctx.reflect.get('derivation'),
    sampler: samplerFiber.store.saturdaySamplerOu,
  }
}

async function dispose(env) {
  await env.samplerFiber.dispose()
  await env.derivationFiber.dispose()
  await env.fiber.dispose()
}

test('1. 合并回填后谱系各自独立可撤回：沿某一来源失效 → 提案失效，另一来源照常在场', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-merge-live-'))
  const env = await mount()
  try {
    const cu = await env.handles.materialService.load('Cu')
    const p1 = join(dir, 'p1.json')
    const p2 = join(dir, 'p2.json')
    await writeFile(p1, JSON.stringify({ version: STORE_VERSION, size: 1, entries: [
      { entryVersion: ENTRY_VERSION, graph: cu.graph, source: 'material:cu-merge', composition: { Cu: 4 } },
    ] }))
    await writeFile(p2, JSON.stringify({ version: STORE_VERSION, size: 1, entries: [
      { entryVersion: ENTRY_VERSION, graph: cu.graph, source: 'job:j-merge#engine=emt-mock', composition: { Cu: 4 } },
    ] }))
    const loaded = await env.sampler.rt.tools.call('sampler.anchor.load', { paths: [p1, p2] })
    assert.equal(loaded.added, 2, '跨载荷合并回填两条')

    const mixture = await env.sampler.rt.tools.call('sampler.mixture', {
      nAtoms: 4, composition: { Cu: 4 }, n: 2, seed: 8, batchId: 'merge-live',
    })
    const proposalRef = mixture.derivation.proposalRef
    assert.equal(env.registry.status(proposalRef).status, 'valid')

    // 汇聚不糊化谱系边界：沿其中一份载荷的来源失效，提案推导如实失效
    await env.registry.invalidate('job:j-merge', '跨载荷汇聚的谱系独立撤回')
    assert.equal(env.registry.status(proposalRef).status, 'invalid',
      '沿某一来源失效传播到提案（谱系各自独立可撤回）')
    // 失效不删数据：另一来源与全部条目照常在场（可撤回的是推导活性，不是库内数据）
    assert.equal(env.sampler.anchorStore.size(), 2, '失效不删数据：库内条目照常在场')
    assert.ok(env.sampler.anchorStore.entries().some(e => e.source === 'material:cu-merge'),
      '另一来源照常在场（汇聚的谱系边界不被糊化）')
  } finally {
    await dispose(env)
    await rm(dir, { recursive: true, force: true })
  }
})

test('2. 合并后提案的锚点归属与载荷谱系逐条一致（汇聚不改写谱系）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-merge-norm-'))
  const env = await mount()
  try {
    const cu = await env.handles.materialService.load('Cu')
    const p1 = join(dir, 'p1.json')
    const p2 = join(dir, 'p2.json')
    await writeFile(p1, JSON.stringify({ version: STORE_VERSION, size: 1, entries: [
      { entryVersion: ENTRY_VERSION, graph: cu.graph, source: 'material:cu-norm', composition: { Cu: 4 } },
    ] }))
    await writeFile(p2, JSON.stringify({ version: STORE_VERSION, size: 1, entries: [
      { entryVersion: ENTRY_VERSION, graph: cu.graph, source: 'job:j-norm#engine=emt-mock', composition: { Cu: 4 } },
    ] }))
    const loaded = await env.sampler.rt.tools.call('sampler.anchor.load', { paths: [p1, p2] })

    const mixture = await env.sampler.rt.tools.call('sampler.mixture', {
      nAtoms: 4, composition: { Cu: 4 }, n: 2, seed: 9, batchId: 'merge-norm',
    })
    // 提案锚点归属（归一化）与落盘载荷谱系逐条一致：不冒充、不丢、不改写
    const anchorRefs = mixture.anchors.map(a => a.source.split('#')[0]).sort()
    assert.deepEqual(anchorRefs, loaded.lineageRefs.slice().sort(),
      '合并后提案归属与载荷谱系一致（汇聚不改写谱系）')
    assert.equal(mixture.derivation.anchorRefs.length, 2, '提案推导登记双来源输入')
  } finally {
    await dispose(env)
    await rm(dir, { recursive: true, force: true })
  }
})
