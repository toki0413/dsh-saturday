#!/usr/bin/env node
// Saturday MCP server stdio 入口。
// 环境变量：
//   SATURDAY_TRAJECTORY_PATH —— Trajectory 落盘路径（默认 <cwd>/saturday-data/trajectory.jsonl）
//   SATURDAY_DISABLE         —— 逗号分隔的插件名排除表（如 "plugin-mp,plugin-lammps"）
// 数据面自适应：有 Python + ASE 走 EMT 真物理，否则 lj-js 零依赖引擎（横幅如实）。
// stdio 传输下 stderr 之外的输出会污染协议——日志一律走 stderr。

import { startStdio } from './index.mjs'

const trajectoryPath = process.env.SATURDAY_TRAJECTORY_PATH || undefined
const disabled = new Set((process.env.SATURDAY_DISABLE ?? '').split(',').map(s => s.trim()).filter(Boolean))
const plugins = disabled.size
  ? (await import('./index.mjs')).PLUGIN_MANIFEST.filter(p => !disabled.has(p.name))
  : undefined

if (disabled.size) {
  process.stderr.write(`[saturday-mcp] plugins disabled by env: ${[...disabled].join(', ')}\n`)
}

const { shutdown } = await startStdio({ trajectoryPath, plugins })
process.stderr.write('[saturday-mcp] ready (stdio)\n')

// stdin 关闭（宿主退出）→ 优雅卸载（sidecar 收尸）
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
