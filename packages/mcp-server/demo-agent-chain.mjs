#!/usr/bin/env node
// 面向 Agent 开发者的端到端演示：一个无头 MCP 客户端经真·stdio 协议驱动 Saturday，
// 跑一条"成分稳定性发现闭环"并打印任何 MCP 宿主里的 agent 都会看到的调用面。
// 这是 demo:fullchain 的协议层翻版——区别只在：不 import 插件，纯靠 tools/list + tools/call，
// 也就是 Claude Desktop / Cursor 等宿主里 LLM 所面对的同一张工具面（这里用确定性脚本代替 LLM 决策）。
// 链尾当场演示一次"拒绝伪造"：EMT/LJ 不声明应力时 analysis.elasticity 显式失败，而非硬编一个数。
//
// 运行：npm run demo --workspace @toki0413/mcp-server
// 数据面自适应：有 Python+ASE 走 EMT 真物理；纯 Node 走零依赖 lj-js（LJ 玩具势，定性演示档）。

import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const cliPath = fileURLToPath(new URL('./src/cli.mjs', import.meta.url))
const dir = await mkdtemp(join(tmpdir(), 'saturday-agent-'))
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cliPath],
  env: { ...process.env, SATURDAY_TRAJECTORY_PATH: join(dir, 'trajectory.jsonl') },
  stderr: 'pipe',
})
const client = new Client({ name: 'agent-demo', version: '0.0.1' })
await client.connect(transport)

const call = async (tool, args = {}) => {
  const r = await client.callTool({ name: tool, arguments: args })
  const payload = JSON.parse(r.content[0]?.text ?? '{}')
  return { isError: r.isError === true, payload }
}
const step = (n, title) => console.log(`\n── ${n} · ${title}`)

console.log('══ Saturday：一个 agent 经 MCP 驱动材料发现闭环 ══')

// 0) 工具面：agent 先发现能力（runtime.capability.list + tools/list）
step('0', '发现工具面（tools/list）')
const { tools } = await client.listTools()
const groups = {}
for (const t of tools) (groups[t.name.split('.')[0]] ??= []).push(t.name)
console.log(`共 ${tools.length} 个工具：` + Object.entries(groups).map(([k, v]) => `${k}(${v.length})`).join('  '))
const caps = await call('runtime.capability.list')
console.log(`数据面在册引擎：${caps.payload.engines.map(e => `${e.name}(${e.available === false ? '不可用' : 'ok'})`).join(', ')}`)
// 锁定“当前激活的数据面引擎”来算声子：EMT 档→emt-mock（真物理），纯 Node→lj-js（玩具势，仅定性）。
// 不写死引擎名，否则零依赖机上会因 emt-mock 不在场而崩——这正是 agent 先查能力再显式选引擎的价值。
const activeEngine = caps.payload.engines.find(e => e.isActive)?.name ?? caps.payload.engines[0]?.name

// 1) 物质输入
step('1', 'material.load —— 载入基体 Cu')
const host = await call('material.load', { query: 'Cu' })
console.log(`基体：${host.payload.formula}  nAtoms=${host.payload.nAtoms}  id=${host.payload.materialId.slice(0, 8)}…`)

// 2) 采样（sampler seam：OU 受控扩散，exact 提议似然）
step('2', 'sampler.ou —— 生成候选（n=3, T=300K）')
const smp = await call('sampler.ou', { referenceId: host.payload.materialId, n: 3, temperatureK: 300 })
console.log(`采样：${smp.payload.n} 个候选  likelihood=${smp.payload.likelihood}（语义如实声明，不称唯一解）`)

// 3) 掺杂筛选 + 联合排序
step('3', 'workflow.screen —— 掺杂 Ag/Ni/Pt + 采样候选联合排序')
const scr = await call('workflow.screen', {
  materialId: host.payload.materialId,
  dopants: ['Ag', 'Ni', 'Pt'],
  sampled: smp.payload.candidates.map(c => ({ graph: c.graph, source: c.source, logProb: c.logProb })),
  sampledSource: 'sampler.ou',
  temperatureK: 300, samplerTemperatureK: 300,
})
console.log(`排序交付 ${scr.payload.ranked.length} 项，联合排序参与 ${scr.payload.sampledJoint?.entries?.length ?? 0} 条`)
for (const r of scr.payload.ranked.slice(0, 3)) {
  console.log(`   ${r.label.padEnd(16)} E/atom=${r.energyPerAtom?.toFixed(4)} eV`)
}

// 4) 声子稳定性（Top 候选，显式锁激活引擎）
step('4', 'analysis.phonon —— Top-2 候选动力学稳定性（engine=' + activeEngine + '）')
for (const r of scr.payload.ranked.slice(0, 2)) {
  if (!r.materialId) { console.log(`   ${r.label}: 无 materialId，诚实跳过`); continue }
  const ph = await call('analysis.phonon', { materialId: r.materialId, engine: activeEngine })
  console.log(`   ${r.label.padEnd(16)} verdict=${ph.payload.stability.verdict}  虚频=${ph.payload.imaginary.count}  (calc=${ph.payload.calculator})`)
}

// 5) 谱系登记：结论 ← 来源，可回放可失效
step('5', 'derivation.record —— 登记结论来源（活性上下文谱系）')
const ref = 'result:agent-demo-cu-x'
await call('derivation.record', {
  inputs: [`material:${host.payload.materialId}`], output: ref, producer: 'demo:agent-chain',
})
const st = await call('derivation.status', { ref })
console.log(`   ${ref} → ${st.payload.status ?? JSON.stringify(st.payload)}`)

// 6) 当场演示"拒绝伪造"：默认引擎无应力 → elasticity 显式失败，不硬编
step('6', 'analysis.elasticity —— 无应力引擎时显式拒绝（不做近似替代）')
const elas = await call('analysis.elasticity', { materialId: host.payload.materialId })
if (elas.isError) {
  console.log(`   isError=${elas.isError}  code=${elas.payload.code}  ← 拒绝伪造，而非给一个没应力源硬算的 C_ij`)
  console.log(`   （解锁：挂载 MACE 常驻 batch 档 runtime.engine.attach {plugin:'mace', config:{resident:true}}）`)
} else {
  console.log(`   C11=${elas.payload.gpa?.c11?.toFixed(1)} GPa（在场应力引擎）`)
}

console.log('\n══ 闭环经 MCP 协议跑通；每个数可回放，不可得处显式拒绝 ══')

await client.close()
await rm(dir, { recursive: true, force: true })
