// @toki0413/plugin-phonon 测试（契约 §4.4 analysis seam，力注入式）
// 纯函数层：解析弹簧对账（声学零频 + 光学支闭式 + 换算因子）/ ASR 残余机械断言 /
// 虚频诚实判定 / 显式失败 / 确定性；插件层：§4.4 形态 + 谱系登记 + 工具层报错 +
// 真实桥集成（任意有力引擎走成功路，无力引擎显式失败）+ 卸载回收。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import bridgePlugin from '@toki0413/bridge'
import plugin, {
  phononAnalysis, runPhononAnalysis, displacedGraph, displacementJobs,
  SQRT_EV_A2_AMU_TO_THZ, THZ_TO_MEV, MASS_AMU, displacedVariant,
} from '../src/index.mjs'

const cubeCell = (a) => [[a, 0, 0], [0, a, 0], [0, 0, a]]
const atom = (number, x, y, z) => ({ number, position: [x, y, z] })

// ── 解析力模型（Hessian 常数，有限差分无高阶误差）────────────────

/** 独立弹簧：F_i = −k·(r_i − r_i⁰)（违反平移不变性——ASR off 时用于对账换算因子） */
function independentSpring(k, refPositions) {
  return async (graph) => ({
    forces: graph.nodes.map((n, i) =>
      n.position.map((x, a) => -k * (x - refPositions[i][a]))),
    calculator: 'analytic-spring',
  })
}

/** 平移不变弹簧对（原子 0–1，各向同性，Hessian 常数）：
 *  F_0 = −k·[(r_0 − r_1) − d0]，F_1 = +k·[(r_0 − r_1) − d0]
 *  解析 Γ 点：声学三支 λ=0，光学三支 λ = k·(1/m_0 + 1/m_1) */
function springPair(k, d0) {
  return async (graph) => {
    const [p0, p1] = graph.nodes.map(n => n.position)
    const f = p0.map((x, a) => -k * ((x - p1[a]) - d0[a]))
    return { forces: [f, f.map(v => -v)], calculator: 'analytic-pair' }
  }
}

const freqFromOmegaSq = (lambda) => Math.sqrt(Math.abs(lambda)) * SQRT_EV_A2_AMU_TO_THZ

test('1. 换算因子与 CODATA 推导一致（独立数值真值 + meV 换算）', () => {
  // 外部推导真值（手工计算：sqrt(e/(Å²·amu))/(2π·1e12)，CODATA-2018）
  assert.ok(Math.abs(SQRT_EV_A2_AMU_TO_THZ - 15.633302) < 1e-5,
    `换算因子 ${SQRT_EV_A2_AMU_TO_THZ} 应 ≈ 15.633302`)
  assert.equal(THZ_TO_MEV, 4.135667696)
  assert.ok(MASS_AMU[29] > 63 && MASS_AMU[29] < 64, 'Cu 原子量 63.546 在册')
})

test('2. 位移作业表与位移变体：6N 项、原对象不可变、位移精确', () => {
  const jobs = displacementJobs(2)
  assert.equal(jobs.length, 12)
  const graph = { cell: cubeCell(3.6), nodes: [atom(29, 0, 0, 0), atom(47, 1.8, 1.8, 1.8)] }
  const job = { atomIndex: 1, direction: 2, sign: -1 }
  const g = displacedGraph(graph, job, 0.01)
  assert.equal(g.nodes[1].position[2], 1.8 - 0.01)
  assert.equal(graph.nodes[1].position[2], 1.8, '原 graph 不受影响（纯函数）')
  assert.throws(() => displacedVariant({ graph }, job, -1), err => err.code === 'PHONON_BAD_DISPLACEMENT')
})

test('3. 独立弹簧（ASR off）：三重频率精确对账 sqrt(k/m)·因子——验证换算常数端到端', async () => {
  const k = 1.0
  const ref = [[0, 0, 0]]
  const graph = { cell: cubeCell(3.6), nodes: [atom(29, 0, 0, 0)] }
  const out = await runPhononAnalysis(graph, independentSpring(k, ref), { applyAsr: false })
  const truth = freqFromOmegaSq(k / MASS_AMU[29])
  assert.equal(out.frequencies.length, 3)
  for (const f of out.frequencies) {
    assert.ok(Math.abs(f - truth) / truth < 1e-9, `频率 ${f} vs 解析 ${truth}`)
  }
  assert.equal(out.calculator, 'analytic-spring')
  assert.equal(out.equilibriumForceMax, 0, '平衡点残余力为零（参考位形即弹簧原长）')
  assert.equal(out.forceResidualMax, 0, '线性力场对称残余为零')
})

