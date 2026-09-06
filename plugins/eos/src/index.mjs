// @toki0413/plugin-eos —— 分析插件（契约 §4.4 analysis seam 第二个实证）
// Birch-Murnaghan 状态方程拟合。拟合逻辑保持纯函数（./eos.mjs）；
// 数据面两条路：显式 (V, E) 序列，或经 material/potential 服务按缩放体积
// 做静态单点（calculate，非弛豫——E(V) 曲线的标准取数法）自产序列。
// §4.4 两个冻结点：输入/输出类型声明（eosAnalysis.inputs/outputs）+
// 谱系登记（结果落 Trajectory，同时广播 saturday/analysis/complete）。

import { createCordisAdapter } from '@toki0413/kernel'
import { Material } from '@toki0413/core'
import { fitBirchMurnaghan, cellVolume, analysisError } from './eos.mjs'

export { fitBirchMurnaghan, birchMurnaghan, cellVolume, analysisError, EV_PER_A3_TO_GPA } from './eos.mjs'

export const DEFAULT_SCALES = [0.94, 0.97, 1.0, 1.03, 1.06]

/**
 * 晶胞均匀缩放变体：返回新 Material（不可变 fork 语义，§6），
 * 分数坐标不变（笛卡尔位置随晶胞同因子缩放），谱系登记 'cell-scaled'。
 */
export function scaledVariant(material, scale) {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw analysisError('EOS_BAD_SCALE', `scale must be a positive finite number; got ${scale}`)
  }
  const graph = structuredClone(material.graph)
  graph.cell = graph.cell.map(row => row.map(x => x * scale))
  graph.nodes = graph.nodes.map(n => ({ ...n, position: n.position.map(x => x * scale) }))
  return new Material(
    {
      modalities: { graph, formula: material.formula },
      lineage: [
        ...material.lineage,
        { operation: 'cell-scaled', detail: { parent: material.id, scale }, timestamp: Date.now() },
      ],
    },
    graph,
  )
}

/** §4.4 AnalysisPlugin 形态：name + inputs/outputs 类型声明 + describe + run */
export const eosAnalysis = {
  name: 'eos',
  inputs: ['ev-series'],
  outputs: ['equation-of-state'],
  describe() {
    return {
      description: 'Birch-Murnaghan（三阶）状态方程拟合：由 (V, E) 序列给出 ' +
                   'E0 / V0 / B0 / B0′ 与体积模量（GPa）。序列应为固定体积的静态单点能量。',
      parameters: {
        series: 'Array<{ volume: Å³, energy: eV }>，至少 4 点',
        B0p0: 'B0′ 初值（数字，默认 4）',
      },
    }
  },
  async run({ series, B0p0 } = {}, rt) {
    if (!Array.isArray(series)) {
      throw analysisError('ANALYSIS_INPUT_MISSING',
        'analysis.eos requires a series of { volume, energy } points (ev-series)')
    }
    const t0 = Date.now()
    const result = fitBirchMurnaghan(series, B0p0 === undefined ? {} : { B0p0 })
    // 谱系登记：分析结果也是事实，落 append-only Trajectory（§4.4 冻结点）
    if (rt?.appendTrajectory) {
      await rt.appendTrajectory({
        type: 'analysis_complete',
        analysis: 'eos',
        converged: result.converged,
        result: {
          E0: result.params.E0,
          V0: result.params.V0,
          B0GPa: result.B0GPa,
          B0p: result.params.B0p,
          rmse: result.rmse,
          r2: result.r2,
          nPoints: result.nPoints,
        },
        wallSeconds: (Date.now() - t0) / 1000,
      })
    }
    if (rt?.emit) {
      await rt.emit('saturday/analysis/complete', {
        type: 'saturday/analysis/complete',
        payload: {
          analysis: 'eos',
          converged: result.converged,
          V0: result.params.V0,
          B0GPa: result.B0GPa,
        },
      })
    }
    return result
  },
}

export default {
  name: 'saturday-eos',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    rt.provideService('analysis/eos', eosAnalysis)

    rt.registerTool({
      name: 'analysis.eos',
      description: 'Birch-Murnaghan 状态方程拟合。两条数据路：' +
                   '(1) 显式传 series=[{volume,energy}]；' +
                   '(2) 传 materialId，按 scales 对各缩放体积做静态单点自产序列' +
                   '（需要 material / potential 服务）。',
      parameters: {
        materialId: { type: 'string', description: '材料 ID（数据路 2）' },
        scales: {
          type: 'array',
          items: { type: 'number' },
          description: '体积缩放因子列表，默认 [0.94, 0.97, 1.0, 1.03, 1.06]',
        },
        engine: { type: 'string', default: 'auto' },
        series: {
          type: 'array',
          items: { type: 'object' },
          description: '显式 (V, E) 序列（数据路 1），每项 { volume, energy }',
        },
        B0p0: {
          type: 'number',
          default: 4,
          description: 'B0′ 初值（常见区间 4–6）',
        },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        let series = args.series
        if (!series) {
          if (!args.materialId) {
            throw analysisError('ANALYSIS_INPUT_MISSING',
              'analysis.eos requires either a series or materialId ' +
              '(with services "material" and "potential" mounted)')
          }
          // 服务依赖在调用时解析：缺依赖显式报错，不静默降级（契约 §2）
          const materialService = rt.getService('material')
          const potential = rt.getService('potential')
          if (!materialService || !potential) {
            throw analysisError('ANALYSIS_INPUT_MISSING',
              'analysis.eos with materialId requires services "material" and "potential" ' +
              '(mount the saturday core plugin first)')
          }
          const material = await materialService.get(args.materialId)
          const provider = potential.resolveProvider(
            { engine: args.engine },
            { type: 'calculate', nAtoms: material.nAtoms },
          )
          series = []
          for (const scale of args.scales ?? DEFAULT_SCALES) {
            const variant = scaledVariant(material, scale)
            const r = await provider.calculate(variant)
            if (!Number.isFinite(r?.energy)) {
              throw analysisError('EOS_BAD_POINT',
                `engine "${provider.name}" returned non-finite energy at scale ${scale}`)
            }
            series.push({ volume: cellVolume(variant.cell), energy: r.energy, scale })
          }
        }
        return eosAnalysis.run({ series, B0p0: args.B0p0 }, rt)
      },
    })

    ctx.fiber.store.saturdayEos = { rt }
  },
}
