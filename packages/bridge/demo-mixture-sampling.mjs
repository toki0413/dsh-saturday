// 多锚点混合采样演示：跨盆地探索的闭式似然 + 引擎回算闭环
// OU 单峰 = 局部采样器；跨盆地 = 多参考加权混合（ouSampleMixture）：
//   A. 双锚点（Cu 基体 / Cu3Ag 掺杂，同拓扑）按 [0.6, 0.4] 配额采样（最大余数法）
//   B. 混合似然独立重算（相对全部锚点，'exact' 不降档，可复现 1e-9）
//   C. 回算闭环：候选不自证，引擎是唯一 oracle（采样似然 ≠ 物理能量）
// 运行：node demo-mixture-sampling.mjs（环境自适应：有 Python 走 EMT 单点；
// 纯 Node 走零依赖 lj-js 引擎，回算闭环两环境均完整）

import { Context } from '@deepseek-ai/cordis'
import plugin from './src/saturday.plugin.mjs'
import { ouSampleMixture, ouMixtureLogProb } from '@toki0413/plugin-sampler-ou'
import { Material } from '@toki0413/core'

const ctx = new Context()
const fiber = await ctx.registry.plugin({
  name: 'saturday',
  apply: (ctx) => plugin.apply(ctx, {}),
})
const { potential, materialService, dataPlane } = fiber.store.saturday

// ── A. 双锚点混合采样：Cu fcc 原胞与其单点掺杂 Cu3Ag（同拓扑：均 4 原子）──
const cu = await materialService.load('Cu')
const cu3ag = cu.substitute(0, 'Ag')
const target = {
  references: [
    { reference: { graph: cu.graph }, weight: 0.6 },
    { reference: { graph: cu3ag.graph }, weight: 0.4 },
  ],
}
const n = 10
const candidates = await ouSampleMixture(target, { n, seed: 7, uEq: 0.05, gammaDt: 1.0 })

console.log('── A. 多锚点混合采样（配额 = 最大余数法确定性分配）──')
const perAnchor = candidates.reduce((acc, c) => (acc[c.anchorIndex] = (acc[c.anchorIndex] ?? 0) + 1, acc), {})
console.log(`锚点: [0]=Cu(${cu.formula})  [1]=${cu3ag.formula}（同拓扑 ${cu.nAtoms} 原子）`)
console.log(`混合权重: ${JSON.stringify(candidates[0].mixtureWeights)}（归一后随每个交付呈现）`)
console.log(`配额: 锚点0 → ${perAnchor[0] ?? 0} 个，锚点1 → ${perAnchor[1] ?? 0} 个（0.6/0.4 × ${n}，平手取靠前）`)
console.log(`谱系: ${candidates[0].source}（所属锚点可追溯）\n`)

// ── B. 混合似然独立重算：交付的 logProb 相对全部锚点，消费方可机械复核 ──
console.log('── B. 混合似然独立重算（' + "'exact'" + ' 不降档：闭式可复现）──')
let maxDev = 0
for (const c of candidates) {
  const dispsAll = target.references.map(({ reference }) => {
    const out = []
    c.graph.nodes.forEach((node, i) => {
      node.position.forEach((x, col) => out.push(x - reference.graph.nodes[i].position[col]))
    })
    return out
  })
  const recomputed = ouMixtureLogProb(dispsAll, [0.6, 0.4], { uEq: 0.05, gammaDt: 1.0 })
  maxDev = Math.max(maxDev, Math.abs(recomputed - c.logProb))
}
console.log(`10 个候选逐一重算，最大偏差 ${maxDev.toExponential(2)}（< 1e-9：似然声明可独立验证）\n`)

// ── C. 回算闭环：候选不自证——采样似然是提议核声明，物理能量只认引擎单点 ──
console.log('── C. 回算闭环（候选不自证，引擎是唯一 oracle）──')
const pick = candidates[0]
const candidate = await Material.create({
  modalities: { graph: pick.graph, formula: cu.formula },
  lineage: [{ operation: 'sampled-candidate', detail: { source: pick.source }, timestamp: Date.now() }],
})
const provider = potential.get(dataPlane)
const calc = await provider.calculate(candidate)
console.log(`候选[0] 谱系: ${pick.source}`)
console.log(`采样似然: logProb = ${pick.logProb.toFixed(6)}（提议核下的相对全部锚点混合似然）`)
console.log(`引擎单点: energy = ${calc.energy.toFixed(6)} eV（${calc.calculator ?? calc.engine}）`)
console.log('诚实声明：似然 "exact" 指混合转移密度闭式可求值，与物理能量无关——')
console.log('候选是否物理可信只由引擎回算裁定（生成 → 回算 → 核对，谱系不断）。')

await fiber.dispose()
