// @toki0413/plugin-xrd —— 分析插件（契约 §4.4 analysis seam）：X 射线粉末衍射谱。
// 纯几何：几何结构因子 F(hkl) + 倒格度规 d-spacing + Bragg 2θ + 系统消光。
// 仅需 material 服务（引擎无关、零外部依赖、任何环境可跑——比声子/弹性更普适）。
// 计算逻辑保持纯函数（./xrd.mjs）；§4.4 冻结点：inputs/outputs 类型声明 +
// 谱系登记（结果落 Trajectory，同时广播 saturday/analysis/complete）。
// 诚实边界随交付呈现：峰位/消光精确，强度为 |F|² 相对值（f≈Z，未含 LP/温度/织构因子）。

import { createCordisAdapter } from '@toki0413/kernel'
import { powderPeaks, xrdError, CU_KA_A } from './xrd.mjs'
import { identifyPhase } from './phase-match.mjs'

export { powderPeaks, structureFactor, dSpacing, toFractional, realMetric, reciprocalMetric, braggTheta, xrdError, CU_KA_A } from './xrd.mjs'
export { identifyPhase, matchPattern, normalizePeaks } from './phase-match.mjs'

/** §4.4 AnalysisPlugin 形态：name + inputs/outputs 类型声明 + describe + run */
export const xrdAnalysis = {
  name: 'xrd',
  inputs: ['material-structure'],
  outputs: ['powder-diffraction-pattern'],
  describe() {
    return {
      description: 'X 射线粉末衍射谱（运动学、单色）：由材料结构给出各反射的 d(hkl)、Bragg 2θ、' +
        '相对强度 |F|² 与系统消光。峰位/消光精确；强度为 f≈Z 前向近似下的相对值（未校准）。',
      parameters: {
        graph: 'Saturday AtomGraph（cell 行矢量 Å、nodes[].number/position 笛卡尔）',
        lambdaA: 'X 射线波长（Å，默认 Cu Kα 1.54056）',
        hmax: 'Miller 指数枚举上限（默认 6）',
        twoThetaMaxDeg: '2θ 上限（度，默认 120）',
      },
    }
  },
  async run({ graph, lambdaA, hmax, twoThetaMaxDeg } = {}, rt) {
    if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
      throw xrdError('XRD_BAD_GRAPH', 'analysis.xrd requires a material graph with nodes (material-structure input)')
    }
    const t0 = Date.now()
    const result = powderPeaks(graph, { lambdaA, hmax, twoThetaMaxDeg })
    if (rt?.appendTrajectory) {
      await rt.appendTrajectory({
        type: 'analysis_complete', analysis: 'xrd',
        result: {
          nPeaks: result.peaks.length,
          radiation: result.radiation.label,
          firstTwoThetaDeg: result.peaks[0]?.twoThetaDeg ?? null,
          lambdaA: result.radiation.lambdaA,
        },
        wallSeconds: (Date.now() - t0) / 1000,
      })
    }
    if (rt?.emit) {
      await rt.emit('saturday/analysis/complete', {
        type: 'saturday/analysis/complete',
        payload: { analysis: 'xrd', nPeaks: result.peaks.length },
      })
    }
    return result
  },
}

export default {
  name: 'saturday-xrd',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    rt.provideService('analysis/xrd', xrdAnalysis)

    rt.registerTool({
      name: 'analysis.xrd',
      description: 'X 射线粉末衍射谱。传 materialId，纯几何计算各反射 d(hkl)/Bragg 2θ/相对强度 |F|² 与系统消光' +
        '（仅需 material 服务，引擎无关、任何环境可跑）。峰位/消光精确；强度为 f≈Z 前向近似的相对值' +
        '（未含 Lorentz-偏振/温度/吸收/织构因子，非实验定量强度，随交付声明）。',
      parameters: {
        materialId: { type: 'string', description: '材料 ID' },
        lambdaA: { type: 'number', default: CU_KA_A, description: 'X 射线波长（Å，默认 Cu Kα）' },
        hmax: { type: 'integer', default: 6, description: 'Miller 指数枚举上限' },
        twoThetaMaxDeg: { type: 'number', default: 120, description: '2θ 采集上限（度）' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        const materialService = rt.getService('material')
        if (!args.materialId || !materialService) {
          throw xrdError('ANALYSIS_INPUT_MISSING',
            'analysis.xrd requires materialId with service "material" (mount the saturday core plugin first)')
        }
        const material = await materialService.get(args.materialId)
        return xrdAnalysis.run({
          graph: material.graph,
          lambdaA: args.lambdaA, hmax: args.hmax, twoThetaMaxDeg: args.twoThetaMaxDeg,
        }, rt)
      },
    })

    rt.registerTool({
      name: 'analysis.xrd.phaseIdentify',
      description: 'XRD 相鉴定：给实测粉末峰（measuredPeaks=[{twoTheta,intensity}]）与一组候选材料 ID，'
        + '各自算理论粉末峰后做几何峰位加权匹配（recall+precision 对称、相对强度归一、弱峰阈值过滤、'
        + '角容差 tolDeg），按 score 降序排。非 Rietveld 全谱精修、不含择优取向/织构/峰形拟合。'
        + '需 material 服务。',
      parameters: {
        measuredPeaks: { type: 'array', items: { type: 'object' }, description: '实测峰 [{twoTheta,intensity}]' },
        candidateIds: { type: 'array', items: { type: 'string' }, description: '候选材料 ID 列表' },
        tolDeg: { type: 'number', default: 0.5, description: '峰位角容差（度）' },
        minRelativeIntensity: { type: 'number', default: 0.2, description: '弱峰过滤阈值（相对最强峰）' },
        lambdaA: { type: 'number', default: CU_KA_A, description: '候选理论峰波长' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        const materialService = rt.getService('material')
        if (!Array.isArray(args.measuredPeaks) || !Array.isArray(args.candidateIds) || args.candidateIds.length === 0 || !materialService) {
          throw xrdError('ANALYSIS_INPUT_MISSING',
            'analysis.xrd.phaseIdentify requires measuredPeaks + non-empty candidateIds with service "material"')
        }
        const candidates = []
        for (const id of args.candidateIds) {
          const m = await materialService.get(id)
          const pat = powderPeaks(m.graph, { lambdaA: args.lambdaA, twoThetaMaxDeg: 150 })
          candidates.push({ id, label: m.formula, peaks: pat.peaks.map(p => ({ twoTheta: p.twoThetaDeg, intensity: p.intensityRel })) })
        }
        const result = identifyPhase({
          measuredPeaks: args.measuredPeaks, candidates,
          tolDeg: args.tolDeg, minRelativeIntensity: args.minRelativeIntensity,
        })
        await rt.appendTrajectory?.({
          type: 'analysis_complete', analysis: 'xrd-phase-identify',
          result: { best: result.best, nCandidates: candidates.length, topScore: result.ranked[0]?.score ?? null, tolDeg: result.params.tolDeg },
        })
        await rt.emit?.('saturday/analysis/complete', { type: 'saturday/analysis/complete', payload: { analysis: 'xrd-phase-identify', best: result.best } })
        return result
      },
    })

    ctx.fiber.store.saturdayXrd = { rt }
  },
}
