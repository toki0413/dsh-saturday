// @toki0413/plugin-sampler-perturb —— 首个薄 sampler 插件（契约 §4.5 sampler seam 首个实证）
// 参考结构微扰采样：给定 referenceId，在参考结构邻域采样 n 个候选。
// 采样语义而非求逆：候选必须连同非唯一性一起呈现，且可回算验证
// （生成 → 弛豫 → 核对闭环由工作流层编排，§4.5 oracle 条款）。

import { createCordisAdapter } from '@toki0413/kernel'
import { referencePerturbationSampler, samplerError } from './sampler.mjs'

export { referencePerturbationSampler, mulberry32, samplerError, SAMPLER_NAME } from './sampler.mjs'

export default {
  name: 'saturday-sampler-perturb',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    rt.provideService('sampler/reference-perturbation', referencePerturbationSampler)

    rt.registerTool({
      name: 'sampler.perturb',
      description: '参考结构微扰采样（§4.5 采样语义）：在 referenceId 结构的邻域内' +
                   '采样 n 个候选。候选是分布上的采样点而非唯一解；似然不可求（已如实声明），' +
                   '请送入引擎回算验证后再使用。',
      parameters: {
        referenceId: { type: 'string', required: true, description: '参考结构材料 ID' },
        n: { type: 'integer', default: 8, description: '候选数量' },
        seed: { type: 'integer', default: 1, description: '随机种子（确定性复现）' },
        sigma: { type: 'number', default: 0.05, description: '笛卡尔位移标准差（Å）' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        // 服务依赖在调用时解析：缺依赖显式报错，不静默降级（契约 §2）
        const materialService = rt.getService('material')
        if (!materialService) {
          throw samplerError('SAMPLER_UNAVAILABLE',
            'sampler.perturb requires service "material" (mount the saturday core plugin first)')
        }
        const reference = await materialService.get(args.referenceId)
        const candidates = await referencePerturbationSampler.sample(
          { reference },
          { n: args.n, seed: args.seed, sigma: args.sigma },
        )
        return {
          sampler: referencePerturbationSampler.name,
          semantics: 'sampling',
          likelihood: 'none',
          invertible: false,
          n: candidates.length,
          candidates,
          note: '候选是参考结构邻域微扰分布的采样点，不构成唯一解；' +
                '似然不可精确求值（manifest 已声明 none）；' +
                '使用前必须回算验证（生成 → 弛豫 → 核对）',
        }
      },
    })

    ctx.fiber.store.saturdaySamplerPerturb = { rt }
  },
}
