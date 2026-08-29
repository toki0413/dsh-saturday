# DSH 适配清单（Phase 0 Spike 交付物）

**日期**: 2026-08-27 · **底座版本**: `@deepseek-ai/dsh@0.1.1-rc.2` / `@deepseek-ai/cordis@4.0.1`
**结论**: **Go** —— Bundle 机制可以承载计算类工具；裸 cordis 11/11 测试通过（v0.2 新增 ASE EMT 真物理、substitute 掺杂、workflow.screen 批量筛选），**且已在真实 dsh web 运行时完成 profile 级挂载验证（0 错误，sidecar 由 dsh 拉起，工具通过真实注册表校验）**。详见 §8 验收记录。

---

## 0. 硬性环境要求（实测踩出，最重要）

| 项 | 要求 | 证据 |
|---|---|---|
| **Node 版本** | **≥ 22（实测 v22.20.0 可用；Node 20 启动即崩）** | Node 20 下 dsh web 启动报：`createZstdDecompress`（node:zlib，22.15+）、`Promise.withResolvers`（22+）、`stripTypeScriptTypes`（node:module，22.6+）三个致命错误 |
| Python | ≥ 3.10 + numpy + scipy（MVP 计算器） | — |
| 安装体量 | ~445 个包（含 web 前端资产），弱网环境需 `fetch-retries 10 + network-concurrency 2` | 本沙箱装了三轮 |
| pnpm 本地包 | `pnpm add file:/path` 在本环境解析失败（pnpm 12 + 内网 registry mirror）；**改用手动编辑 profile `package.json` 的 dependencies + `pnpm install`**；变更 file: 依赖的 package.json 后需"先删再加"刷新快照 | 实测 |

## 1. 运行时形态（实测确认）

| 项 | 事实 |
|---|---|
| 安装 | `npm i @deepseek-ai/dsh`（CLI 仅 33KB，真实运行时为 ~445 个 `@deepseek-ai/dsh-*` 依赖包） |
| 启动 | `dsh web`（=`--profile web`）、`dsh --profile headless "job"`（无浏览器跑会话，适合 CI/演示） |
| profile | 目录含 `package.json`（`dsh.profile` manifest + `bundles` 列表 + **dependencies 声明插件包**）+ `cordis.patch.yml`（用户 patch 层） |
| 组合叠加 | bundles patch → profile patch → `$DSH_HOME/cordis.patch.yml` → `--patch` 指定层 |
| 插件安装 | 正式路径 `dsh plugin --profile <name> add <pkg>`（转发 pnpm）；本地开发包见 §0 |
| 配置检查 | `--dump-config` / `--dump-default-config`（不启动即可验证组合树，patch 行已确认入树） |
| 内核 | **`@deepseek-ai/cordis`（DeepSeek 命名空间）v4.0.1**，非 koishi 的 `cordis` 包——依赖声明必须用这个 |

## 2. 内核 API（@deepseek-ai/cordis@4.0.1，实测）

| 能力 | 真实 API | 备注 |
|---|---|---|
| 服务注册 | `ctx.reflect.provide(name, impl)` → 返回回收器 | 归属当前 fiber，卸载自动回收 ✅ 已验证 |
| 服务读取 | `ctx.reflect.get(name)` | 不存在返回 `undefined`；插件内推荐 `ctx.get()` 或 `inject` 声明 |
| 事件 | `ctx.events.on/emit/once/waterfall/serial/parallel` | waterfall 监听器末参为 `next`，须 `return next()` |
| 可逆效果 | `ctx.fiber.effect(fn, label?)` | fn 返回 disposer 或 disposer 迭代器；fiber dispose 时逆序回退 ✅ 已验证 |
| 插件挂载 | `ctx.registry.plugin({ name, inject?, apply })` → Fiber（thenable） | |
| 句柄外挂 | `ctx.fiber.store` | 见 §3 坑 1 |

## 3. 插件开发的关键坑（实测踩出）