test('4. 单原子 + ASR：投影后全零频——Γ 点声学支的物理正确结果', async () => {
  // 单原子原胞 Γ 点只有平移零频；ASR（单原子退化为对角块清零）必须精确给出 0
  const k = 1.0
  const graph = { cell: cubeCell(3.6), nodes: [atom(29, 0, 0, 0)] }
  const out = await runPhononAnalysis(graph, independentSpring(k, [[0, 0, 0]]), { applyAsr: true })
  assert.equal(out.asrApplied, true)
  assert.ok(out.asrResidualBefore > k - 1e-9, `投影前行块残余应 = k（got ${out.asrResidualBefore}）`)
  for (const f of out.frequencies) assert.equal(f, 0, 'ASR 投影后频率精确为零')
  assert.equal(out.stability.verdict, 'stable')
})

test('5. 平移不变弹簧对（ASR on）：声学三支精确零频 + 光学三支闭式对账', async () => {
  const k = 0.5
  const d0 = [1.8, 1.8, 1.8]
  const graph = { cell: cubeCell(3.6), nodes: [atom(29, 0, 0, 0), atom(47, 1.8, 1.8, 1.8)] }
  const out = await runPhononAnalysis(graph, springPair(k, d0))
  const truthOptical = freqFromOmegaSq(k * (1 / MASS_AMU[29] + 1 / MASS_AMU[47]))
  assert.equal(out.frequencies.length, 6)
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(out.frequencies[i]) < 1e-6, `声学支 ${i}: ${out.frequencies[i]} 应为零（差分噪声底内）`)
  }
  for (let i = 3; i < 6; i++) {
    assert.ok(Math.abs(out.frequencies[i] - truthOptical) / truthOptical < 1e-6,
      `光学支 ${i}: ${out.frequencies[i]} vs 解析 ${truthOptical}`)
  }
  assert.ok(out.asrResidualBefore < 1e-8, '解析平移不变力场不破坏和规则（差分精度内）')
  assert.equal(out.stability.verdict, 'stable')
  assert.equal(out.imaginary.count, 0)
  assert.equal(out.imaginary.numericalNegativeCount, 3,
    '声学支的微负 λ（数值噪声）如实报告，不计入显著虚频')
})

test('6. 虚频体系（负弹簧）：verdict unstable + maxOmegaSq 闭式 + 阈值随结果交付', async () => {
  const k = -0.5
  const graph = { cell: cubeCell(3.6), nodes: [atom(29, 0, 0, 0), atom(47, 1.8, 1.8, 1.8)] }
  const out = await runPhononAnalysis(graph, springPair(k, [1.8, 1.8, 1.8]))
  assert.equal(out.stability.verdict, 'unstable', '显著虚频必须判不稳定（禁止粉饰）')
  assert.equal(out.imaginary.count, 3, '三支光学虚频；声学三支仍精确为零')
  const truthNeg = k * (1 / MASS_AMU[29] + 1 / MASS_AMU[47])
  assert.ok(Math.abs(out.imaginary.maxOmegaSq - (-truthNeg)) < 1e-9 * Math.abs(truthNeg),
    `maxOmegaSq ${out.imaginary.maxOmegaSq} vs 解析 ${truthNeg}`)
  assert.equal(out.stability.thresholdOmegaSq, 1e-4, '判定阈值随结果交付（声明即对账）')
})

test('7. 显式失败：位移非正 / 缺力函数 / 空 graph / 力形状错 / 力非有限', async () => {
  const graph = { cell: cubeCell(3.6), nodes: [atom(29, 0, 0, 0)] }
  const fp = independentSpring(1, [[0, 0, 0]])
  await assert.rejects(
    () => runPhononAnalysis(graph, fp, { displacement: 0 }),
    err => err.code === 'PHONON_BAD_DISPLACEMENT')
  await assert.rejects(
    () => runPhononAnalysis(graph, undefined),
    err => err.code === 'PHONON_FORCE_PROVIDER_MISSING')
  await assert.rejects(
    () => runPhononAnalysis({ cell: cubeCell(3.6), nodes: [] }, fp),
    err => err.code === 'PHONON_BAD_GRAPH')
  await assert.rejects(
    () => runPhononAnalysis({ nodes: [atom(29, 0, 0, 0)] }, fp),
    err => err.code === 'PHONON_BAD_GRAPH')
  await assert.rejects(
    () => runPhononAnalysis(graph, async () => ({ forces: [[0, 0]] })),
    err => err.code === 'PHONON_BAD_FORCE')
  await assert.rejects(
    () => runPhononAnalysis(graph, async () => ({ forces: [[NaN, 0, 0]] })),
    err => err.code === 'PHONON_BAD_FORCE')
  await assert.rejects(
    () => runPhononAnalysis({ cell: cubeCell(3.6), nodes: [atom(999, 0, 0, 0)] }, fp),
    err => err.code === 'PHONON_MASS_MISSING')
})

