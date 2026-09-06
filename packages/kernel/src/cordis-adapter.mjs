// @toki0413/kernel —— 防腐层（Anti-Corruption Layer）
// Saturday 领域代码只依赖本模块暴露的 SaturdayRuntime 接口。
// 全仓库唯一允许 import '@deepseek-ai/cordis' 的文件。
// DSH 上游 API 变更时，只改这一个文件。

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @typedef {Object} SaturdayRuntime
 * @property {(name: string, impl: any) => () => void} provideService 注册服务（返回回收器）
 * @property {(name: string) => any} getService 读取可选服务，不存在返回 undefined
 * @property {(event: string, handler: Function) => () => void} on 订阅事件（返回回收器）
 * @property {(event: string, payload: any) => Promise<any>} emit 发布事件
 * @property {(fn: () => any, label?: string) => any} effect 注册随插件卸载自动回退的效果
 * @property {(tool: Object) => any} registerTool 注册 Agent 工具（dsh 内走 harness；裸 cordis 走本地注册表）
 * @property {(entry: Object) => Promise<void>} appendTrajectory 追加溯源日志（append-only）
 * @property {LocalToolRegistry} tools 本地工具注册表（测试/无 dsh 环境用）
 */

/** 裸 cordis 环境下的本地工具注册表：与 harness.defineTool 同构的最小实现 */
export class LocalToolRegistry {
  constructor() { this.tools = new Map() }
  register(tool) {
    this.tools.set(tool.name, tool)
    return () => this.tools.delete(tool.name)
  }
  list() { return [...this.tools.values()].map(t => ({ name: t.name, description: t.description })) }
  /** 完整工具描述（含 parameters JSON schema）——宿主适配层（如 MCP server）注册工具面用 */
  describe() {
    return [...this.tools.values()].map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? {},
    }))
  }
  /** 模拟 Agent 调用工具（测试/无 LLM 演示用） */
  async call(name, args) {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`Tool ${name} not found. Available: ${[...this.tools.keys()].join(', ')}`)
    return tool.execute(args)
  }
}

/**
 * 基于 Cordis v4 真实 API 的适配器。
 * 已核实的内核 API（@deepseek-ai/cordis@4.0.1）：
 *   ctx.reflect.provide/get  —— 服务注册与读取
 *   ctx.events.on/emit       —— 类型化事件
 *   ctx.fiber.effect(fn)     —— 可逆效果（fiber 卸载时自动回退）
 *   ctx.registry.plugin()    —— 插件挂载
 * dsh 运行时特有的 Builtin：
 *   globalThis.harness.defineTool/registerTool —— Agent 工具注册
 */
export function createCordisAdapter(ctx, options = {}) {
  const localTools = new LocalToolRegistry()
  const trajectoryPath = options.trajectoryPath ?? fileURLToPath(new URL('../../data/trajectory.jsonl', import.meta.url))
  // dsh 静态插件官方路径所需的 defineTool（来自 @deepseek-ai/dsh-tools，可选注入）
  const defineTool = options.defineTool ?? null

  return {
    tools: localTools,

    provideService(name, impl) {
      // cordis 语义：provide 归属当前 fiber，fiber 卸载时服务自动消失
      return ctx.reflect.provide(name, impl)
    },

    getService(name) {
      return ctx.reflect.get(name)
    },

    on(event, handler) {
      return ctx.events.on(event, handler)
    },

    async emit(event, payload) {
      return ctx.events.emit(event, payload)
    },

    effect(fn, label) {
      return ctx.fiber.effect(fn, label)
    },

    registerTool(tool) {
      // 路径 1（dsh 静态插件，官方写法）：inject ['tools'] + ctx.tools.register(defineTool({...}))
      // 证据：@deepseek-ai/dsh-tool-todo 源码；defineTool 来自 @deepseek-ai/dsh-tools
      const registry = ctx.reflect.get('tools')
      if (registry?.register && defineTool) {
        return registry.register(defineTool(tool))
      }
      // 路径 2（dsh 动态插件沙箱）：harness 作为 Builtin 注入
      const harness = globalThis.harness
      if (harness?.defineTool && harness?.registerTool) {
        return harness.registerTool(ctx, harness.defineTool(tool))
      }
      // 路径 3（裸 cordis，开发/CI）：落本地注册表，且注册动作包成 effect——
      // 插件卸载时工具自动回收，与 dsh 内注册表的生命周期语义对齐
      let disposer
      ctx.fiber.effect(() => {
        disposer = localTools.register(tool)
        return disposer
      }, `tool:${tool.name}`)
      return () => disposer?.()
    },

    async appendTrajectory(entry) {
      const record = { ...entry, _ts: new Date().toISOString() }
      // dsh 运行时：优先写入会话日志服务（若该服务存在）
      const sessions = ctx.reflect.get('sessions')
      if (sessions?.append) {
        await sessions.append({ type: 'saturday', ...record })
        return
      }
      // 裸 cordis：append-only JSONL，与 Trajectory 语义对齐（不可改、可回放）
      await mkdir(dirname(trajectoryPath), { recursive: true })
      await appendFile(trajectoryPath, JSON.stringify(record) + '\n')
    },
  }
}
