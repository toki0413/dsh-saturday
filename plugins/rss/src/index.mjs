// @toki0413/plugin-rss —— RSS 随机结构搜索采样插件
// 契约 §4.5 sampler seam 第二个生成式实现（非 normalizing-flow 路线）：
// 在成分/晶胞约束下均匀生成随机晶体结构候选，不依赖参考结构拓扑。
// 采样语义而非求逆：候选必须连同非唯一性一起呈现，且可回算验证
// （生成 → 弛豫 → 核对闭环由工作流层编排，§4.5 oracle 条款）。

import { createCordisAdapter } from '@toki0413/kernel'
import { rssSampler, samplerError, resolveComposition } from './rss.mjs'

export { rssSampler, mulberry32, samplerError, resolveComposition, SAMPLER_NAME } from './rss.mjs'

export default {
  name: 'saturday-sampler-rss',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    rt.provideService('sampler/rss', rssSampler)

    rt.registerTool({
      name: 'sampler.rss',
      description: 'RSS 随机结构搜索采样（§4.5 采样语义，非 flow 生成式路线）：在成分/原子数/' +
                   '晶胞约束下均匀生成随机晶体结构候选（正交晶胞 + 最小间距门禁），' +
                   '不依赖参考结构拓扑。候选是均匀提议分布的采样点而非唯一解；' +
                   '提议分布经门禁截断后归一化常数无闭式，似然如实声明 none（不伪造）；' +
                   '请送入引擎回算验证后再使用（workflow.explore / 逐候选弛豫）。',
      parameters: {
        elements: { type: 'array', description: '元素符号数组（与 counts 搭配，如 ["Cu","Pt"]）；与 referenceId 二选一' },
        counts: { type: 'array', description: '各元素原子数（与 elements 等长，如 [3,1]）' },
        referenceId: { type: 'string', description: '参考结构材料 ID：成分自其 graph 继承（结构本身不参考）；与 elements 二选一' },
        n: { type: 'integer', default: 8, description: '候选数量' },
        seed: { type: 'integer', default: 1, description: '随机种子（确定性复现）' },
        aMin: { type: 'number', default: 2.5, description: '正交晶胞边长下界（Å）' },
        aMax: { type: 'number', default: 6.0, description: '正交晶胞边长上界（Å）' },
        minDistance: { type: 'number', default: 1.1, description: '最小原子间距门禁（Å，最小像约定）' },
        maxAttempts: { type: 'integer', default: 200, description: '单原子放置重试上限（耗尽即显式报错）' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        // 成分来源二选一：显式 composition（elements+counts）或 reference 继承
        const hasComposition = Array.isArray(args.elements) || Array.isArray(args.counts)
        if (!hasComposition && !args.referenceId) {
          throw samplerError('SAMPLER_UNAVAILABLE',
            'sampler.rss requires either elements+counts (explicit composition) or referenceId (inherit composition)')
        }
        if (hasComposition && (!Array.isArray(args.elements) || !Array.isArray(args.counts))) {
          throw samplerError('SAMPLER_UNAVAILABLE', 'elements and counts must be provided together (equal length arrays)')
        }

        let target
        if (hasComposition) {
          target = { composition: { elements: args.elements, counts: args.counts } }
        } else {
          // 服务依赖在调用时解析：缺依赖显式报错，不静默降级（契约 §2）
          const materialService = rt.getService('material')
          if (!materialService) {
            throw samplerError('SAMPLER_UNAVAILABLE',
              'sampler.rss requires service "material" for referenceId (mount the saturday core plugin first)')
          }
          const reference = await materialService.get(args.referenceId)
          target = { reference }
        }

        const candidates = await rssSampler.sample(target, {
          n: args.n,
          seed: args.seed,
          aMin: args.aMin,
          aMax: args.aMax,
          minDistance: args.minDistance,
          maxAttempts: args.maxAttempts,
        })
        return {
          sampler: rssSampler.name,
          semantics: 'sampling',
          likelihood: 'none',
          invertible: false,
          n: candidates.length,
          formula: candidates[0]?.formula,
          candidates,
          note: '候选是成分/晶胞约束下均匀提议分布的采样点，不构成唯一解；' +
                '似然如实声明 none（最小间距门禁使交付分布截断，归一化常数无闭式，' +
                '不伪造 exact——无门禁的提议分布本身可精确归一）；' +
                '使用前必须回算验证（生成 → 弛豫 → 核对，引擎是唯一 oracle）',
        }
      },
    })

    ctx.fiber.store.saturdaySamplerRss = { rt }
  },
}
