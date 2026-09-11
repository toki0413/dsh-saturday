// @toki0413/plugin-mp —— Materials Project 结构源插件（契约 §4.1）
// 挂载 resolver 服务 + structure.resolve 工具。与核心插件解耦：
// 材料服务若存在则工具可直接产出 Material，否则只返回候选结构。
// 挂载即探测（plugin-mace/plugin-lammps 先例）：凭据缺失则不注册并显式报告，
// 工具面不得展示一个本环境注定失败的能力（缺席即诚实声明，非静默降级）。

import { createCordisAdapter } from '@toki0413/kernel'
import { MaterialsProjectResolver } from './mp-resolver.mjs'

export { MaterialsProjectResolver, MpApiKeyMissingError } from './mp-resolver.mjs'

export default {
  name: 'saturday-mp',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)
    const resolver = new MaterialsProjectResolver({
      apiKey: config.apiKey ?? process.env.MP_API_KEY,
      endpoint: config.endpoint,
      fetchImpl: config.fetchImpl,
    })

    // 挂载即探测：无 API Key 则服务与工具均不注册（可注入 checkImpl 供测试复用）
    const available = config.checkImpl ? await config.checkImpl() : Boolean(resolver.apiKey)
    if (!available) {
      process.stderr.write('[plugin-mp] MP_API_KEY 未配置（config.apiKey / 环境变量均缺失），跳过注册；structure.resolve 不进入工具面（配置凭据后重新挂载即可解锁）\n')
      ctx.fiber.store.saturdayMp = { rt, resolver, registered: false }
      return
    }

    // 服务形态暴露：其他插件可经 seam 消费（如替换默认结构源）
    rt.provideService('structure-resolver.materials-project', resolver)

    rt.registerTool({
      name: 'structure.resolve',
      description: '经 Materials Project 解析化学式为候选结构（需 MP_API_KEY）。' +
                   '返回候选含 material_id 来源与 hull 上方能量，按稳定性排序。',
      parameters: {
        query: { type: 'string', required: true, description: '化学式，如 "TiO2"' },
        polymorphRank: { type: 'integer', description: '只返回第 N 个候选（0 = 最稳定）' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        const candidates = await resolver.resolve(args.query)
        const picked = args.polymorphRank != null
          ? candidates.filter(c => c.polymorphRank === args.polymorphRank)
          : candidates
        return {
          resolver: resolver.name,
          formula: args.query,
          candidates: picked.map(c => ({
            source: c.source,
            polymorphRank: c.polymorphRank,
            nAtoms: c.graph.nodes.length,
            energyAboveHull: c.energyAboveHull,
          })),
        }
      },
    })

    ctx.fiber.store.saturdayMp = { rt, resolver }
  },
}
