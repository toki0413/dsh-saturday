// analysis.quasiharmonic 工具集成测试：真桥 + phonon 挂载，极小网格跑通 QHA 交付形态与确定性。
// 不断言 α 符号/数值（玩具势+稀网格无定量意义，见交付 note），只验结构有效 + 可复现 + 谱系落盘。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bridgePlugin from '@toki0413/bridge'
import plugin from '../src/index.mjs'

test('1. analysis.quasiharmonic 端到端：交付形态 + 确定性 + 轨迹落盘', async () => {
  const ctx = new Context()
  const dir = await mkdtemp(join(tmpdir(), 'sat-qha-'))
  const path = join(dir, 'trajectory.jsonl')
  const coreFiber = await ctx.registry.plugin({ name: 'saturday', apply: (c) => bridgePlugin.apply(c, { trajectoryPath: path, quiet: true }) })
  const phFiber = await ctx.registry.plugin({ name: 'saturday-phonon', apply: (c) => plugin.apply(c, { trajectoryPath: path }) })
  const coreRt = coreFiber.store.saturday.rt
  const phRt = phFiber.store.saturdayPhonon.rt
  try {
    const cu = await coreRt.tools.call('material.load', { query: 'Cu' })
    const args = { materialId: cu.materialId, scales: [0.99, 1, 1.01], temperatures: [100, 300], mesh: 4 }
    let out
    try {
      out = await phRt.tools.call('analysis.quasiharmonic', args)
    } catch (err) {
      assert.equal(err.code, 'PHONON_FORCE_MISSING', '无力引擎必须显式失败（不静默）')
      return
    }
    assert.ok(out.baseVolume > 0)
    assert.equal(out.points.length, 2)
    assert.ok(out.points.every(p => Number.isFinite(p.scale) && Number.isFinite(p.volume)))
    assert.ok(out.points.every(p => p.volume > 0))
    assert.ok(out.equilibriumT0.scale >= 0.99 && out.equilibriumT0.scale <= 1.01, 'T=0 平衡标度应在网格内')
    assert.ok(out.note.includes('准谐'))
    // 确定性复现
    const out2 = await phRt.tools.call('analysis.quasiharmonic', args)
    assert.equal(out2.volumeAt0, out.volumeAt0)
    assert.deepEqual(out2.points.map(p => p.scale), out.points.map(p => p.scale))
    await new Promise(r => setTimeout(r, 50))
    const text = await readFile(path, 'utf8')
    assert.ok(text.includes('"quasiharmonic"'), 'analysis_complete(quasiharmonic) 落 Trajectory')
  } finally {
    await phFiber.dispose()
    assert.ok(!phRt.tools.list().some(t => t.name === 'analysis.quasiharmonic'), '工具随卸载回收')
    await coreFiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
