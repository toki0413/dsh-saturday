# Saturday AGENTS.md

> 本文件为 AI Agent 提供仓库导航、构建命令、核心约束与契约入口。
> 创建后 Agent 应优先阅读本文件，避免从零探索仓库。

## 仓库定位

Saturday 是**材料计算的插件运行时**（非求解器替代品）。一切功能以插件形式挂载于 DeepSeek Harness (dsh) / Cordis v4 上，由 Agent 自由调度。

- **唯一官方宿主**：dsh（DeepSeek Harness）
- **开发/CI 模式**：裸 cordis（同一内核，非另一宿主）
- **npm 包命名**：`@toki0413/*`（核心包）+ `@toki0413/plugin-*`（插件）
- **版本**：v0.3.4

## 核心模块地图

```
packages/
  kernel/          → @toki0413/kernel         防腐层：全仓唯一接触 cordis 的文件
  core/            → @toki0413/core           领域模型（Material / Potential / StructureResolver）
  python-bridge/   → @toki0413/python-bridge  通用 Python sidecar 客户端
  contract-tests/  → @toki0413/contract-tests  五条 seam 契约测试套件
  bridge/          → @toki0413/bridge         dsh Bundle 主插件 + 全部演示脚本
  mcp-server/      → @toki0413/mcp-server     MCP 协议 server（36 工具 stdio）
  data/            → @toki0413/data           运行时数据（JSONL 轨迹等）

plugins/           → 各独立插件（新插件必须过 contract-tests）
  screening/       →   批量掺杂筛选
  sampler-ou/      →   OU 采样 + 锚点工具链（最大插件，含 12 个测试文件）
  sampler-flow/    →   仿射耦合流采样
  sampler-perturb/ →   参考结构微扰采样
  ase/             →   通用 ASE 计算器引擎
  lammps/          →   LAMMPS 批处理引擎
  mace/            →   MACE ML 势引擎
  lennard-jones/   →   零依赖纯 JS LJ 引擎（优雅回退档）
  mp-structure-source/ → Materials Project 远端结构解析
  derivation/      →   活性上下文：失效传播与惰性重算
  replay/          →   Trajectory 回放与索引重建
  rss/             →   RSS 随机结构搜索采样（§4.5 非 flow 生成式第二实证）
  neb/             →   NEB 势垒分析
  eos/             →   Birch-Murnaghan 状态方程
  phonon/          →   Γ 点声子
  elasticity/      →   6×6 弹性张量（Born 判据 + VRH，应力源能力门禁）
  explore/         →   采样→回算闭环
  ergodic/         →   遍历对账
  free-energy/     →   构型自由能曲线

scripts/
  summary/         → 摘要机械汇编（npm run summary → SUMMARY.md/.json）
  pack-check.mjs   → 发布形态核验
```

## 构建与测试命令

| 命令 | 作用 |
|------|------|
| `npm install` | 安装全部 workspace 依赖 |
| `npm test` | 全量测试（`npm test --workspaces --if-present`，一次遍历全部 workspace） |
| `npm run summary` | 再生项目摘要（实跑测试 + 提取契约实证表） |
| `node scripts/pack-check.mjs` | 发布形态核验（逐包 pack 干跑） |
| `npm run demo --workspace @toki0413/bridge` | 基础端到端演示 |
| `npm run demo:agent --workspace @toki0413/bridge` | Agent 十阶段端到端（mock LLM） |
| 单包测试 | `cd plugins/sampler-ou && npm test` |

**环境要求**：Node >= 22。纯 Node 即可跑全部演示（无 Python 时自动回退 lj-js）。

**执行纪律**：回归与摘要脚本必须串行执行（`--test-concurrency=1`），禁止多 workspace 并发。23 包同时 `node --test` 并行跑测试文件会导致内存峰值溢出。正确做法：
```powershell
# 逐包串行（推荐）
npm test --workspaces --if-present --foreground-scripts
# 或单包内显式串行
cd plugins/sampler-ou; node --test --test-concurrency=1 "test/*.test.mjs"
```

## 插件契约入口

- **契约文档**：`packages/bridge/docs/plugin-contract-v0.md`（中文）/ `.en.md`（英文）
- **契约测试套件**：`packages/contract-tests/src/index.mjs` — 5 条 seam：
  `structureResolver` / `potentialProvider` / `workflow` / `sampler` / `derivation`
- **注册方式**：插件 `src/index.mjs` 导出 `apply(ctx)` 函数，通过 `ctx.registerTool` / `ctx.registerWorkflow` 等挂载

## 关键架构约束

1. **防腐层纪律**：插件代码只依赖 `@saturday/kernel` 的 SaturdayRuntime 接口；禁止直接 `import` cordis / dsh。
2. **DSH 单宿主押注**：裸 cordis 不是另一宿主，仅是开发/CI 模式。
3. **单位与能力指纹入契约**：引擎注册即校验单位三元组与能力指纹；换算只能由调用方显式发起。
4. **热力学诚实**：能量零点显式声明，不可得时降级并明说。
5. **采样语义**：逆解是采样而非求逆；似然可求值性显式声明；候选必须可回算验证。
6. **摘要可再生**：SUMMARY.md 机械汇编，不手写不人工维护。
7. **双通道事件流**：瀑布事件（全序接力/时间维）+ 广播事件（一对多/空间维）。
8. **可逆性边界**：可逆的是决策上下文，物理过程不可逆，计算结果不可变。

## 代码风格

- **扩展名**：ESM `.mjs`（非 `.js`、非 `.ts`），`package.json` 顶层 `"type": "module"`
- **Windows 兼容**：文件路径使用 `fileURLToPath(import.meta.url)` 而非 `URL.pathname`
- **测试框架**：`node:test`（Node 内置），断言用 `node:assert/strict`
- **测试 glob**：Windows 下 `node --test` 使用 glob 模式（`test/*.test.mjs`）而非目录路径
- **零运行时外部依赖**：core / kernel / plugins 禁止引入非 devDependencies 的外部包

## 新插件 Checklist

1. 在 `plugins/<name>/` 创建，package.json name 为 `@toki0413/plugin-<name>`
2. 根 `package.json` workspaces 自动覆盖（`packages/*` + `plugins/*`）
3. 导出 `apply(ctx)` 入口
4. 编写契约测试（使用 `@toki0413/contract-tests` 对应 seam）
5. 确保 `npm test` 全量通过
6. 执行 `npm run summary` 更新摘要与附录 A
