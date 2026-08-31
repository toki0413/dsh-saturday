// 锚点引导混合提案端到端演示：锚点工具链的完整真实编排——
//   A. 闭环产出的锚点入库（材料入库：来源声明缺省 = 材料身份，谱系门禁工具层生效）
//   B. sampler.mixture 会话库检索 → 配额 → OU 混合提案（检索距离随交付呈现）
//   C. 候选回算后进联合排序（候选不自证：采样似然 ≠ 物理能量，引擎是唯一 oracle；
//      谱系在编排层不断——工具间只传 {graph, source, logProb} 交付）
// 诚实纪律：无 ASE 环境下数据面诚实报错，本演示如实终止不伪造证据。
// 运行：node demo-anchor-guided.mjs（依赖 Python sidecar 做真实单点）

import { Context } from '@deepseek-ai/cordis'
import plugin from './src/saturday.plugin.mjs'
import screeningPlugin from '@saturday/plugin-screening'
import samplerOuPlugin from '@saturday/plugin-sampler-ou'

const ctx = new Context()
const fiber = await ctx.registry.plugin({ name: 'saturday', apply: (ctx) => plugin.apply(ctx, {}) })
const { potential, materialService } = fiber.store.saturday
const screenFiber = await ctx.registry.plugin({ name: 'saturday-screening', apply: (ctx) => screeningPlugin.apply(ctx, {}) })
const samplerFiber = await ctx.registry.plugin({ name: 'saturday-sampler-ou', apply: (ctx) => samplerOuPlugin.apply(ctx, {}) })
const screenRt = screenFiber.store.saturdayScreening.rt
const samplerRt = samplerFiber.store.saturdaySamplerOu.rt   // 锚点工具注册在采样器插件自己的运行时

try {
  // ── A. 锚点入库：闭环产出的参考结构经工具入库（无谱系数据不入库在工具层生效）──
  console.log('── A. 锚点入库（材料入库：来源声明缺省 = 材料身份）──')
  const cu = await materialService.load('Cu')
  const cu3ag = cu.substitute(0, 'Ag')
  materialService.store.set(cu3ag.id, cu3ag)   // 闭环产出的变体注册入会话（与筛选演示同款）
  const addCu = await samplerRt.tools.call('sampler.anchor.add', { materialId: cu.id })
  const addDoped = await samplerRt.tools.call('sampler.anchor.add', { materialId: cu3ag.id })
  console.log(`锚点 1: ${addCu.entry.formula}（source=${addCu.entry.source}，组分 ${JSON.stringify(addCu.entry.composition)}）`)
  console.log(`锚点 2: ${addDoped.entry.formula}（source=${addDoped.entry.source}，组分 ${JSON.stringify(addDoped.entry.composition)}）`)
  console.log(`库规模: ${addDoped.size}（会话级，与闭环运行同生命周期）\n`)

  // ── B. 锚点引导混合采样：会话库检索（拓扑门禁 + 组分 L1 距离）→ 配额 → 混合提案 ──
  console.log('── B. sampler.mixture：会话库检索 → 配额 → OU 混合提案（似然 exact）──')
  const mixture = await samplerRt.tools.call('sampler.mixture', {
    nAtoms: 4, composition: { Cu: 3, Ag: 1 },
    weights: [0.6, 0.4],
    n: 8, seed: 7, uEq: 0.05, gammaDt: 1.0, temperatureK: 300,
  })
  console.log(`锚点来源层: ${mixture.anchorOrigin}（闭环积累的会话库）`)
  for (const [i, a] of mixture.anchors.entries()) {
    console.log(`  检索[${i}]: ${a.source}，组分 L1 距离 = ${a.distance}`)
  }
  const per = mixture.candidates.reduce((acc, c) => (acc[c.anchorIndex] = (acc[c.anchorIndex] ?? 0) + 1, acc), {})
  console.log(`配额: 锚点0 → ${per[0] ?? 0} 个，锚点1 → ${per[1] ?? 0} 个（0.6/0.4 × 8，最大余数法）`)
  console.log(`谱系: ${mixture.candidates[0].source}（所属锚点可追溯）`)
  console.log(`温度声明: ${mixture.candidates[0].samplerTemperatureK} K（声明 ≠ 替换，随交付呈现）\n`)

  // ── C. 回算闭环 + 联合排序：候选不自证，引擎是唯一 oracle ──
  console.log('── C. 回算 + 联合排序（候选不自证；谱系在编排层不断）──')
  const hasAse = potential.get('emt-mock').bridge.sidecarInfo?.calculators?.['ase-emt'] === true
  if (!hasAse) {
    console.log('ASE 不可用：数据面诚实报错，本演示如实终止（不伪造回算证据）。')
  } else {
    const result = await screenRt.tools.call('workflow.screen', {
      materialId: cu.id, dopants: ['Ag'],
      // 工具间只传交付（{graph, source, logProb}）：编排层不触碰候选本体之外的任何东西
      sampled: mixture.candidates.map(c => ({ graph: c.graph, source: c.source, logProb: c.logProb })),
      sampledSource: 'sampler.mixture',
      temperatureK: 300,
    })
    const joint = result.sampledJoint
    console.log(`联合排序: ${joint.entries.length} 候选全部回算成功（${joint.samplerName}）`)
    console.log(`证据源: ${joint.sourceNames.join(' × ')}（能量证据 × 提议似然）`)
    const sum = joint.entries.reduce((a, e) => a + e.weight, 0)
    console.log(`权重归一: Σw = ${sum.toFixed(12)}（配分函数归一，非近似）；ESS 占比 = ${joint.essFraction.toFixed(3)}`)
    console.log(`独立性声明: ${joint.independence}`)
    const top = joint.entries[0]
    console.log(`权重最高候选: 能量 ${top.energy.toFixed(6)} eV，logProb ${top.logProb.toFixed(4)}`)
    console.log('诚实声明：混合似然 "exact" 指提议核闭式可求值，与物理能量无关——')
    console.log('候选是否物理可信只由引擎回算裁定（入库 → 检索 → 提案 → 回算 → 排序，谱系不断）。')
  }
} finally {
  await samplerFiber.dispose()
  await screenFiber.dispose()
  await fiber.dispose()
}
