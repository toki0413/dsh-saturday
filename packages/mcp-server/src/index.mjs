// @toki0413/mcp-server —— Saturday 工具面的 MCP 协议投影。
// 职责：无宿主引导（kernel/bootstrapPlugins）挂载全部插件 → 聚合工具面 →
// 逐工具注册为 MCP tool。 SaturdayTool 的 parameters（JSON Schema 形态，键 →
// { type, description, default? }）转 Zod raw shape（SDK 1.30 要求），类型集
// 有限（string/number/boolean/array/object），未知类型显式报错（诚实纪律：
// 静默放宽 schema = 让宿主对参数形态产生错误预期）。
// 错误语义：工具抛错（Saturday 的结构化错误码）→ MCP isError 响应携带
// { error, code }——不静默、不吞错；调用方（LLM）能读到失败原因。
// 防腐层边界：本包不 import cordis（引导走 @toki0413/kernel/bootstrap）；
// 插件仍只依赖 @toki0413/kernel。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { bootstrapPlugins } from '@toki0413/kernel/bootstrap'

import bridgePlugin from '@toki0413/bridge'
import pluginAse from '@toki0413/plugin-ase'
import pluginDerivation from '@toki0413/plugin-derivation'
import pluginEos from '@toki0413/plugin-eos'
import pluginErgodic from '@toki0413/plugin-ergodic'
import pluginExplore from '@toki0413/plugin-explore'
import pluginFreeEnergy from '@toki0413/plugin-free-energy'
import pluginLammps from '@toki0413/plugin-lammps'
import pluginLj from '@toki0413/plugin-lj'
import pluginMace from '@toki0413/plugin-mace'
import pluginMp from '@toki0413/plugin-mp'
import pluginNeb from '@toki0413/plugin-neb'
import pluginPhonon from '@toki0413/plugin-phonon'
import pluginReplay from '@toki0413/plugin-replay'
import pluginSamplerFlow from '@toki0413/plugin-sampler-flow'
import pluginSamplerOu from '@toki0413/plugin-sampler-ou'
import pluginSamplerPerturb from '@toki0413/plugin-sampler-perturb'
import pluginScreening from '@toki0413/plugin-screening'

/** 全量插件清单（bridge = core 运行时先行，其余按字母序） */
export const PLUGIN_MANIFEST = [
  { name: 'saturday', apply: bridgePlugin.apply },
  { name: 'plugin-ase', apply: pluginAse.apply },
  { name: 'plugin-derivation', apply: pluginDerivation.apply },
  { name: 'plugin-eos', apply: pluginEos.apply },
  { name: 'plugin-ergodic', apply: pluginErgodic.apply },
  { name: 'plugin-explore', apply: pluginExplore.apply },
  { name: 'plugin-free-energy', apply: pluginFreeEnergy.apply },
  { name: 'plugin-lammps', apply: pluginLammps.apply },
  { name: 'plugin-lj', apply: pluginLj.apply },
  { name: 'plugin-mace', apply: pluginMace.apply },
  { name: 'plugin-mp', apply: pluginMp.apply },
  { name: 'plugin-neb', apply: pluginNeb.apply },
  { name: 'plugin-phonon', apply: pluginPhonon.apply },
  { name: 'plugin-replay', apply: pluginReplay.apply },
  { name: 'plugin-sampler-flow', apply: pluginSamplerFlow.apply },
  { name: 'plugin-sampler-ou', apply: pluginSamplerOu.apply },
  { name: 'plugin-sampler-perturb', apply: pluginSamplerPerturb.apply },
  { name: 'plugin-screening', apply: pluginScreening.apply },
]

const SERVER_INFO = { name: 'saturday', version: '0.3.0' }

/** 单个参数定义 → Zod（类型集有限，未知类型显式报错） */
function zodFor(def, key) {
  let base
  switch (def?.type) {
    case 'string': base = z.string(); break
    case 'number': base = z.number(); break
    case 'integer': base = z.number().int(); break
    case 'boolean': base = z.boolean(); break
    case 'array':
      base = z.array(def.items ? zodFor(def.items, `${key}[]`) : z.unknown())
      break
    case 'object':
      base = def.properties ? z.object(jsonToZodShape(def.properties)) : z.record(z.unknown())
      break
    default:
      throw new Error(`tool parameter "${key}": unsupported type "${def?.type}"（诚实纪律：未知类型显式报错而非放宽 schema）`)
  }
  return base
}

/** SaturdayTool.parameters（JSON Schema 形态）→ Zod raw shape（导出供测试门禁） */
export function jsonToZodShape(parameters) {
  const shape = {}
  for (const [key, def] of Object.entries(parameters ?? {})) {
    if (!def || typeof def !== 'object') {
      throw new Error(`tool parameter "${key}": definition must be an object`)
    }
    let base = zodFor(def, key)
    if (def.description) base = base.describe(def.description)
    if (def.default !== undefined) base = base.default(def.default)
    else base = base.optional()
    shape[key] = base
  }
  return shape
}

/**
 * 构建 Saturday MCP server（不连接传输层——测试用 InMemory，CLI 用 stdio）。
 * @param {{ trajectoryPath?: string, plugins?: Array, env?: object }} options
 * @returns {{ mcp: McpServer, boot: object, toolNames: string[] }}
 */
export async function createSaturdayMcpServer(options = {}) {
  const plugins = options.plugins ?? PLUGIN_MANIFEST
  const boot = await bootstrapPlugins(plugins.map(p => ({
    name: p.name,
    apply: p.apply,
    config: { trajectoryPath: options.trajectoryPath },
  })))

  const mcp = new McpServer(SERVER_INFO)
  const toolNames = []
  for (const tool of boot.tools.describe()) {
    const inputSchema = jsonToZodShape(tool.parameters)
    mcp.registerTool(tool.name, { description: tool.description, inputSchema }, async (args) => {
      try {
        const result = await boot.tools.call(tool.name, args ?? {})
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        // Saturday 结构化错误 → MCP isError 约定：错误码与消息都给调用方（不静默）
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: err.message, code: err.code ?? null }) }],
        }
      }
    })
    toolNames.push(tool.name)
  }
  return { mcp, boot, toolNames }
}

/** stdio 入口：连接 StdioServerTransport，SIGINT/SIGTERM 优雅卸载（sidecar 先于进程退出收尸） */
export async function startStdio(options = {}) {
  const { mcp, boot } = await createSaturdayMcpServer(options)
  const transport = new StdioServerTransport()
  await mcp.connect(transport)
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    try { await mcp.close() } catch { /* 连接可能已断 */ }
    await boot.dispose()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return { shutdown }
}
