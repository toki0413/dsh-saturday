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
    // dsh 静态插件路径需要 defineTool（@deepseek-ai/dsh-tools）；裸 cordis / CI
    // 环境无此包，优雅降级到本地注册表（与 saturday 主插件同款写法）
    const { defineTool } = await import('@deepseek-ai/dsh-tools').catch(() => ({}))
    const rt = createCordisAdapter(ctx, { ...config, defineTool })

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
          items: { type: 'object', additionalProperties: true },
          description: '共掺变体列表，如 [{"elements":["Pt","Ni"],"sites":[0,1]}]；落在稳定相连线上的物理内点',
        },
        sampled: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: '采样候选（通常来自 sampler.ou 的交付）：每项 {"materialId":"...","logProb":-12.3}（已注册材料）' +
                       '或 {"graph":{...},"source":"...","logProb":-12.3}（§4.5 SampledStructure 透传）；' +
                       '逐候选单点回算后与似然证据联合排序（需提供 temperatureK）',
        },
        sampledSource: {
          type: 'string', default: 'external-sampler',
          description: '采样来源声明（如 "sampler.ou"；似然语义随交付呈现，不默认）',
        },
        temperatureK: {
          type: 'number',
          description: '联合排序目标温度（K；提供 sampled 或 evidenceSources 时必填）',
        },
        samplerTemperatureK: {
          type: 'number',
          description: '采样器声明的自身温度（K，可选）；与 temperatureK 不一致时随交付诚实声明温差不纠正',
        },
        evidenceSources: {
          type: 'array',
          items: { type: 'string' },
          description: '枚举候选联合排序的额外证据源（显式启用，缺省只按能量排）；内置 ["hull"]（凸包距离，需参考态）' +
                       '与 ["mixing-entropy"]（理想混合熵组分先验，只消费组分）；可同启，退化关联由机器审计随交付呈现',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        // dsh 工具出口要求：结果需经 render 投影为内容块（与主插件两个工具同款）
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value) }]
        },
      },
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
              // 参考态由本引擎显式产出 → 按定义同源：直接升级为声明形态（携带本引擎的
              // 归一指纹与能量单位），凸包能量全链同源可比（M3 消费：provenance 声明态）
              references[el] = {
                energyPerAtom: (await provider.referenceEnergy(el)).energy_per_atom,
                ...(provider._fingerprint ? { fingerprint: provider._fingerprint } : {}),
                ...(provider._units ? { energyUnit: provider._units.energy } : {}),
              }
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
        // 采样候选（可选）：Agent 先调采样器再调筛选，谱系在编排层不断；
        // 已注册材料按 ID 解析，采样器直交付（{graph, source}）透传纯层构造；缺/错显式报错（不静默丢弃候选）
        let sampled
        if (args.sampled?.length) {
          const candidates = []
          for (let i = 0; i < args.sampled.length; i++) {
            const s = args.sampled[i]
            if (s.materialId) {
              candidates.push({ material: await materialService.get(s.materialId), logProb: s.logProb })
            } else if (s.graph) {
              candidates.push({ graph: s.graph, source: s.source, logProb: s.logProb })
            } else {
              throw new Error(`sampled[${i}] needs either materialId or graph (missing candidate structure)：` +
                              '候选结构不得静默丢弃')
            }
          }
          sampled = {
            candidates,
            samplerName: args.sampledSource ?? 'external-sampler',
            likelihood: 'declared-by-caller',
            ...(Number.isFinite(args.samplerTemperatureK) ? { samplerTemperatureK: args.samplerTemperatureK } : {}),
          }
        }
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
          sampled,
          temperatureK: args.temperatureK,
          evidenceSources: args.evidenceSources,
          // 事件经本插件的运行时出口发布，同 Context 内核心插件的监听器照常收到
          emit: (type, event) => rt.emit(type, event),
        })
      },
    })

    ctx.fiber.store.saturdayScreening = { rt }
  },
}
