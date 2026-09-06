// @toki0413/plugin-neb —— 分析插件（契约 §4.4 analysis seam 首个实证）
// NEB 最小能量路径与势垒。编排逻辑保持纯函数（./neb.mjs），能量/梯度注入；
// 工具层提供内置玩具体系 lj-double-well：端点先 quench 到两侧极小再拉带。
// §4.4 两个冻结点：输入/输出类型声明（nebAnalysis.inputs/outputs）+
// 谱系登记（结果落 Trajectory，同时广播 saturday/analysis/complete）。

import { createCordisAdapter } from '@toki0413/kernel'
import { neb, quench, ljDoubleWell, analysisError } from './neb.mjs'

export { neb, quench, ljDoubleWell, analysisError } from './neb.mjs'

/** §4.4 AnalysisPlugin 形态：name + inputs/outputs 类型声明 + describe + run */
export const nebAnalysis = {
  name: 'neb',
  inputs: ['energy-model'],
  outputs: ['minimum-energy-path'],
  describe() {
    return {
      description: 'Nudged Elastic Band：在能量函数的两个极小之间求最小能量路径，' +
                   '估计过渡态位置与正反向势垒。能量/梯度必须是逐点可求值调用。',
      parameters: {
        energyModel: '能量/梯度 callable { energy(x), gradient(x) }',
        start: '起点坐标（固定端点，应为极小点）',
        end: '终点坐标（固定端点，应为极小点）',
        nImages: '像元总数（含端点，整数 >= 3）',
        springK: '弹性带弹簧常数',
        ftol: '力收敛阈值',
        maxSteps: '最大优化步数',
      },
    }
  },
  async run({ energyModel, start, end, nImages, springK, ftol, maxSteps } = {}, rt) {
    // 缺输入显式报错，不静默降级（契约纪律）
    if (!energyModel || typeof energyModel.energy !== 'function' ||
        typeof energyModel.gradient !== 'function') {
      throw analysisError('ANALYSIS_INPUT_MISSING',
        'analysis.neb requires an energyModel with pointwise energy() and gradient()')
    }
    const t0 = Date.now()
    const result = neb({
      energy: energyModel.energy, gradient: energyModel.gradient,
      start, end, nImages, springK, ftol, maxSteps,
    })
    // 谱系登记：分析结果也是事实，落 append-only Trajectory（§4.4 冻结点）
    if (rt?.appendTrajectory) {
      await rt.appendTrajectory({
        type: 'analysis_complete',
        analysis: 'neb',
        converged: result.converged,
        result: {
          barrierForward: result.barrierForward,
          barrierReverse: result.barrierReverse,
          nSteps: result.nSteps,
          nImages: result.nImages,
        },
        wallSeconds: (Date.now() - t0) / 1000,
      })
    }
    if (rt?.emit) {
      await rt.emit('saturday/analysis/complete', {
        type: 'saturday/analysis/complete',
        payload: {
          analysis: 'neb',
          converged: result.converged,
          barrierForward: result.barrierForward,
          barrierReverse: result.barrierReverse,
        },
      })
    }
    return result
  },
}

export default {
  name: 'saturday-neb',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    rt.provideService('analysis/neb', nebAnalysis)

    rt.registerTool({
      name: 'analysis.neb',
      description: 'NEB 最小能量路径与过渡态势垒。内置玩具体系 lj-double-well' +
                   '（吸附原子双位跳跃，对称双阱）：端点自动 quench 到两侧极小。' +
                   '真实势请经编程 API 注入能量/梯度 callable。',
      parameters: {
        system: { type: 'string', default: 'lj-double-well', description: '玩具体系名（v0 仅支持 lj-double-well）' },
        nImages: { type: 'integer', default: 7, description: '像元总数（含端点）' },
        springK: { type: 'number', default: 1, description: '弹性带弹簧常数' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        const system = args.system ?? 'lj-double-well'
        if (system !== 'lj-double-well') {
          throw analysisError('ANALYSIS_SYSTEM_UNKNOWN',
            `unknown analysis system "${system}" (v0 supports: lj-double-well)`)
        }
        const model = ljDoubleWell(config.ljDoubleWell ?? {})
        // NEB 端点应为极小点：两侧初猜先 quench；不收敛显式报错，不猜
        const left = quench({ x0: model.wellGuesses[0], energy: model.energy, gradient: model.gradient })
        const right = quench({ x0: model.wellGuesses[1], energy: model.energy, gradient: model.gradient })
        if (!left.converged || !right.converged) {
          throw analysisError('ANALYSIS_QUENCH_FAILED',
            'endpoint quench did not converge; NEB band cannot be constructed')
        }
        return nebAnalysis.run({
          energyModel: model,
          start: left.x,
          end: right.x,
          nImages: args.nImages,
          springK: args.springK,
        }, rt)
      },
    })

    ctx.fiber.store.saturdayNeb = { rt }
  },
}
