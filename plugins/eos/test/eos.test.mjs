// @toki0413/plugin-eos 测试（契约 §4.4 analysis seam 第二个实证）
// 纯函数层：BM 闭式自洽 / 无噪声参数恢复 / 噪声鲁棒性 / 显式失败；
// 领域层：缩放变体体积按 s³ 缩放 + 谱系登记 + 原对象不可变；
// 契约层：§4.4 两个冻结点；插件层：显式序列路、真实桥集成（EMT/LJ 全链）、卸载回收。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import bridgePlugin from '@toki0413/bridge'
import plugin, {
  eosAnalysis, fitBirchMurnaghan, birchMurnaghan, cellVolume,
  scaledVariant, DEFAULT_SCALES,
} from '../src/index.mjs'

// 合成真值：量级对应真实金属（B0 = 0.9 eV/Å³ ≈ 144 GPa）
const TRUTH = { E0: -14, V0: 11.6, B0: 0.9, B0p: 5 }
const syntheticScales = [0.92, 0.95, 0.98, 1.0, 1.02, 1.05, 1.08]
const syntheticSeries = (noise = 0) =>
  syntheticScales.map((s, i) => ({
    volume: TRUTH.V0 * s,
    energy: birchMurnaghan(TRUTH.V0 * s, TRUTH) + (noise ? noise * Math.sin(i * 12.9898) : 0),
  }))

test('1. BM 闭式自洽：V0 处能量 E0、一阶导为零（极小）', () => {
  assert.equal(birchMurnaghan(TRUTH.V0, TRUTH), TRUTH.E0)
  const h = 1e-5
  const dE =
    (birchMurnaghan(TRUTH.V0 + h, TRUTH) - birchMurnaghan(TRUTH.V0 - h, TRUTH)) / (2 * h)
  assert.ok(Math.abs(dE) < 1e-8, 'dE/dV |_{V0} ≈ 0')
  // 压缩侧能量升高（正曲率）
  assert.ok(birchMurnaghan(TRUTH.V0 * 0.9, TRUTH) > TRUTH.E0)
})

test('2. 无噪声参数恢复：四参数精确复现，r² ≈ 1', () => {
  const fit = fitBirchMurnaghan(syntheticSeries())
  assert.ok(fit.converged)
  assert.ok(Math.abs(fit.params.E0 - TRUTH.E0) < 1e-5)
  assert.ok(Math.abs(fit.params.V0 - TRUTH.V0) < 1e-4)
  assert.ok(Math.abs(fit.params.B0 / TRUTH.B0 - 1) < 1e-3)
  assert.ok(Math.abs(fit.params.B0p - TRUTH.B0p) < 0.05)
  assert.ok(fit.r2 > 0.999999)
  assert.ok(fit.rmse < 1e-6)
  assert.ok(Number.isFinite(fit.B0GPa) && fit.B0GPa > 100)
})

test('3. 噪声鲁棒性：2 meV 确定性扰动下参数仍在容差内，质量由 r²/rmse 诚实报告', () => {
  const fit = fitBirchMurnaghan(syntheticSeries(0.002))
  assert.ok(fit.converged)
  assert.ok(Math.abs(fit.params.V0 - TRUTH.V0) < 0.05)
  assert.ok(Math.abs(fit.params.B0 / TRUTH.B0 - 1) < 0.05)
  assert.ok(Math.abs(fit.params.B0p - TRUTH.B0p) < 0.6)
  assert.ok(fit.r2 > 0.99)
  assert.ok(fit.rmse > 0 && fit.rmse < 0.01, 'rmse 反映噪声量级而非假装为零')
})

test('4. 显式失败：点数不足 / 体积非正 / 能量非有限都带 code', () => {
  const s3 = syntheticSeries().slice(0, 3)
  assert.throws(() => fitBirchMurnaghan(s3), err => err.code === 'EOS_UNDERDETERMINED')
  assert.throws(
    () => fitBirchMurnaghan([{ volume: -1, energy: 0 }, ...s3]),
    err => err.code === 'EOS_BAD_POINT',
  )
  assert.throws(
    () => fitBirchMurnaghan([{ volume: 10, energy: NaN }, ...s3]),
    err => err.code === 'EOS_BAD_POINT',
  )
})

test('5. 缩放变体：体积按 s³ 缩放、谱系登记、原对象不可变', async () => {
  const { Material, PrototypeLibResolver } = await import('@toki0413/core')
  const cu = await Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())
  const v0 = cellVolume(cu.cell)
  const s = 1.03
  const variant = scaledVariant(cu, s)
  assert.ok(Math.abs(cellVolume(variant.cell) - v0 * s ** 3) < 1e-9)
  assert.equal(variant.lineage.at(-1).operation, 'cell-scaled')
  assert.equal(variant.lineage.at(-1).detail.scale, s)
  assert.equal(cellVolume(cu.cell), v0, '原对象不受影响（不可变 fork）')
  assert.throws(() => scaledVariant(cu, 0), err => err.code === 'EOS_BAD_SCALE')
})

