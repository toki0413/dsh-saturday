// 掺杂筛选演示：Cu 基体 + 4 种 fcc 金属掺杂 → ASE EMT 批量弛豫 → 能量排序 → 溯源
// 运行：node demo-screening.mjs

import { Context } from '@deepseek-ai/cordis'
import plugin from './src/saturday.plugin.mjs'

const ctx = new Context()
const fiber = await ctx.registry.plugin({
  name: 'saturday',
  apply: (ctx) => plugin.apply(ctx, {}),
})
const { rt, potential } = fiber.store.saturday

const provider = potential.get('emt-mock')
console.log(`sidecar 后端: ${JSON.stringify(provider.bridge.sidecarInfo.calculators)}\n`)

const cu = await rt.tools.call('material.load', { query: 'Cu' })
console.log(`基体: ${cu.formula} (${cu.nAtoms} 原子, id=${cu.materialId.slice(0, 8)}…)`)
console.log('筛选: 掺杂 Ag / Au / Ni / Pt（各取代位点 0）\n')

const t0 = Date.now()
const result = await rt.tools.call('workflow.screen', {
  materialId: cu.materialId,
  dopants: ['Ag', 'Au', 'Ni', 'Pt'],
})

console.log('排名  变体              E/atom (eV)   收敛   步数   计算器')
console.log('────  ────────────────  ────────────  ────   ────   ────────')
result.ranked.forEach((r, i) => {
  console.log(
    `${String(i + 1).padEnd(5)}${r.label.padEnd(19)}${r.energyPerAtom.toFixed(4).padStart(9)}    ` +
    `${String(r.converged).padEnd(6)} ${String(r.nSteps).padEnd(6)} ${r.calculator}`,
  )
})
if (result.failed.length) {
  console.log('\n失败变体:', result.failed.map(f => `${f.label}: ${f.error}`).join('; '))
}
console.log(`\n共 ${result.ranked.length} 个变体，耗时 ${((Date.now() - t0) / 1000).toFixed(1)} s`)
console.log(`注: ${result.note}`)
console.log('每个变体的完整计算记录已写入 Trajectory（data/trajectory.jsonl）')

await fiber.dispose()
