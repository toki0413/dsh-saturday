// 三元混掺筛选演示：Cu 基体 + 4 种掺杂（5 元素统一成分空间）
// → 当前数据面引擎批量弛豫 + 全元素参考态显式计算 → 严格形成焓 + 多组分凸包判据。
// 物理看点：形成焓的符号与凸包几何由引擎能量裁定——落入包络下方的候选成为稳定相顶点；
// EMT 下 Cu-Pt/Cu-Au 呈负形成焓（有序化倾向），LJ 玩具势下数值与符号可不同（定性演示档），
// 判据机制本身不依赖引擎精度。
// 几何诚实声明：单点掺杂候选位于"基体端点→掺杂端点"连线上，该连线内包络仍由 0-0 弦主导，
// 故判据保持 max(0, ΔH_f) 退化形；非退化判据需每掺杂多浓度内点（见浓度扫描演示）。
// 运行：npm run demo:screening-ternary

import { Context } from '@deepseek-ai/cordis'
import plugin from './src/saturday.plugin.mjs'
import screeningPlugin from '@saturday/plugin-screening'

const ctx = new Context()
const fiber = await ctx.registry.plugin({
  name: 'saturday',
  apply: (ctx) => plugin.apply(ctx, {}),
})
const { rt, potential, dataPlane } = fiber.store.saturday

const screenFiber = await ctx.registry.plugin({
  name: 'saturday-screening',
  apply: (ctx) => screeningPlugin.apply(ctx, {}),
})
const screenRt = screenFiber.store.saturdayScreening.rt

if (dataPlane === 'emt-mock') {
  const provider = potential.get('emt-mock')
  console.log(`sidecar 后端: ${JSON.stringify(provider.bridge.sidecarInfo.calculators)}\n`)
} else {
  console.log(`数据面: ${dataPlane}（零依赖纯 JS 引擎，LJ 玩具势——定性演示档）\n`)
}

const cu = await rt.tools.call('material.load', { query: 'Cu' })
console.log(`基体: ${cu.formula} (${cu.nAtoms} 原子, id=${cu.materialId.slice(0, 8)}…)`)
console.log('筛选: 掺杂 Ag / Au / Ni / Pt（5 元素统一成分空间，d=4 单形下包络）\n')

const t0 = Date.now()
const result = await screenRt.tools.call('workflow.screen', {
  materialId: cu.materialId,
  dopants: ['Ag', 'Au', 'Ni', 'Pt'],
})

console.log('排名  变体              ΔH_f (eV/atom)  hull 距离      状态')
console.log('────  ────────────────  ──────────────  ─────────────  ──────────')
result.ranked.forEach((r, i) => {
  const onHull = r.energyAboveHull < 1e-9
  console.log(
    `${String(i + 1).padEnd(5)}${r.label.padEnd(19)} ` +
    `${r.formationEnthalpy.toFixed(4).padStart(12)}    ` +
    `${r.energyAboveHull.toFixed(4).padStart(9)}    ` +
    `${onHull ? '包上（稳定相候选）' : '包上方'}`,
  )
})
if (result.failed.length) {
  console.log('\n失败变体:', result.failed.map(f => `${f.label}: ${f.error}`).join('; '))
}

const t = result.thermo
console.log(`\n热力学声明: level=${t.level}, mode=${t.mode}, hullDimension=${t.hullDimension}`)
console.log(`参考态（每原子，显式计算）: ${Object.entries(t.references).map(([el, e]) => `${el}=${e.toFixed(4)}`).join(', ')}`)
console.log(`注: ${t.note}`)
const degenerate = result.ranked.filter(r =>
  Math.abs(r.energyAboveHull - Math.max(0, r.formationEnthalpy)) > 1e-6)
console.log(`\n非退化判据候选 ${degenerate.length} 个（判据 ≠ max(0, ΔH_f)）：` +
  (degenerate.length ? degenerate.map(r => r.formula).join(', ') : '无（单点掺杂的几何必然：连线内包络由 0-0 弦主导）'))
console.log('提示：非退化判据需同掺杂多浓度内点——浓度扫描见 demo:concentrations')
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)} s`)

await screenFiber.dispose()
await fiber.dispose()
