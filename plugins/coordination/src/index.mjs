// @toki0413/plugin-coordination —— 分析插件（契约 §4.4 analysis seam）：局域配位与短程有序。
// 仅需 material 服务（引擎无关、零外部依赖、任何环境可跑；形态同 plugin-xrd）。
// 计算逻辑保持纯函数（./coordination.mjs）；§4.4 冻结点：inputs/outputs 类型声明 +
// 谱系登记（结果落 Trajectory，同时广播 saturday/analysis/complete）。
// 诚实边界随交付呈现：CN 依赖截断半径（双定义并存 + 模糊邻居计数）、α 的随机参照含有限
// 尺寸校正（小组胞有序下限到不了 −1）、非周期体系不与体相对照——见纯层 declaration。

import { createCordisAdapter } from '@toki0413/kernel'
import { coordinationAnalysis, coordError } from './coordination.mjs'

export { coordinationAnalysis, neighborPairs, autoCutoff, isPeriodic, coordError } from './coordination.mjs'

/** §4.4 AnalysisPlugin 形态：name + inputs/outputs 类型声明 + describe + run */
export const coordinationAnalysisPlugin = {
  name: 'coordination',
  inputs: ['material-structure'],
  outputs: ['local-coordination-analysis'],
  describe() {
    return {
      description: '局域配位与短程有序：逐原子配位数、分种对键长分布、Warren–Cowley 短程有序参数 α。' +
        '纯几何（不碰引擎），截断半径与 α 的随机参照两处约定随交付显式声明。',
      parameters: {
        graph: 'Saturday AtomGraph（cell 行矢量 Å、nodes[].number/position 笛卡尔、可选 pbc）',
        rCut: '邻居截断半径（Å）；省略则走自动壳层间隙判据',
      },
    }
  },
  async run({ graph, rCut } = {}, rt) {
    const t0 = Date.now()
    const result = coordinationAnalysis(graph, { rCut })
    if (rt?.appendTrajectory) {
      await rt.appendTrajectory({
        type: 'analysis_complete', analysis: 'coordination',
        result: {
          nAtoms: result.nAtoms, periodic: result.periodic, method: result.method,
          rCut: result.rCut, cnMean: result.cnStats?.mean ?? null,
          cnMin: result.cnStats?.min ?? null, cnMax: result.cnStats?.max ?? null,
          totalBonds: result.totalBonds,
          alphaSummary: result.warrenCowley.map(w => `${w.pair}=${w.alpha == null ? 'n/a' : w.alpha.toFixed(3)}`).join(' '),
        },
        wallSeconds: (Date.now() - t0) / 1000,
      })
    }
    if (rt?.emit) {
      await rt.emit('saturday/analysis/complete', {
        type: 'saturday/analysis/complete',
        payload: { analysis: 'coordination', nAtoms: result.nAtoms, method: result.method },
      })
    }
    return result
  },
}

export default {
  name: 'saturday-coordination',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    rt.provideService('analysis/coordination', coordinationAnalysisPlugin)

    rt.registerTool({
      name: 'analysis.coordination',
      description: '局域配位与短程有序分析。传 materialId（可选 rCut）：逐原子配位数 + 最近/平均邻居距离、'
        + '分种对（A–A/A–B/B–B）键长分布、Warren–Cowley 短程有序参数 α（+1=相分离富聚，负=有序交替，'
        + '0=与随机参照无偏离）。纯几何、不碰引擎，任何环境可跑（含分子/非周期体系）。'
        + 'rCut 省略时走自动壳层间隙判据（理想 fcc/bcc/金刚石/岩盐给 12/8/4/6）；CN 依赖截断半径这一'
        + '二义性以 method/rCut/ambiguous 计数随交付显式声明，不冒充唯一定义。',
      parameters: {
        materialId: { type: 'string', required: true, description: '材料 ID' },
        rCut: { type: 'number', description: '邻居截断半径（Å，省略=自动壳层间隙）' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        const materialService = rt.getService('material')
        if (!args.materialId || !materialService) {
          throw coordError('ANALYSIS_INPUT_MISSING',
            'analysis.coordination requires materialId with service "material" (mount the saturday core plugin first)')
        }
        const material = await materialService.get(args.materialId)
        const result = await coordinationAnalysisPlugin.run({ graph: material.graph, rCut: args.rCut }, rt)
        return { ...result, materialId: material.id, formula: material.formula }
      },
    })

    ctx.fiber.store.saturdayCoordination = { rt }
  },
}
