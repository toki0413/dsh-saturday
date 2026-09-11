// @toki0413/plugin-elasticity —— 弹性张量分析插件（analysis seam 第三个实证，继 phonon/eos）
// 工具 analysis.elasticity：6 种 Voigt 应变 ± 中心差分（12 次引擎 calculate）→ 完整 C_ij 6×6
// → VRH 多晶 K/G/E/ν + Born 正定判据 + 各向异性因子 A。
// 应力源门禁：引擎必须声明 calculate 的 properties 含 stress——无应力即显式
// ELASTICITY_STRESS_MISSING，绝不退化为能量二阶差分等近似（诚实纪律，同 phonon 的
// PHONON_FORCE_MISSING 家族）。编排逻辑在纯函数层（./elasticity.mjs）。

import { createCordisAdapter } from '@toki0413/kernel'
import { Material } from '@toki0413/core'
import { elasticStiffness, elasticityError, EV_PER_A3_TO_GPA } from './elasticity.mjs'

export { elasticStiffness, elasticityError, EV_PER_A3_TO_GPA, strainedGraph, assembleStiffness, deriveModuli, jacobiEigenvalues } from './elasticity.mjs'

export default {
  name: 'saturday-elasticity',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    rt.registerTool({
      name: 'analysis.elasticity',
      description: '完整 6×6 弹性刚度张量（Voigt）：6 种独立应变 ± 中心差分共 12 次引擎应力计算，' +
                   'C_ij=∂σ_i/∂ε_j（拉正约定）；派生 VRH 多晶 K/G/E/ν、Born 正定稳定性判据、' +
                   '立方各向异性因子 A=2C44/(C11−C12)。引擎必须声明 calculate+stress 能力' +
                   '（当前：MACE 常驻 batch 档；EMT/LJ 无应力输出即显式拒绝，不做近似替代）。' +
                   '仿射应变无内部弛豫：适用于高对称/单质体系，一般结构声明边界。' +
                   '单位：C 原生 eV/Å³，GPa 换算随交付显式声明。',
      parameters: {
        materialId: { type: 'string', required: true, description: '材料 ID（须为平衡附近结构）' },
        engine: { type: 'string', default: 'auto', description: '应力源引擎（须声明 calculate 的 stress 性质）' },
        eps: { type: 'number', default: 0.005, description: '应变幅值（线性响应有效域 (0,0.05)）' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        const materialService = rt.getService('material')
        const potential = rt.getService('potential')
        if (!materialService || !potential) {
          throw elasticityError('ANALYSIS_INPUT_MISSING',
            'analysis.elasticity requires services "material" and "potential" (mount the saturday core plugin first)')
        }
        const material = await materialService.get(args.materialId)
        const provider = potential.resolveProvider(
          { engine: args.engine },
          { type: 'calculate', nAtoms: material.nAtoms, profile: 'validation' },
        )
        // 应力源门禁：能力声明里必须有 calculate + stress（无声明即拒绝，不静默近似）
        const calcCap = (provider.manifest?.capabilities ?? []).find(c => c.type === 'calculate')
        if (!calcCap || !Array.isArray(calcCap.properties) || !calcCap.properties.includes('stress')) {
          throw elasticityError('ELASTICITY_STRESS_MISSING',
            `engine "${provider.name}" does not declare calculate+stress; elasticity requires a stress-providing engine (never approximated from energy differences silently)`)
        }
        const calculateStress = async (graph) => {
          const variant = new Material(
            { modalities: { graph, formula: material.formula } }, graph,
          )
          const r = await provider.calculate(variant, { properties: ['stress'] })
          if (!Array.isArray(r?.stress) || r.stress.length !== 6) {
            throw elasticityError('ELASTICITY_STRESS_MISSING',
              `engine "${provider.name}" returned no 6-component Voigt stress`)
          }
          return r.stress
        }
        const result = await elasticStiffness({ graph: material.graph, calculateStress, eps: args.eps })
        return {
          ...result,
          units: { stiffness: 'eV/Å³', gpaConversion: `1 eV/Å³ = ${EV_PER_A3_TO_GPA} GPa (CODATA-derived, explicit)` },
          engine: provider.name,
          formula: material.formula,
          note: 'C_ij 由 ±ε 中心差分（12 次引擎应力计算，拉正约定）；Born 判据=C 正定（Jacobi 特征值，自带实现）；' +
                '仿射应变不含内部弛豫（高对称/单质精确，一般结构声明边界）；' +
                '多晶 K/G 为 VRH 均值，单晶各向异性看 A 与特征值谱',
        }
      },
    })

    ctx.fiber.store.saturdayElasticity = { rt }
  },
}
