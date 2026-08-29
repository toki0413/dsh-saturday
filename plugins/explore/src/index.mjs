// @saturday/plugin-explore —— 采样 → 回算闭环工作流插件（契约 §4.5 oracle 条款 + §4.3）
// 编排：sampler 在参考结构邻域产候选 → 逐候选构造 Material 送入引擎回算 →
// 按 energyPerAtom 排序 → 逐变体事件落 Trajectory（含 generative: 谱系引用）。
// 编排逻辑保持纯函数（./explore.mjs），插件层只做工具注册与服务依赖解析。

import { createCordisAdapter } from '@saturday/kernel'
import { exploreCandidates } from './explore.mjs'

export { exploreCandidates }

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

    ctx.fiber.store.saturdayExplore = { rt }
  },
}
