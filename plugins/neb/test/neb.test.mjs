// @saturday/plugin-neb 测试（契约 §4.4 analysis seam 首个实证）
// 纯函数层：玩具体系理智检查（对称 / 鞍点 / 解析梯度）/ quench /
// NEB 鞍点定位与势垒独立 oracle 对账 / 幂等；
// 契约层：§4.4 两个冻结点（输入输出类型声明 + 谱系登记）+ 显式失败；
// 插件层：真实挂载，注册即 effect，卸载全回收。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import plugin, { nebAnalysis, neb, quench, ljDoubleWell } from '../src/index.mjs'

const model = ljDoubleWell()

/** 端点先 quench 到两侧极小（工具层的同款流程），再拉 NEB 带 */
function runNeb(extra = {}) {
  const left = quench({ x0: model.wellGuesses[0], energy: model.energy, gradient: model.gradient })
  const right = quench({ x0: model.wellGuesses[1], energy: model.energy, gradient: model.gradient })
  return {
    left, right,
    result: neb({ energy: model.energy, gradient: model.gradient, start: left.x, end: right.x, nImages: 7, ...extra }),
  }
}

test('1. 玩具体系：对称双阱，原点是鞍点不是极小，解析梯度对得上有限差分', () => {
  // 镜像对称：E(x, y, z) === E(−x, y, z)
  const p = [0.7, 0.3, -0.2]
  assert.equal(model.energy(p), model.energy([-p[0], p[1], p[2]]))

  // 原点是驻点（对称性），但能量高于阱底 → 鞍点而非极小
  for (const gi of model.gradient([0, 0, 0])) assert.ok(Math.abs(gi) < 1e-12)
  const left = quench({ x0: model.wellGuesses[0], energy: model.energy, gradient: model.gradient })
  assert.ok(model.energy([0, 0, 0]) > left.energy, '原点能量高于阱底：鞍点')

  // 解析梯度与中心差分一致（一般点，非对称轴上）
  const x = [-0.7, 0.25, -0.15]
  const h = 1e-6
  const ga = model.gradient(x)
  for (let j = 0; j < 3; j++) {
    const xp = [...x], xm = [...x]
    xp[j] += h; xm[j] -= h
    const gn = (model.energy(xp) - model.energy(xm)) / (2 * h)
    assert.ok(Math.abs(ga[j] - gn) < 1e-5, `分量 ${j}：解析 ${ga[j]} vs 数值 ${gn}`)
  }
})

test('2. quench：两侧初猜收敛到镜像对称的极小', () => {
  const left = quench({ x0: model.wellGuesses[0], energy: model.energy, gradient: model.gradient })
  const right = quench({ x0: model.wellGuesses[1], energy: model.energy, gradient: model.gradient })
  assert.ok(left.converged && right.converged)
  assert.ok(left.x[0] < 0 && right.x[0] > 0)
  assert.ok(Math.abs(left.x[0] + right.x[0]) < 1e-6, '双阱镜像对称')
  assert.ok(Math.abs(left.energy - right.energy) < 1e-9)
  assert.ok(Math.abs(left.x[1]) < 1e-6 && Math.abs(left.x[2]) < 1e-6, '极小在 x 轴上')
  assert.ok(left.energy < -1.0, '阱底低于单 LJ 阱深（双位吸引叠加）')
})

test('3. NEB 基本形状：收敛、像元数、端点固定', () => {
  const { left, right, result } = runNeb()
  assert.ok(result.converged)
  assert.equal(result.nImages, 7)
  assert.equal(result.energies.length, 7)
  assert.deepEqual(result.images[0], left.x, '起点固定不动')
  assert.deepEqual(result.images[6], right.x, '终点固定不动')
  assert.ok(result.saddleIndex > 0 && result.saddleIndex < 6)
  assert.ok(Number.isFinite(result.barrierForward))
  assert.ok(Number.isFinite(result.barrierReverse))
})

