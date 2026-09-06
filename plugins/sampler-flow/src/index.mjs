// @saturday/plugin-sampler-flow —— 仿射耦合流采样器
// 契约 §4.5 sampler seam 第三实证：invertible: true 首实证——
// 双射输运映射（潜变量 ↔ 位移向量）+ 换元公式精确似然（likelihood: 'exact'），
// encode 是 decode 的严格逆（可逆性声明是可执行条款，不是文档修辞）。
// 采样语义而非求逆；候选必须连同非唯一性一起呈现，且可回算验证
// （生成 → 弛豫 → 核对闭环由工作流层编排，§4.5 oracle 条款）。

import { createCordisAdapter } from '@saturday/kernel'
import { affineFlowSampler, createFlowSampler, samplerError } from './sampler.mjs'

export {
  affineFlowSampler, createFlowSampler, flowForward, flowInverse, flowParams,
  stdNormalLogProb, baseLogProb, mulberry32, samplerError, SAMPLER_NAME, DEFAULT_LAYERS,
} from './sampler.mjs'

export default {
  name: 'saturday-sampler-flow',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    rt.provideService('sampler/affine-flow', affineFlowSampler)

    rt.registerTool({
      name: 'sampler.flow',
      description: '仿射耦合流参考结构采样（§4.5 采样语义，invertible 首实证）：' +
                   '潜变量 z ~ N(0, I) 经双射输运映射为位移向量，叠加参考结构得候选；' +
                   '似然经换元公式精确可求（logProb 逐候选可独立重算），encode 可把候选映回潜变量。' +
                   '候选是分布上的采样点而非唯一解；流参数由 seed 派生（非训练产物，如实声明）；' +
                   '请送入引擎回算验证后再使用。',
      parameters: {
        referenceId: { type: 'string', required: true, description: '参考结构材料 ID' },
        n: { type: 'integer', default: 8, description: '候选数量' },
        seed: { type: 'integer', default: 1, description: '随机种子（同时决定流参数与潜变量抽样；确定性复现）' },
        sMax: { type: 'number', default: 0.1, description: '微分同胚窗口半宽（Å）：位移 |d| < sMax + 0.1，窗口外 encode 显式拒绝' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        // 服务依赖在调用时解析：缺依赖显式报错，不静默降级（契约 §2）
        const materialService = rt.getService('material')
        if (!materialService) {
          throw samplerError('SAMPLER_UNAVAILABLE',
            'sampler.flow requires service "material" (mount the saturday core plugin first)')
        }
        const reference = await materialService.get(args.referenceId)
        const sampler = createFlowSampler({ reference, seed: args.seed, sMax: args.sMax })
        const candidates = await sampler.sample({ reference }, { n: args.n })
        return {
          sampler: sampler.name,
          semantics: 'sampling',
          likelihood: 'exact',
          invertible: true,
          n: candidates.length,
          candidates,
          note: '候选是仿射耦合流（双射输运映射）的采样点，不构成唯一解；' +
                'exact 指换元公式 log N(z) − log|det J| 的输运似然（latent 随交付，逐候选可独立重算），' +
                '不是能量面上的玻尔兹曼似然——热力学加权仍须引擎回算（候选不自证）；' +
                '流参数由 seed 派生（非数据训练产物）；位移约束在微分同胚窗口内，窗口外 encode 显式拒绝',
        }
      },
    })

    rt.registerTool({
      name: 'sampler.flow.encode',
      description: '双射输运映射的反向（契约：仅 invertible === true 提供）：把与参考结构同拓扑的候选 graph ' +
                   '映回潜变量（encode(decode(z)) ≡ z）。窗口外结构显式拒绝（不外推冒充覆盖）；' +
                   '跨拓扑显式拒绝（位移无定义）。',
      parameters: {
        referenceId: { type: 'string', required: true, description: '参考结构材料 ID（位移空间的定义基准）' },
        graph: { type: 'object', additionalProperties: true, description: '待编码结构（AtomGraph：nodes[].position 逐坐标）' },
        seed: { type: 'integer', default: 1, description: '随机种子（必须与生成时一致：seed 决定流参数）' },
        sMax: { type: 'number', default: 0.1, description: '微分同胚窗口半宽（必须与生成时一致）' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        const materialService = rt.getService('material')
        if (!materialService) {
          throw samplerError('SAMPLER_UNAVAILABLE',
            'sampler.flow.encode requires service "material" (mount the saturday core plugin first)')
        }
        if (!args.graph?.nodes?.length) {
          throw samplerError('SAMPLER_UNAVAILABLE', 'encode 需要非空 graph（AtomGraph 形态）')
        }
        const reference = await materialService.get(args.referenceId)
        const sampler = createFlowSampler({ reference, seed: args.seed, sMax: args.sMax })
        const encoded = await sampler.encode(args.graph)
        return {
          sampler: sampler.name,
          invertible: true,
          ...encoded,
          note: 'encode 交付潜变量与正向 log|det J|（同一映射的雅可比）；' +
                '双射对账：flowForward(latent) 可逐坐标还原位移（encode(decode(z)) ≡ z）',
        }
      },
    })

    ctx.fiber.store.saturdaySamplerFlow = { rt }
  },
}
