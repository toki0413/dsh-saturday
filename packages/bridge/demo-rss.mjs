// RSS 随机结构搜索演示：§4.5 第二个生成式实现（非 flow 路线）端到端
// 链路：成分/晶胞约束下均匀随机生成（最小间距门禁）→ 逐候选引擎回算弛豫 →
//       能量排序（dE 相对参考）→ 谱系全程可溯源（generative:rss 前缀）
// 运行：node demo-rss.mjs（环境自适应：有 Python 走 EMT 单点；
// 纯 Node 走零依赖 lj-js 引擎，回算闭环两环境均完整）

import { Context } from '@deepseek-ai/cordis'
import plugin from './src/saturday.plugin.mjs'
import rssPlugin, { rssSampler } from '@toki0413/plugin-rss'
import { exploreCandidates } from '@toki0413/plugin-explore'

const ctx = new Context()
const coreFiber = await ctx.registry.plugin({
  name: 'saturday',
  apply: (ctx) => plugin.apply(ctx, {}),
})
const rssFiber = await ctx.registry.plugin({
  name: 'saturday-sampler-rss',
  apply: (ctx) => rssPlugin.apply(ctx, {}),
})
const { potential, materialService, dataPlane } = coreFiber.store.saturday
const { rt } = rssFiber.store.saturdaySamplerRss

console.log(`数据面: ${dataPlane}（环境自适应，横幅如实呈报）\n`)

// ── A. RSS 生成：成分继承自参考结构（Cu，4 原子），结构本身独立随机 ──
const cu = await materialService.load('Cu')
const out = await rt.tools.call('sampler.rss', { referenceId: cu.id, n: 8, seed: 42 })

console.log('── A. RSS 随机结构生成（成分继承 + 最小间距门禁）──')
console.log(`采样器: ${out.sampler}（semantics=${out.semantics}, likelihood=${out.likelihood}, invertible=${out.invertible}）`)
console.log(`候选: ${out.n} 个 ${out.formula} 随机晶胞（正交，边长 2.5–6.0 Å，最小间距 1.1 Å）`)
console.log(`谱系: ${out.candidates[0].source}（同种子可复现）\n`)

// ── B. 回算闭环：候选不自证——引擎是唯一 oracle，逐候选弛豫后按能量排序 ──
console.log('── B. 回算闭环（生成 → 弛豫 → 核对，能量排序）──')
const result = await exploreCandidates({
  reference: cu,
  candidates: out.candidates,
  potential,
  engine: 'auto',
  emit: () => {}, // 事件已落 Trajectory，演示从简
})

console.log(`引擎: ${result.provider}；参考回算 ${result.referenceEnergy?.toFixed(4) ?? '?'} eV（${result.reference}）\n`)
console.log('排名  energyPerAtom (eV)   dE vs 参考 (eV)   谱系')
for (const [i, r] of result.ranked.slice(0, 5).entries()) {
  console.log(
    `#${i + 1}   ${r.energyPerAtom.toFixed(4).padStart(16)}   ${r.dE?.toFixed(4)?.padStart(15)}   ${r.source}`,
  )
}
console.log(`\n（仅展示 Top-5/${result.ranked.length}；失败候选 ${result.failed.length} 个——失败如实呈报不吞错）`)
console.log('说明: 参考结构自身也在回算环内（dE 基线）；RSS 候选弛豫后高于还是低于')
console.log('参考，由引擎回算说话（本例随机晶胞弛入局部极小与 fcc 原型互有高低）；')
console.log('跨候选相对比较与闭环验证才是排序的价值所在。')
console.log(`\n诚实声明: ${out.note}`)

await rssFiber.dispose()
await coreFiber.dispose()
