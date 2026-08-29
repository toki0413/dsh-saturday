// @saturday/plugin-screening —— 批量掺杂筛选工作流插件（契约 §4.3）
// 形态：独立插件，不进核心。编排逻辑保持纯函数（./screening.mjs），
// 插件层只做工具注册与服务依赖解析（material / potential 由核心插件提供）。

import { createCordisAdapter } from '@saturday/kernel'
import { screenDopants } from './screening.mjs'

export { screenDopants }

export default {
  name: 'saturday-screening',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    rt.registerTool({
      name: 'workflow.screen',
      description: '批量掺杂筛选：基体 + 掺杂变体逐个弛豫，按能量排序。' +
                   '每个变体独立落 Trajectory，可全程溯源。支持元素：Cu Ag Al Ni Au Pd Pt（EMT 范围）。',
      parameters: {
        materialId: { type: 'string', required: true, description: '基体材料 ID' },
        dopants: {
          type: 'array', required: true,
          items: { type: 'string' },
          description: '掺杂元素列表，如 ["Ag","Ni"]',
        },
        topK: { type: 'integer', description: '只返回能量最低的前 K 个' },
        engine: { type: 'string', default: 'auto' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        // 服务依赖在调用时解析：缺依赖显式报错，不静默降级（契约 §2 生命周期规则）
        const materialService = rt.getService('material')
        const potential = rt.getService('potential')
        if (!materialService || !potential) {
          throw new Error('workflow.screen requires services "material" and "potential" ' +
                          '(mount the saturday core plugin first)')
        }
        const material = await materialService.get(args.materialId)
        return screenDopants({
          material,
          dopants: args.dopants,
          potential,
          topK: args.topK,
          engine: args.engine,
          // 事件经本插件的运行时出口发布，同 Context 内核心插件的监听器照常收到
          emit: (type, event) => rt.emit(type, event),
        })
      },
    })

    ctx.fiber.store.saturdayScreening = { rt }
  },
}
