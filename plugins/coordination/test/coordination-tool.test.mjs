// plugin-coordination 工具层集成测试：挂 core + coordination，走 material/POSCAR 入口做端到端。
// 仅需 material 服务（不碰引擎，双档 CI 结果一致）；验 §4.4 出口字段、谱系落盘、卸载回收、显式报错。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bridgePlugin from '@toki0413/bridge'
import { writePoscar } from '@toki0413/core/codecs'
import plugin from '../src/index.mjs'

const cellOf = (a) => [[a, 0, 0], [0, a, 0], [0, 0, a]]
const fccFrac = [[0, 0, 0], [0, .5, .5], [.5, 0, .5], [.5, .5, 0]]

async function boot() {
  const ctx = new Context()
  const dir = await mkdtemp(join(tmpdir(), 'saturday-coord-'))
  const path = join(dir, 'trajectory.jsonl')
  const coreFiber = await ctx.registry.plugin({
    name: 'saturday', apply: (c) => bridgePlugin.apply(c, { trajectoryPath: path, quiet: true }),
  })
  const fiber = await ctx.registry.plugin({
    name: 'saturday-coordination', apply: (c) => plugin.apply(c, { trajectoryPath: path }),
  })
  const coreRt = coreFiber.store.saturday.rt
  const rt = fiber.store.saturdayCoordination.rt
  return { coreRt, rt, dir, path, async close() { await fiber.dispose(); await coreFiber.dispose(); await rm(dir, { recursive: true, force: true }) } }
}

test('1. analysis.coordination：material.load Cu（fcc）→ 逐原子 CN=12 + 声明随交付 + 谱系落盘', async () => {
  const h = await boot()
  try {
    const cu = await h.coreRt.tools.call('material.load', { query: 'Cu' })
    const out = await h.rt.tools.call('analysis.coordination', { materialId: cu.materialId })
    assert.equal(out.formula, 'Cu')
    assert.equal(out.periodic, true, '原型结构按周期体系处理')
    assert.equal(out.method, 'shell-gap')
    assert.deepEqual([...new Set(out.perAtom.map(p => p.cn))], [12], 'fcc 每原子 CN=12（不论取常规胞还是原胞）')
    assert.equal(out.cnStats.min, 12)
    assert.equal(out.cnStats.max, 12)
    assert.deepEqual(out.cnSumIdentity, { sumCn: 2 * out.totalBonds, bondsTimes2: 2 * out.totalBonds }, 'ΣCN=2·键数恒等式随交付可核')
    assert.ok(Number.isFinite(out.rCut) && out.rCut > 0, '截断半径随交付（CN 不无根可谈）')
    assert.match(out.declaration, /截断半径/, 'CN 依赖截断半径的二义性显式声明')
    assert.equal(out.warrenCowley.length, 0, '单质无异种对：不编 α')
    // 显式 rCut 走另一条定义，且结果如实反映截断
    const deep = await h.rt.tools.call('analysis.coordination', { materialId: cu.materialId, rCut: 6.0 })
    assert.equal(deep.method, 'explicit')
    assert.ok(deep.perAtom[0].cn > 12, `rCut=6 Å 应把第二第三壳层算进来，got ${deep.perAtom[0].cn}`)
    // 缺 materialId 显式报错
    await assert.rejects(() => h.rt.tools.call('analysis.coordination', {}),
        e => /ANALYSIS_INPUT_MISSING/.test(String(e?.message || e?.code)))
    await new Promise(r => setTimeout(r, 50))
    const text = await readFile(h.path, 'utf8')
    assert.ok(text.includes('"coordination"'), 'analysis_complete(coordination) 落 Trajectory')
  } finally {
    await h.close()
  }
})

test('2. 端到端：写 POSCAR → structure.fromPoscar → 配位分析读出岩盐型有序（α 命中解析下限）', async () => {
  const h = await boot()
  try {
    const a = 5.640
    const nodes = [
      ...fccFrac.map(f => ({ number: 29, position: f.map(v => v * a) })),
      ...fccFrac.map(f => ({ number: 47, position: f.map((v, k) => (v + (k === 0 ? 0.5 : 0)) * a) })),
    ]
    const poscar = writePoscar({ cell: cellOf(a), nodes }, { comment: 'Cu4Ag4 rock-salt' })
    const loaded = await h.coreRt.tools.call('structure.fromPoscar', { text: poscar })
    assert.match(loaded.formula, /Cu4/, '四种铜')
    assert.match(loaded.formula, /Ag4/, '四种银')
    const out = await h.rt.tools.call('analysis.coordination', { materialId: loaded.materialId })
    assert.deepEqual([...new Set(out.perAtom.map(p => p.cn))], [6], '岩盐型 CN=6')
    assert.equal(out.bonds.length, 1, '全部为异种键（完全交替）')
    assert.equal(out.bonds[0].pair, 'Ag-Cu')
    const wc = out.warrenCowley[0]
    assert.equal(wc.observed, out.totalBonds)
    assert.ok(Math.abs(wc.alpha - (1 - (8 * 7) / (2 * 4 * 4))) < 1e-12, `α 应命中解析下限 −0.75，got ${wc.alpha}`)
    assert.match(wc.note, /有限尺寸/, '小 N 有序下限到不了 −1 这件事写进 note')
  } finally {
    await h.close()
  }
})
