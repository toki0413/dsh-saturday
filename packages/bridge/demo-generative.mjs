// 旗舰端到端演示：一份 sampler seam、两种生成式提议器（RSS 随机结构搜索 / 仿射耦合流）
// 喂进 workflow.explore 的可插拔 sampler（#115 解锁）→ 候选不自证、引擎回算弛豫 → 能量排序。
// 运行：node demo-generative.mjs（环境自适应：有 Python 走 EMT；纯 Node 走零依赖 lj-js，闭环两档均完整）
import { Context } from '@deepseek-ai/cordis'
import bridgePlugin from './src/saturday.plugin.mjs'
import rssPlugin from '@toki0413/plugin-rss'
import flowPlugin from '@toki0413/plugin-sampler-flow'
import explorePlugin from '@toki0413/plugin-explore'

const ctx = new Context()
const core = await ctx.registry.plugin({ name: 'saturday', apply: (c) => bridgePlugin.apply(c, { quiet: true }) })
await ctx.registry.plugin({ name: 'saturday-sampler-rss', apply: (c) => rssPlugin.apply(c, {}) })
await ctx.registry.plugin({ name: 'saturday-sampler-flow', apply: (c) => flowPlugin.apply(c, {}) })
const explore = await ctx.registry.plugin({ name: 'saturday-explore', apply: (c) => explorePlugin.apply(c, {}) })
const { rt, dataPlane } = core.store.saturday
const eRt = explore.store.saturdayExplore.rt

const cu = await rt.tools.call('material.load', { query: 'Cu' })
const refId = cu.materialId ?? cu.id
console.log(`数据面: ${dataPlane}（环境自适应）；参考材料: ${cu.formula} ${refId}\n`)

for (const sampler of ['rss', 'affine-flow']) {
  console.log(`══ 生成式提议器 sampler='${sampler}' → workflow.explore 回算闭环 ══`)
  const out = await eRt.tools.call('workflow.explore', { referenceId: refId, sampler, n: 6, seed: 42 })
  console.log(`引擎: ${out.provider ?? '?'}；候选+参考回算 ${out.ranked.length} 项，失败 ${out.failed.length}（不吞错）`)
  console.log('排名  energyPerAtom(eV)   dE(eV)      kind/source')
  for (const [i, r] of out.ranked.slice(0, 6).entries()) {
    console.log(`#${i + 1}   ${r.energyPerAtom.toFixed(4).padStart(12)}   ${(r.dE ?? 0).toFixed(4).padStart(8)}   ${r.kind} ${r.source ?? ''}`)
  }
  console.log(`  （参考结构 ${out.ranked.some(r => r.kind === 'reference') ? '在环内作 dE 基线' : '？'}；排序由引擎回算说话，非透传）\n`)
}

console.log('说明: 同一 sampler seam、同一回算闭环，换 rss / affine-flow 只改一个参数；')
console.log('候选是生成分布点非唯一解，能量为引擎回算（generative 谱系可溯、跨引擎可比受单位/指纹门禁约束）。')

await explore.dispose()
await core.dispose()
