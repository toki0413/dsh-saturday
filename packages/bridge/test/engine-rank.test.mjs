// runtime.engine.rank 集成测：两引擎对同一批候选回算 energyPerAtom，核对 Spearman/topK/平均绝对差与可比性。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import bridgePlugin from '../src/saturday.plugin.mjs'

function stubEngine(name, perAtomByFormula) {
  return {
    name,
    manifest: {
      capabilities: [{ type: 'calculate', properties: ['energy'], accuracy: 0.5, speed: 0.9, cost: 0.1, maxAtoms: 200 }],
      constraints: {}, eventGranularity: 'job',
      units: { energy: 'eV', length: 'Å', time: 'fs' },
      fingerprint: { software: name, method: 'rank-stub', version: 'unknown' },
    },
    async calculate(material) {
      const e = perAtomByFormula[material.formula]
      return { jobId: `j-${name}`, engine: name, calculator: name, energy: e * material.nAtoms }
    },
  }
}

async function boot() {
  const ctx = new Context()
  const core = await ctx.registry.plugin({ name: 'saturday', apply: (c) => bridgePlugin.apply(c, { quiet: true }) })
  const { rt, potential } = core.store.saturday
  potential.register(stubEngine('rk-a', { Cu: -4.0, Ni: -3.5 }))
  potential.register(stubEngine('rk-b', { Cu: -10.0, Ni: -9.0 }))     // 与 a 同序
  potential.register(stubEngine('rk-c', { Cu: -9.0, Ni: -10.0 }))     // 与 a 逆序
  return { rt, async close() { await core.dispose() } }
}

test('1. 同序两引擎：spearman=1、topK=1、meanAbsDelta 正确、comparable', async () => {
  const h = await boot()
  try {
    const cu = await h.rt.tools.call('material.load', { query: 'Cu' })
    const ni = await h.rt.tools.call('material.load', { query: 'Ni' })
    const out = await h.rt.tools.call('runtime.engine.rank', {
      materialIds: [cu.materialId ?? cu.id, ni.materialId ?? ni.id], engines: ['rk-a', 'rk-b'], kind: 'calculate', k: 1,
    })
    assert.equal(out.engines.length, 2)
    const p = out.pairs[0]
    assert.equal(p.a, 'rk-a'); assert.equal(p.b, 'rk-b'); assert.equal(p.comparable, true)
    assert.equal(p.spearman, 1)
    assert.equal(p.topK, 1)
    assert.ok(Math.abs(p.meanAbsDelta - 5.75) < 1e-9, `meanAbsDelta 期望 5.75 got ${p.meanAbsDelta}`)
  } finally { await h.close() }
})

test('2. 逆序两引擎：spearman=-1、topK(1)=0；三引擎两两均报', async () => {
  const h = await boot()
  try {
    const cu = await h.rt.tools.call('material.load', { query: 'Cu' })
    const ni = await h.rt.tools.call('material.load', { query: 'Ni' })
    const out = await h.rt.tools.call('runtime.engine.rank', {
      materialIds: [cu.materialId ?? cu.id, ni.materialId ?? ni.id], engines: ['rk-a', 'rk-c'], kind: 'calculate', k: 1,
    })
    const p = out.pairs[0]
    assert.equal(p.spearman, -1)
    assert.equal(p.topK, 0)
    const three = await h.rt.tools.call('runtime.engine.rank', {
      materialIds: [cu.materialId ?? cu.id, ni.materialId ?? ni.id], engines: ['rk-a', 'rk-b', 'rk-c'], kind: 'calculate',
    })
    assert.equal(three.pairs.length, 3, '三引擎两两 = 3 对')
  } finally { await h.close() }
})

test('3. 不足两引擎 / 不足两材料 / 未知名 显式报错', async () => {
  const h = await boot()
  try {
    const cu = await h.rt.tools.call('material.load', { query: 'Cu' })
    const id = cu.materialId ?? cu.id
    await assert.rejects(() => h.rt.tools.call('runtime.engine.rank', { materialIds: [id], engines: ['rk-a', 'rk-b'] }), e => e.code === 'RANK_NEEDS_MATERIALS')
    await assert.rejects(() => h.rt.tools.call('runtime.engine.rank', { materialIds: [id, id], engines: ['ghost-a', 'ghost-b'] }), e => e.code === 'RANK_ENGINE_UNAVAILABLE')
    await assert.rejects(() => h.rt.tools.call('runtime.engine.rank', { materialIds: [id, id], engines: ['rk-a'] }), e => e.code === 'RANK_NEEDS_TWO')
  } finally { await h.close() }
})
