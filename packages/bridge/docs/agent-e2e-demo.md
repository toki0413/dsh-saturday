# 让一个 Agent 经 MCP 跑通材料发现闭环（agent 开发者向）

**一句话:** 这不是"又一个能算材料的脚本",而是**一张 36 工具的 MCP 面 + 一个会拒绝伪造、每个数可回放的运行时**。给做科学 Agent 的人:你的 agent 不用重写求解器,直接调度这些工具,拿到的每个结论都带引擎指纹和可回放的推导谱系。

## 两条路,都先给证据

### A. 零 LLM 的确定性证明(2 分钟,任何人可复现)
一条命令,起一个无头 MCP 客户端经**真·stdio 协议**驱动整条发现链(与宿主里的 LLM 面对的是同一张工具表,这里用脚本代替决策):

```bash
npm run demo --workspace @toki0413/mcp-server
```

实测输出(本机 Python+ASE 在场 → EMT 真物理档):

```
共 35 个工具：material(1) structure(1) potential(1) engine(1) runtime(3)
             derivation(3) analysis(4) workflow(4) trajectory(1) sampler(16)
数据面在册引擎：emt-mock(ok), ase(ok), lj-js(ok), mace(ok)
1 · material.load   基体：Cu nAtoms=4
2 · sampler.ou      采样 3 候选  likelihood=exact（不称唯一解）
3 · workflow.screen Cu3Pt -0.1005 eV/atom < pristine < Cu3Ni   （联合排序参与 3 条）
4 · analysis.phonon Cu3Pt stable 虚频0 (calc=emt-mock) / pristine stable 虚频0
5 · derivation.record result:agent-demo-cu-x → valid
6 · analysis.elasticity isError=true code=ELASTICITY_STRESS_MISSING ← 当场拒绝伪造
```

> 第 0 步无 `MP_API_KEY` 时 `structure.resolve` 不注册 = 35 工具(有 key 则 36)——工具面随环境如实收缩,不摆一个注定失败的工具。

### B. 你自己的宿主里,让 LLM 驱动
任何 MCP 宿主(Claude Desktop / Cursor / Cline)配置:

```json
{
  "mcpServers": {
    "saturday-materials": { "command": "npx", "args": ["-y", "@toki0413/mcp-server"] }
  }
}
```

丢给它这句话,看它自己把闭环走下来:

> "用 Cu 基体,采样几个候选再对 Ag/Ni/Pt 做掺杂筛选并联合排序,把最稳的两个候选跑一下 Γ 点声子判动力学稳定性,最后把结论按谱系登记。弹性张量也顺手给我。"

预期:它 `tools/list` → `material.load` → `sampler.ou` → `workflow.screen` → `analysis.phonon` → `derivation.record`;到"弹性张量"这步,在没有应力引擎的机器上它会**拿到一个结构化失败**(`ELASTICITY_STRESS_MISSING`)而不是一个假数——好的 agent 会据此改口去挂 MACE 或如实报告"此环境算不了"。

## 为什么不是手搓 ASE 脚本——三个只有运行时才给的东西

1. **跨引擎不可瞎拼。** 单位三元组与能力指纹入注册门禁(M1);把 LJ 玩具势的能量和 MACE 的能量混进同一条凸包/排序,会被显式拒绝,而不是静默出一个"看着合法、物理无意义"的结论。
2. **结论可回放、可失效。** 每个结果落 append-only Trajectory(`trajectory.replay`),并声明来源(`derivation.record`);上游换了引擎或指纹实测升级(`refingerprinted`),下游导出量自动标 stale——审计链是运行时自带的,不是脚本里的注释。
3. **诚实是默认,不是加分项。** 采样器显式声明似然可求值性(exact/none)与"逆解是采样不是唯一解";玩具势标注在先;缺应力/缺凭据即显式失败,不降级不伪造。

## 它不是什么(别误导)

- **lj-js 是 LJ 玩具势**:纯 Node 回退档只保证"闭环与门禁跑通",能量数值无定量意义;要定量数字请装 Python+ASE(EMT)或挂 MACE。第 4 步在 lj-js 档会显式定性交付。
- **弹性张量对文献的定量对账**需要应力源引擎(MACE 常驻 batch 档:`runtime.engine.attach {plugin:'mace', config:{resident:true}}`),不是开箱 LJ 能给——这正是第 6 步拒绝伪造想让你看到的边界。
- **没有"点开即用"的托管**:要么本地 `npx`(需 Node ≥ 22),要么自备宿主;托管 `run.tools` 端点无 Python,只剩 lj-js 演示档。

## 配套
- 确定性版(直接 import 插件、同一 Context 组合):`npm run demo:fullchain --workspace @toki0413/bridge`
- 验收判据:`packages/bridge/docs/benchmark.md`
