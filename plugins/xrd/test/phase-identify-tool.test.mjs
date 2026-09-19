// analysis.xrd.phaseIdentify 工具集成测试：用 Cu 的计算峰当"实测"，候选 [Cu, Al]，应判回 Cu。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bridgePlugin from '@toki0413/bridge'
import plugin from '../src/index.mjs'

test('1. phaseIdentify：Cu 实测峰在 Cu/Al 候选中判回 Cu + 轨迹落盘', async () => {
  const ctx = new Context()
  const dir = await mkdtemp(join(tmpdir(), 'sat-xrdid-'))
  const path = join(dir, 'trajectory.jsonl')
  const coreFiber = await ctx.registry.plugin({ name: 'saturday', apply: (c) => bridgePlugin.apply(c, { trajectoryPath: path, quiet: true }) })
  const xrdFiber = await ctx.registry.plugin({ name: 'saturday-xrd', apply: (c) => plugin.apply(c, { trajectoryPath: path }) })
  const coreRt = coreFiber.store.saturday.rt
  const xrdRt = xrdFiber.store.saturdayXrd.rt
  try {
    const cu = await coreRt.tools.call('material.load', { query: 'Cu' })
    const al = await coreRt.tools.call('material.load', { query: 'Al' })
    // 用 Cu 的计算峰当"实测谱"
    const cuPat = await xrdRt.tools.call('analysis.xrd', { materialId: cu.materialId ?? cu.id, twoThetaMaxDeg: 100 })
    const measuredPeaks = cuPat.peaks.map(p => ({ twoTheta: p.twoThetaDeg, intensity: p.intensityRel }))
    assert.ok(measuredPeaks.length >= 3)
    const out = await xrdRt.tools.call('analysis.xrd.phaseIdentify', {
      measuredPeaks, candidateIds: [cu.materialId ?? cu.id, al.materialId ?? al.id], tolDeg: 0.3,
    })
    assert.equal(out.best, cu.materialId ?? cu.id, '应判回 Cu')
    assert.ok(out.ranked[0].score > 0.9, `self-match 高分，got ${out.ranked[0].score}`)
    assert.ok(out.note.includes('Rietveld'))
    await new Promise(r => setTimeout(r, 50))
    const text = await readFile(path, 'utf8')
    assert.ok(text.includes('"xrd-phase-identify"'), 'analysis_complete(xrd-phase-identify) 落 Trajectory')
  } finally {
    await xrdFiber.dispose()
    assert.ok(!xrdRt.tools.list().some(t => t.name === 'analysis.xrd.phaseIdentify'), '工具随卸载回收')
    await coreFiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('2. 缺 measuredPeaks/candidateIds 显式报错', async () => {
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin({ name: 'saturday', apply: (c) => bridgePlugin.apply(c, { quiet: true }) })
  const xrdFiber = await ctx.registry.plugin({ name: 'saturday-xrd', apply: (c) => plugin.apply(c, {}) })
  const xrdRt = xrdFiber.store.saturdayXrd.rt
  try {
    await assert.rejects(() => xrdRt.tools.call('analysis.xrd.phaseIdentify', { measuredPeaks: [], candidateIds: [] }),
      e => /ANALYSIS_INPUT_MISSING/.test(String(e?.message)))
  } finally {
    await xrdFiber.dispose(); await coreFiber.dispose()
  }
})
