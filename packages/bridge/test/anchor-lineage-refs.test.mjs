// 落盘侧谱系可追溯声明（磁盘数据起点的失效传播）：
// `sampler.anchor.load` 交付附 `lineageRefs`（载荷内可追溯来源的归一化声明，
// 与  归一规则同款：取 # 前段）——消费方不必翻库即可从磁盘数据起点发起
// 失效传播；声明不是装饰：沿 lineageRefs 逐个 invalidate，提案推导如实失效。
// 泄漏防护（纪律）：挂载即拉起 Python sidecar，前置断言入 try，finally 保证 dispose + 临时目录清理。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/saturday.plugin.mjs'
import derivationPlugin from '@toki0413/plugin-derivation'
import samplerOuPlugin from '@toki0413/plugin-sampler-ou'

const TRAJECTORY = fileURLToPath(new URL('../data/trajectory-lineage-refs.jsonl', import.meta.url))

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

test('1. lineageRefs 随交付呈现：归一化声明与载荷谱系一致（不冒充、不遗漏）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-lineage-refs-'))
  const sessionA = await mount()
  const sessionB = await mount()
  try {
    const cu = await sessionA.handles.materialService.load('Cu')
    sessionA.sampler.anchorStore.add({ graph: cu.graph, source: 'material:cu-ref', composition: { Cu: 4 } })
    sessionA.sampler.anchorStore.add({ graph: cu.graph, source: 'job:j-7#engine=emt-mock', composition: { Cu: 3, Ag: 1 } })
    const path = join(dir, 'refs.json')
    await sessionA.sampler.rt.tools.call('sampler.anchor.save', { path })
    await dispose(sessionA)

    const loaded = await sessionB.sampler.rt.tools.call('sampler.anchor.load', { path })
    assert.deepEqual(loaded.lineageRefs.sort(), ['job:j-7', 'material:cu-ref'],
      'lineageRefs 归一化声明（取 # 前段）与载荷谱系一致')
  } finally {
    await dispose(sessionB)
    await rm(dir, { recursive: true, force: true })
  }
})

test('2. 声明不是装饰：沿 lineageRefs 起点发起失效，提案推导如实失效（磁盘数据起点可撤回）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-lineage-live-'))
  const sessionA = await mount()
  const sessionB = await mount()
  try {
    const cu = await sessionA.handles.materialService.load('Cu')
    sessionA.sampler.anchorStore.add({ graph: cu.graph, source: 'material:cu-live-ref', composition: { Cu: 4 } })
    const path = join(dir, 'live-refs.json')
    await sessionA.sampler.rt.tools.call('sampler.anchor.save', { path })
    await dispose(sessionA)

    const loaded = await sessionB.sampler.rt.tools.call('sampler.anchor.load', { path })
    const mixture = await sessionB.sampler.rt.tools.call('sampler.mixture', {
      nAtoms: 4, composition: { Cu: 4 }, n: 2, seed: 6, batchId: 'refs-live',
    })
    const proposalRef = mixture.derivation.proposalRef
    assert.equal(sessionB.registry.status(proposalRef).status, 'valid')

    // 消费方不翻库：直接沿交付的 lineageRefs 起点发起失效（磁盘数据起点可撤回）
    for (const ref of loaded.lineageRefs) {
      await sessionB.registry.invalidate(ref, '沿落盘交付的可追溯声明起点撤回')
    }
    assert.equal(sessionB.registry.status(proposalRef).status, 'invalid',
      '沿 lineageRefs 起点的失效传播到提案（声明即活性起点，不是装饰）')
  } finally {
    await dispose(sessionB)
    await rm(dir, { recursive: true, force: true })
  }
})
