// @saturday/plugin-free-energy —— 热力学第二档：构型自由能曲线（契约 §9 演进）
// 给定参考结构 + 能量函数（引擎）+ 温度网格：逐网格点恒温 MD（复用 `md` 原语）
// 得 ⟨U⟩(β)，沿 β 热力学积分出构型自由能曲线。
// 锚点显式注入（第一档纪律延续：自由能零点不得静默假设为零）。
// 曲线型工作流（非变体型），不接 `workflowContract`——强套会扭曲契约形态，
// 诚实声明记录在契约文档附录 A。

import { createCordisAdapter } from '@saturday/kernel'
import { freeEnergyByIntegration, harmonicVibrationalFreeEnergy, thermoError } from './free-energy.mjs'

export { freeEnergyByIntegration, harmonicVibrationalFreeEnergy, thermoError, KB_EV_PER_K, H_EV_S } from './free-energy.mjs'

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
        anchorMode: {
          type: 'string', default: 'explicit',
          description: '锚点模式：explicit = 调用方显式声明 anchorF0；' +
                       'harmonic = 引擎 harmonic 原语计算（弛豫+Hessian 简正模，量子谐振子闭式）',
        },
        anchorF0: { type: 'number', description: '锚点自由能 F₀（eV；anchorMode=explicit 时必填）' },
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

        // 锚点解析：explicit 由调用方声明；harmonic 由引擎原语计算（锚点物理化）。
        // 两种模式同一纪律：零点来源显式记录进交付，绝不静默假设为零。
        let anchorF0 = args.anchorF0
        let anchorSource = args.anchorSource
        let harmonicDetail
        if ((args.anchorMode ?? 'explicit') === 'harmonic') {
          if (typeof mdProvider.harmonic !== 'function') {
            throw thermoError('THERMO_INVALID_INPUT',
              `engine ${mdProvider.name} does not declare the "harmonic" primitive; ` +
              'declare the anchor explicitly instead of assuming one')
          }
          const hres = await mdProvider.harmonic(reference, {})
          if (hres.imaginary_modes > 0) {
            throw thermoError('THERMO_REFERENCE_MISSING',
              `harmonic anchor refused: ${hres.imaginary_modes} imaginary mode(s) — ` +
              'the relaxed point is a saddle, not a minimum; declare the anchor honestly instead')
          }
          const vib = harmonicVibrationalFreeEnergy({
            frequenciesTHz: hres.frequencies_thz,
            temperatureK: args.anchorTemperatureK,
          })
          anchorF0 = hres.u0_eV + vib.vibrationalFreeEnergyEV
          harmonicDetail = {
            u0EV: hres.u0_eV, ...vib,
            zeroModes: hres.zero_modes ?? 0,   // 平动零模不进振动闭式（如实声明）
            imaginaryModes: hres.imaginary_modes,
          }
          anchorSource = `谐波近似：弛豫平衡点 + 有限差分 Hessian 简正模（${vib.nModes} 实模，` +
                         `${hres.zero_modes ?? 0} 平动零模不计入）+ 量子谐振子闭式；` +
                         '经典 TI 采样与量子锚点混合为声明的近似'
        } else if (!Number.isFinite(anchorF0)) {
          throw thermoError('THERMO_REFERENCE_MISSING',
            'anchorF0 is required when anchorMode=explicit: the free-energy zero must be declared')
        }

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
          anchor: { temperatureK: args.anchorTemperatureK, F0: anchorF0 },
          anchorSource,
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
            anchor: { temperatureK: args.anchorTemperatureK, F0: anchorF0 },
            anchorMode: args.anchorMode ?? 'explicit',
            endpointDF: endpoint.dF,
          },
        })

        return {
          reference: reference.formula,
          engine: mdProvider.name,
          mdJobIds,
          ...(harmonicDetail ? { harmonicDetail } : {}),
          ...result,
        }
      },
    })

    ctx.fiber.store.saturdayFreeEnergy = { rt }
  },
}
