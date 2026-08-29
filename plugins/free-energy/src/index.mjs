// @saturday/plugin-free-energy —— 热力学第二档：构型自由能曲线（契约 §9 演进）
// 给定参考结构 + 能量函数（引擎）+ 温度网格：逐网格点恒温 MD（复用 `md` 原语）
// 得 ⟨U⟩(β)，沿 β 热力学积分出构型自由能曲线。
// 锚点显式注入（第一档纪律延续：自由能零点不得静默假设为零）。
// 曲线型工作流（非变体型），不接 `workflowContract`——强套会扭曲契约形态，
// 诚实声明记录在契约文档附录 A。

import { createCordisAdapter } from '@saturday/kernel'
import { freeEnergyByIntegration, thermoError } from './free-energy.mjs'

export { freeEnergyByIntegration, thermoError, KB_EV_PER_K } from './free-energy.mjs'

export default {
  name: 'saturday-free-energy',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    rt.registerTool({
      name: 'workflow.freeEnergy',
      description: '热力学第二档：构型自由能曲线。逐温度网格点恒温 MD 得 ⟨U⟩(β)，' +
                   '沿 β 热力学积分（d(βF_conf)/dβ = ⟨U⟩），锚点显式声明。' +
                   '交付的是构型自由能（不含动量部分）；锚点以外只承诺 ΔF 的积分正确性。',
      parameters: {
        referenceId: { type: 'string', required: true, description: '参考结构材料 ID（MD 起点）' },
        temperatures: { type: 'array', required: true, description: '温度网格（K，升序，≥2 点）' },
        anchorTemperatureK: { type: 'number', required: true, description: '锚点温度（必须是网格点）' },
        anchorF0: { type: 'number', required: true, description: '锚点自由能 F₀（eV，由调用方显式声明）' },
        anchorSource: { type: 'string', description: '锚点物理来源声明（如"谐波近似"/"实验值"）' },
        engine: { type: 'string', default: 'auto', description: '能量函数（引擎名，须支持 md）' },
        mdSteps: { type: 'integer', default: 100, description: '每网格点 MD 步数' },
        dtFs: { type: 'number', default: 1, description: 'MD 时间步长（fs）' },
        sampleEvery: { type: 'integer', default: 5, description: 'MD 能量采样间隔（步）' },
        seed: { type: 'integer', default: 1, description: 'MD 随机种子（确定性复现）' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        // 服务依赖在调用时解析：缺依赖显式报错，不静默降级（契约 §2）
        const materialService = rt.getService('material')
        const potential = rt.getService('potential')
        if (!materialService || !potential) {
          throw thermoError('THERMO_INVALID_INPUT',
            'workflow.freeEnergy requires services "material" and "potential" ' +
            '(mount the saturday core plugin first)')
        }
        const reference = await materialService.get(args.referenceId)
        const mdProvider = potential.resolveProvider(
          { engine: args.engine },
          { type: 'md', nAtoms: reference.nAtoms, profile: 'validation' },
        )

        // 逐网格点恒温 MD（种子确定性）：势能轨迹是积分的唯一数据源
        const temperatures = args.temperatures ?? []
        const potentialEnergies = []
        const mdJobIds = []
        for (const t of temperatures) {
          const mdResult = await mdProvider.md(reference, {
            temperature_K: t,
            steps: args.mdSteps ?? 100,
            dt_fs: args.dtFs ?? 1,
            sample_every: args.sampleEvery ?? 5,
            seed: args.seed,
          })
          potentialEnergies.push(mdResult.energies)
          mdJobIds.push(mdResult.jobId)
        }

        const result = freeEnergyByIntegration({
          temperaturesK: temperatures,
          potentialEnergies,
          anchor: { temperatureK: args.anchorTemperatureK, F0: args.anchorF0 },
          anchorSource: args.anchorSource,
        })

        // 分析结果落 Trajectory（薄载荷：引用 + 标量锚点与端点 ΔF）
        const endpoint = result.curve[result.curve.length - 1]
        await rt.emit?.('saturday/analysis/complete', {
          type: 'saturday/analysis/complete',
          payload: {
            analysis: 'free-energy',
            material: { id: reference.id, formula: reference.formula },
            engine: mdProvider.name,
            nGrid: temperatures.length,
            anchor: { temperatureK: args.anchorTemperatureK, F0: args.anchorF0 },
            endpointDF: endpoint.dF,
          },
        })

        return {
          reference: reference.formula,
          engine: mdProvider.name,
          mdJobIds,
          ...result,
        }
      },
    })

    ctx.fiber.store.saturdayFreeEnergy = { rt }
  },
}
