// @toki0413/kernel —— 无宿主引导（bootstrap）。
// 职责：在没有 dsh harness 的进程（MCP server / CI / 脚本）里创建 cordis
// Context 并按序挂载插件，返回**聚合后的全量工具面**与统一 dispose。
// 防腐层边界：cordis 的 import 只发生在 kernel 包内（cordis-adapter.mjs 与
// 本文件）——宿主适配层（MCP server 等）只依赖 @toki0413/kernel 与插件包，
// 纪律从"唯一文件"收敛为"唯一包"，约束强度不变。
//
// 工具面聚合：每个插件的 createCordisAdapter 持有独立 LocalToolRegistry
// （工具注册走 fiber effect，插件卸载即从各自注册表回收）。本模块按
// duck-typing（对象含 .tools 且具备 describe/call）收集所有 fiber.store 上
// 的 rt，并把同名工具视为安装错误（工具名带 seam 前缀，冲突即污染）。

import { Context } from '@deepseek-ai/cordis'

function collectRts(fibers) {
  const rts = []
  for (const f of fibers) {
    for (const v of Object.values(f?.store ?? {})) {
      if (v && typeof v === 'object' && v.rt?.tools?.describe && v.rt?.tools?.call) {
        rts.push(v.rt)
      }
    }
  }
  return rts
}

/** 聚合注册表：describe/call/list 路由到工具所属插件的注册表 */
function aggregateTools(rts) {
  const routes = new Map()
  for (const rt of rts) {
    for (const t of rt.tools.describe()) {
      if (routes.has(t.name)) {
        throw new Error(`tool name collision across plugins: "${t.name}"（工具名带 seam 前缀，冲突即污染）`)
      }
      routes.set(t.name, rt.tools)
    }
  }
  return {
    describe: () => [...routes.keys()].length
      ? rts.flatMap(rt => rt.tools.describe()).filter(t => routes.has(t.name))
      : [],
    list: () => [...routes.keys()].map(name => {
      const full = routes.get(name).describe().find(t => t.name === name)
      return { name, description: full?.description }
    }),
    call: async (name, args) => {
      const registry = routes.get(name)
      if (!registry) {
        throw new Error(`Tool ${name} not found. Available: ${[...routes.keys()].join(', ')}`)
      }
      return registry.call(name, args)
    },
    size: () => routes.size,
  }
}

/**
 * 按序挂载插件。
 * @param {Array<{ name: string, apply: (ctx, config) => any, config?: object }>} plugins
 * @returns {{ fibers: any[], tools: Object, dispose: () => Promise<void> }}
 *   tools 为聚合全量工具面：describe()（含 parameters schema）/ call(name, args)
 */
export async function bootstrapPlugins(plugins) {
  const ctx = new Context()
  const fibers = []
  for (const p of plugins) {
    fibers.push(await ctx.registry.plugin({ name: p.name, apply: (ctx) => p.apply(ctx, p.config ?? {}) }))
  }
  const rts = collectRts(fibers)
  if (rts.length === 0) {
    throw new Error('bootstrapPlugins: no plugin exposed a runtime (expected fiber.store entries with .rt.tools)')
  }
  return {
    fibers,
    tools: aggregateTools(rts),
    async dispose() {
      // 与挂载顺序相反的方向卸载（先挂的后卸，消费方先于提供方消失）
      for (const f of [...fibers].reverse()) await f.dispose()
    },
  }
}
