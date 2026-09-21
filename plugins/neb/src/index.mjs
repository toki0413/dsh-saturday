// @toki0413/plugin-neb —— 分析插件（契约 §4.4 analysis seam 首个实证）
// NEB 最小能量路径与势垒。编排逻辑保持纯函数（./neb.mjs），能量/梯度注入；
// 工具层提供内置玩具体系 lj-double-well：端点先 quench 到两侧极小再拉带。
// §4.4 两个冻结点：输入/输出类型声明（nebAnalysis.inputs/outputs）+
// 谱系登记（结果落 Trajectory，同时广播 saturday/analysis/complete）。

import { createCordisAdapter } from '@toki0413/kernel'
import { neb, quench, ljDoubleWell, analysisError } from './neb.mjs'
import { saddleSearch, quarticDoubleWell } from './saddle.mjs'

export { neb, quench, ljDoubleWell, analysisError } from './neb.mjs'
export { saddleSearch, quarticDoubleWell, finiteDifferenceHessian, SADDLE_DEFAULTS, QUARTIC_DOUBLE_WELL_DEFAULTS } from './saddle.mjs'

/** §4.4 AnalysisPlugin 形态：name + inputs/outputs 类型声明 + describe + run */
export const saddleAnalysis = {
  name: 'saddle-search',
  inputs: ['energy-model'],
  outputs: ['saddle-point'],
  describe() {
    return {
      description: 'QMM 鞍点搜索（沿 Hessian 最小特征向量上坡、其余方向下坡 + trust region）：'
        + '返回驻点、本征谱、index-1 核验与两侧 quench 得到的势垒。能量/梯度必须逐点可求值。',
      parameters: {
        energyModel: '能量/梯度 callable { energy(x), gradient(x), hessian?(x) }',
        start: '初值坐标（找的是离它最近的 index-1 鞍点）',
        radius: 'trust region 半径（防沿无约束通道逃向无穷）',
      },
    }
  },
  async run({ energyModel, start, radius, opts } = {}, rt) {
    if (!energyModel || typeof energyModel.energy !== 'function' || typeof energyModel.gradient !== 'function') {
      throw analysisError('ANALYSIS_INPUT_MISSING',
        'analysis.saddleSearch requires an energyModel with pointwise energy() and gradient()')
    }
    const t0 = Date.now()
    const result = saddleSearch({
      energy: energyModel.energy, gradient: energyModel.gradient,
      hessian: typeof energyModel.hessian === 'function' ? energyModel.hessian : undefined,
      start, opts: { ...(radius != null ? { radius } : {}), ...(opts ?? {}) },
    })
    if (rt?.appendTrajectory) {
      await rt.appendTrajectory({
        type: 'analysis_complete', analysis: 'saddle-search',
        converged: result.converged,
        result: {
          reason: result.reason, gradNorm: result.gradNorm, negativeCount: result.negativeCount,
          nSteps: result.nSteps, evals: result.energyGradientEvals,
          barrierForward: result.barriers?.forward ?? null,
        },
        wallSeconds: (Date.now() - t0) / 1000,
      })
    }
    if (rt?.emit) {
      await rt.emit('saturday/analysis/complete', {
        type: 'saturday/analysis/complete',
        payload: { analysis: 'saddle-search', converged: result.converged, reason: result.reason },
      })
    }
    return result
  },
}

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
        climb: '是否启用 climbing-image NEB（鞍点由 CI 像元给出，而非带内最高点）',
      },
    }
  },
  async run({ energyModel, start, end, nImages, springK, ftol, maxSteps, climb } = {}, rt) {
    // 缺输入显式报错，不静默降级（契约纪律）
    if (!energyModel || typeof energyModel.energy !== 'function' ||
        typeof energyModel.gradient !== 'function') {
      throw analysisError('ANALYSIS_INPUT_MISSING',
        'analysis.neb requires an energyModel with pointwise energy() and gradient()')
    }
    const t0 = Date.now()
    const result = neb({
      energy: energyModel.energy, gradient: energyModel.gradient,
      start, end, nImages, springK, ftol, maxSteps, climb,
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
          method: result.method,
          saddleSource: result.saddleSource,
          maxForce: result.convergence.maxForce,
          stepLimitReached: result.convergence.stepLimitReached,
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
    rt.provideService('analysis/saddle', saddleAnalysis)

    rt.registerTool({
      name: 'analysis.saddleSearch',
      description: 'QMM 鞍点搜索（不需 NEB 带、不需二阶导 callable）：方向 F_eff=−∇E+2(ĉ·∇E)ĉ，ĉ 取'
        + ' Hessian 最小特征向量（软模上坡、其余下坡），步长自适应 + 以初值为中心的 trust region。'
        + '成功需三条同时成立：‖∇E‖<gtol、恰一个负特征值（index-1）、未越出区域；收敛到极小按失败报。'
        + '内置玩具体系 lj-double-well（鞍点由对称性精确）与 quartic-double-well（鞍点、本征值、势垒全闭式）；'
        + '真实势请经编程 API 注入 callable。不承诺全局最低势垒。',
      parameters: {
        system: { type: 'string', default: 'quartic-double-well', description: "'quartic-double-well'（闭式基准）| 'lj-double-well'" },
        start: { type: 'array', items: { type: 'number' }, description: '初值坐标（quartic 为 2 维、lj 为 3 维）' },
        c: { type: 'number', default: 1, description: 'quartic-double-well 的四次系数 c（鞍点 (0,0)，势垒 1/(4c)）' },
        radius: { type: 'number', description: 'trust region 半径（省略用默认 1.5）' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        const system = args.system ?? 'quartic-double-well'
        let model, dims
        if (system === 'quartic-double-well') { model = quarticDoubleWell({ c: args.c }); dims = 2 }
        else if (system === 'lj-double-well') { model = ljDoubleWell(config.ljDoubleWell ?? {}); dims = 3 }
        else {
          throw analysisError('ANALYSIS_SYSTEM_UNKNOWN',
            `unknown saddle system "${system}" (supports: quartic-double-well, lj-double-well)`)
        }
        const start = args.start ?? (dims === 2 ? [0.4, 0.25] : [0.3, 0.1, 0])
        if (!Array.isArray(start) || start.length !== dims) {
          throw analysisError('SADDLE_BAD_INPUT', `start must have ${dims} coordinates for system "${system}"`)
        }
        const result = await saddleAnalysis.run({
          energyModel: model, start, radius: args.radius,
        }, rt)
        return {
          ...result, system,
          exactReference: model.note ?? (system === 'lj-double-well'
            ? 'lj-double-well 两侧镜像对称 ⇒ 鞍点精确在 [0,0,0]（阱底由 quench 给出，势垒可逐点求值为 oracle）' : null),
        }
      },
    })

    rt.registerTool({
      name: 'analysis.neb',
      description: 'NEB 最小能量路径与过渡态势垒。内置玩具体系 lj-double-well' +
                   '（吸附原子双位跳跃，对称双阱）：端点自动 quench 到两侧极小。' +
                   'climb=true 走 climbing-image NEB（鞍点由 CI 像元给出）。' +
                   '结果附收敛报告（maxForce/逐像元力/maxForce 历史/stepLimitReached）——' +
                   '未收敛时不把带内最高点当成已求得的过渡态。真实势请经编程 API 注入能量/梯度 callable。',
      parameters: {
        system: { type: 'string', default: 'lj-double-well', description: '玩具体系名（v0 仅支持 lj-double-well）' },
        nImages: { type: 'integer', default: 7, description: '像元总数（含端点）' },
        springK: { type: 'number', default: 1, description: '弹性带弹簧常数' },
        climb: { type: 'boolean', default: false, description: '启用 climbing-image NEB（鞍点由 CI 像元给出）' },
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
          climb: args.climb,
        }, rt)
      },
    })

    ctx.fiber.store.saturdayNeb = { rt }
  },
}
