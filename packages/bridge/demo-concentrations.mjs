// 浓度扫描演示：Cu 基体 + Pt/Ni 各三档浓度 + 共掺变体（统一成分空间）
// → 同掺杂多浓度内点让凸包变密；共掺候选落在稳定相之间的成分空间内部。
// 非退化判据的机制由筛选测试 9 闭式对账（7/75）；本演示展示当前数据面引擎下的包络实证：
// 负 ΔH_f 候选成为稳定相顶点，包络不再由端点弦单独主导（EMT 下 Cu-Pt-Ni 共掺呈负 ΔH_f；
// LJ 玩具势下数值与符号可不同——定性演示档，判据机制不依赖引擎精度）。
// 运行：npm run demo:concentrations

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
console.log(`基体: ${cu.formula} (${cu.nAtoms} 原子)\n`)
console.log('浓度扫描: Cu-Pt-Ni 系，每掺杂取代位点数 1..3（6 个内点候选 + 3 端点）\n')

const t0 = Date.now()
const result = await screenRt.tools.call('workflow.screen', {
  materialId: cu.materialId,
  dopants: ['Pt', 'Ni'],
  maxDopedSites: 3,
  // 共掺变体：Cu2NiPt 落在成分三角形内部——若其能量高于包络插值则产生非退化判据；
  // 共掺负 ΔH_f（有序化）→ 直接成为稳定相顶点（机制已由测试 9 闭式验证）
  codopants: [{ elements: ['Pt', 'Ni'], sites: [0, 1] }],
})

console.log('排名  变体              成分                  ΔH_f (eV/atom)  hull 距离      判据形态')
console.log('────  ────────────────  ────────────────────  ──────────────  ─────────────  ──────────────')
result.ranked.forEach((r, i) => {
  const total = Object.values(r.composition).reduce((a, b) => a + b, 0)
  const comp = Object.entries(r.composition)
    .map(([el, n]) => `${el}${(n / total).toFixed(2)}`).join('/')
  const verdict = r.kind === 'pristine'
    ? '端点（定义在包上）'
    : Math.abs(r.energyAboveHull - Math.max(0, r.formationEnthalpy ?? 0)) < 1e-6
      ? '退化（= max(0,ΔH_f)）' : '非退化（包络插值）'
  console.log(
    `${String(i + 1).padEnd(5)}${r.label.padEnd(19)}${comp.padEnd(21)} ` +
    `${r.formationEnthalpy.toFixed(4).padStart(12)}    ` +
    `${r.energyAboveHull.toFixed(4).padStart(9)}    ` +
    verdict,
  )
})

const t = result.thermo
console.log(`\n热力学声明: level=${t.level}, mode=${t.mode}, hullDimension=${t.hullDimension ?? 'n/a'}`)
console.log(`参考态（每原子）: ${Object.entries(t.references).map(([el, e]) => `${el}=${e.toFixed(4)}`).join(', ')}`)
const cands = result.ranked.filter(r => r.kind !== 'pristine')
const nOnHull = cands.filter(r => r.energyAboveHull < 1e-9).length
const nNonDegenerate = cands.filter(r =>
  Math.abs(r.energyAboveHull - Math.max(0, r.formationEnthalpy)) > 1e-6).length
console.log(`\n判据统计: ${cands.length} 候选中 ${nOnHull} 个在包络上（稳定相候选）、${nNonDegenerate} 个非退化`)
console.log('在包络上 = 候选撑起包络（凸包变密的直接实证）；非退化 = 判据由包络插值决定，偏离 max(0, ΔH_f)')
console.log('（非退化机制的闭式对账见筛选测试 9：稳定相顶点拉低包络，距离 = 7/75）')
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)} s`)

await screenFiber.dispose()
await fiber.dispose()