test('6. §4.4 形态与谱系登记：输入/输出类型声明 + Trajectory 记录', async () => {
  assert.equal(eosAnalysis.name, 'eos')
  assert.ok(Array.isArray(eosAnalysis.inputs) && eosAnalysis.inputs.length > 0)
  assert.ok(Array.isArray(eosAnalysis.outputs) && eosAnalysis.outputs.length > 0)
  const desc = eosAnalysis.describe()
  assert.ok(typeof desc.description === 'string' && desc.parameters)

  const trajectory = []
  const rtStub = {
    appendTrajectory: async (entry) => trajectory.push(entry),
    emit: async () => {},
  }
  await eosAnalysis.run({ series: syntheticSeries() }, rtStub)
  assert.equal(trajectory.length, 1)
  assert.equal(trajectory[0].type, 'analysis_complete')
  assert.equal(trajectory[0].analysis, 'eos')
  assert.ok(Number.isFinite(trajectory[0].result.B0GPa))

  await assert.rejects(
    () => eosAnalysis.run({}, rtStub),
    err => err.code === 'ANALYSIS_INPUT_MISSING',
  )
})

test('7. 工具层：显式序列路可用；两条数据路都缺时显式报错', async () => {
  const ctx = new Context()
  const dir = await mkdtemp(join(tmpdir(), 'saturday-eos-'))
  const path = join(dir, 'trajectory.jsonl')
  const fiber = await ctx.registry.plugin({
    name: 'saturday-eos',
    apply: (ctx) => plugin.apply(ctx, { trajectoryPath: path }),
  })
  try {
    const { rt } = fiber.store.saturdayEos

    const out = await rt.tools.call('analysis.eos', { series: syntheticSeries() })
    assert.ok(out.converged)
    assert.ok(Math.abs(out.params.V0 - TRUTH.V0) < 1e-4)

    await assert.rejects(
      () => rt.tools.call('analysis.eos', {}),
      /requires either a series or materialId/,
    )
  } finally {
    // 清理先于断言结果生效：断言失败不能跳过 dispose（sidecar 句柄会挂住进程）
    await fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('8. 集成：真实桥 + Cu，缩放体积静态单点 → 拟合（EMT/LJ 均可用）', async () => {
  const ctx = new Context()
  const dir = await mkdtemp(join(tmpdir(), 'saturday-eos-'))
  const path = join(dir, 'trajectory.jsonl')

  const coreFiber = await ctx.registry.plugin({
    name: 'saturday',
    apply: (ctx) => bridgePlugin.apply(ctx, { trajectoryPath: path }),
  })
  const eosFiber = await ctx.registry.plugin({
    name: 'saturday-eos',
    apply: (ctx) => plugin.apply(ctx, { trajectoryPath: path }),
  })
  const coreRt = coreFiber.store.saturday.rt
  const eosRt = eosFiber.store.saturdayEos.rt

  try {
    const loaded = await coreRt.tools.call('material.load', { query: 'Cu' })
    const out = await eosRt.tools.call('analysis.eos', {
      materialId: loaded.materialId,
      scales: DEFAULT_SCALES,
    })

    assert.ok(out.converged)
    assert.equal(out.nPoints, DEFAULT_SCALES.length)
    // 平衡体积应落在采样范围附近（EMT 与 LJ 玩具势的零点不同，断言放宽）
    const vRef = cellVolume((await coreRt.getService('material').get(loaded.materialId)).cell)
    assert.ok(out.params.V0 > 0.5 * vRef && out.params.V0 < 1.5 * vRef,
      `V0=${out.params.V0} vs 参考体积 ${vRef}`)
    assert.ok(Number.isFinite(out.B0GPa) && out.B0GPa > 0)
    assert.ok(out.r2 > 0.95)

    // 谱系登记落盘
    await new Promise(r => setTimeout(r, 50))
    const text = await readFile(path, 'utf8')
    assert.ok(text.includes('"analysis":"eos"'), 'analysis_complete 落入 Trajectory')
  } finally {
    // 清理先于断言结果生效：断言失败不能跳过 dispose（sidecar 句柄会挂住进程）
    await eosFiber.dispose()
    assert.equal(eosRt.getService('analysis/eos'), undefined, '服务随卸载消失')
    assert.ok(!eosRt.tools.list().some(t => t.name === 'analysis.eos'), '工具随卸载回收')
    await coreFiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
