// 构型自由能曲线演示（热力学第二档）：
// Cu 原胞 + 真实 ASE 引擎（EMT 计算器 / Langevin 恒温 MD）→ 逐温度网格点恒温 MD 得 ⟨U⟩(β)
// → 沿 β 热力学积分出构型自由能曲线。
// 锚点物理化：anchorMode='harmonic' → 引擎 harmonic 原语（弛豫+有限差分 Hessian
// 简正模）+ 量子谐振子闭式给出 F₀；经典 TI 采样与量子锚点混合为声明的近似。
// 运行：npm run demo:freeenergy

import { Context } from '@deepseek-ai/cordis'
import plugin from './src/saturday.plugin.mjs'
import asePlugin from '@saturday/plugin-ase'
import freeEnergyPlugin from '@saturday/plugin-free-energy'

const ctx = new Context()
const fiber = await ctx.registry.plugin({
  name: 'saturday',
  apply: (ctx) => plugin.apply(ctx, {}),
})
const { rt, potential } = fiber.store.saturday

// 真实 ASE 引擎（EMT 计算器，声明 md 能力）：自由能积分的逐网格点恒温 MD 由它提供；
// 核心插件的 emt-mock 只声明 relax，路由自动选 ase 引擎（契约 §4.1 能力路由）
const aseFiber = await ctx.registry.plugin({
  name: 'saturday-ase',
  apply: (ctx) => asePlugin.apply(ctx, { calculator: 'emt' }),
})

// 工作流插件独立挂载（契约 §4.3）：与核心插件同一 Context 组合
const feFiber = await ctx.registry.plugin({
  name: 'saturday-free-energy',
  apply: (ctx) => freeEnergyPlugin.apply(ctx, {}),
})
const feRt = feFiber.store.saturdayFreeEnergy.rt

const provider = potential.get('emt-mock')
console.log(`sidecar 后端: ${JSON.stringify(provider.bridge.sidecarInfo.calculators)}\n`)

const cu = await rt.tools.call('material.load', { query: 'Cu' })
console.log(`参考结构: ${cu.formula} (${cu.nAtoms} 原子, id=${cu.materialId.slice(0, 8)}…)`)
console.log('温度网格: 300 / 600 K（锚点 300 K，谐波近似物理化；逐点 200 步恒温 MD）\n')

const t0 = Date.now()
const result = await feRt.tools.call('workflow.freeEnergy', {
  referenceId: cu.materialId,
  temperatures: [300, 600],
  anchorTemperatureK: 300,
  anchorMode: 'harmonic',
  mdSteps: 200,
  dtFs: 1,
  sampleEvery: 5,
  seed: 42,
})

const hd = result.harmonicDetail
console.log(`谐波锚点: u0=${hd.u0EV.toFixed(5)} eV，实模 ${hd.nModes} 个` +
            `（平动零模 ${hd.zeroModes} 不计入），零点能 ${hd.zeroPointEnergyEV.toFixed(5)} eV`)
console.log(`频率范围: 省略——见交付；锚点 F0 = ${result.anchor.F0.toFixed(5)} eV\n`)

console.log('T (K)   ⟨U⟩ (eV/atom)      SEM          F (eV/atom)    ΔF vs 锚点')
console.log('─────   ──────────────     ──────────   ─────────────  ──────────')
for (const p of result.curve) {
  console.log(
    `${String(p.temperatureK).padEnd(7)} ` +
    `${p.meanU.toFixed(5).padStart(13)}      ` +
    `${p.sem.toExponential(2).padStart(9)}    ` +
    `${p.F.toFixed(5).padStart(12)}   ` +
    `${(p.dF >= 0 ? '+' : '') + p.dF.toFixed(5)}`,
  )
}
console.log(`\n引擎: ${result.engine}；方法: ${result.method}；量: ${result.quantity}`)
console.log(`锚点声明: ${result.anchor.source}`)
console.log(`MD 任务: ${result.mdJobIds.length} 个（逐网格点一条，确定性种子 42）`)
console.log(`注: ${result.note}`)
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)} s`)
console.log('分析事件已发布（saturday/analysis/complete，薄载荷）')

await feFiber.dispose()
await aseFiber.dispose()
await fiber.dispose()
