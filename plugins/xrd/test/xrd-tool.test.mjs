// plugin-xrd 工具层集成测试：挂 core + xrd，载入 Cu（fcc conventional），经工具出口 analysis.xrd
// 拿粉末谱；验峰序/系统消光（fcc {100} 不出现）/辐射/谱系落盘。仅需 material 服务，无需引擎。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bridgePlugin from '@toki0413/bridge'
import plugin from '../src/index.mjs'

test('1. analysis.xrd：Cu 粉末谱峰序 + fcc 消光 + 谱系落盘 + 卸载回收', async () => {
  const ctx = new Context()
  const dir = await mkdtemp(join(tmpdir(), 'saturday-xrd-'))
  const path = join(dir, 'trajectory.jsonl')
  const coreFiber = await ctx.registry.plugin({
    name: 'saturday', apply: (c) => bridgePlugin.apply(c, { trajectoryPath: path, quiet: true }),
  })
  const xrdFiber = await ctx.registry.plugin({
    name: 'saturday-xrd', apply: (c) => plugin.apply(c, { trajectoryPath: path }),
  })
  const coreRt = coreFiber.store.saturday.rt
  const xrdRt = xrdFiber.store.saturdayXrd.rt
  try {
    const cu = await coreRt.tools.call('material.load', { query: 'Cu' })
    const out = await xrdRt.tools.call('analysis.xrd', { materialId: cu.materialId, twoThetaMaxDeg: 100 })
    assert.ok(out.radiation, '辐射信息随交付')
    assert.equal(out.radiation.label, 'Cu Kα')
    assert.ok(Array.isArray(out.peaks) && out.peaks.length > 0, '应有衍射峰')
    // 峰按 2θ 升序
    for (let i = 1; i < out.peaks.length; i++) assert.ok(out.peaks[i].twoThetaDeg >= out.peaks[i - 1].twoThetaDeg - 1e-9)
    // fcc 消光：{100}（d≈a）不出现，首峰为 {111}（d=a/√3）
    const a = 3.615
    assert.ok(!out.peaks.some(p => Math.abs(p.d - a) < 0.05), 'fcc {100} 应系统消光')
    assert.ok(out.peaks[0].d > a / Math.sqrt(3) - 0.05 && out.peaks[0].d < a / Math.sqrt(2), `首峰应为 {111}，got d=${out.peaks[0].d}`)
    assert.ok(typeof out.note === 'string' && out.note.includes('f≈Z'), '近似边界随交付声明（强度为相对值）')
    // 缺 material 服务/空 materialId 显式报错
    await assert.rejects(() => xrdRt.tools.call('analysis.xrd', {}), e => /ANALYSIS_INPUT_MISSING/.test(String(e?.message || e?.code)))
    // 谱系落盘
    await new Promise(r => setTimeout(r, 50))
    const text = await readFile(path, 'utf8')
    assert.ok(text.includes('"xrd"'), 'analysis_complete(xrd) 落 Trajectory')
  } finally {
    await xrdFiber.dispose()
    assert.ok(!xrdRt.tools.list().some(t => t.name === 'analysis.xrd'), '工具随卸载回收')
    await coreFiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
