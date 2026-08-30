// @saturday/plugin-sampler-ou —— OU（Ornstein-Uhlenbeck）参考结构采样器
// 契约 §4.5 sampler seam 第二实证：似然声明从 'none'（微扰）升档到 'exact'
// （OU 转移密度是闭式高斯，逐点精确可求值）。
// 采样语义而非求逆；候选必须连同非唯一性一起呈现，且可回算验证
// （生成 → 弛豫 → 核对闭环由工作流层编排，§4.5 oracle 条款）。

import { createCordisAdapter } from '@saturday/kernel'
import { ouSampler, samplerError } from './sampler.mjs'

export { ouSampler, ouStd, ouLogProb, mulberry32, samplerError, SAMPLER_NAME, uEqFromHarmonicTemperature, KB_EV_PER_K, ouMixtureLogProb, ouSampleMixture } from './sampler.mjs'

export default {
  name: 'saturday-sampler-ou',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    rt.provideService('sampler/ou-perturbation', ouSampler)

    rt.registerTool({
      name: 'sampler.ou',
      description: 'OU 参考结构采样（§4.5 采样语义）：均值回归锚定 referenceId 的受控扩散，' +
                   '采样 n 个候选并附精确提议似然（logProb）。候选是分布上的采样点而非唯一解；' +
                   '局部采样器（盆地内），请送入引擎回算验证后再使用。',
      parameters: {
        referenceId: { type: 'string', required: true, description: '参考结构材料 ID' },
        n: { type: 'integer', default: 8, description: '候选数量' },
        seed: { type: 'integer', default: 1, description: '随机种子（确定性复现）' },
        uEq: { type: 'number', default: 0.05, description: '平衡态每坐标涨落幅度（Å）' },
        gammaDt: { type: 'number', default: 1.0, description: 'γΔ 无量纲摩擦时间尺度积（小→贴近参考，大→近平稳）' },
        temperatureK: { type: 'number', description: '采样器自身温度声明（可选；声明 ≠ 替换：不改变采样行为，' +
          '只随交付呈现供消费方做温差诚实核对；标定建议值可用 uEqFromHarmonicTemperature 换算）' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        // 服务依赖在调用时解析：缺依赖显式报错，不静默降级（契约 §2）
        const materialService = rt.getService('material')
        if (!materialService) {
          throw samplerError('SAMPLER_UNAVAILABLE',
            'sampler.ou requires service "material" (mount the saturday core plugin first)')
        }
        const reference = await materialService.get(args.referenceId)
        const candidates = await ouSampler.sample(
          { reference },
          { n: args.n, seed: args.seed, uEq: args.uEq, gammaDt: args.gammaDt, temperatureK: args.temperatureK },
        )
        return {
          sampler: ouSampler.name,
          semantics: 'sampling',
          likelihood: 'exact',
          invertible: false,
          n: candidates.length,
          candidates,
          note: '候选是 OU 提议核（均值回归锚定参考的受控扩散）的采样点，不构成唯一解；' +
                'exact 指提议核自身的闭式高斯似然（logProb 已附），不是能量面上的玻尔兹曼似然——' +
                '热力学加权仍须引擎回算（候选不自证）；OU 单峰，定位为局部采样器',
        }
      },
    })

    ctx.fiber.store.saturdaySamplerOu = { rt }
  },
}
