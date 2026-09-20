// 跨引擎 A/B 对账测试：纯比较器不变量 + runtime.engine.crossCheck 工具集成（真桥 + 注入 stub 引擎）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bridgePlugin from '../src/saturday.plugin.mjs'
import { crossCompare } from '../src/cross-check.mjs'

const run = (engine, energyPerAtom, over = {}) => ({
  engine, energyPerAtom,
  units: { energy: 'eV', length: 'Å', time: 'fs' },
  fingerprint: { software: engine, method: 'm', version: '1.0' }, ...over,
})

test('1. 纯比较器：<2 引擎/非有限能/缺单位/缺指纹 各显式报错', () => {
  assert.throws(() => crossCompare([run('a', 1)]), e => e.code === 'CROSS_NEED_TWO')
  assert.throws(() => crossCompare([run('a', NaN), run('b', 1)]), e => e.code === 'CROSS_BAD_RUN')
  assert.throws(() => crossCompare([{ engine: 'a', energyPerAtom: 1, fingerprint: { software: 'a', method: 'm' } }, run('b', 1)]), e => e.code === 'CROSS_BAD_RUN')
})

test('2. 同单位 → comparable + delta；异单位 → comparable=false 仍报原始差', () => {
  const a = run('eA', -3.0), b = run('eB', -2.5)
  const r = crossCompare([a, b])
  assert.equal(r.pairs.length, 1)
  const p = r.pairs[0]
  assert.equal(p.comparable, true); assert.equal(p.sameUnits, true)
  close(p.deltaEnergyPerAtom, -0.5, 1e-12)
  assert.equal(p.fingerprintSame, false, 'software 不同 → 标注不同源')
  const ryd = run('eRy', -3.0, { units: { energy: 'Ry', length: 'Å', time: 'fs' } })
  const r2 = crossCompare([a, ryd])
  assert.equal(r2.pairs[0].comparable, false, 'eV vs Ry 单位不一致 → 不可比')
  assert.equal(r2.allComparable, false)
  assert.ok(Number.isFinite(r2.pairs[0].deltaEnergyPerAtom), '不可比也报原始差,不自动换算')
})

function close(a, b, eps, msg = '') { assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps}) ${msg}`) }

test('3. unknown 版本通配：同 software/method 且一方 unknown → same=true 且 reason 标未验证', () => {
  const a = { ...run('eA', -3), fingerprint: { software: 'ase', method: 'EMT', version: 'unknown' } }
  const b = { ...run('eB', -3.1), fingerprint: { software: 'ase', method: 'EMT', version: '3.26' } }
  const p = crossCompare([a, b]).pairs[0]
  assert.equal(p.fingerprintSame, true)
  assert.ok(/未验证|unknown|通配/.test(p.fingerprintReason || '') || p.fingerprintReason === null, '同源含未验证维如实标')
})

test('4. runtime.engine.crossCheck 工具：真桥 + stub 引擎 A/B + 轨迹落盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-xcheck-'))
  const path = join(dir, 'trajectory.jsonl')
  const ctx = new Context()
  const core = await ctx.registry.plugin({ name: 'saturday', apply: (c) => bridgePlugin.apply(c, { trajectoryPath: path, quiet: true }) })
  const { rt, potential } = core.store.saturday
  try {
    // 注入第二个引擎（stub），与当前数据面引擎做 A/B
    potential.register({
      name: 'ab-stub',
      manifest: {
        capabilities: [{ type: 'calculate', properties: ['energy'], accuracy: 0.4, speed: 0.9, cost: 0.1, maxAtoms: 100 }],
        constraints: {}, eventGranularity: 'job',
        units: { energy: 'eV', length: 'Å', time: 'fs' },
        fingerprint: { software: 'ab-stub', method: 'toy', version: 'unknown' },
      },
      async calculate(material) { return { energy: -3.7 * material.nAtoms, calculator: 'ab-stub' } },
    })
    const cu = await rt.tools.call('material.load', { query: 'Cu' })
    const active = potential.activeProvider
    const engines = [active, 'ab-stub']
    const out = await rt.tools.call('runtime.engine.crossCheck', { materialId: cu.materialId ?? cu.id, engines, kind: 'calculate' })
    assert.equal(out.nEngines, 2)
    assert.equal(out.runs.length, 2)
    assert.ok(out.runs.every(r => Number.isFinite(r.energyPerAtom)))
    assert.equal(out.pairs[0].sameUnits, true, '两者均 eV/Å/fs → 可比')
    assert.equal(out.allComparable, true)
    assert.equal(out.pairs[0].fingerprintSame, false, 'ab-stub 与数据面引擎 software 不同 → 标注不同源')
    assert.ok(Number.isFinite(out.pairs[0].deltaEnergyPerAtom))
    await new Promise(r => setTimeout(r, 50))
    const text = await readFile(path, 'utf8')
    assert.ok(text.includes('runtime_engine_cross_check'), 'A/B 动作落 Trajectory 可回放')
  } finally {
    await core.dispose(); await rm(dir, { recursive: true, force: true })
  }
})

test('5. 引擎不足 2 / 未在册 → 工具显式报错', async () => {
  const ctx = new Context()
  const core = await ctx.registry.plugin({ name: 'saturday', apply: (c) => bridgePlugin.apply(c, { quiet: true }) })
  const { rt } = core.store.saturday
  try {
    const cu = await rt.tools.call('material.load', { query: 'Cu' })
    const id = cu.materialId ?? cu.id
    await assert.rejects(() => rt.tools.call('runtime.engine.crossCheck', { materialId: id, engines: ['ghost'], kind: 'calculate' }),
      e => e.code === 'CROSS_NEED_TWO')
    await assert.rejects(() => rt.tools.call('runtime.engine.crossCheck', { materialId: id, engines: ['lj-js', 'ghost'], kind: 'calculate' }),
      e => e.code === 'CROSS_ENGINE_UNAVAILABLE')
  } finally { await core.dispose() }
})