1. **`apply` 只能返回 `undefined` 或 disposer/效果迭代器**。返回任意对象（如 `{ rt, service }`）会被当作 effect 而抛 `Invalid effect`。需要句柄外挂时用 `ctx.fiber.store`（本仓库测试即如此）。
2. **`async apply` 合法**（返回 `Promise<void>`），启动中的 await 不阻塞其他插件。
3. **工具注册必须包成 effect**。直接注册不进 fiber 生命周期，dispose 后工具残留（本仓库测试 8 曾因此失败）。dsh 的 `harness.registerTool` 自带生命周期；裸 cordis 的本地注册表需手动包 `ctx.fiber.effect`。
4. **动态插件（cordis_define 路线）是纯 JS 函数体**：禁止 `import/require`/TS/JSX；dsh 官方指南明确要求先用 `cordis_inspect_list/query` 查真实接口再写码，禁止凭服务名猜测 API。本 Spike 的代码全部以实测接口为准。
5. **timer 是服务不是全局**：`inject: ['timer']` 后用 `ctx.timeout/interval`；插件内禁用原生 `setTimeout`（动态插件沙箱无此全局）。Saturday 静态插件在 Node 域不受此限，但轮询类逻辑建议仍走 timer 服务以便统一诊断。

## 4. Agent 工具注册（三路径，全部实证）

**静态插件（npm 包，产品形态）——官方写法，已从 `@deepseek-ai/dsh-tool-todo` 源码提取并在真实运行时验证**：

```js
import { defineTool } from '@deepseek-ai/dsh-tools'

export default {
  name: 'my-plugin',
  inject: ['tools'],            // 或可选读取 ctx.reflect.get('tools')
  apply(ctx) {
    ctx.tools.register(defineTool({
      name: 'material.load',
      description: '…',
      // schema 方言：schemastery 扁平式（per-property required），
      // 且所有 object schema 必须显式写 additionalProperties: true|false
      // —— 缺省会抛 "unsupported JSON schema"（实测踩出）
      parameters: {
        query: { type: 'string', required: true, description: '化学式' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) { … },
    }))
  },
}
```

**动态插件（cordis_define 沙箱）**：`harness.registerTool(ctx, harness.defineTool({...}))`，`harness` 为注入的 Builtin。

**裸 cordis（CI）**：无 tools 注册表，防腐层落本地注册表。

防腐层 `kernel.registerTool` 按 `ctx.tools` 注册表 → `harness` Builtin → 本地注册表 顺序探测，三个环境同一套工具定义。✅ 路径 1 已在真实 dsh web 启动中通过注册表 schema 校验（0 错误）。

## 5. 长任务行为（Spike 核心验证项）

- 工具 `execute` 是普通 async 函数：2 秒模拟弛豫全程无超时、无阻塞其他事件 ✅
- Python sidecar 走 stdio JSON-lines，请求/响应按 id 配对，sidecar 崩溃时所有 pending 调用统一 reject ✅（测试 6/7 覆盖）
- **待 dsh 环境确认**：工具执行在 agent 循环中的超时上限、长任务在 Web UI 的进度呈现（`dsh-jobs-local` 包的存在暗示有 jobs 子系统，Phase 1 评估 `potential.relax` 是否应注册为 job 而非同步工具）
- 传输层 MVP 用 stdio 而非方案的 ZeroMQ：pyzmq 装不上（沙箱 PyPI 不可达）。接口已隔离，替换传输层不改业务代码。

## 6. 组合平面归属（依据官方 compositions 指南）

- `material` / `potential` 服务**跨会话共享** → host 平面（profile 的 `cordis.patch.yml` 用户层，本仓库 `profiles/cordis.patch.yml` 为示例）
- 若未来要"每会话独立材料空间"：工具行移入自定义 agent preset（`copy` 自 `standard`），服务行必须包进 `isolate: { material: true, potential: true }` 的 group——否则第二会话挂载时服务名冲突被拒（官方明确规则）
- 验证手段：preset 用 `agentPresets.standingKeyFor(id)` 挂载校验；host 组合用 `--dump-config`

## 7. Trajectory / 会话日志

- dsh 的 append-only 会话日志经 `sessions` 服务访问；防腐层 `appendTrajectory`：有 `sessions.append` 走真实日志，无则落 JSONL（语义对齐：不可改、可回放）✅
- **待确认**：`sessions.append` 的确切签名与写入后在 Trajectory 视图的呈现形式（需 dsh 运行实例，`cordis_inspect_query` 查 `sessions` 服务）
- `dsh-llm-mock-server@0.0.1-rc.1` 已发布：**M3 的 Agent 会话演示可以不需要真实 API Key**（mock LLM），在有网络的机器上验证

