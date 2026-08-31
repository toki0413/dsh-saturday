// Phase 0 Spike 端到端演示
// 模拟 Agent 会话（无 LLM，工程链路演示）：
//   "加载 Ar 并弛豫" → material.load → potential.relax → 事件 → Trajectory
// 环境自适应：有 Python 走 EMT sidecar；纯 Node 走零依赖 lj-js 引擎（横幅如实声明）。
// 运行：node demo.mjs

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import plugin from './src/saturday.plugin.mjs'

const line = (s = '') => console.log(s)
const step = s => console.log(`\n\x1b[36m▸ ${s}\x1b[0m`)

const ctx = new Context()
const fiber = await ctx.registry.plugin({
  name: 'saturday',
  apply: ctx => plugin.apply(ctx, {}),
})
const { rt } = fiber.store.saturday

step('Bundle 已加载，Agent 可见工具：')
for (const t of rt.tools.list()) console.log(`  - ${t.name}: ${t.description.slice(0, 40)}…`)

step('用户: "帮我加载 Ar 晶体"')
const loaded = await rt.tools.call('material.load', { query: 'Ar' })
line(`  → materialId=${loaded.materialId.slice(0, 8)}…  atoms=${loaded.nAtoms}  来源=${loaded.structureOrigin.source}`)

step('用户: "弛豫它"（模拟 2 秒计算，演示长任务）')
const t0 = Date.now()
const relaxed = await rt.tools.call('potential.relax', {
  materialId: loaded.materialId, simulatedSeconds: 2,
})
line(`  → 收敛=${relaxed.converged}  E=${relaxed.energy.toFixed(5)} eV  缩放=${relaxed.scale?.toFixed(4) ?? '—'}  步数=${relaxed.n_steps}  引擎=${relaxed.engine}  (总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s)`)

step('Trajectory（append-only 溯源日志）：')
await new Promise(r => setTimeout(r, 100))
const traj = (await readFile(fileURLToPath(new URL('./data/trajectory.jsonl', import.meta.url)), 'utf8'))
  .trim().split('\n').map(JSON.parse)
for (const entry of traj) {
  line(`  [${entry._ts}] ${entry.type}  ${entry.material?.formula ?? ''}  E=${entry.result?.energy?.toFixed(5) ?? '-'}  engine=${entry.engine ?? '-'}`)
}

await fiber.dispose()
step('Bundle 已卸载：服务与工具全部回收 ✓')
