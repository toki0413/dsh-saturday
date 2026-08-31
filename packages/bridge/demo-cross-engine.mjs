// 跨引擎对照演示：异构引擎生态的泛化地基实证
// 同一条候选链（Cu + Ag 掺杂）分别经两个指纹不同的引擎回算，演示：
//   A. 筛选交付自带能量来源可追溯性（providerFingerprint/providerUnits + 参考态来源声明态）
//   B. M3 拦截：异源参考态混入凸包前显式拒绝（不静默混源）
//   C. M2 激活门禁：热切换事件携带指纹差异声明（声明"为何旧能量不再可比"）
//   D. 双引擎对照：两份交付指纹并排——能量不直接可比是诚实声明，不是缺陷
// 运行：node demo-cross-engine.mjs（依赖 Python sidecar，与 demo:screening 同款要求）

import { Context } from '@deepseek-ai/cordis'
import plugin from './src/saturday.plugin.mjs'
import screeningPlugin, { screenDopants } from '@saturday/plugin-screening'
import { PotentialRegistry } from '@saturday/core'

const ctx = new Context()
const fiber = await ctx.registry.plugin({
  name: 'saturday',
  apply: (ctx) => plugin.apply(ctx, {}),
})
const { potential } = fiber.store.saturday
const screenFiber = await ctx.registry.plugin({
  name: 'saturday-screening',
  apply: (ctx) => screeningPlugin.apply(ctx, {}),
})
const screenRt = screenFiber.store.saturdayScreening.rt

// 声明式 DFT 桩引擎：确定性固定能量（演示用；指纹如实声明为 DFT 家族）
const DFT_ENERGIES = { Cu: -14.8, Cu3Ag: -59.35 }
potential.register({
  name: 'dft-mock',
  manifest: {
    capabilities: [{ type: 'relax', accuracy: 0.95, speed: 0.3, cost: 0.9, maxAtoms: 200 }],
    constraints: {},
    eventGranularity: 'job',
    units: { energy: 'eV', length: 'Å', time: 'fs' },
    fingerprint: { software: 'dft-mock', method: 'DFT-PBE' },
  },
  relax: async (m) => ({
    jobId: `dft-${m.formula}`, engine: 'dft-mock', converged: true,
    energy: DFT_ENERGIES[m.formula] ?? -14.8 * m.nAtoms / 4, n_steps: 40,
  }),
})

const cu = await fiber.store.saturday.materialService.load('Cu')
console.log(`基体: ${cu.formula} (${cu.nAtoms} 原子)\n`)

// ── A. 声明随交付：工具层自产参考态 = 声明形态，指纹/单位投影给消费方 ──
console.log('── A. 筛选交付自带能量来源可追溯性（emt-mock 引擎）──')
const a = await screenRt.tools.call('workflow.screen', {
  materialId: cu.id, dopants: ['Ag'],
})
console.log(`providerFingerprint: ${JSON.stringify(a.providerFingerprint)}`)
console.log(`providerUnits:       ${JSON.stringify(a.providerUnits)}`)
console.log(`参考态来源:          ${a.thermo?.referenceProvenance ?? 'n/a'}（工具层自产参考态按定义同源）`)
console.log(`候选排序:            ${a.ranked.map(r => `${r.formula}(${r.energyPerAtom.toFixed(4)})`).join('  ')}\n`)

// ── B. M3 拦截：DFT 指纹的参考态混进 LJ-mock 引擎的凸包 → 显式拒绝 ──
console.log('── B. M3 门禁：异源参考态混入凸包前显式拒绝 ──')
try {
  await screenDopants({
    material: cu, dopants: ['Ag'], potential,
    references: {
      Cu: { energyPerAtom: -3.0, fingerprint: a.providerFingerprint },
      Ag: { energyPerAtom: -2.8, fingerprint: { software: 'dft-mock', method: 'DFT-PBE' } },
    },
  })
  console.log('（不应到达：M3 必须拦截）')
} catch (err) {
  console.log(`拦截成功：${err.message}\n`)
}

// ── C. M2 激活门禁：热切换事件携带指纹差异声明 ──
console.log('── C. M2 门禁：热切换事件携带指纹差异声明 ──')
const events = []
const reg = new PotentialRegistry({ on() {}, emit: async (type, ev) => events.push(ev) })
reg.register(potential.get('emt-mock'))
reg.register(potential.get('dft-mock'))
await reg.activate('emt-mock')
await reg.activate('dft-mock')
const fc = events[0].payload.fingerprintChange
console.log(`激活事件: emt-mock → dft-mock`)
console.log(`fingerprintChange: same=${fc.same}, reason="${fc.reason}"`)
console.log('（§8.2 失效传播照常沿 engine:<id> 走；差异声明让消费方知晓为何旧能量不再可比）\n')

// ── D. 双引擎对照：同候选两份交付，指纹并排，不直接可比是诚实声明 ──
console.log('── D. 双引擎对照：同候选链两份交付 ──')
const d1 = await screenDopants({ material: cu, dopants: ['Ag'], potential, engine: 'emt-mock' })
await potential.activate('dft-mock')
const d2 = await screenDopants({ material: cu, dopants: ['Ag'], potential, engine: 'dft-mock' })
console.log('引擎                 指纹                                    Cu E/atom    Cu3Ag E/atom')
console.log('───────────────────  ──────────────────────────────────────  ─────────  ────────────')
for (const d of [d1, d2]) {
  const fp = `${d.providerFingerprint.software}/${d.providerFingerprint.method}`
  const e = Object.fromEntries(d.ranked.map(r => [r.formula, r.energyPerAtom]))
  console.log(`${d.provider.padEnd(20)} ${fp.padEnd(39)} ${e.Cu.toFixed(4).padStart(9)}  ${(e.Cu3Ag ?? NaN).toFixed(4).padStart(12)}`)
}
console.log('\n诚实声明：两份能量来自不同 software/method 指纹（LJ-mock vs DFT-PBE 桩），')
console.log('数值差异不构成任何物理比较依据——跨引擎比较须调用方显式声明换算与可比性假设（M3 纪律）。')

await screenFiber.dispose()
await fiber.dispose()
