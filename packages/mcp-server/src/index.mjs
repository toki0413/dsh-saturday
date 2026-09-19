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
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { bootstrapPlugins } from '@toki0413/kernel/bootstrap'

import bridgePlugin from '@toki0413/bridge'
import pluginAse from '@toki0413/plugin-ase'
import pluginDerivation from '@toki0413/plugin-derivation'
import pluginElasticity from '@toki0413/plugin-elasticity'
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
import pluginRss from '@toki0413/plugin-rss'
import pluginSamplerFlow from '@toki0413/plugin-sampler-flow'
import pluginSamplerOu from '@toki0413/plugin-sampler-ou'
import pluginSamplerPerturb from '@toki0413/plugin-sampler-perturb'
import pluginScreening from '@toki0413/plugin-screening'
import pluginXrd from '@toki0413/plugin-xrd'

/** 全量插件清单（bridge = core 运行时先行，其余按字母序） */
export const PLUGIN_MANIFEST = [
  { name: 'saturday', apply: bridgePlugin.apply },
  { name: 'plugin-ase', apply: pluginAse.apply },
  { name: 'plugin-derivation', apply: pluginDerivation.apply },
  { name: 'plugin-elasticity', apply: pluginElasticity.apply },
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
  { name: 'plugin-rss', apply: pluginRss.apply },
  { name: 'plugin-sampler-flow', apply: pluginSamplerFlow.apply },
  { name: 'plugin-sampler-ou', apply: pluginSamplerOu.apply },
  { name: 'plugin-sampler-perturb', apply: pluginSamplerPerturb.apply },
  { name: 'plugin-screening', apply: pluginScreening.apply },
  { name: 'plugin-xrd', apply: pluginXrd.apply },
]

const SERVER_INFO = { name: 'saturday', version: '0.3.8' }

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
    else if (def.required !== true) base = base.optional()
    // required: true 不包 optional()——契约声明的必填语义直通宿主（缺参由 MCP schema
    // 校验显式拒绝，而非流入领域层报出难以归因的业务错）；诚实纪律同款：
    // schema 不得对宿主撒谎
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
  const boot = await bootSaturday(options)
  const { mcp, toolNames } = buildMcpServer(boot)
  return { mcp, boot, toolNames }
}

/** 引导全部插件（宽容挂载）——stdio 一次性；http 全局一次多会话共享 */
export async function bootSaturday(options = {}) {
  const plugins = options.plugins ?? PLUGIN_MANIFEST
  const boot = await bootstrapPlugins(
    plugins.map(p => ({ name: p.name, apply: p.apply, config: { trajectoryPath: options.trajectoryPath } })),
    // 宽容挂载：环境不可用的插件（如无 ASE 时 plugin-ase 挂载即校验失败）显式
    // 报告并跳过，工具面相应收缩——server 整体可用性优先于单插件强求
    { onMountError: (name, err) => process.stderr.write(`[saturday-mcp] plugin "${name}" not mounted: ${err.message}\n`) },
  )
  return boot
}

/** 已 boot 的工具面 → 一个 McpServer 实例（http 每会话新建，共享同一 boot） */
export function buildMcpServer(boot) {
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
  return { mcp, toolNames }
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

/** 读 POST 体为 JSON（node:http 无内置 body parser，不引 express） */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : undefined) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

/**
 * streamable-http 入口：让任意远程 MCP 宿主（无需本地安装）经 HTTP 接入同一工具面。
 * 会话态：全局只 boot 一次（多会话共享 boot，避免每会话重起 Python sidecar），每 session 新建一个
 * McpServer + StreamableHTTPServerTransport。仅用 node 内置 http（零外部依赖）。
 * 诚实：无 Python 的部署上工具面同样收缩到 lj-js 演示档（同 ModelScope 判定）。
 * @param {{ port?:number, host?:string, path?:string } & object} options
 */
export async function startHttp(options = {}) {
  const { port = 3000, host = '127.0.0.1', path = '/mcp' } = options
  const boot = await bootSaturday(options)
  const sessions = new Map() // sessionId -> { mcp, transport }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          ok: true, server: SERVER_INFO.name, transport: 'streamable-http',
          endpoint: path, tools: boot.tools.describe().length,
        }))
        return
      }
      if (url.pathname !== path) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return }
      const sid = req.headers['mcp-session-id']
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        if (!sid) {
          // 无 session → 视为 initialize：新建一个会话的 mcp + transport
          const { mcp } = buildMcpServer(boot)
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => { sessions.set(id, { mcp, transport }) },
          })
          transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); mcp.close().catch(() => {}) }
          await mcp.connect(transport)
          await transport.handleRequest(req, res, body)
          return
        }
        const s = sessions.get(sid)
        if (!s) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'no such session' })); return }
        await s.transport.handleRequest(req, res, body)
        return
      }
      if (req.method === 'GET' || req.method === 'DELETE') {
        const s = sid && sessions.get(sid)
        if (!s) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'missing or invalid mcp-session-id' })); return }
        await s.transport.handleRequest(req, res)
        if (req.method === 'DELETE') sessions.delete(sid)
        return
      }
      res.writeHead(405, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'method not allowed' }))
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(err?.message || err) }))
    }
  })
  await new Promise((resolve) => server.listen(port, host, resolve))
  const addr = server.address()
  const shutdown = async () => {
    for (const { mcp, transport } of sessions.values()) {
      try { await transport.close() } catch { /* 已断 */ }
      try { await mcp.close() } catch { /* 已断 */ }
    }
    sessions.clear()
    await new Promise((r) => server.close(r))
    await boot.dispose()
  }
  process.stderr.write(`[saturday-mcp] streamable-http ready on http://${host}:${addr?.port ?? port}${path}\n`)
  return { host, port: addr?.port ?? port, path, url: `http://${host}:${addr?.port ?? port}${path}`, sessions, shutdown }
}