## 8. 验收记录（2026-08-27）

**A. 裸 cordis 环境**（`node --test test/`，11/11 通过；演示 `node demo.mjs` / `node demo-screening.mjs`）

| # | 验收项 | 结果 |
|---|---|---|
| 1 | Bundle 加载，material/potential 服务可用 | ✅ |
| 2 | Si → 金刚石 8 原子，谱系记录 resolver 来源 | ✅ |
| 3 | TiO2 多晶型：rank 0 金红石 / rank 1 锐钛矿 | ✅ |
| 4 | formula-only 无 resolver 显式报错（修订 #8） | ✅ |
| 5 | autoRoute：screening 选 emt-mock，validation 选 vasp（修订 #7） | ✅ |
| 6 | relax 经 Python sidecar 完成，Ar 走 LJ 兜底收敛（元素不在 EMT 范围自动路由） | ✅ |
| 7 | 工具调用 → 事件 → Trajectory 落盘 | ✅ |
| 8 | dispose 后服务/工具/sidecar 全部回收 | ✅ |
| 9 | **ASE EMT 真物理**：Cu 弛豫 a=3.590 Å（实验 3.615，偏差 0.7%），calculator='ase-emt' | ✅ |
| 10 | Material.substitute：Cu→Cu3Ag 不可变掺杂，谱系记录 substitute 事件，原对象不变 | ✅ |
| 11 | workflow.screen：pristine+2 掺杂变体批量弛豫，按 E/atom 排序，逐变体落 Trajectory | ✅ |

**B. 真实 dsh web 运行时（profile 级，Node v22.20.0）**

| # | 验收项 | 结果 |
|---|---|---|
| 9 | 组合树包含 saturday 行（`--dump-config`） | ✅ |
| 10 | `dsh web` 启动 0 错误，HTTP 200 | ✅ |
| 11 | 插件 apply 真实执行（Python sidecar 由 dsh 拉起，进程实证） | ✅ |
| 12 | 工具通过真实 `ctx.tools` 注册表的 schema 校验 | ✅（曾暴露 `additionalProperties` 硬性要求并修复） |

## 9. 未竟项（按优先级）

- [ ] **Agent 会话端到端**（自然语言 → material.load → relax）：需模型 key，或用已发布的 `dsh-llm-mock-server@0.0.1-rc.1` 做无 key 演示
- [ ] `sessions.append` 确切签名与 Trajectory 视图呈现（需运行实例内 `cordis_inspect_query` 查 `sessions` 服务）
- [ ] 长任务与 `dsh-jobs-local` 的关系：relax 是否应注册为 job 而非同步工具（Phase 1 评审）
- [x] ~~ASE EMT 替换 LJ 玩具势~~ ✅ 已完成（v0.2）：sidecar 按结构元素逐调用路由——全 EMT 元素（Al/Cu/Ag/Au/Ni/Pd/Pt）走 ASE 真物理，其余走 LJ 兜底；Cu 掺杂筛选排序与实验冶金学一致
- [ ] 工具结果卡片 `render` 定制（material 摘要/结构图）
- [ ] 严格热力学筛选：形成焓相对凸包（当前 EMT 零点恰为元素平衡 fcc，E/atom 近似形成焓）

## 10. 对 v3.3 方案的反馈（Spike 结论 → 文档修订建议）

1. **环境前提新增：Node ≥ 22**（§0），写入附录 C 开发环境搭建与 CI 矩阵。
2. 附录 A 依赖项：`cordis` 应改为 **`@deepseek-ai/cordis`**（DeepSeek 命名空间，v4.0.1）；新增 `@deepseek-ai/dsh-tools`（defineTool）。
3. kernel 接口需增加 `tools` 三路径注册与 `appendTrajectory` 双写策略（本仓库 `cordis-adapter.mjs` 已是参考实现，经真实运行时验证）。
4. "工具即 effect"应写入 Phase 1 Week 5-6 验收标准（本 Spike 测试 8 的由来）。
5. `apply` 返回值约束（§3.1）与 schema 方言要求（§4，`additionalProperties` 显式化）应写入 Phase 1 开发规范。
6. profile 插件解析：本地包必须声明在 profile `package.json` dependencies；`dsh plugin add` 对本地路径的支持待上游确认（当前有绕过方案，§0）。
