// 全自动锚点引导闭环演示：无人工入库形态——
//   A. 闭环产出参考结构：Cu 与其掺杂变体 Cu3Ag 各自弛豫（收敛 + 终态交付）
//   B. 自动入库：弛豫后结构随收敛事件自动进会话锚点库（谱系自动声明
//      `job:<id>#engine=<name>`，全程无一次手动 `sampler.anchor.add`）
//   C. sampler.mixture 会话库检索 → 配额 → 混合提案（检索距离随交付呈现，
//      组分不可考锚点排尾如实呈现）
//   D. 工具间只传交付接 `workflow.screen` 联合排序（候选不自证，引擎是唯一 oracle）
// 诚实纪律：回算证据只认真实可算的数据面——纯 Node 下 lj-js 引擎可回算，
// 闭环完整；Python 在场但无 ASE 的边缘环境下数据面诚实报错，本演示如实终止不伪造证据。
// 运行：node demo-anchor-auto.mjs（环境自适应：弛豫/单点走 EMT 或 lj-js）

import { Context } from '@deepseek-ai/cordis'
import plugin from './src/saturday.plugin.mjs'
import screeningPlugin from '@saturday/plugin-screening'
import samplerOuPlugin from '@saturday/plugin-sampler-ou'

const ctx = new Context()
const fiber = await ctx.registry.plugin({ name: 'saturday', apply: (ctx) => plugin.apply(ctx, {}) })
const { potential, materialService, dataPlane } = fiber.store.saturday
const screenFiber = await ctx.registry.plugin({ name: 'saturday-screening', apply: (ctx) => screeningPlugin.apply(ctx, {}) })
const samplerFiber = await ctx.registry.plugin({ name: 'saturday-sampler-ou', apply: (ctx) => samplerOuPlugin.apply(ctx, {}) })
const screenRt = screenFiber.store.saturdayScreening.rt
const samplerRt = samplerFiber.store.saturdaySamplerOu.rt   // 锚点工具注册在采样器插件自己的运行时
const anchorStore = samplerFiber.store.saturdaySamplerOu.anchorStore

try {
  // ── A/B. 闭环产出 → 弛豫 → 自动入库（全程无手动锚点入库）──
  console.log('── A/B. 弛豫收敛 → 自动入库（谱系自动声明，无手动入库）──')
  const cu = await materialService.load('Cu')
  const cu3ag = cu.substitute(0, 'Ag')
  materialService.store.set(cu3ag.id, cu3ag)   // 闭环产出的变体注册入会话
  async function materialRelax(m) {   // potential.relax 工具路径：收敛事件 → 监听 → 自动入库
    const rt = fiber.store.saturday.rt
    return rt.tools.call('potential.relax', { materialId: m.id, simulatedSeconds: 0 })
  }
  for (const m of [cu, cu3ag]) {
    const r = await materialRelax(m)
    console.log(`弛豫 ${m.formula}: converged=${r.converged}，energy=${r.energy.toFixed(6)} eV（${r.calculator ?? r.engine}）`)
  }
  console.log(`锚点库（自动积累）: ${anchorStore.size()} 个`)
  for (const e of anchorStore.entries()) {
    console.log(`  ${e.source}（组分 ${JSON.stringify(e.composition)}）`)
  }
  console.log('')

  // ── C. 锚点引导混合提案：会话库检索（自动积累的锚点）→ 配额 → 提案 ──
  console.log('── C. sampler.mixture：会话库检索 → 配额 → 混合提案（似然 exact）──')
  const mixture = await samplerRt.tools.call('sampler.mixture', {
    nAtoms: 4, composition: { Cu: 3, Ag: 1 },
    weights: [0.6, 0.4],
    n: 8, seed: 7, uEq: 0.05, gammaDt: 1.0, temperatureK: 300,
  })
  console.log(`锚点来源层: ${mixture.anchorOrigin}（自动积累，无手动入库）`)
  for (const [i, a] of mixture.anchors.entries()) {
    console.log(`  检索[${i}]: ${a.source.split('#')[0]}…，组分 L1 距离 = ${a.distance}${a.distance === null ? '（不可考，排尾如实呈现）' : ''}`)
  }
  const per = mixture.candidates.reduce((acc, c) => (acc[c.anchorIndex] = (acc[c.anchorIndex] ?? 0) + 1, acc), {})
  console.log(`配额: ${JSON.stringify(per)}（0.6/0.4 × 8，最大余数法）`)
  console.log(`谱系: ${mixture.candidates[0].source}（所属锚点可追溯）\n`)

  // ── D. 回算闭环 + 联合排序：候选不自证，引擎是唯一 oracle ──
  console.log('── D. 回算 + 联合排序（候选不自证；谱系在编排层不断）──')
  const canRecalc = dataPlane === 'lj-js'
    || potential.get('emt-mock').bridge.sidecarInfo?.calculators?.['ase-emt'] === true
  if (!canRecalc) {
    console.log('ASE 不可用：数据面诚实报错，本演示如实终止（不伪造回算证据）。')
  } else {
    const result = await screenRt.tools.call('workflow.screen', {
      materialId: cu.id, dopants: ['Ag'],
      sampled: mixture.candidates.map(c => ({ graph: c.graph, source: c.source, logProb: c.logProb })),
      sampledSource: 'sampler.mixture',
      temperatureK: 300,
    })
    const joint = result.sampledJoint
    const sum = joint.entries.reduce((a, e) => a + e.weight, 0)
    console.log(`联合排序: ${joint.entries.length} 候选全部回算成功（${joint.samplerName}）`)
    console.log(`证据源: ${joint.sourceNames.join(' × ')}；权重归一 Σw = ${sum.toFixed(12)}；ESS 占比 = ${joint.essFraction.toFixed(3)}`)
    console.log('全自动闭环完成：弛豫 → 自动入库 → 检索 → 提案 → 回算 → 排序，全程无手动锚点操作，谱系不断。')
  }
} finally {
  await samplerFiber.dispose()
  await screenFiber.dispose()
  await fiber.dispose()
}
