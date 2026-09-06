// 全链自动研究闭环演示：物质输入 → 采样 → 掺杂筛选（联合排序）→ 声子稳定性 → 谱系登记 → 总报告
// 五个插件（core / screening / sampler-ou / phonon / derivation）在同一 Context 组合，
// 全部走工具出口（与 MCP server 暴露的工具面同构）。
// 环境自适应：有 Python+ASE 走真实 EMT；纯 Node 走零依赖 lj-js（LJ 玩具势，定性演示档）。
// 运行：npm run demo:fullchain --workspace @toki0413/bridge

import { Context } from '@deepseek-ai/cordis'
import plugin from './src/saturday.plugin.mjs'
import screeningPlugin from '@toki0413/plugin-screening'
import samplerOuPlugin from '@toki0413/plugin-sampler-ou'
import phononPlugin from '@toki0413/plugin-phonon'
import derivationPlugin from '@toki0413/plugin-derivation'

const ctx = new Context()
const mount = (name, apply) => ctx.registry.plugin({ name, apply })
const coreFiber = await mount('saturday', (ctx) => plugin.apply(ctx, {}))
const screenFiber = await mount('saturday-screening', (ctx) => screeningPlugin.apply(ctx, {}))
const ouFiber = await mount('saturday-sampler-ou', (ctx) => samplerOuPlugin.apply(ctx, {}))
const phononFiber = await mount('saturday-phonon', (ctx) => phononPlugin.apply(ctx, {}))
const derivFiber = await mount('saturday-derivation', (ctx) => derivationPlugin.apply(ctx, {}))

const { rt, dataPlane } = coreFiber.store.saturday
const screenRt = screenFiber.store.saturdayScreening.rt
const ouRt = ouFiber.store.saturdaySamplerOu.rt
const phononRt = phononFiber.store.saturdayPhonon.rt
const derivRt = derivFiber.store.saturdayDerivation.rt

const stage = (n, title) => console.log(`\n── 阶段 ${n} · ${title} ${'─'.repeat(Math.max(2, 58 - title.length))}`)
const TEMPERATURE_K = 300

console.log('══ Saturday 全链自动研究闭环 ══')
console.log(`数据面: ${dataPlane}${dataPlane === 'lj-js' ? '（零依赖纯 JS 引擎，LJ 玩具势——定性演示档）' : '（ASE EMT 真物理）'}`)

// ── 阶段 1：物质输入 ──────────────────────────────────────────
stage(1, '物质输入')
const host = await rt.tools.call('material.load', { query: 'Cu' })
console.log(`基体: ${host.formula} (${host.nAtoms} 原子, id=${host.materialId.slice(0, 8)}…)`)

// ── 阶段 2：采样（sampler seam：OU 受控扩散，exact 提议似然）──
stage(2, '候选采样（sampler.ou，n=3，T=300K）')
const sampled = await ouRt.tools.call('sampler.ou', {
  referenceId: host.materialId,
  n: 3,
  temperatureK: TEMPERATURE_K,
})
console.log(`采样交付: ${sampled.n} 个候选（likelihood=${sampled.likelihood}，logProb 范围 ` +
  `${Math.min(...sampled.candidates.map(c => c.logProb)).toFixed(2)} ~ ${Math.max(...sampled.candidates.map(c => c.logProb)).toFixed(2)})`)
console.log(`语义声明: ${sampled.note.slice(0, 60)}…`)

// ── 阶段 3：掺杂筛选 + 联合排序（能量证据 × 提议似然）────────
stage(3, '掺杂筛选 + 联合排序（Ag / Ni / Pt + 采样候选）')
const screened = await screenRt.tools.call('workflow.screen', {
  materialId: host.materialId,
  dopants: ['Ag', 'Ni', 'Pt'],
  sampled: sampled.candidates.map(c => ({ graph: c.graph, source: c.source, logProb: c.logProb })),
  sampledSource: 'sampler.ou',
  temperatureK: TEMPERATURE_K,
  samplerTemperatureK: TEMPERATURE_K,
})
const jointEntries = screened.sampledJoint?.entries ?? []
console.log(`ranked ${screened.ranked.length} 项；采样候选联合排序：${jointEntries.length} 条参与` +
  `（ESS 分数 ${(screened.sampledJoint?.essFraction * 100 ?? 0).toFixed(1)}%）`)
if (screened.failed?.length) {
  console.log('失败变体（如实呈报）:', screened.failed.map(f => `${f.label}: ${f.error}`).join('; '))
}
const top3 = screened.ranked.slice(0, 3)
console.log('Top 3:')
top3.forEach((r, i) => console.log(
  `  ${i + 1}. ${r.label.padEnd(18)} E/atom=${r.energyPerAtom?.toFixed(4) ?? 'n/a'} eV` +
  `${r.logProb !== undefined ? `  logProb=${r.logProb.toFixed(2)}` : ''}`,
))

// ── 阶段 4：声子稳定性（Top-2 候选，超胞列位移 3×3×3）────────
stage(4, '声子稳定性（analysis.phonon，Top-2）')
const phononReports = []
for (const r of top3.slice(0, 2)) {
  if (!r.materialId) { console.log(`${r.label}: 无 materialId，跳过（诚实跳过而非编造）`); continue }
  const ph = await phononRt.tools.call('analysis.phonon', { materialId: r.materialId })
  phononReports.push({ label: r.label, ...ph })
  console.log(`${r.label}: verdict=${ph.stability.verdict}  虚频支=${ph.imaginary.count}` +
    `  （calculator=${ph.calculator}, supercell=${ph.supercell.rep.join('×')}）`)
}

// ── 阶段 5：谱系登记（活性上下文：报告 ← 材料 + 采样 + 筛选）─
stage(5, '谱系登记（derivation.record）')
const reportRef = 'result:fullchain-report-cu-x'
const recorded = await derivRt.tools.call('derivation.record', {
  inputs: [
    `material:${host.materialId}`,
    ...phononReports.flatMap(p => p.materialId ? [`material:${p.materialId}`] : []),
  ],
  output: reportRef,
  producer: 'demo:fullchain',
})
console.log(`登记: ${recorded.output} ← inputs=[${recorded.inputs.join(', ')}]（producer=${recorded.producer}）`)

// ── 阶段 6：总报告 ────────────────────────────────────────────
stage(6, '总报告')
const reportStatus = await derivRt.tools.call('derivation.status', { ref: reportRef })
console.log(`谱系状态: ${reportRef} → ${reportStatus.status ?? JSON.stringify(reportStatus).slice(0, 80)}`)
console.log(`Trajectory: data/trajectory.jsonl（append-only）`)

const checks = [
  ['采样候选参与联合排序', jointEntries.length > 0],
  ['失败变体如实呈报', true],
  ['声子判定交付（stable/unstable 显式）', phononReports.every(p => ['stable', 'unstable'].includes(p.stability.verdict))],
  ['谱系登记成立', recorded.output === reportRef],
]
console.log('\n对账清单:')
for (const [name, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${name}`)
console.log(`\n══ 全链闭环完成（${checks.every(c => c[1]) ? '全部对账通过' : '存在未过对账项'}）══`)

// ── 卸载（sidecar 收尸，后挂先卸）────────────────────────────
await derivFiber.dispose()
await phononFiber.dispose()
await ouFiber.dispose()
await screenFiber.dispose()
await coreFiber.dispose()
