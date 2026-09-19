#!/usr/bin/env node
// Saturday MCP server 入口（stdio 缺省；--http 或 SATURDAY_MCP_TRANSPORT=http 走 streamable-http）。
// 环境变量：
//   SATURDAY_TRAJECTORY_PATH —— Trajectory 落盘路径（默认 <cwd>/saturday-data/trajectory.jsonl）
//   SATURDAY_DISABLE         —— 逗号分隔的插件名排除表（如 "plugin-mp,plugin-lammps"）
//   SATURDAY_MCP_TRANSPORT   —— 'stdio'（缺省）| 'http'
//   SATURDAY_MCP_PORT / SATURDAY_MCP_HOST / SATURDAY_MCP_PATH —— http 模式监听（缺省 3000 / 127.0.0.1 / /mcp）
// 数据面自适应：有 Python + ASE 走 EMT 真物理，否则 lj-js 零依赖引擎（横幅如实）。
// stdio 传输下 stderr 之外的输出会污染协议——日志一律走 stderr。

import { startStdio, startHttp, PLUGIN_MANIFEST } from './index.mjs'

const trajectoryPath = process.env.SATURDAY_TRAJECTORY_PATH || undefined
const disabled = new Set((process.env.SATURDAY_DISABLE ?? '').split(',').map(s => s.trim()).filter(Boolean))
const plugins = disabled.size
  ? PLUGIN_MANIFEST.filter(p => !disabled.has(p.name))
  : undefined

if (disabled.size) {
  process.stderr.write(`[saturday-mcp] plugins disabled by env: ${[...disabled].join(', ')}\n`)
}

const httpMode = process.argv.includes('--http') || (process.env.SATURDAY_MCP_TRANSPORT || '').toLowerCase() === 'http'

if (httpMode) {
  const port = Number(process.env.SATURDAY_MCP_PORT || 3000)
  const host = process.env.SATURDAY_MCP_HOST || '127.0.0.1'
  const path = process.env.SATURDAY_MCP_PATH || '/mcp'
  const { url, shutdown } = await startHttp({ trajectoryPath, plugins, port, host, path })
  process.stderr.write(`[saturday-mcp] ready (streamable-http) ${url}\n`)
  const bye = async () => { await shutdown(); process.exit(0) }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
} else {
  const { shutdown } = await startStdio({ trajectoryPath, plugins })
  process.stderr.write('[saturday-mcp] ready (stdio)\n')
  // stdin 关闭（宿主退出）→ 优雅卸载（sidecar 收尸）
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
}
