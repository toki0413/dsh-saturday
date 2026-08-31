// 修复后载荷的活性闭环：
// 不可追溯载荷经修复原语修复 + 审计验收后回填——修复达标的数据成为数据燃料：
// 提案照常登记推导（谱系用修复后的来源，不冒充原件），沿修复后谱系可撤回。
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

const TRAJECTORY = fileURLToPath(new URL('../data/trajectory-repair-liveness.jsonl', import.meta.url))

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

test('1. 修复达标的数据成为数据燃料：验收→回填→提案登记推导，沿修复后谱系可撤回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-repair-live-'))
  const env = await mount()
  try {
    const cu = await env.handles.materialService.load('Cu')
    const src = join(dir, 'src.json')
    const fixed = join(dir, 'fixed.json')
    await writeFile(src, JSON.stringify({ version: STORE_VERSION, size: 1, entries: [
      { entryVersion: ENTRY_VERSION, graph: cu.graph, source: 'inline:adhoc-live', composition: { Cu: 4 } },
    ] }))
    // 观测→修复→验收：修复写新载荷，审计是修复的验收面（全可追溯才进下一环）
    await env.sampler.rt.tools.call('sampler.anchor.repair', {
      path: src, out: fixed, repairs: [{ index: 0, source: 'material:cu-repaired-live' }],
    })
    const verdict = await env.sampler.rt.tools.call('sampler.anchor.audit', { path: fixed })
    assert.equal(verdict.files[0].traceable, 1, '验收环：修复后载荷全可追溯')

    // 入库环：验收达标的载荷回填，即刻参与提案（修复达标的数据成为数据燃料）
    const loaded = await env.sampler.rt.tools.call('sampler.anchor.load', { path: fixed })
    assert.equal(loaded.added, 1)
    assert.deepEqual(loaded.lineageRefs, ['material:cu-repaired-live'], '回填谱系用修复后的来源（不冒充原件）')

    const mixture = await env.sampler.rt.tools.call('sampler.mixture', {
      nAtoms: 4, composition: { Cu: 4 }, n: 2, seed: 11, batchId: 'repair-live',
    })
    const proposalRef = mixture.derivation.proposalRef
    assert.equal(env.registry.status(proposalRef).status, 'valid', '提案照常登记推导（活性不因修复史降级）')

    // 活性环：沿修复后谱系失效 → 提案推导如实失效（修复后的数据同样可撤回）
    await env.registry.invalidate('material:cu-repaired-live', '沿修复后谱系撤回')
    assert.equal(env.registry.status(proposalRef).status, 'invalid',
      '失效沿修复后谱系传播到提案（活性闭环：可追溯即意味着可撤回）')
    assert.equal(env.sampler.anchorStore.size(), 1, '失效不删数据：库内条目照常在场')
  } finally {
    await dispose(env)
    await rm(dir, { recursive: true, force: true })
  }
})

test('2. 修复后载荷的提案归属如实：锚点来源是修复声明的来源，原件来源不冒充在场', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-repair-attr-'))
  const env = await mount()
  try {
    const cu = await env.handles.materialService.load('Cu')
    const src = join(dir, 'src.json')
    const fixed = join(dir, 'fixed.json')
    await writeFile(src, JSON.stringify({ version: STORE_VERSION, size: 1, entries: [
      { entryVersion: ENTRY_VERSION, graph: cu.graph, source: 'inline:adhoc-attr', composition: { Cu: 4 } },
    ] }))
    await env.sampler.rt.tools.call('sampler.anchor.repair', {
      path: src, out: fixed, repairs: [{ index: 0, source: 'job:j-repair-attr#engine=emt-mock' }],
    })
    await env.sampler.rt.tools.call('sampler.anchor.load', { path: fixed })

    const mixture = await env.sampler.rt.tools.call('sampler.mixture', {
      nAtoms: 4, composition: { Cu: 4 }, n: 2, seed: 12, batchId: 'repair-attr',
    })
    // 提案归属逐条如实：修复声明的来源（归一化取 # 前段），原件的不可追溯来源不冒充在场
    assert.deepEqual(mixture.derivation.anchorRefs, ['job:j-repair-attr'],
      '提案推导登记的输入是修复后的可追溯来源（同提案登记归一规则）')
    assert.ok(!env.sampler.anchorStore.entries().some(e => String(e.source).startsWith('inline:adhoc-attr')),
      '原件的不可追溯来源未入库（修复链不携带原件谱系进场）')
  } finally {
    await dispose(env)
    await rm(dir, { recursive: true, force: true })
  }
})
