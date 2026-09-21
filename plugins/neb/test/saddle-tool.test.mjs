// analysis.saddleSearch 工具层测试：挂 core + neb，走工具出口做闭式基准与失败模式核验。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bridgePlugin from '@toki0413/bridge'
import plugin from '../src/index.mjs'

test('1. analysis.saddleSearch：闭式基准走工具出口，鞍点/本征值/势垒逐位对账 + 谱系落盘', async () => {
  const ctx = new Context()
  const dir = await mkdtemp(join(tmpdir(), 'saturday-saddle-'))
  const path = join(dir, 'trajectory.jsonl')
  const coreFiber = await ctx.registry.plugin({
    name: 'saturday', apply: (c) => bridgePlugin.apply(c, { trajectoryPath: path, quiet: true }),
  })
  const nebFiber = await ctx.registry.plugin({
    name: 'saturday-neb', apply: (c) => plugin.apply(c, { trajectoryPath: path }),
  })
  const rt = nebFiber.store.saturdayNeb.rt
  try {
    const out = await rt.tools.call('analysis.saddleSearch',
      { system: 'quartic-double-well', c: 1, start: [0.5, 0.3] })
    assert.equal(out.system, 'quartic-double-well')
    assert.equal(out.converged, true, out.reason)
    assert.equal(out.reason, 'converged-index1')
    assert.ok(Math.hypot(...out.x) < 1e-6, `鞍点偏差 ${Math.hypot(...out.x)}`)
    assert.ok(Math.abs(out.eigenvalues[0] + 2) < 1e-9 && Math.abs(out.eigenvalues[1] - 2) < 1e-9)
    assert.equal(out.negativeCount, 1)
    assert.equal(out.indexVerified, true)
    assert.ok(Math.abs(out.barriers.forward - 0.25) < 1e-9, `势垒 ${out.barriers.forward} vs 闭式 0.25`)
    assert.equal(out.barriers.distinctMinima, true)
    assert.match(out.exactReference, /1\/\(4c\)/, '闭式参照随交付给出')
    assert.match(out.report.note, /恰一个负特征值/, '成功三条件写进报告')
    assert.ok(out.energyGradientEvals > 0 && out.costNote, '代价如实上报')

    // lj-double-well：鞍点由对称性精确在原点，势垒对独立 oracle
    const lj = await rt.tools.call('analysis.saddleSearch',
      { system: 'lj-double-well', start: [0.3, 0.1, 0], radius: 1.2 })
    assert.equal(lj.converged, true, lj.reason)
    assert.ok(Math.hypot(...lj.x) < 1e-6, `lj 鞍点偏差 ${Math.hypot(...lj.x)}`)
    assert.match(lj.exactReference, /镜像对称/)
    assert.ok(Math.abs(lj.barriers.forward - 0.88398845) < 1e-5, `lj 势垒 ${lj.barriers.forward}`)

    // 失败模式：壁上初值不得报 converged，也不得给势垒
    const bad = await rt.tools.call('analysis.saddleSearch',
      { system: 'lj-double-well', start: [1.0, 0, 0], radius: 1.2 })
    assert.equal(bad.converged, false)
    assert.equal(bad.barriers, null, '未收敛不交付势垒')
    assert.equal(bad.negativeCount, 0, '落到极小一侧：靠 index 核验拦下')

    // 错误路径
    await assert.rejects(() => rt.tools.call('analysis.saddleSearch', { system: 'morse' }),
        e => /ANALYSIS_SYSTEM_UNKNOWN/.test(String(e?.message || e?.code)))
    await assert.rejects(() => rt.tools.call('analysis.saddleSearch',
        { system: 'quartic-double-well', start: [0.3] }), e => /SADDLE_BAD_INPUT/.test(String(e?.message || e?.code)))

    await new Promise(r => setTimeout(r, 50))
    const text = await readFile(path, 'utf8')
    assert.ok(text.includes('"saddle-search"'), 'analysis_complete(saddle-search) 落 Trajectory')
  } finally {
    await nebFiber.dispose()
    assert.ok(!rt.tools.list().some(t => t.name === 'analysis.saddleSearch'), '工具随卸载回收')
    assert.ok(!rt.getService('analysis/saddle'), '服务随卸载回收')
    await coreFiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
