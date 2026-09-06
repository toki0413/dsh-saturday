// @toki0413/plugin-phonon —— 分析插件（契约 §4.4 analysis seam，力注入式）
// Γ 点声子：有限位移 → 力常数 → 声学和规则 → 质量加权动力学矩阵 → 频率/虚频/稳定性。
// 纯函数逻辑在 ./phonon.mjs（不触碰引擎）；力经 potential-provider 的 calculate
// 取（静态单点返回 forces）。§4.4 两个冻结点：inputs/outputs 类型声明 +
// 谱系登记（结果落 Trajectory，同时广播 saturday/analysis/complete）。
// 物理诚实：虚频是物理结果不是错误——stability 按显式阈值判定并随阈值交付；
// 引擎报错（如 EMT 元素外）显式上抛，绝不静默换引擎（§4.2 门禁在 provider 层）。

import { createCordisAdapter } from '@toki0413/kernel'
import { Material } from '@toki0413/core'
import {
  runPhononAnalysis, displacedGraph, displacementJobs,
  SQRT_EV_A2_AMU_TO_THZ, THZ_TO_MEV, MASS_AMU,
  phononError,
} from './phonon.mjs'

export {
  runPhononAnalysis, displacedGraph, displacementJobs,
  SQRT_EV_A2_AMU_TO_THZ, THZ_TO_MEV, MASS_AMU,
  phononError,
} from './phonon.mjs'

export const DEFAULT_DISPLACEMENT = 0.01

/**
 * 位移变体 Material（不可变 fork 语义，§6）：原子 atomIndex 沿笛卡尔 direction
 * 移动 sign·displacement，谱系登记 'displaced'。
 */
export function displacedVariant(material, job, displacement) {
  if (!Number.isFinite(displacement) || displacement <= 0) {
    throw phononError('PHONON_BAD_DISPLACEMENT',
      `displacement must be a positive finite number; got ${displacement}`)
  }
  const graph = displacedGraph(material.graph, job, displacement)
  return new Material(
    {
      modalities: { graph, formula: material.formula },
      lineage: [
        ...material.lineage,
        {
          operation: 'displaced',
          detail: { parent: material.id, ...job, displacement },
          timestamp: Date.now(),
        },
      ],
    },
    graph,
  )
}

/** §4.4 AnalysisPlugin 形态：name + inputs/outputs 类型声明 + describe + run */
export const phononAnalysis = {
  name: 'phonon',
  inputs: ['engine-forces'],
  outputs: ['phonon-spectrum'],
  describe() {
    return {
      description: 'Γ 点声子分析（力注入式有限位移）：由引擎力构造力常数与质量加权' +
                   '动力学矩阵，交付频率（THz，负值 = 虚频）、虚频计数与稳定性判定' +
                   '（阈值显式）。适合小原胞（6N+1 次力调用）。',
      parameters: {
        graph: 'Saturday AtomGraph（cell 3×3、nodes[].number/position）',
        forceProvider: 'async (variantGraph) => { forces: eV/Å 行表, calculator? }',
        displacement: '有限位移步长（Å，默认 0.01）',
        applyAsr: '声学和规则投影（默认 true）',
        stableTolOmegaSq: '稳定性 ω² 阈值（eV/Å²/amu，默认 1e-4）',
      },
    }
  },
  async run({ graph, forceProvider, displacement, applyAsr, stableTolOmegaSq } = {}, rt) {
    if (!graph || typeof forceProvider !== 'function') {
      throw phononError('ANALYSIS_INPUT_MISSING',
        'analysis.phonon requires graph and forceProvider (engine-forces input)')
    }
    const t0 = Date.now()
    const result = await runPhononAnalysis(graph, forceProvider, {
      displacement, applyAsr, stableTolOmegaSq,
    })
    // 谱系登记：分析结果也是事实，落 append-only Trajectory（§4.4 冻结点）
    if (rt?.appendTrajectory) {
      await rt.appendTrajectory({
        type: 'analysis_complete',
        analysis: 'phonon',
        result: {
          nAtoms: result.nAtoms,
          calculator: result.calculator,
          minFrequencyTHz: result.frequencies[0],
          maxFrequencyTHz: result.frequencies[result.frequencies.length - 1],
          imaginaryCount: result.imaginary.count,
          verdict: result.stability.verdict,
          forceResidualMax: result.forceResidualMax,
          equilibriumForceMax: result.equilibriumForceMax,
        },
        wallSeconds: (Date.now() - t0) / 1000,
      })
    }
    if (rt?.emit) {
      await rt.emit('saturday/analysis/complete', {
        type: 'saturday/analysis/complete',
        payload: {
          analysis: 'phonon',
          nAtoms: result.nAtoms,
          imaginaryCount: result.imaginary.count,
          verdict: result.stability.verdict,
        },
      })
    }
    return result
  },
}

export default {
  name: 'saturday-phonon',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    rt.provideService('analysis/phonon', phononAnalysis)

    rt.registerTool({
      name: 'analysis.phonon',
      description: 'Γ 点声子分析（力注入式有限位移）。传 materialId，引擎做静态单点' +
                   '取力（需要 material / potential 服务）；交付频率、虚频与稳定性判定。',
      parameters: {
        materialId: { type: 'string', description: '材料 ID（需已弛豫到平衡附近）' },
        engine: { type: 'string', default: 'auto' },
        displacement: { type: 'number', default: DEFAULT_DISPLACEMENT, description: '位移步长（Å）' },
        applyAsr: { type: 'boolean', default: true, description: '声学和规则投影' },
        stableTolOmegaSq: { type: 'number', default: 1e-4, description: '稳定性 ω² 阈值' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        if (!args.materialId) {
          throw phononError('ANALYSIS_INPUT_MISSING',
            'analysis.phonon requires materialId ' +
            '(with services "material" and "potential" mounted)')
        }
        // 服务依赖在调用时解析：缺依赖显式报错，不静默降级（契约 §2）
        const materialService = rt.getService('material')
        const potential = rt.getService('potential')
        if (!materialService || !potential) {
          throw phononError('ANALYSIS_INPUT_MISSING',
            'analysis.phonon requires services "material" and "potential" ' +
            '(mount the saturday core plugin first)')
        }
        const material = await materialService.get(args.materialId)

        // 力注入：位移变体按 Material fork 语义构造（谱系登记 'displaced'），
        // 力来自 provider.calculate（静态单点）。引擎不可用显式上抛（§4.2）。
        const provider = potential.resolveProvider(
          { engine: args.engine },
          { type: 'calculate', nAtoms: material.nAtoms },
        )
        const forceProvider = async (variantGraph) => {
          const variant = new Material(
            { modalities: { graph: variantGraph, formula: material.formula } },
            variantGraph,
          )
          const r = await provider.calculate(variant)
          if (!Array.isArray(r?.forces)) {
            throw phononError('PHONON_FORCE_MISSING',
              `engine "${provider.name}" returned no forces; phonon analysis requires forces`)
          }
          return { forces: r.forces, calculator: provider.name }
        }

        return phononAnalysis.run({
          graph: material.graph,
          forceProvider,
          displacement: args.displacement,
          applyAsr: args.applyAsr,
          stableTolOmegaSq: args.stableTolOmegaSq,
        }, rt)
      },
    })

    ctx.fiber.store.saturdayPhonon = { rt }
  },
}
