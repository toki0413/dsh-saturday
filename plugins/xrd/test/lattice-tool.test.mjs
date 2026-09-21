// analysis.xrd.latticeFromPeaks 工具层测试：挂 core + xrd，走工具出口精修立方胞参数，
// 验胞参数回收、σ/残差随交付、谱系落 Trajectory、缺 peaks 显式报错、卸载回收。纯几何不需引擎。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bridgePlugin from '@toki0413/bridge'
import plugin from '../src/index.mjs'

const DEG = Math.PI / 180
const CU_A = 3.615
/** 由立方 a 正演 fcc 允许反射的 2θ（Cu Kα 1.54056 Å） */
function fccPeaks(a) {
  const hkls = [[1, 1, 1], [2, 0, 0], [2, 2, 0], [3, 1, 1], [2, 2, 2], [4, 0, 0], [3, 3, 1], [4, 2, 0]]
  return hkls.map(hkl => {
    const d = a / Math.sqrt(hkl.reduce((s, v) => s + v * v, 0))
    return { hkl, twoThetaDeg: 2 * Math.asin(1.54056 / (2 * d)) / DEG }
  })
}

test('1. analysis.xrd.latticeFromPeaks：立方精修回收 a、σ 与残差随交付、谱系落盘', async () => {
  const ctx = new Context()
  const dir = await mkdtemp(join(tmpdir(), 'saturday-xrd-lattice-'))
  const path = join(dir, 'trajectory.jsonl')
  const coreFiber = await ctx.registry.plugin({
    name: 'saturday', apply: (c) => bridgePlugin.apply(c, { trajectoryPath: path, quiet: true }),
  })
  const xrdFiber = await ctx.registry.plugin({
    name: 'saturday-xrd', apply: (c) => plugin.apply(c, { trajectoryPath: path }),
  })
  const xrdRt = xrdFiber.store.saturdayXrd.rt
  try {
    const out = await xrdRt.tools.call('analysis.xrd.latticeFromPeaks',
      { peaks: fccPeaks(CU_A), system: 'cubic' })
    assert.equal(out.system, 'cubic')
    assert.equal(out.nPeaks, 8)
    assert.ok(Math.abs(out.cell.a - CU_A) < 1e-9, `a 回收 ${out.cell.a}`)
    assert.ok(out.cellSigma.a >= 0 && Number.isFinite(out.cellSigma.a), 'σ 随交付')
    assert.ok(out.residualsDeg.max < 1e-9 && out.goodness.r2 > 1 - 1e-12)
    assert.match(out.declaration, /不自动指标化|指标化/, '边界声明随交付')
    assert.equal(out.units.length, 'Å')

    // 同一批峰走三斜六参数：立方解就在六参数族内，满秩则应回收到同一胞；
    // 秩不足则必须显式报错——两种结局都可接受，静默给伪解不可接受。
    let tri
    try {
      tri = await xrdRt.tools.call('analysis.xrd.latticeFromPeaks', { peaks: fccPeaks(CU_A) })
    } catch (err) {
      assert.match(String(err?.message || err?.code), /LP_DEGENERATE_PEAKS|LP_UNDERDETERMINED/,
          '三斜秩不足时只能显式报错')
    }
    if (tri) {
      assert.equal(tri.system, 'triclinic')
      for (const k of ['a', 'b', 'c']) assert.ok(Math.abs(tri.cell[k] - CU_A) < 1e-6, `${k}=${tri.cell[k]}`)
      for (const k of ['alpha', 'beta', 'gamma']) assert.ok(Math.abs(tri.cell[k] - 90) < 1e-4, `${k}=${tri.cell[k]}`)
    }

    // 峰数不足以定六参数 → 报错（不猜）
    await assert.rejects(() => xrdRt.tools.call('analysis.xrd.latticeFromPeaks', { peaks: fccPeaks(CU_A).slice(0, 6) }),
        e => /LP_UNDERDETERMINED/.test(String(e?.message || e?.code)))

    await assert.rejects(() => xrdRt.tools.call('analysis.xrd.latticeFromPeaks', {}),
        e => /LP_BAD_PEAKS/.test(String(e?.message || e?.code)))

    await new Promise(r => setTimeout(r, 50))
    const text = await readFile(path, 'utf8')
    assert.ok(text.includes('xrd-lattice-from-peaks'), 'analysis_complete(xrd-lattice-from-peaks) 落 Trajectory')
  } finally {
    await xrdFiber.dispose()
    assert.ok(!xrdRt.tools.list().some(t => t.name === 'analysis.xrd.latticeFromPeaks'), '工具随卸载回收')
    await coreFiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
