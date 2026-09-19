// @toki0413/plugin-explore —— 采样 → 回算闭环工作流插件（契约 §4.5 oracle 条款 + §4.3）
// 编排：sampler 在参考结构邻域产候选 → 逐候选构造 Material 送入引擎回算 →
// 按 energyPerAtom 排序 → 逐变体事件落 Trajectory（含 generative: 谱系引用）。
// 编排逻辑保持纯函数（./explore.mjs），插件层只做工具注册与服务依赖解析。

import { createCordisAdapter } from '@toki0413/kernel'
import { Material } from '@toki0413/core'
import { exploreCandidates } from './explore.mjs'
import { runActiveLearning } from './active-learning.mjs'
import { boMinimize, boMinimizePareto } from './gp.mjs'

export { exploreCandidates, runActiveLearning, boMinimize, boMinimizePareto }

export default {
  name: 'saturday-explore',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    rt.registerTool({
      name: 'workflow.explore',
      description: '采样 → 回算闭环（§4.5 oracle 条款）：采样器在 referenceId 结构邻域产生候选，' +
                   '每个候选独立送入引擎弛豫验证后按能量排序。候选是分布采样点而非唯一解，' +
                   '能量为引擎回算结果，全程谱系可溯源。',
      parameters: {
        referenceId: { type: 'string', required: true, description: '参考结构材料 ID' },
        n: { type: 'integer', default: 8, description: '候选数量' },
        seed: { type: 'integer', default: 1, description: '随机种子（确定性复现）' },
        sigma: { type: 'number', default: 0.05, description: '微扰位移标准差（Å）' },
        engine: { type: 'string', default: 'auto', description: '引擎选择（validation 画像）' },
        topK: { type: 'integer', description: '只返回能量最低的前 K 个' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        // 服务依赖在调用时解析：缺依赖显式报错，不静默降级（契约 §2）
        const materialService = rt.getService('material')
        const potential = rt.getService('potential')
        const sampler = rt.getService('sampler/reference-perturbation')
        if (!materialService || !potential || !sampler) {
          throw new Error('workflow.explore requires services "material", "potential" and ' +
                          '"sampler/reference-perturbation" (mount the saturday core and ' +
                          'sampler-perturb plugins first)')
        }
        const reference = await materialService.get(args.referenceId)
        const candidates = await sampler.sample(
          { reference },
          { n: args.n, seed: args.seed, sigma: args.sigma },
        )
        return exploreCandidates({
          reference,
          candidates,
          potential,
          engine: args.engine,
          topK: args.topK,
          // 事件经本插件的运行时出口发布，同 Context 内核心插件的监听器照常收到
          emit: (type, event) => rt.emit(type, event),
        })
      },
    })

    rt.registerTool({
      name: 'workflow.activeLearning',
      description: 'basin-hopping 主动学习闭环（§4.3+§4.5 迭代版）：每轮从当前最优结构微扰产候选→引擎 relax '
        + '回算→能量更低则更新中心与最优。引擎是唯一 oracle（无 GP 代理，非贝叶斯优化）；候选是采样分布点'
        + '非唯一解；history 最优能量按构造单调不升，不声明全局最优。逐轮回算落 Trajectory（含 round/谱系）。'
        + '需 material/potential/sampler/reference-perturbation 服务。',
      parameters: {
        referenceId: { type: 'string', required: true, description: '种子结构材料 ID' },
        rounds: { type: 'integer', default: 3, description: '主动学习轮数' },
        candidatesPerRound: { type: 'integer', default: 4, description: '每轮候选数' },
        sigma: { type: 'number', default: 0.05, description: '微扰位移标准差（Å）' },
        seed: { type: 'integer', default: 1, description: '随机种子（第 r 轮用 seed+r，确定性复现）' },
        engine: { type: 'string', default: 'auto' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        const materialService = rt.getService('material')
        const potential = rt.getService('potential')
        const sampler = rt.getService('sampler/reference-perturbation')
        if (!materialService || !potential || !sampler) {
          throw new Error('workflow.activeLearning requires services "material", "potential" and '
            + '"sampler/reference-perturbation" (mount the saturday core and sampler-perturb plugins first)')
        }
        const reference = await materialService.get(args.referenceId)
        return runActiveLearning({
          reference, sampler, potential, engine: args.engine,
          rounds: args.rounds, candidatesPerRound: args.candidatesPerRound,
          sigma: args.sigma, seed: args.seed,
          emit: (type, event) => rt.emit(type, event),
        })
      },
    })

    rt.registerTool({
      name: 'workflow.bayesOptimize',
      description: 'GP 代理贝叶斯优化（1D，极小化昂贵黑箱）：对种子材料施体变标度 x（各向同性缩放），'
        + '引擎 calculate 回算 E(x)/原子作 oracle，高斯过程（RBF+Cholesky）建模、LCB 采集选下一评估点，'
        + '少回算逼近极小（平衡体积代理）。不声明全局最优（启发式）；缺 material/potential 服务显式报错。'
        + '需 material / potential 服务。',
      parameters: {
        materialId: { type: 'string', required: true, description: '种子材料 ID' },
        scaleRange: { type: 'array', items: { type: 'number' }, description: '体变标度区间 [lo,hi]（缺省 [0.9,1.1]）' },
        iterations: { type: 'integer', default: 8, description: 'LCB 采集迭代数（另加 3 个冷启动点）' },
        kappa: { type: 'number', default: 2.0, description: 'LCB 探索系数（越大越偏探索）' },
        engine: { type: 'string', default: 'auto' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        const materialService = rt.getService('material')
        const potential = rt.getService('potential')
        if (!args.materialId || !materialService || !potential) {
          throw new Error('workflow.bayesOptimize requires materialId with services "material" and "potential" '
            + '(mount the saturday core plugin first)')
        }
        const material = await materialService.get(args.materialId)
        const [lo, hi] = args.scaleRange ?? [0.9, 1.1]
        const provider = potential.resolveProvider(
          { engine: args.engine }, { type: 'calculate', nAtoms: material.nAtoms },
        )
        const evaluate = async (scale) => {
          const graph = structuredClone(material.graph)
          graph.cell = graph.cell.map(row => row.map(v => v * scale))
          graph.nodes = graph.nodes.map(n => ({ ...n, position: n.position.map(v => v * scale) }))
          const variant = await Material.create({
            modalities: { graph, formula: material.formula },
            lineage: [{ operation: 'cell-scaled', detail: { parent: material.id, scale }, timestamp: Date.now() }],
          })
          const r = await provider.calculate(variant)
          if (!Number.isFinite(r?.energy)) throw new Error(`engine "${provider.name}" returned non-finite energy at scale ${scale}`)
          await rt.emit('saturday/simulation/single-point', {
            type: 'saturday/simulation/single-point',
            payload: { scale, energyPerAtom: r.energy / material.nAtoms, engine: provider.name, workflow: 'bayes-optimize' },
          })
          return r.energy / material.nAtoms
        }
        const out = await boMinimize({ lo, hi, objective: evaluate, iterations: args.iterations, kappa: args.kappa })
        await rt.appendTrajectory?.({
          type: 'analysis_complete', analysis: 'bayes-optimize',
          result: { provider: provider.name, bestScale: out.bestX, bestEnergyPerAtom: out.bestY, evaluations: out.evaluations },
        })
        return { ...out, provider: provider.name, materialId: material.id, formula: material.formula, lo, hi }
      },
    })

    rt.registerTool({
      name: 'workflow.bayesOptimizePareto',
      description: '多目标（2）GP 贝叶斯优化：对种子材料体变标度 x，两目标 = [每原子能量 E/n, 最大残余力范数 max|F|]（均最小化）'
        + '——低能与“平衡附近小力”常不在同一 x，构成权衡。逐目标独立 GP + 超体积增益采集，返回观测非支配前沿与超体积。'
        + '引擎为唯一 oracle；不声明收敛到真实 Pareto 前沿（后验均值贪心采集）。需 material/potential（引擎需回能量与力）。',
      parameters: {
        materialId: { type: 'string', required: true, description: '种子材料 ID' },
        scaleRange: { type: 'array', items: { type: 'number' }, description: '体变标度区间 [lo,hi]（缺省 [0.92,1.08]）' },
        iterations: { type: 'integer', default: 8, description: '采集迭代数（另加 3 个冷启动点）' },
        engine: { type: 'string', default: 'auto' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        const materialService = rt.getService('material')
        const potential = rt.getService('potential')
        if (!args.materialId || !materialService || !potential) {
          throw new Error('workflow.bayesOptimizePareto requires materialId with services "material" and "potential" '
            + '(mount the saturday core plugin first)')
        }
        const material = await materialService.get(args.materialId)
        const [lo, hi] = args.scaleRange ?? [0.92, 1.08]
        const provider = potential.resolveProvider({ engine: args.engine }, { type: 'calculate', nAtoms: material.nAtoms })
        const objectiveFor = (which) => async (scale) => {
          const graph = structuredClone(material.graph)
          graph.cell = graph.cell.map(row => row.map(v => v * scale))
          graph.nodes = graph.nodes.map(n => ({ ...n, position: n.position.map(v => v * scale) }))
          const variant = await Material.create({
            modalities: { graph, formula: material.formula },
            lineage: [{ operation: 'cell-scaled', detail: { parent: material.id, scale }, timestamp: Date.now() }],
          })
          const r = await provider.calculate(variant)
          if (which === 0) {
            if (!Number.isFinite(r?.energy)) throw new Error('non-finite energy at scale ' + scale)
            return r.energy / material.nAtoms
          }
          if (!Array.isArray(r?.forces)) throw new Error('engine returned no forces at scale ' + scale)
          return Math.max(...r.forces.map(f => Math.hypot(...f)))
        }
        const out = await boMinimizePareto({ lo, hi, objectives: [objectiveFor(0), objectiveFor(1)], iterations: args.iterations })
        await rt.appendTrajectory?.({
          type: 'analysis_complete', analysis: 'bayes-optimize-pareto',
          result: { provider: provider.name, paretoSize: out.pareto.length, hypervolume: out.hypervolume, evaluations: out.evaluations },
        })
        return { ...out, provider: provider.name, materialId: material.id, formula: material.formula, objectives: ['energyPerAtom', 'maxForce'], lo, hi }
      },
    })

    ctx.fiber.store.saturdayExplore = { rt }
  },
}
