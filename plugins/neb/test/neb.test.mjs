// @toki0413/plugin-neb 测试（契约 §4.4 analysis seam 首个实证）
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

test('9. climbing-image NEB：鞍点命中对称性 oracle（原点），势垒与逐点求值一致', () => {
  const { left, result } = runNeb({ climb: true })
  assert.equal(result.method, 'neb+climbing-image')
  assert.equal(result.saddleSource, 'climbing-image')
  assert.ok(result.converged)
  // 对称带上中心像元由对称性钉在 x=0（镜像对消）
  assert.ok(Math.abs(result.saddle[0]) < 1e-6, `CI 鞍点 x=${result.saddle[0]}`)
  assert.ok(Math.abs(result.saddle[1]) < 1e-6 && Math.abs(result.saddle[2]) < 1e-6)
  const oracleBarrier = model.energy([0, 0, 0]) - left.energy
  assert.ok(Math.abs(result.barrierForward - oracleBarrier) < 1e-6,
      `CI 势垒 ${result.barrierForward} vs oracle ${oracleBarrier}`)
  assert.ok(Math.abs(result.barrierForward - result.barrierReverse) < 1e-9, '对称双阱正反向势垒相等')

  // 与不带 CI 的对比：CI 的鞍点不劣于带内最高点
  const plain = runNeb().result
  assert.ok(Math.abs(result.saddle[0]) <= Math.abs(plain.saddle[0]) + 1e-12,
      `CI 鞍点更近中心：${result.saddle[0]} vs ${plain.saddle[0]}`)
})

test('10. 收敛报告自证：maxForce=逐像元最大、末帧在历史里、共线等距带标为初帧驻定', () => {
  const { result } = runNeb({ historyEvery: 7 })
  const c = result.convergence
  assert.ok(c.maxForce < c.ftol && result.converged)
  assert.equal(c.stepLimitReached, false)
  assert.equal(c.maxForcePerImage.length, 5, 'nImages=7 → 5 个自由像元')
  assert.ok(Math.abs(Math.max(...c.maxForcePerImage) - c.maxForce) < 1e-15,
      'maxForce 就是逐像元力的最大值')
  assert.equal(c.history[c.history.length - 1].step, result.nSteps, '末帧在历史里')
  assert.ok(c.history.every((h, i) => i === 0 || h.step > c.history[i - 1].step), '历史步号递增')
  assert.ok(c.forceCriterion.length > 0 && c.ftol > 0 && c.maxSteps > 0)
  assert.match(result.note, /上界估计|不把/, '未收敛时的判读边界随交付')

  // 内置玩法的直线等距带：初帧 nudged 力就是 0（切向真力被投影掉、等距使弹力差为 0），
  // 一步也没跑。报 converged 但必须标出 trivialStationary，不能说成"已弛豫"。
  assert.equal(c.trivialStationary, true)
  assert.equal(result.nSteps, 0)
  assert.equal(c.spacing.uniform, true)
  assert.ok(c.maxForceAtStart === 0)
})

test('10b. 给定弯曲初始带就真开始优化：不收敛时 stepLimitReached 与势垒偏高都如实报', () => {
  const left = quench({ x0: model.wellGuesses[0], energy: model.energy, gradient: model.gradient })
  const right = quench({ x0: model.wellGuesses[1], energy: model.energy, gradient: model.gradient })
  const N = 7
  const band = Array.from({ length: N }, (_, i) => {
    const t = i / (N - 1)
    return [left.x[0] + t * (right.x[0] - left.x[0]), (i > 0 && i < N - 1) ? 0.4 * Math.sin(Math.PI * t) : 0, 0]
  })
  const result = neb({
    energy: model.energy, gradient: model.gradient,
    start: band[0], end: band[N - 1], nImages: N, initialBand: band,
  })
  const c = result.convergence
  assert.equal(c.trivialStationary, false, '弯曲带不驻定，优化器必须动起来')
  assert.ok(result.nSteps > 0 && c.maxForceAtStart > c.maxForce, '力确实在下降')

  // 已知边界（本测目地是把现状钉住，不是断言优化器优秀）：
  // 现有显式 Euler + "升则折半/降则 1.02×"的步长控制在 3000 步内不能收敛，
  // 此时必须报 stepLimitReached=true，势垒仍高于 oracle（偏高而非假装到位）。
  const oracle = model.energy([0, 0, 0]) - model.energy(band[0])
  assert.equal(c.stepLimitReached, true, '未收敛必须说未收敛')
  assert.equal(result.converged, false)
  assert.ok(c.maxForce > c.ftol)
  assert.ok(result.barrierForward > oracle, `势垒 ${result.barrierForward} 应高于 oracle ${oracle}（未弛豫完）`)
  assert.ok(c.spacing.uniform === false && c.spacing.min > 0)
  assert.ok(c.forceDrop > 0 && c.forceDrop < 1)
})

test('10c. initialBand 非法输入显式拒（长度、端点不吻合、非有限坐标）', () => {
  const left = quench({ x0: model.wellGuesses[0], energy: model.energy, gradient: model.gradient })
  const right = quench({ x0: model.wellGuesses[1], energy: model.energy, gradient: model.gradient })
  const base = { energy: model.energy, gradient: model.gradient, start: left.x, end: right.x, nImages: 5 }
  assert.throws(() => neb({ ...base, initialBand: [[0, 0, 0]] }), e => e.code === 'NEB_BAD_INPUT')
  assert.throws(() => neb({ ...base, initialBand: Array.from({ length: 5 }, (_, i) => [i, 0, 0]) }),
      e => e.code === 'NEB_BAD_INPUT', '端点不吻合 start/end')
  const ok = Array.from({ length: 5 }, (_, i) => [left.x[0] + i * (right.x[0] - left.x[0]) / 4, 0, 0])
  ok[2] = [ok[2][0], NaN, 0]
  assert.throws(() => neb({ ...base, initialBand: ok }), e => e.code === 'NEB_BAD_INPUT')
})

test('11. 收敛判据本身的非法输入显式拒绝（不静默给永不收敛的循环）', () => {
  const base = { energy: model.energy, gradient: model.gradient, start: [-1, 0, 0], end: [1, 0, 0], nImages: 5 }
  for (const ftol of [0, -1e-6, NaN, Infinity]) {
    assert.throws(() => neb({ ...base, ftol }), e => e.code === 'NEB_BAD_INPUT', `ftol=${ftol} 应拒`)
  }
  assert.throws(() => neb({ ...base, maxSteps: 0 }), e => e.code === 'NEB_BAD_INPUT')
  assert.throws(() => neb({ ...base, maxSteps: 1.5 }), e => e.code === 'NEB_BAD_INPUT')
  assert.throws(() => neb({ ...base, springK: 0 }), e => e.code === 'NEB_BAD_INPUT')
  assert.throws(() => neb({ ...base, historyEvery: 0 }), e => e.code === 'NEB_BAD_INPUT')
  assert.throws(() => neb({ ...base, initialBand: 'nope' }), e => e.code === 'NEB_BAD_INPUT')
})