test('8. 确定性：同输入两次完全一致（Jacobi 无随机性）', async () => {
  const k = 0.5
  const graph = { cell: cubeCell(3.6), nodes: [atom(29, 0, 0, 0), atom(47, 1.8, 1.8, 1.8)] }
  const a = await runPhononAnalysis(graph, springPair(k, [1.8, 1.8, 1.8]))
  const b = await runPhononAnalysis(graph, springPair(k, [1.8, 1.8, 1.8]))
  assert.deepEqual(a.frequencies, b.frequencies)
  assert.deepEqual(a.imaginary, b.imaginary)
})

test('9. §4.4 形态与谱系登记：inputs/outputs 声明 + Trajectory 记录', async () => {
  assert.equal(phononAnalysis.name, 'phonon')
  assert.deepEqual(phononAnalysis.inputs, ['engine-forces'])
  assert.deepEqual(phononAnalysis.outputs, ['phonon-spectrum'])
  const desc = phononAnalysis.describe()
  assert.ok(typeof desc.description === 'string' && desc.parameters)

  const trajectory = []
  const rtStub = {
    appendTrajectory: async (entry) => trajectory.push(entry),
    emit: async () => {},
  }
  const k = 0.5
  const graph = { cell: cubeCell(3.6), nodes: [atom(29, 0, 0, 0), atom(47, 1.8, 1.8, 1.8)] }
  await phononAnalysis.run({ graph, forceProvider: springPair(k, [1.8, 1.8, 1.8]) }, rtStub)
  assert.equal(trajectory.length, 1)
  assert.equal(trajectory[0].type, 'analysis_complete')
  assert.equal(trajectory[0].analysis, 'phonon')
  assert.equal(trajectory[0].result.verdict, 'stable')
  assert.ok(Number.isFinite(trajectory[0].result.maxFrequencyTHz))

  await assert.rejects(
    () => phononAnalysis.run({}, rtStub),
    err => err.code === 'ANALYSIS_INPUT_MISSING')
})

test('10. 工具层：缺 materialId 显式报错', async () => {
  const ctx = new Context()
  const fiber = await ctx.registry.plugin({
    name: 'saturday-phonon',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdayPhonon
    await assert.rejects(
      () => rt.tools.call('analysis.phonon', {}),
      /requires materialId/)
  } finally {
    await fiber.dispose()
  }
})

test('11. 集成：真实桥 + Cu → analysis.phonon（任意有力引擎）+ 谱系落盘 + 卸载回收', async () => {
  const ctx = new Context()
  const dir = await mkdtemp(join(tmpdir(), 'saturday-phonon-'))
  const path = join(dir, 'trajectory.jsonl')

  const coreFiber = await ctx.registry.plugin({
    name: 'saturday',
    apply: (ctx) => bridgePlugin.apply(ctx, { trajectoryPath: path }),
  })
  const phononFiber = await ctx.registry.plugin({
    name: 'saturday-phonon',
    apply: (ctx) => plugin.apply(ctx, { trajectoryPath: path }),
  })
  const coreRt = coreFiber.store.saturday.rt
  const phononRt = phononFiber.store.saturdayPhonon.rt

  try {
    const loaded = await coreRt.tools.call('material.load', { query: 'Cu' })

    // 纯 JS 数据面（lj-js）的 calculate 不提供力：显式报错而非静默降级（契约 §2）；
    // EMT 路径走完整断言。
    let out = null
    try {
      out = await phononRt.tools.call('analysis.phonon', { materialId: loaded.materialId })
    } catch (err) {
      // 引擎无力时必须走到这里：显式失败而非静默降级（契约 §2）
      assert.equal(err.code, 'PHONON_FORCE_MISSING', '无力引擎必须显式报错')
    }

    if (out) {
      // 管线与交付形态（任何提供力的引擎都成立：emt-mock / lj-js）
      assert.equal(out.nAtoms, (await coreRt.getService('material').get(loaded.materialId)).nAtoms)
      assert.equal(out.frequencies.length, 3 * out.nAtoms)
      for (const f of out.frequencies) assert.ok(Number.isFinite(f))
      assert.ok(Number.isFinite(out.forceResidualMax) && Number.isFinite(out.equilibriumForceMax))
      assert.ok(['stable', 'unstable'].includes(out.stability.verdict))
      // 真力路径：单原子原胞 ASR 后声学支精确零频（投影与引擎无关，端到端对账）
      if (out.nAtoms === 1) {
        for (const f of out.frequencies) assert.equal(f, 0, '单原子原胞 Γ 声学支 = 0')
      }

      // 谱系登记落盘
      await new Promise(r => setTimeout(r, 50))
      const text = await readFile(path, 'utf8')
      assert.ok(text.includes('"analysis":"phonon"'), 'analysis_complete 落入 Trajectory')
    }
  } finally {
    // 清理先于断言结果生效：断言失败不能跳过 dispose（sidecar 句柄会挂住进程）
    await phononFiber.dispose()
    assert.equal(phononRt.getService('analysis/phonon'), undefined, '服务随卸载消失')
    assert.ok(!phononRt.tools.list().some(t => t.name === 'analysis.phonon'), '工具随卸载回收')
    await coreFiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
