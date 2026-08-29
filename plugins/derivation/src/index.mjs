// @saturday/plugin-derivation —— 推导登记簿插件（契约 §8.2 首个实证：活性上下文地基）
// 材料上下文 = 响应式谱系图：每个导出量声明推导来源（derivation.record），
// 上游失效沿推导图向下游传播（derivation.invalidate），重算惰性且预算受控。
// 纯数据面逻辑保持纯函数（./derivation.mjs），插件层只做服务/工具注册。
// 本插件不依赖其他服务：它是纯提供方（与核心物理解耦，任何宿主可独立挂载）。

import { createCordisAdapter } from '@saturday/kernel'
import { createDerivationRegistry } from './derivation.mjs'

export { createDerivationRegistry, derivationError } from './derivation.mjs'

export default {
  name: 'saturday-derivation',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    const registry = createDerivationRegistry({
      emit: (type, event) => rt.emit(type, event),
    })
    rt.provideService('derivation', registry)

    rt.registerTool({
      name: 'derivation.record',
      description: '登记一条推导：导出量（output）由哪些输入（inputs）经哪个生产者（producer）得出。' +
                   '引用形如 material:<id> / job:<id> / result:<id> / engine:<id>。冻结结果传 frozen（只追加修正、不重算）。',
      parameters: {
        inputs: { type: 'array', required: true, description: '输入引用数组' },
        output: { type: 'string', required: true, description: '输出引用' },
        producer: { type: 'string', required: true, description: '生产者（工具/引擎名）' },
        frozen: { type: 'boolean', default: false, description: '冻结（实验数据/已交付）' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        return registry.record({
          inputs: args.inputs, output: args.output,
          producer: args.producer, frozen: args.frozen,
        })
      },
    })

    rt.registerTool({
      name: 'derivation.invalidate',
      description: '失效传播（§8.2）：声明某引用失效并给出原因，沿推导图向下游传递；' +
                   '冻结结果只追加修正记录。返回失效与修正的引用清单。',
      parameters: {
        ref: { type: 'string', required: true, description: '失效源引用（如 material:<id>）' },
        reason: { type: 'string', required: true, description: '失效原因（写入谱系）' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        return registry.invalidate(args.ref, args.reason)
      },
    })

    rt.registerTool({
      name: 'derivation.status',
      description: '查询导出量的活性状态：valid / invalid、冻结、修正记录与失效来源。',
      parameters: {
        ref: { type: 'string', required: true, description: '导出量引用' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        return registry.status(args.ref)
      },
    })

    ctx.fiber.store.saturdayDerivation = { registry, rt }
  },
}
