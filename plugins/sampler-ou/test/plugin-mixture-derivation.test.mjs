// 提案层谱系登记（活性上下文 §8.2）：锚点混合提案接推导登记簿——
// 注入推导服务时登记一层提案推导（输入 = 可追溯锚点来源，输出 = result:mixture-<batchId>）；
// 上游锚点失效沿推导图传播到提案；不可追溯来源不冒充推导输入（诚实声明）；
// 未注入服务时行为不变（纯编排层零依赖，与 workflow.screen 同款）。
// 泄漏防护（纪律）：挂载即拉起 Python sidecar，前置断言入 try，finally 保证 dispose。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import samplerPlugin from '../src/index.mjs'
import derivationPlugin from '@toki0413/plugin-derivation'

const graph4 = {
  nodes: Array.from({ length: 4 }, (_, i) => ({ number: 29, position: [i * 1.8, 0, 0] })),
  edges: [],
  periodic: true,
  cell: [[8, 0, 0], [0, 8, 0], [0, 0, 8]],
}

async function mount({ withDerivation } = {}) {
  const ctx = new Context()
  ctx.provide('material', { get: async () => { throw new Error('stub: material not needed') } })
  const derivationFiber = withDerivation
    ? await ctx.registry.plugin({ name: 'saturday-derivation', apply: (ctx) => derivationPlugin.apply(ctx, {}) })
    : null
  const samplerFiber = await ctx.registry.plugin({ name: 'saturday-sampler-ou', apply: (ctx) => samplerPlugin.apply(ctx, {}) })
  return {
    ctx,
    samplerFiber,
    derivationFiber,
    handles: samplerFiber.store.saturdaySamplerOu,
    registry: withDerivation ? ctx.reflect.get('derivation') : null,
  }
}

test('1. 注入推导服务：提案登记一层推导，锚点失效沿图传播到提案（活性上下文接通）', async () => {
  const env = await mount({ withDerivation: true })
  try {
    env.handles.anchorStore.add({ graph: graph4, source: 'material:cu-anchor', composition: { Cu: 4 } })
    const result = await env.handles.rt.tools.call('sampler.mixture', {
      nAtoms: 4, composition: { Cu: 4 }, n: 4, seed: 3, batchId: 'drv-test-1',
    })
    const rec = result.derivation
    assert.ok(rec, '注入推导服务后交付必须携带登记凭证')
    assert.equal(rec.batchId, 'drv-test-1')
    assert.deepEqual(rec.anchorRefs, ['material:cu-anchor'], '锚点来源归一化为推导输入')
    assert.equal(rec.proposalRef, 'result:mixture-drv-test-1')
    assert.equal(env.registry.status(rec.proposalRef).status, 'valid', '提案登记初始 valid')
    // 失效传播接通：锚点材料失效 → 提案随之失效（谱系不只是字符串，是活性推导图）
    await env.registry.invalidate('material:cu-anchor', '锚点材料撤回')
    assert.equal(env.registry.status(rec.proposalRef).status, 'invalid', '锚点失效必须传播到提案')
  } finally {
    await env.samplerFiber.dispose()
    await env.derivationFiber.dispose()
  }
})

test('2. 自动入库谱系归一：job:<id>#engine=<name> 取 # 前段为推导输入', async () => {
  const env = await mount({ withDerivation: true })
  try {
    env.handles.anchorStore.add({ graph: graph4, source: 'job:j-42#engine=emt-mock', composition: { Cu: 4 } })
    const result = await env.handles.rt.tools.call('sampler.mixture', {
      nAtoms: 4, n: 2, seed: 1,
    })
    assert.deepEqual(result.derivation.anchorRefs, ['job:j-42'], '自动入库谱系归一为 job 引用（引擎名不入引用）')
    assert.equal(result.derivation.untrackedSources.length, 0)
  } finally {
    await env.samplerFiber.dispose()
    await env.derivationFiber.dispose()
  }
})

test('3. 全部来源不可追溯：不伪登记，诚实声明随交付呈现', async () => {
  const env = await mount({ withDerivation: true })
  try {
    env.handles.anchorStore.add({ graph: graph4, source: 'inline:adhoc', composition: { Cu: 4 } })
    const sizeBefore = env.registry.size
    const result = await env.handles.rt.tools.call('sampler.mixture', {
      nAtoms: 4, n: 2, seed: 1,
    })
    assert.equal(env.registry.size, sizeBefore, '无可声明输入时不得伪登记')
    assert.equal(result.derivation.proposalRef, null)
    assert.deepEqual(result.derivation.untrackedSources, ['inline:adhoc'], '不可追溯来源如实声明')
    assert.ok(result.derivation.note.includes('不伪登记'))
  } finally {
    await env.samplerFiber.dispose()
    await env.derivationFiber.dispose()
  }
})

test('4. 未注入推导服务：行为不变（交付无 derivation 字段，纯编排层零依赖）', async () => {
  const env = await mount({ withDerivation: false })
  try {
    env.handles.anchorStore.add({ graph: graph4, source: 'material:cu-anchor', composition: { Cu: 4 } })
    const result = await env.handles.rt.tools.call('sampler.mixture', {
      nAtoms: 4, n: 2, seed: 1,
    })
    assert.ok(!('derivation' in result), '未注入服务时交付不得携带登记凭证')
    assert.equal(result.candidates.length, 2, '提案交付本身不受影响')
  } finally {
    await env.samplerFiber.dispose()
  }
})