test('4. 鞍点定位与势垒对账：独立逐点求值做 oracle（对称性：鞍在原点）', () => {
  const { left, result } = runNeb()
  assert.ok(Math.abs(result.saddle[0]) < 0.03, '鞍点 x ≈ 原点')
  assert.ok(Math.abs(result.saddle[1]) < 0.02 && Math.abs(result.saddle[2]) < 0.02)

  // 对称双阱：正反向势垒一致
  assert.ok(Math.abs(result.barrierForward - result.barrierReverse) < 1e-3)

  // oracle：barrier = E(0,0,0) − 阱底，E 独立逐点求值（不经 NEB）
  const oracleBarrier = model.energy([0, 0, 0]) - left.energy
  assert.ok(result.barrierForward > 0.5, '势垒显著')
  assert.ok(
    Math.abs(result.barrierForward - oracleBarrier) < 5e-3,
    `NEB 势垒 ${result.barrierForward} vs oracle ${oracleBarrier}`,
  )
})

test('5. 幂等：同输入两次运行结果完全一致', () => {
  const a = runNeb().result
  const b = runNeb().result
  assert.deepEqual(a, b)
})

test('6. 显式失败：缺能量模型 / 像元数非法都带 code，不静默', async () => {
  await assert.rejects(
    () => nebAnalysis.run({ start: [0], end: [1] }, null),
    err => err.code === 'ANALYSIS_INPUT_MISSING',
  )
  await assert.rejects(
    () => nebAnalysis.run({ energyModel: { energy: 'not-a-function' }, start: [0], end: [1] }, null),
    /ANALYSIS_INPUT_MISSING/,
  )
  assert.throws(
    () => neb({ energy: () => 0, gradient: () => [0], start: [0], end: [1], nImages: 2 }),
    err => err.code === 'NEB_BAD_INPUT',
  )
})

test('7. §4.4 形态与谱系登记：输入/输出类型声明 + Trajectory 记录', async () => {
  // 冻结点一：输入/输出类型声明
  assert.equal(nebAnalysis.name, 'neb')
  assert.ok(Array.isArray(nebAnalysis.inputs) && nebAnalysis.inputs.length > 0)
  assert.ok(Array.isArray(nebAnalysis.outputs) && nebAnalysis.outputs.length > 0)
  const desc = nebAnalysis.describe()
  assert.ok(typeof desc.description === 'string' && desc.parameters)

  // 冻结点二：谱系登记——分析结果落 Trajectory
  const trajectory = []
  const rtStub = {
    appendTrajectory: async (entry) => trajectory.push(entry),
    emit: async () => {},
  }
  const left = quench({ x0: model.wellGuesses[0], energy: model.energy, gradient: model.gradient })
  const right = quench({ x0: model.wellGuesses[1], energy: model.energy, gradient: model.gradient })
  await nebAnalysis.run({ energyModel: model, start: left.x, end: right.x }, rtStub)
  assert.equal(trajectory.length, 1)
  assert.equal(trajectory[0].type, 'analysis_complete')
  assert.equal(trajectory[0].analysis, 'neb')
  assert.ok(Number.isFinite(trajectory[0].result.barrierForward))
})

test('8. 插件层：注册即 effect，工具真实可调用，卸载后服务与工具全回收', async () => {
  const ctx = new Context()
  const dir = await mkdtemp(join(tmpdir(), 'saturday-neb-'))
  const path = join(dir, 'trajectory.jsonl')

  const fiber = await ctx.registry.plugin({
    name: 'saturday-neb',
    apply: (ctx) => plugin.apply(ctx, { trajectoryPath: path }),
  })
  const { rt } = fiber.store.saturdayNeb
  assert.equal(rt.getService('analysis/neb'), nebAnalysis, '服务随挂载注册')
  assert.ok(rt.tools.list().some(t => t.name === 'analysis.neb'))

  // 未知体系显式报错
  await assert.rejects(
    () => rt.tools.call('analysis.neb', { system: 'bogus' }),
    /ANALYSIS_SYSTEM_UNKNOWN/,
  )

  const out = await rt.tools.call('analysis.neb', { nImages: 7 })
  assert.ok(out.converged)
  assert.ok(out.barrierForward > 0.5)

  // 谱系登记走真实内核适配器落盘
  const text = await readFile(path, 'utf8')
  assert.ok(text.includes('"analysis":"neb"'), 'analysis_complete 落入 Trajectory')

  await fiber.dispose()
  assert.equal(rt.getService('analysis/neb'), undefined, '服务随 fiber 卸载消失')
  assert.ok(!rt.tools.list().some(t => t.name === 'analysis.neb'), '工具随卸载回收')
  await rm(dir, { recursive: true, force: true })
})
