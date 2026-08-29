// @saturday/plugin-screening —— 批量掺杂筛选工作流插件（契约 §4.3）
// 形态：独立插件，不进核心。编排逻辑保持纯函数（./screening.mjs），
// 插件层只做工具注册与服务依赖解析（material / potential 由核心插件提供）。

import { createCordisAdapter } from '@saturday/kernel'
import { compositionFromNumbers } from '@saturday/core'
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
        batchId: { type: 'string', description: '筛选批次号（活性上下文登记用，缺省自动生成）' },
        maxDopedSites: {
          type: 'integer', default: 1,
          description: '每掺杂的最大取代位数（浓度扫描：1..max 各一个变体；不得超过基体可取代位数）',
        },
        codopants: {
          type: 'array',
          items: { type: 'object' },
          description: '共掺变体列表，如 [{"elements":["Pt","Ni"],"sites":[0,1]}]；落在稳定相连线上的物理内点',
        },
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
        // 热力学第一档：用当前引擎显式计算全部所需元素的参考态（形成焓能量零点）；
        // 引擎/数据面不支持（无 ASE / 元素超范围 / 未声明原语）时诚实降级，绝不静默假设零点。
        const provider = potential.resolveProvider(
          { engine: args.engine },
          { type: 'relax', nAtoms: material.nAtoms, profile: 'screening' },
        )
        const elementSet = new Set([
          ...Object.keys(compositionFromNumbers(material.graph.nodes.map(n => n.number))),
          ...args.dopants,
          ...(args.codopants ?? []).flatMap(cd => cd.elements),
        ])
        let references
        let thermoUnavailable
        if (typeof provider.referenceEnergy === 'function') {
          try {
            references = {}
            for (const el of elementSet) {
              references[el] = (await provider.referenceEnergy(el)).energy_per_atom
            }
          } catch (err) {
            references = undefined
            thermoUnavailable = err.message
          }
        } else {
          thermoUnavailable = `引擎 ${provider.name} 未声明参考态计算原语（referenceEnergy）`
        }
        // derivation 可选（优雅降级）：未挂载推导插件时不登记，工作流照常跑完。
        // 登记后排序 = f(基体, 引擎)：势函数热替换沿 engine:<id> 传播失效（§8.2）。
        const derivation = rt.getService('derivation')
        return screenDopants({
          material,
          dopants: args.dopants,
          potential,
          topK: args.topK,
          engine: args.engine,
          derivation,
          batchId: args.batchId,
          references,
          thermoUnavailable,
          maxDopedSites: args.maxDopedSites,
          codopants: args.codopants,
          // 事件经本插件的运行时出口发布，同 Context 内核心插件的监听器照常收到
          emit: (type, event) => rt.emit(type, event),
        })
      },
    })

    ctx.fiber.store.saturdayScreening = { rt }
  },
}
