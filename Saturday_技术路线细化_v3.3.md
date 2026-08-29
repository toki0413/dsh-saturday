# Saturday 技术路线细化
## 基于 DeepSeek Harness (DSH) 的实施蓝图

**版本**: v3.3
**日期**: 2026-08-27
**状态**: 详细技术设计（v3.1 评审修订版，v3.3 补设计原则）
**底座**: DeepSeek Harness (dsh) / Cordis v4

---

## 修订说明

### v3.3 相对 v3.2 的变更

| # | 变更 | 动因 |
|---|---|---|
| 17 | 新增第 2.1 节「设计原则：Spatiotemporal Composability 与原子化操作」，将上层蓝图的两条核心概念显式承接进技术路线，并按"近期承诺 / 远期方向"分级表述 | v3.1 起概念名词丢失，顶层叙事与技术里程碑断层；写回但不恢复不现实的承诺 |

其余内容同 v3.2。

### v3.2 相对 v3.1 的变更

v3.2 在 v3.1 评审基础上修订，DSH 作为产品既定底座，修订重点是：**把对底座的依赖从"隐性押注"变为"显性治理"，把过满的排期改为有资源支撑的计划，修正若干概念性技术缺陷**。

| # | 变更 | 动因 |
|---|---|---|
| 1 | 新增第 0 章「底座策略」：版本锁定 + 防腐层 + 上游跟踪机制 | DSH 于 2026-08-13 发布开发者预览版，官方明确"将有破坏性兼容变更"[^1^]，全案最大外部依赖必须有治理策略 |
| 2 | 新增 Phase 0 底座验证 Spike（2 周） | 投入 24 周开发前，先跑通 "Agent 工具调用 → 真实计算 → 事件回流" 最小闭环 |
| 3 | 新增第 1 章「资源与团队计划」 | v3.1 无人力/预算假设，可行性无从评估 |
| 4 | 新增「竞品定位与技术复用」一节 | 回答"为什么不是 AiiDA/atomate2"，明确差异化 |
| 5 | Phase 2 重排：多尺度映射降级为文件导出；实验闭环拆出为独立研究轨 Track X（不设周数承诺） | 原 16 周范围含三个研究项目级任务，不现实 |
| 6 | 首次外部用户从 Week 56 提前至 Week 26（Alpha 内测，3-5 个合作课题组） | 方向验证前置，避免 Phase 2-3 空转 |
| 7 | 修正 `scoreProvider` 评分公式方向性错误 | 原公式 `1/speed` 奖励慢引擎，与设计意图相反 |
| 8 | formula→graph 改为显式 `StructureResolver` 服务，含多晶型处理 | 化学式本身不含结构信息，v3.1 实现依赖隐式假设 |
| 9 | electronic view 从同步 getter 改为异步计算产物 | 电子结构是 DFT 计算结果，不是廉价视图 |
| 10 | 可逆效果改用 Cordis `ctx.effect` 真实语义，限定软件资源域；物理设备操作走审批 + 审计 | 物理世界无事务回滚；`ctx.effect` 的语义是"插件卸载时自动回退"[^2^]，不是手动全局回滚 |
| 11 | 新增 HPC/Slurm 集成设计 + 大对象存储策略（第 13 章） | v3.1 最大工程空白 |
| 12 | 存储栈简化：PostgreSQL 统一承载，Neo4j 推迟至 Phase 3 按需引入，弃用 TimescaleDB | 降低小团队运维负担 |
| 13 | CI 改用 mock 计算器（ASE EMT）+ 自托管 runner 跑真实引擎 | GitHub 托管 runner 不可能持有 VASP license |
| 14 | DSH API 对齐真实接口（Bundle / Trajectory / PTC / approval / `ctx.tools`），替换 v3.1 中推测的 `@dsh/*` 包名 | v3.1 代码基于臆想 API，无法落地 |
| 15 | 异构编码器改为接入现成预训练模型，验收标准改为检索指标 Recall@10 | 4 周从零训练多模态模型不现实 |
| 16 | Phase 5 补商业论证与合规（VASP BYOL、出口管制、数据完整性；删除 HIPAA）；ARR 目标改为发布后 18 个月 | 原"8 周 10 客户 100 万 ARR"无支撑；HIPAA 与材料软件无关 |

---

## 目录

0. [底座策略：DSH 依赖治理](#0-底座策略dsh-依赖治理)
1. [资源与团队计划](#1-资源与团队计划)
2. [技术架构总览](#2-技术架构总览)
   - [2.1 设计原则：Spatiotemporal Composability 与原子化操作](#21-设计原则spatiotemporal-composability-与原子化操作)
3. [竞品定位与技术复用](#3-竞品定位与技术复用)
4. [Phase 0: 底座验证 Spike（Week 1-2）](#4-phase-0-底座验证-spikeweek-1-2)
5. [Phase 1: 核心运行时（Week 3-26）](#5-phase-1-核心运行时week-3-26)
6. [Phase 2: 多引擎与 HPC 规模化（Week 27-42）](#6-phase-2-多引擎与-hpc-规模化week-27-42)
7. [Phase 3: DSH 融合与 Agent 集成（Week 43-58）](#7-phase-3-dsh-融合与-agent-集成week-43-58)
8. [Phase 4: DSL 与智能检索（Week 59-74）](#8-phase-4-dsl-与智能检索week-59-74)
9. [Phase 5: 生态与商业化（Week 75-98）](#9-phase-5-生态与商业化week-75-98)
10. [Track X: 实验闭环专项（独立研究轨）](#10-track-x-实验闭环专项独立研究轨)
11. [数据模型详细设计](#11-数据模型详细设计)
12. [事件协议详细规范](#12-事件协议详细规范)
13. [HPC/Slurm 集成与大对象存储](#13-hpcslurm-集成与大对象存储)
14. [API 接口设计](#14-api-接口设计)
15. [性能基准与测试策略](#15-性能基准与测试策略)
16. [技术债务管理](#16-技术债务管理)
17. [风险缓解与回退方案](#17-风险缓解与回退方案)

---

## 0. 底座策略：DSH 依赖治理

### 0.1 底座事实

- DSH（DeepSeek Harness）由 DeepSeek AI 开发，2026-08-13 以 MIT 协议开源，安装形态为 `npx @deepseek-ai/dsh web`，TypeScript/Node.js 运行时[^1^]。
- 底层为 Cordis v4 插件内核：插件贡献服务（Service）、类型化事件（typed events）与可逆效果（reversible effects）到共享 Context；模型适配、工具注册表、会话日志、Agent 循环本身都是插件[^2^]。
- 组合机制：Profile（命名组合）→ Bundle（`package.json` 中 `dsh.bundle` 字段声明的分发格式）→ patch 层（`cordis.patch.yml`，后层覆盖前层）[^3^]。
- 关键能力：append-only Trajectory 会话日志（resume / fork / replay）、四种预设模式（Standard / PTC / Minimal / Creator）、沙箱策略、人工审批（approval）。
- **官方明示：当前为开发者预览版，迭代迅速，将存在破坏性兼容变更[^1^]。**

### 0.2 治理策略

DSH 是产品既定底座，"脱离 DSH 自研"不是选项。风险治理改为以下四条：

**（1）版本锁定 + 受控升级**

```jsonc
// package.json —— 锁定精确版本，不用 ^ 范围
{
  "dependencies": {
    "@deepseek-ai/dsh": "0.1.0-rc.6",   // 精确锁定
    "cordis": "4.x.x"                    // 随 dsh 锁定的传递版本对齐
  }
}
```

- 升级节奏：每 4 周评估一次上游新版本，在独立分支完成适配后合入，不追最新。
- 每次升级跑「底座兼容测试集」（见 Phase 0 交付物），作为升级准入门禁。

**（2）防腐层（Anti-Corruption Layer）**

Saturday 领域代码不直接 import Cordis/DSH API，全部经由 `@saturday/kernel` 适配层：

```typescript
// packages/kernel/src/runtime.ts
// Saturday 领域代码只依赖这个接口，不依赖 cordis 类型
export interface MateriaRuntime {
  registerService(name: string, impl: unknown): EffectHandle;
  emit(event: MateriaEvent): Promise<void>;
  on(eventType: string, handler: EventHandler): EffectHandle;
  registerTool(tool: MateriaTool): EffectHandle;
  requestApproval(req: ApprovalRequest): Promise<ApprovalResult>;
  appendTrajectory(entry: TrajectoryEntry): Promise<void>;
}

// packages/kernel/src/cordis-adapter.ts
// 唯一允许 import 'cordis' / '@deepseek-ai/dsh' 的文件
export class CordisRuntimeAdapter implements MateriaRuntime {
  constructor(private ctx: Context) { /* ... */ }
  // DSH 上游 API 变更时，只改这一个文件
}
```

上游破坏性变更的影响面被收敛到 `cordis-adapter.ts` 一个文件，这是对冲预览期风险的核心手段。

**（3）能力接缝（Seam）对齐**

DSH 的能力组织方式是 seam：Service Definition（接口）+ Service Provider（实现）+ Consumer（注入方）[^3^]。Saturday 的核心抽象按同构设计——`PotentialProvider` 就是一个 seam（接口 = `PotentialProvider`，实现 = VASP/LAMMPS/MACE Provider，消费方 = 工作流/Agent 工具）。这使 Saturday 的引擎热插拔直接复用 Cordis 的挂载/卸载/依赖追踪机制，而非自建一套。

**（4）上游协同**

- 指定 1 名工程师跟踪 dsh 仓库（Discussions / release notes），每周同步。
- 适配层中发现的 Cordis 缺陷，优先向上游提 issue/PR，避免私下 fork 累积分叉。

---

## 1. 资源与团队计划

### 1.1 团队配置（分阶段到位）

| 角色 | 职责 | Phase 0-1 | Phase 2 | Phase 3 | Phase 4-5 |
|---|---|---|---|---|---|
| TS 平台工程师 ×2 | kernel 适配层、核心服务、API、DSL | 2 | 2 | 2 | 2 |
| 计算材料工程师 ×1-2 | Provider 实现、计算正确性、参数模板 | 1 | 2 | 2 | 1 |
| HPC 工程师 ×1 | Slurm 集成、调度、存储 | — | 1 | 1 | 1 |
| ML/全栈工程师 ×1 | Python bridge、检索模型、Web UI | 1 | 1 | 1 | 1 |
| 产品/开发者关系 ×1 | 内测运营、文档、商业化 | — | — | 0.5 | 1 |
| **合计** | | **4** | **6** | **6.5** | **6** |

### 1.2 预算锚点（年）

| 项 | 估算 | 说明 |
|---|---|---|
| 人力 | 按上表 | — |
| HPC 算力 | 5-15 万 GPU 卡时 | 开发自测 + 内测用户消耗，MACE 筛选用本地 GPU 工作站可降本 |
| VASP license | 已有（假设） | 云服务阶段需 BYOL 方案，见 Phase 5 |
| 云基础设施 | 开发期 < 1 万/月 | Postgres + Redis + MinIO + CI runner |
| LLM API | 按 token | Agent 工作流消耗，PTC 模式可显著降本 |

### 1.3 里程碑与外部验证节奏

| 节点 | 时间 | 验证动作 |
|---|---|---|
| Week 2 | Phase 0 末 | Spike 通过/不通过评审：**不通过则暂停投入，回到底座评估** |
| Week 26 | Alpha | 3-5 个合作材料课题组内测，收集真实工作流反馈 |
| Week 42 | Phase 2 末 | 内测用户跑通高通量筛选真实课题 |
| Week 58 | Beta | 公开测试，目标 20+ 外部团队安装 |
| Week 98 | 1.0 + 商业化启动 | 见 Phase 5 商业论证 |

---

## 2. 技术架构总览

### 2.1 设计原则：Spatiotemporal Composability 与原子化操作

这两条是上层蓝图的核心概念，也是 Saturday 的顶层架构原则。v3.1 细化为技术路线时丢失了概念名词，造成顶层叙事与技术里程碑的断层；本节将其显式承接，**并按"近期承诺 / 远期方向"分级表述**——概念认领，但不恢复已被评审否定的过度承诺。后续所有章节均可回溯到这两条原则。

#### 原则一：Spatiotemporal Composability（时空可组合性）

材料研发的对象与过程，沿空间与时间两个维度可自由组合。

**空间维（跨尺度组合）**：同一材料对象在原子 / 电子 / 连续介质尺度间切换视图、传递数据。

| 级别 | 形态 | 落点 |
|---|---|---|
| 近期（本路线图内，**承诺**） | 视图抽象：`atomicView` 为内联廉价视图，`electronicView` 为异步计算产物；跨尺度数据导出：MD 轨迹 → 位移/应力场 → ABAQUS/VTK，保证数据正确、格式正确、可溯源 | Phase 1 Week 7-9；Phase 2 Week 35-36；第 11 章 |
| 远期（Track X / 2.0，**不承诺**） | 自动跨尺度耦合（MD → 相场的物理映射，含位错/损伤变量传递） | 属研究问题，由 Track X 阶段门或后续版本评估 |

**时间维（跨时刻组合）**：研发过程是一条可在任意时刻挂起、恢复、分叉、回放的事件流，昨天的计算可以与今天的实验、明天的 Agent 决策自由衔接。

| 级别 | 形态 | 落点 |
|---|---|---|
| 近期（**已落地支撑**） | 类型化事件协议；DSL DAG 编排；DSH Trajectory（append-only，原生 resume / fork / replay）；计算溯源与 `inputHash` 幂等 | 第 12 章；Phase 4 Week 59-62；Phase 3 Week 43-46；第 11 章 |
| 远期 | 跨会话、跨团队的过程级组合（研究项目的分叉与合并，类似 git 之于代码） | 1.0 后评估 |

#### 原则二：原子化操作（Atomic Operations）

一切研发动作分解为可独立调用、自由组合的原语；"原子性"按作用域分级，不一刀切。

**组合性（核心承诺，已落地）**：`relax` / `calculate` / `simulate` 等原语经 `PotentialProvider` seam 统一抽象（Phase 1 Week 10-11），同一组原语同时暴露给三种消费方——DSL 阶段（Phase 4）、Agent 工具（Phase 3）、编程 API（第 14 章）。这是"自然语言与声明式 DSL 双入口"成立的结构基础。

**原子性（分级）**：

| 作用域 | 语义 | 机制 | 落点 |
|---|---|---|---|
| 软件资源域 | 完全可逆 | Cordis `ctx.effect`：服务注册、事件监听、临时资源随插件卸载自动回退 | Phase 1 Week 5-6、19-22 |
| 计算任务域 | 幂等 + 可取消，不承诺"回滚已完成的计算" | `inputHash` 去重命中缓存；任务可 cancel 且无孤儿进程；失败按 TIMEOUT/OOM/NODE_FAIL 分级重试 | 第 11、13 章 |
| 物理设备域 | **永不回滚** | 审批 + 审计日志 + 参数白名单 + 硬件急停旁路 | Track X 安全红线（第 10 章） |

#### 两条原则的相互支撑

时空可组合性定义了"组合什么"（跨尺度的对象、跨时刻的过程），原子化操作定义了"用什么组合"（原语及其作用域语义）。Agent 工作流（Phase 3）正是二者交汇处的消费方：它在时间维上编排原子原语，在空间维上经由视图与导出工具跨尺度传递数据。

### 2.2 技术栈分层（修订）

```
+------------------------------------------------------------------+
|                        用户界面层 (UI Layer)                       |
|  dsh Web UI (复用)  |  CLI (materia)  |  Jupyter Extension        |
+------------------------------------------------------------------+
|                        API 网关层 (API Gateway)                    |
|  REST API  |  WebSocket (实时事件流)                               |
|  ※ GraphQL 推迟：无明确消费方，YAGNI                               |
+------------------------------------------------------------------+
|                        运行时层 (Runtime Layer)                    |
|  +----------------------+  +----------------------+              |
|  |   DSH Bundle 域       |  |  Saturday Bundle 域  |              |
|  |  agent loop / tools  |  |  material / potential |              |
|  |  sessions / approval |  |  workflow / retrieval |              |
|  +----------------------+  +----------------------+              |
|  +----------------------------------------------------------+   |
|  |        @saturday/kernel  (防腐层, 唯一接触 cordis 的包)   |   |
|  +----------------------------------------------------------+   |
+------------------------------------------------------------------+
|                        计算桥接层 (Compute Bridge)                 |
|  Python Sidecar (FastAPI+ZeroMQ)  |  ASE/Pymatgen Adapter        |
+------------------------------------------------------------------+
|                        调度与存储层 (Scheduling & Storage)          |
|  BullMQ (控制面)  |  Slurm Adapter (计算面)  |  PostgreSQL        |
|  Redis (队列/事件)  |  MinIO/S3 (轨迹/大文件)                      |
+------------------------------------------------------------------+
|                        基础设施层 (Infrastructure)                 |
|  HPC (Slurm)  |  Cloud (AWS)  |  Lab (文件导入 → OPC-UA, Track X) |
+------------------------------------------------------------------+
```

### 2.3 关键技术选型理由（修订）

| 组件 | 选型 | 备选 | 理由 |
|---|---|---|---|
| 运行时底座 | DSH / Cordis v4 (TypeScript) | — | **既定底座**；一切 Agent 能力即插件，Trajectory 天然承载计算溯源 |
| 计算桥接 | Python Sidecar + ZeroMQ | gRPC | 材料计算生态 100% 在 Python（ASE/Pymatgen/VASP/LAMMPS）；TS 控制面 + Python 数据面是被底座选择决定的架构，须显式承认并控制其代价（双语维护、序列化开销） |
| 任务队列（控制面） | BullMQ (Redis) | Celery | TS 生态一致；只管排队/优先级/重试，不管算力调度 |
| 算力调度（计算面） | Slurm Adapter | 云 Batch | 见第 13 章，这是 v3.1 缺失的核心拼图 |
| 主数据库 | PostgreSQL 16 (+JSONB) | Neo4j + TimescaleDB | 材料、计算记录、谱系、事件遥测全部可承载；运维单一 |
| 图数据库 | 推迟至 Phase 3 按需评估 | Neo4j | 仅当"多跳谱系查询/知识推理"被内测用户验证为刚需时引入 |
| 时序数据 | Postgres 分区表 | TimescaleDB | 事件/遥测量级（百万行/年）无需专用时序库 |
| 大对象存储 | MinIO / S3 | 共享文件系统 | MD 轨迹、CHGCAR 等 GB 级文件，见第 13 章 |
| 前端框架 | 复用 dsh Web UI + React 扩展 | 独立前端 | dsh Web UI 已提供会话/Trajectory/审批界面，自建部分只做材料可视化（Three.js） |
| 容器编排 | Docker Compose | Kubernetes | 初期简单，云服务阶段再迁移 |

---

## 3. 竞品定位与技术复用

### 3.1 现有格局

| 项目 | 定位 | 与 Saturday 的关系 |
|---|---|---|
| **AiiDA** | 计算材料工作流引擎，provenance 图谱成熟，Python 原生 | 谱系/provenance 设计直接借鉴；可作为计算后端被 Python bridge 适配（可选集成） |
| **atomate2 / FireWorks** | 高通量工作流（VASP 等），jobflow 体系 | 工作流语义的参照系；Saturday DSL 的 forward pipeline 与其对齐 |
| **ASE** | 原子模拟环境，计算器抽象 | 直接复用，Python bridge 的核心依赖 |
| **A-Lab (Berkeley)** | 自主实验室闭环 | Track X 的对标，非 96 周内的竞争目标 |
| **dsh 社区插件生态** | Agent 工具/技能插件 | Saturday 以 Bundle 形态进入该生态，获取 Agent 侧分发 |

### 3.2 差异化陈述（写入对外材料）

> 现有材料计算工作流引擎（AiiDA/atomate2）解决了"计算的可重复性与高通量"，但入口仍是代码与命令行。Saturday 的差异是 **Agent 原生**：材料、计算、实验数据全部暴露为 Agent 可理解的工具与事件，自然语言与声明式 DSL 双入口，且计算全生命周期落入 DSH Trajectory，实现"每一次计算决策可追溯、可回放、可分叉"。

### 3.3 复用决策

- **不重造**：结构解析（ASE/pymatgen）、工作流语义（对齐 atomate2 概念）、会话/审批 UI（复用 dsh）。
- **自建**：Material 领域模型、PotentialProvider seam、HPC 适配层、材料知识检索。

---

## 4. Phase 0: 底座验证 Spike（Week 1-2）

### 4.1 目标

在承诺后续 96 周投入之前，用 2 周验证全案最大的技术未知数：**DSH Agent 能否经由我们开发的 Bundle，驱动一次真实材料计算并把结果回流入会话**。

### 4.2 任务

**Deliverable**: 最小端到端原型（允许硬编码、允许丑陋）

```
dsh web (锁定版本)
  └── materia-spike Bundle (packages/spike/)
        ├── tool: material.load      # 硬编码返回 Si 原胞
        ├── tool: potential.relax    # 调 Python sidecar -> ASE EMT relax
        └── listener: 计算完成 -> 写入 Trajectory
```

**步骤**:
1. 按 dsh 官方文档创建一个 Bundle（`package.json` 声明 `dsh.bundle` 字段），用 Creator 模式在内存中试验插件组合[^3^]。
2. 实现一个工具（tool），确认工具 schema、执行管线、权限/审批的实际行为。
3. Python sidecar 用 ASE 内置 EMT 计算器对 Si 原胞做 relax（**不依赖 VASP license**）。
4. 计算完成后将结果写入会话，确认在 Trajectory 视图中可检索、可回放。
5. 输出《DSH 适配清单》：记录实际 API 形态（tool 注册、事件订阅、审批请求、Trajectory 写入的确切签名），作为 `@saturday/kernel` 防腐层的接口依据。

**验收标准（Go / No-Go）**:
- [ ] Bundle 被 dsh 正常加载与卸载，卸载后注册完全回退（验证 Cordis effect 语义）
- [ ] Agent 会话中自然语言触发 relax，返回能量/晶胞参数
- [ ] 结果出现在 Trajectory 视图，可 resume 继续对话
- [ ] 《DSH 适配清单》完成，kernel 接口定义评审通过
- [ ] **No-Go 处理**：若 Bundle 机制无法承载计算类工具（如长任务、二进制数据），暂停项目，带证据回到产品层面重新决策

---

## 5. Phase 1: 核心运行时（Week 3-26）

### 5.1 目标

构建可运行的 Saturday 容器，实现 `material` 与 `potential` 两个核心 seam；Week 26 发布 Alpha 并启动**3-5 个合作课题组内测**。

### 5.2 详细任务分解

#### Week 3-4: 项目脚手架

**Deliverable**: 可编译的 TypeScript monorepo

```
saturday/
├── packages/
│   ├── kernel/                  # @saturday/kernel —— 防腐层（唯一 import cordis 的包）
│   │   ├── src/
│   │   │   ├── runtime.ts       # MateriaRuntime 接口
│   │   │   ├── cordis-adapter.ts
│   │   │   └── index.ts
│   ├── core/                    # @saturday/core
│   │   ├── src/
│   │   │   ├── material.ts      # Material + StructureResolver
│   │   │   ├── potential.ts     # PotentialRegistry (seam)
│   │   │   ├── events.ts
│   │   │   └── index.ts
│   ├── engines/emt-mock/        # @saturday/engines-emt —— CI 用 mock Provider
│   ├── engines/vasp/
│   ├── engines/lammps/
│   └── bridge/                  # @saturday/dsh-bridge (dsh Bundle)
├── python-bridge/
│   ├── saturday_bridge/
│   │   ├── server.py            # ZeroMQ 服务端
│   │   ├── adapters/            # emt / vasp / lammps
│   │   └── parsers/             # poscar / outcar / cif
│   └── pyproject.toml
├── docker/
├── docker-compose.yml           # postgres / redis / minio
└── turbo.json
```

**技术决策**:
- Turborepo + pnpm 管理 monorepo；TypeScript `strict: true`
- 依赖锁定：DSH/Cordis 精确版本（见第 0 章）
- **从第一天起提供 EMT mock Provider**：除引擎适配外的全部开发、CI、演示都不依赖真实 VASP/LAMMPS

**验收标准**:
- [ ] `pnpm install && pnpm build && pnpm test` 全绿
- [ ] EMT Provider 通过 Provider 接口全部契约测试

#### Week 5-6: Cordis 容器与 kernel 适配层

**Deliverable**: Saturday 作为 dsh Bundle 可加载，服务注册符合 Cordis 生命周期

```typescript
// packages/kernel/src/cordis-adapter.ts
// 唯一允许 import cordis 的文件
import { Context, Service } from 'cordis';

export class CordisRuntimeAdapter implements MateriaRuntime {
  constructor(private ctx: Context) {}

  registerService(name: string, impl: unknown): EffectHandle {
    // Cordis 语义：服务注册即 effect，插件卸载时自动回退[^2^]
    this.ctx.set(name, impl);
    return { dispose: () => this.ctx.delete(name) };
  }

  on(eventType: string, handler: EventHandler): EffectHandle {
    const listener = (data: unknown) => handler(data);
    this.ctx.on(eventType, listener);
    return { dispose: () => this.ctx.off(eventType, listener) };
  }

  // emit / registerTool / requestApproval / appendTrajectory
  // 按 Phase 0《DSH 适配清单》确认的真实签名实现
}
```

**验收标准**:
- [ ] Bundle 加载/卸载 100 次循环无泄漏（effect 回退验证）
- [ ] `material`、`potential` 服务经 kernel 注册后可被其他插件注入
- [ ] 上游版本升级演练：切换 dsh 版本，仅 `cordis-adapter.ts` 需要改动

#### Week 7-9: Material 对象模型（修订）

**Deliverable**: `Material` 类支持多模态输入与统一图表示，**结构来源显式化**

```typescript
// packages/core/src/material.ts
export interface MaterialModality {
  text?: string;
  formula?: string;
  smiles?: string;
  file?: { path: string; format: 'cif' | 'poscar' | 'xyz' };
  graph?: AtomGraph;
}

// 新增：结构解析 seam —— 化学式本身不含结构信息，必须显式声明来源
export interface StructureResolver {
  readonly name: string;  // 'prototype-lib' | 'materials-project' | 'generative'
  resolve(formula: string): Promise<ResolvedStructure[]>;
}

export interface ResolvedStructure {
  graph: AtomGraph;
  source: string;           // 'mp-149' | 'prototype:A1' | ...
  polymorphRank: number;    // 同化学式多晶型排序（能量/数据库稳定性）
  energyAboveHull?: number; // 若来自 MP，记录相稳定度
}

export class Material {
  readonly id: string;
  readonly modalities: MaterialModality;
  private _graph: AtomGraph;
  private _lineage: LineageNode[];

  // 构建统一图表示：file/graph 直接解析；formula 必须经 Resolver
  static async create(
    data: MaterialData,
    resolver?: StructureResolver,
  ): Promise<Material> {
    if (data.modalities.graph) return new Material(data, data.modalities.graph);
    if (data.modalities.file)  return new Material(data, parseStructureFile(data.modalities.file));
    if (data.modalities.formula) {
      if (!resolver) throw new Error(
        'Formula-only construction requires a StructureResolver ' +
        '(prototype-lib | materials-project | generative)'
      );
      const candidates = await resolver.resolve(data.modalities.formula);
      if (candidates.length === 0) throw new StructureNotFoundError(data.modalities.formula);
      // 默认取最稳定晶型；多晶型场景由调用方显式选择（见 Workflow API）
      const chosen = candidates[0];
      const m = new Material(data, chosen.graph);
      m._lineage.push({
        operation: 'structure-resolved',
        detail: { source: chosen.source, polymorphRank: chosen.polymorphRank },
        timestamp: Date.now(),
      });
      return m;
    }
    throw new Error('No valid modality provided');
  }

  // 多尺度视图：atomic 是廉价视图；electronic/continuum 不是
  get atomicView(): AtomicView {
    return new AtomicView(this._graph);
  }

  // 修正（v3.1 缺陷 #9）：电子结构是 DFT 计算产物，走异步计算管线
  async electronicView(
    potential: PotentialRegistry,
    params?: BandParams,
  ): Promise<ElectronicView> {
    const calc = await potential.calculate(this, {
      properties: ['bandgap', 'dos'],
      ...params,
    });
    return new ElectronicView(calc);
  }

  fork(operation: string): Material { /* 同 v3.1，谱系复制 */ }
}
```

**验收标准**:
- [ ] 从 CIF 创建 < 100ms；formula 创建必须经 Resolver 且记录来源
- [ ] `Si` 经原型库解析为金刚石结构（2 原子原胞），谱系含 `structure-resolved`
- [ ] 多晶型用例（如 `TiO2`）返回多个候选，调用方可指定 `polymorphRank`
- [x] ASE 互转精度测试通过（2026-08-29：sidecar `roundtrip` 算子 + `@saturday/python-bridge` 测试，三斜晶胞/无理坐标逐位无损；pymatgen 腿待入依赖集）
- [x] 调用 `electronicView` 产生一条 CalculationRecord（而非同步返回）（2026-08-29：记录 + 谱系 `electronic-calculated` 条目；未声明性质由 `assertCalculable` 门禁显式拒绝，绝不静默返回 null）

#### Week 10-11: PotentialRegistry（seam 化，修正评分公式）

**Deliverable**: Provider 注册/热替换/自动路由，按 Cordis seam 语义实现

```typescript
// packages/core/src/potential.ts
export interface PotentialProvider {
  readonly name: string;
  readonly version: string;

  manifest: {
    capabilities: ProviderCapability[];  // accuracy/speed/cost 均归一化 [0,1]，语义统一为"越大越好/越贵"
    constraints: ResourceConstraints;
  };

  calculate(structure: Material, params?: CalcParams): Promise<EnergyResult>;
  relax(structure: Material, params?: RelaxParams): Promise<Material>;
  simulate(structure: Material, params?: SimParams): Promise<Trajectory>;

  // 生命周期由 Cordis 管理：mount 内注册的效果在 unmount 时自动回退
  mount(ctx: Context): Promise<void>;
  unmount(ctx: Context): Promise<void>;
}

export class PotentialRegistry {
  private providers = new Map<string, PotentialProvider>();
  private activeProvider?: string;

  async activate(name: string): Promise<void> {
    // 修正（v3.1 缺陷 #10）：切换引擎不再"rollbackAll"。
    // 正在运行的任务属于任务域，不受引擎切换影响；
    // Provider 挂载的资源由 Cordis effect 在 unmount 时精确回退。
    if (this.activeProvider === name) return;
    const provider = this.providers.get(name);
    if (!provider) throw new Error(`Provider ${name} not found`);

    await this.preflight(provider);   // 前置检查：license 可用性、可执行文件、资源
    await provider.mount(this.ctx);
    this.activeProvider = name;
  }

  private async preflight(provider: PotentialProvider): Promise<void> {
    // license 是"前置门禁"而不是"可逆效果"——VASP 站点 license 无法挂载/卸载，
    // 只能检查可用性并在不可用时拒绝或排队
    if (provider.manifest.constraints.requiresLicense) {
      const ok = await this.checkLicense(provider.name);
      if (!ok) throw new LicenseUnavailableError(provider.name);
    }
  }

  // 任务画像决定权重：筛选要吞吐，验证要精度
  private static readonly WEIGHT_PROFILES = {
    screening:  { accuracy: 0.2, speed: 0.5, cost: 0.3 },
    validation: { accuracy: 0.7, speed: 0.1, cost: 0.2 },
    balanced:   { accuracy: 0.4, speed: 0.3, cost: 0.3 },
  } as const;

  autoRoute(task: Task): PotentialProvider {
    const w = WEIGHT_PROFILES[task.profile ?? 'balanced'];
    const candidates = [...this.providers.values()].filter(p => this.canHandle(p, task));
    if (candidates.length === 0) throw new NoCapableProviderError(task.type);
    return candidates.sort((a, b) => this.score(b, task, w) - this.score(a, task, w))[0];
  }

  private score(p: PotentialProvider, task: Task, w: Weights): number {
    const caps = p.manifest.capabilities.find(c => c.type === task.type);
    if (!caps) return 0;
    // 修正（v3.1 缺陷 #7）：原公式 accuracy*0.4 + (1/speed)*0.3 + (1/cost)*0.3
    // 中 speed 语义为"越大越快"，取倒数后慢引擎反而得分更高。
    // 验证：VASP(0.95,0.3,0.9) vs MACE(0.8,0.95,0.3)，screening 权重下
    // 修正后 MACE=0.16+0.475+0.21=0.845 > VASP=0.19+0.15+0.03=0.37 ✓
    return caps.accuracy * w.accuracy
         + caps.speed    * w.speed
         + (1 - caps.cost) * w.cost;
  }
}
```

**验收标准**:
- [ ] 注册 4 个 Provider（emt-mock, vasp, lammps, mace）
- [ ] 热切换 < 1s，且切换不影响已在运行的任务（回归测试）
- [ ] 自动路由：screening 画像选 MACE，validation 画像选 VASP（单元测试固化）
- [ ] license 不可用时返回结构化错误并可配置排队策略

#### Week 12-15: VASP Provider 实现

**Deliverable**: 完整 VASP Provider，支持 relax 与 static；**license 前置检查；环境溯源**

```typescript
// packages/engines/vasp/src/provider.ts
export class VaspProvider implements PotentialProvider {
  readonly name = 'vasp';
  readonly version = '6.4.0';

  manifest = {
    capabilities: [{
      type: 'dft',
      accuracy: 0.95, speed: 0.3, cost: 0.9, maxAtoms: 500,
    }],
    constraints: {
      requiresLicense: true,
      supportedPotentials: ['PAW_PBE', 'PAW_LDA'],
    },
  };

  async calculate(structure: Material, params?: CalcParams): Promise<EnergyResult> {
    const input = this.buildInput(structure, params);
    // 提交到计算面（Phase 1 为本地子进程；Phase 2 切换为 Slurm，接口不变）
    const job = await this.ctx.compute.submit({
      engine: 'vasp',
      input,
      resources: { cores: params?.cores ?? 32, walltime: params?.walltime ?? '24:00:00' },
    });
    return this.parseResult(await job.result());
  }

  private buildInput(structure: Material, params?: CalcParams): VaspInput {
    return {
      poscar: this.toPoscar(structure),
      incar: { ENCUT: params?.encut ?? 520, ISMEAR: 0, SIGMA: 0.05, ...params?.custom },
      kpoints: this.generateKpoints(structure, params?.kspacing ?? 0.2),
    };
  }
}
```

**环境溯源（新增，计算可重复性的底线）**：每条 `CalculationRecord` 必须记录——引擎版本、赝势版本（POTCAR 哈希）、输入文件哈希（INCAR/POSCAR/KPOINTS）、容器镜像 digest、Slurm job id。没有这些，"结果可复现"不成立。

**验收标准**:
- [ ] Si 单胞 relax，能量收敛 < 1 meV/atom，与直接运行 VASP 结果一致
- [ ] 环境溯源字段完整写入 CalculationRecord
- [ ] VASP 失败返回结构化错误（含 OUTCAR 尾部摘录）；临时文件自动清理
- [ ] 同一输入重复提交命中结果缓存（输入哈希幂等）

#### Week 16-18: LAMMPS Provider 实现

同 v3.1 设计，补充两点：
- 轨迹文件（GB 级）不落 Postgres，写对象存储，`TrajectoryRef` 仅存对象 key + checksum + 帧元数据索引（见第 13 章）。
- EAM/ReaxFF/DeepMD 势函数文件同样纳入溯源（文件哈希）。

**验收标准**:
- [ ] NVT Ar 液体温度波动 < 5%；NPT Si 密度收敛
- [ ] 百万原子轨迹写入 MinIO，帧级随机读取 < 200ms

#### Week 19-22: 事件系统与效果语义（修订）

**Deliverable**: 类型化事件总线 + 符合 Cordis 语义的效果管理

```typescript
// packages/core/src/events.ts
// 事件分发走 kernel 防腐层；瀑布语义（顺序、可拦截）在 kernel 内实现，
// 不假设 Cordis 原生事件的具体行为（以 Phase 0 适配清单为准）
export class MateriaEventBus {
  async emit(event: MateriaEvent): Promise<void> {
    const listeners = this.listeners.get(event.type) ?? [];
    for (const listener of listeners) {
      const result = await listener(event);
      if (result === false) throw new EventInterceptedError(event);
    }
  }
}

// 效果语义修正（v3.1 缺陷 #10）：
// - 软件资源（服务注册、事件监听、临时目录）→ Cordis effect，插件卸载自动回退[^2^]
// - 计算任务 → 不是 effect，走任务生命周期（cancel/kill），记录于 CalculationRecord
// - 物理设备指令 → 永不回滚，走审批 + 审计日志（Track X）
export interface EffectScope {
  register(dispose: () => void | Promise<void>): void;  // 卸载时逆序执行
}
```

**验收标准**:
- [ ] 瀑布事件：3 个监听器顺序执行，中间拦截正确
- [ ] Bundle 卸载后，其注册的服务/监听器/临时资源全部回退（自动化验证）
- [ ] 计算任务取消：VASP 任务 cancel 后 Slurm/子进程侧无孤儿进程

#### Week 23-26: Alpha 发布 + 合作课题组内测（提前自 v3.1 的 Week 56）

**Deliverable**: 内测版本 + 内测运营

```yaml
# 内测用例（examples/alpha-si.yml）
study: alpha-si-benchmark
material:
  formula: "Si"
  resolve: { via: prototype-lib }     # 显式结构来源
pipeline:
  - relax:     { engine: vasp, encut: 520 }
  - calculate: { engine: vasp, properties: [energy, forces, stress] }
report: { format: json }
```

**内测运营（新增，产品侧任务）**:
- 招募 3-5 个材料课题组（目标：电池正极、催化、合金各至少 1 个）
- 每个组指派 1 名对接工程师，双周收集反馈
- 内测问卷聚焦三件事：DSL 是否表达得了真实课题？结果是否可信？比现有流程（手写脚本 + 手动提交）省多少时间？

**验收标准**:
- [ ] 端到端：Si relax + static 正确；100 结构批量无内存泄漏
- [ ] 错误输入 graceful degradation；文档（安装 + 快速开始 + API）齐备
- [ ] **至少 3 个课题组用真实课题跑通至少 1 条 pipeline**，反馈报告归档

---

## 6. Phase 2: 多引擎与 HPC 规模化（Week 27-42）

### 6.1 目标（重排说明）

v3.1 的 Phase 2 含四个任务：多引擎热插拔、多尺度映射、仪器连接、实验闭环。评审结论：热插拔是工程任务，后三个是研究项目级任务。本版重排为：

| 任务 | v3.1 处置 | v3.2 处置 |
|---|---|---|
| 多引擎热插拔 | Week 25-28 | 保留，Week 27-30 |
| HPC/Slurm 集成 | **缺失** | **新增，Week 31-34（本阶段核心）** |
| 多尺度映射 | 半自动映射，4 周 | 降级：文件导出 + ABAQUS 模板，Week 35-36 |
| 实验仪器连接 | OPC-UA 实时连接 | 降级：文件/目录监听导入，Week 37-38 |
| 实验-计算闭环 | Week 37-40 承诺闭环 | **拆出为 Track X（第 10 章），不承诺周数** |
| 高通量规模化验证 | 散落各处 | 收拢为 Week 39-42 专项 |

### 6.2 详细任务分解

#### Week 27-30: 多引擎热插拔与交叉验证

同 v3.1 设计（状态序列化、单位制转换 eV↔Hartree↔kcal/mol、MACE↔VASP 系统误差记录），补充：

- 引擎间传递的必须是**序列化中间表示**（AtomGraph JSON），不允许传递引擎私有对象。
- 建立「交叉验证基准集」：20 个覆盖金属/氧化物/分子晶体的标准结构，MACE vs VASP 能量/力误差基线入库，后续每次引擎升级回归对比。

**验收标准**:
- [ ] 热切换 < 1s；MACE→VASP 能量误差 < 10 meV/atom（基准集）
- [ ] 单位制转换双向精度测试通过

#### Week 31-34: HPC/Slurm 集成（新增，详见第 13 章）

**Deliverable**: `SlurmAdapter` 上线，VASP/LAMMPS 作业经 Slurm 调度

- BullMQ（控制面：排队、优先级、重试）→ SlurmAdapter（计算面：sbatch 脚本生成、数据暂存、状态轮询、输出回收）
- 高通量场景用 Slurm job array，一次提交批量作业
- 失败映射：TIMEOUT / OUT_OF_MEMORY / NODE_FAIL → 结构化错误 + 分级重试

**验收标准**:
- [ ] 100 个 VASP 作业经 array 提交，全部正确回收与解析
- [ ] 节点故障注入测试：作业标记失败并可重提，无状态残留
- [ ] 作业全链路 traceId 可从 API 查询到 Slurm job id

#### Week 35-36: 多尺度数据导出（降级自"半自动映射"）

**Deliverable**: MD 轨迹 → 连续介质输入的**文件级**导出工具

- 从轨迹提取位移场/应力场，粗粒化到用户提供的网格
- 导出 ABAQUS 输入片段（位移边界条件）与通用 VTK 格式
- **明确不做自动耦合**：MD→相场的物理映射（位错、损伤变量传递）是研究问题，由用户在领域软件中完成，Saturday 只保证数据正确、格式正确、可溯源（这是空间维可组合性的近期承诺形态，分级定义见第 2.1 节）

**验收标准**:
- [ ] Ni 裂纹 MD 位移场导出，与手算参考解插值误差 < 5%
- [ ] ABAQUS 输入文件可被直接读取运行

#### Week 37-38: 实验数据导入（降级自"实时仪器连接"）

**Deliverable**: 文件级实验数据接入

- 目录监听：XRD（.xrdml/.xy/.csv）、电化学（.mpt/.csv）等格式解析入库
- 数据与 Material 对象关联，进入谱系（`VALIDATED_BY` 关系的前身）
- **真实 OPC-UA/MQTT 实时连接整体移至 Track X**，理由：实验室仪器协议碎片化严重（大量 XRD 只有厂商私有协议或文件导出），实时连接的价值必须先由内测用户验证

**验收标准**:
- [ ] 拖入 XRD 文件 → 自动解析 2θ/强度 → 关联材料 → 触发事件 < 5s
- [ ] 支持格式 ≥ 4 种，解析错误有明确报错

#### Week 39-42: 高通量规模化专项 + Phase 2 验收

**Deliverable**: 真实规模压测 + 内测用户真实课题

- MACE 筛选 1000 结构（单 GPU 工作站，目标 < 8h）
- VASP 验证 Top-50（Slurm array，目标 < 24h）
- 内测课题组各自提交 1 个真实高通量课题，全程跟踪

**验收标准**:
- [ ] 上述两条流水线的吞吐与成功率（> 95% 作业成功回收）达标
- [ ] 内测用户真实课题 ≥ 2 个跑通，产出可写入其课题的数据

---

## 7. Phase 3: DSH 融合与 Agent 集成（Week 43-58）

### 7.1 目标

Saturday 作为标准 dsh Bundle 发布，Agent 可直接操作材料上下文；计算全生命周期接入 DSH Trajectory。

### 7.2 详细任务分解

#### Week 43-46: dsh Bundle 封装（API 对齐真实 DSH）

**Deliverable**: `@saturday/dsh-bridge` 可通过 `dsh plugin add` 安装

```jsonc
// packages/bridge/package.json
{
  "name": "@saturday/dsh-bridge",
  "dsh.bundle": {                          // 真实 Bundle 声明机制[^3^]
    "plugins": ["./dist/index.js"],
    "config": "./cordis.yml"
  }
}
```

```typescript
// packages/bridge/src/index.ts
// 插件入口：导出 apply(ctx)，符合 dsh 插件规范[^4^]
import { Context } from 'cordis';
import { MateriaRuntime } from '@saturday/kernel';

export function apply(ctx: Context) {
  const rt: MateriaRuntime = createCordisAdapter(ctx);

  // ── 工具注册（经 ctx.tools seam，真实签名以锁定的 dsh 版本为准）──
  rt.registerTool({
    name: 'material.load',
    description: '加载材料结构。支持化学式、数据库 ID 或自然语言描述',
    parameters: {
      type: 'object',
      properties: {
        query:  { type: 'string', description: '如 "LiFePO4"、"mp-19017" 或 "高电压层状正极"' },
        source: { type: 'string', enum: ['prototype-lib', 'mp', 'local', 'auto'], default: 'auto' },
        polymorph: { type: 'integer', description: '多晶型序号，默认 0（最稳定）' },
      },
      required: ['query'],
    },
    handler: async ({ query, source, polymorph }) => {
      const type = detectQueryType(query);
      if (type === 'text') {
        // 自然语言 → 意图检索（Phase 4 检索服务，此处先降级为关键词）
        return materialService.searchByText(query, { limit: 1 });
      }
      return materialService.load(query, { source, polymorphRank: polymorph ?? 0 });
    },
  });

  rt.registerTool({
    name: 'potential.calculate',
    description: '计算材料性质。engine=auto 时按任务画像自动路由',
    parameters: {
      type: 'object',
      properties: {
        materialId: { type: 'string' },
        engine:  { type: 'string', enum: ['vasp', 'lammps', 'mace', 'auto'], default: 'auto' },
        profile: { type: 'string', enum: ['screening', 'validation', 'balanced'], default: 'balanced' },
        properties: { type: 'array', items: { enum: ['energy', 'forces', 'stress', 'bandgap'] } },
      },
      required: ['materialId'],
    },
    handler: async (params) => {
      const material = await materialService.get(params.materialId);
      const provider = params.engine === 'auto'
        ? potentialRegistry.autoRoute({
            type: 'calculate', nAtoms: material.nAtoms,
            profile: params.profile, requiredProperties: params.properties,
          })
        : potentialRegistry.get(params.engine);
      return provider.calculate(material, { properties: params.properties });
    },
  });

  rt.registerTool({
    name: 'experiment.schedule',
    description: '安排合成或表征实验。超成本阈值时触发人工审批',
    parameters: { /* 同 v3.1 */ },
    handler: async (params) => {
      const cost = await experimentService.estimateCost(params);
      if (cost > config.get('experiment_cost_threshold')) {
        // 对齐 dsh 内建 approval 机制，不自研审批 UI
        const approved = await rt.requestApproval({
          operation: `Schedule ${params.type} experiment`,
          detail: { estimatedCost: cost, material: params.materialId },
        });
        if (!approved) throw new Error('Experiment rejected by user');
      }
      return experimentService.schedule(params);
    },
  });

  // ── 事件 → Trajectory（替代 v3.1 臆想的 ctx.agent.emitObservation）──
  // DSH 的 append-only 会话日志是天然的计算溯源载体[^2^]：
  // 计算事件写入 Trajectory 后，天然获得可检索、可回放、可 fork 的能力
  rt.on('saturday/simulation/converged', async (event) => {
    await rt.appendTrajectory({
      type: 'material_calculation_complete',
      requestId: event.payload.jobId,
      material: event.payload.material,
      properties: event.payload.result,
      meta: { engine: event.payload.engine, duration: event.payload.duration },
    });
  });

  rt.on('saturday/simulation/failed', async (event) => {
    await rt.appendTrajectory({
      type: 'material_calculation_failed',
      requestId: event.payload.jobId,
      error: event.payload.error,
      suggestion: event.payload.recoverable
        ? `可重试：${event.payload.suggestedFix}`
        : '需要人工介入',
    });
  });
}
```

**验收标准**:
- [ ] `dsh plugin add @saturday/dsh-bridge` 安装并加载成功
- [ ] Agent 会话内完成 "加载 Si → relax → 查询结果" 全流程
- [ ] 计算记录在 Trajectory 视图可见，可 resume / fork

#### Week 47-50: Agent 工作流与 PTC 模式利用

**Deliverable**: 3 个预设工作流；高通量场景验证 PTC 模式

```typescript
// packages/bridge/src/workflows/screening.ts
export class ScreeningWorkflow {
  async execute(intent: ResearchIntent): Promise<ScreeningResult> {
    const constraints = await this.parseIntent(intent);
    const candidates = await this.generateCandidates(constraints);   // DB 检索 + 规则变体
    const screened  = await this.screen(candidates, constraints);    // MACE, profile: 'screening'
    const validated = await this.validate(screened, constraints);    // VASP, profile: 'validation'
    return this.generateReport(validated);
  }

  private async validate(candidates: Material[], c: Constraints) {
    // 批量昂贵计算的审批：一次审批整个批次 + 预算上限，
    // 而非 v3.1 的逐个弹窗（50 个结构弹 50 次不可接受）
    const estimate = await this.estimateBatchCost(candidates);
    const approved = await rt.requestApproval({
      operation: `VASP validation batch (${candidates.length} structures)`,
      detail: { totalGpuHours: estimate.gpuHours, budgetCap: c.budgetCap },
    });
    if (!approved) return [];
    // ...提交 Slurm array，按预算截断
  }
}
```

**PTC 模式专项（新增）**：DSH 的 PTC（Programmatic Tool Calling）模式让模型生成一段 TypeScript 组合多轮工具调用[^1^]。高通量筛选（1000 次工具调用）若走逐轮对话，token 消耗与延迟都不可接受；PTC 是天然解法。本阶段须产出 1 份《PTC 高通量 cookbook》并实测 token 成本对比。

**验收标准**:
- [ ] 筛选工作流：1000 候选 → 10 通过，总时间 < 48h，token 成本较逐轮模式下降 > 80%
- [ ] 批次审批：一次审批覆盖整批 VASP 作业，预算超限自动截断
- [ ] 多尺度工作流：MD → 文件导出 → 用户确认，链路可溯源

#### Week 51-54: 会话记忆与探索历史

设计同 v3.1（探索历史持久化、相似探索检索、LLM 摘要），实现修正：

- 历史存储落到 DSH 会话日志 + Postgres 物化视图，**不另起记忆系统**——DSH 的 append-only 日志已保证重启不丢失、可检索[^2^]。
- 摘要生成走 `ctx.llm` seam（用户配置的任意模型适配器），不绑定特定厂商。

**验收标准**:
- [ ] 探索历史重启后可检索；相似探索检索 Recall@5 > 80%
- [ ] fork 历史会话可复现当时材料上下文

#### Week 55-58: Beta 发布

**验收标准**:
- [ ] 20+ 外部团队安装运行（v3.1 目标 5 个，因内测提前而上调）
- [ ] 文档完整：安装、Bundle 配置、API、3 个 cookbook
- [ ] 收集 30+ 条有效 issue 并分类闭环率 > 60%

---

## 8. Phase 4: DSL 与智能检索（Week 59-74）

### 8.1 目标

声明式研究语言（沿用 v3.1 设计）+ **基于现成预训练模型的材料检索**（替代自研异构编码器）。

### 8.2 详细任务分解

#### Week 59-62: DSL 解析器与执行引擎

沿用 v3.1 设计（YAML → StudyPlan → DAG 拓扑执行），补充两条健壮性要求：

- 过滤器表达式不用裸正则，用微型表达式解析器（如 `expr-eval`），支持 `and/or/()` 与单位（`band_gap < 2.0 eV`）
- DSL schema 版本化（`version: 1` 字段），后续演进不破环旧 study.yml

**验收标准**:
- [ ] 20 个示例 study.yml 全部正确解析执行（含内测用户贡献的 5 个真实案例）
- [ ] 并行执行 100 结构无竞态；依赖失败正确阻断下游
- [ ] 无效 YAML 报错含行号与修复建议

#### Week 63-66: 材料检索服务（替代自研编码器）

**决策变更（修订 #15）**：v3.1 计划 4 周自研 "BERT + 化学式 Transformer + CGCNN" 融合编码器，无训练数据方案、无算力预算、验收标准仅为冒烟测试。本版改为**组装现成组件**：

```python
# python-bridge/saturday_bridge/retrieval/service.py
class MaterialRetrievalService:
    """三通道检索，全部基于现成模型，无自研训练"""

    def __init__(self):
        # 通道 1：文本 —— 通用/材料领域预训练 embedding（如 MatSciBERT 类模型）
        self.text_encoder = load_pretrained_text_encoder()

        # 通道 2：成分 —— 描述符（Magpie/matminer 特征）+ 余弦相似度
        self.composition_featurizer = ElementProperty.from_preset("magpie")

        # 通道 3：结构 —— 图指纹/结构匹配（pymatgen StructureMatcher）
        self.structure_matcher = StructureMatcher()

    def search(self, query: str | Formula | Structure, k: int = 10) -> list[Material]:
        # 通道结果加权融合（权重由内测用户查询日志回归调优）
        ...
```

**验收标准（改为真实检索指标）**:
- [ ] 构建评测集：500 条 "文本查询 → 已知相关材料" 标注对（从内测用户历史检索整理）
- [ ] **Recall@10 ≥ 0.7**；成分相似检索（LiFePO₄→LiMnPO₄ 类）Recall@5 ≥ 0.8
- [ ] 检索延迟 < 300ms（10 万材料库）
- [ ] 若 Recall@10 < 0.5：降级为结构化过滤 + 关键词检索（可接受的用户体验底线）

#### Week 67-70: 生成式候选框架（规则优先，模型殿后）

**排序原则**：数据库检索 > 规则变体（掺杂/缺陷/取代）> 生成模型。前两者覆盖内测用户 80% 场景且结果必然可计算；生成模型（如扩散类晶体生成）仅作为探索性通道，产出必须经 `StructureResolver` 合理性校验（电荷中性、间距合理、可弛豫）。

**验收标准**:
- [ ] "高电压正极"类查询产出 ≥ 10 个候选，全部通过合理性校验
- [ ] 候选谱系完整记录生成路径（检索命中 / 规则变体 / 生成模型）

#### Week 71-74: 自研编码器决策点 + Phase 4 验收

- **Go/No-Go 评审**：仅当检索服务的评测集证明现成模型是瓶颈（而非数据覆盖度），才立项自研微调；预计不做。
- Phase 4 总验收：DSL + 检索 + 候选生成在 2 个内测课题中全流程使用。

---

## 9. Phase 5: 生态与商业化（Week 75-98）

### 9.1 商业论证（新增，替代 v3.1 的空白）

**目标客户画像**（按优先级）：

| 客户 | 痛点 | 付费形态 |
|---|---|---|
| 电池/催化/半导体企业研发中心 | 高通量筛选流程靠脚本拼接，新人难接手；计算与实验数据割裂 | 企业版订阅（私有化部署） |
| 高校/研究所课题组 | 工作流不可复现，毕业即失传 | 开源版免费 → 云服务轻量付费 |
| 材料计算服务商 | 需要可审计的计算交付 | 企业版 + 审计模块 |

**模式**：Open-core。运行时、引擎 Provider、DSL 开源（MIT，与 DSH 一致，借势 dsh 插件生态分发）；云服务（托管调度 + 协作 + 大对象存储）与企业版（SSO、审计、私有化部署支持）收费。

**目标修正**：v3.1 的 "Week 89-96 八周内 10 个企业客户 + 100 万 ARR" 无支撑。修正为 **1.0 发布后 18 个月**：30 家进入 pipeline → 10 家 POC → 3-5 家付费，累计 ARR 100 万（人民币）。Week 75-98 期间的目标仅为：**3 家 POC 签约**。

### 9.2 合规设计（新增，替换 v3.1 的 HIPAA）

| 合规项 | 要求 | 设计 |
|---|---|---|
| **VASP license** | 商业软件，云上代客计算须客户自带 license（BYOL） | 云服务不内置 VASP；客户上传 license 证明 + 自有赝势，作业在其命名空间内运行；开源版文档明确声明此边界 |
| **出口管制** | 国防相关材料数据可能涉及管制 | 企业版支持数据分类标记 + 部署区域约束 |
| **数据完整性** | 研发数据可审计（企业内控/合作审计） | 全链路 append-only：DSH Trajectory + CalculationRecord 哈希链，任何结果可回放复算 |
| **数据不出域** | 企业客户硬性要求 | 私有化部署包：Compose 一键起全栈，无外呼依赖（LLM 可接客户自有模型） |

（v3.1 的 HIPAA 与材料软件无关，删除；GDPR 仅在云服务收集用户账号数据时适用，按常规实践处理。）

### 9.3 详细任务分解

#### Week 75-78: 插件市场基础设施

沿用 v3.1 设计（注册表、签名验证、一键安装），补充：市场同时上架到 **dsh 插件生态**（仓库添加 `dsh-plugin` topic[^1^]），Saturday 官方插件与普通 dsh 插件同机制分发。

#### Week 79-82: 云服务 MVP

沿用 v3.1 架构（api/worker/frontend），补充两条硬约束：
- 云服务**默认引擎为 MACE/LAMMPS**（开源），VASP 走 BYOL 通道
- 计费按实际 Slurm/云资源消耗结算，CalculationRecord 的资源字段即为账单数据源（设计已预留）

#### Week 83-90: 企业版功能

SSO（OIDC 优先，SAML 次之）、审计日志（复用 append-only 事件流，不另建存储）、私有化部署包、数据分类标记。

#### Week 91-98: POC 攻坚与 1.0 发布

- 从内测与 Beta 用户中转化 3 家 POC（目标行业：电池 1、催化 1、半导体 1）
- 学术会议（MRS/ACS）+ 2 篇联合案例研究（与内测课题组共同署名）
- 发布 1.0：API 冻结承诺 + 升级指南

**验收标准**:
- [ ] 3 家 POC 合同签署；POC 成功标准白纸黑字写入合同（如"筛选周期从 6 周缩到 2 周"）
- [ ] 私有化部署包在客户环境 2 天内完成部署
- [ ] 审计报告通过 1 家企业客户的内控审查

---

## 10. Track X: 实验闭环专项（独立研究轨）

### 10.1 定位

实验-计算闭环（XRD 新相 → 自动 DFT → 反向调控合成）是 A-Lab 级能力，本质是**研究项目而非产品迭代**。从主路线拆出，按阶段门（stage-gate）管理，**不承诺周数，只承诺评审节点**。主路线只依赖其文件级产物（Phase 2 的实验数据导入）。

### 10.2 阶段门

| 阶段 | 目标 | 通过标准 | 不通过 |
|---|---|---|---|
| X1：模拟器闭环 | 虚拟 XRD + 虚拟合成炉上跑通事件闭环 | 连续运行 72h 无崩溃；相识别（已知相库）> 90% | 回设计，不进实验室 |
| X2：单仪器真实闭环 | 1 台合作实验室 XRD 实时接入（OPC-UA 或厂商 SDK），数据进系统；调控指令**仅建议、人工执行** | 真实实验流程中连续使用 2 周，数据接入零丢失 | 维持文件导入模式 |
| X3：自动调控 | 经实验室安全评审后，合成炉温度等**可逆、低风险**参数自动微调 | 合作实验室签署安全协议；异常自动熔断 | 停在 X2（人机协同闭环也是可发布的产品能力） |

### 10.3 安全红线（写入代码而非文档）

- 设备指令永不走"可逆效果/回滚"语义（v3.1 缺陷 #10）；全部经审批 + 审计日志
- 自动调控参数白名单制（温度 ±范围、速率上限），白名单外指令物理层拒绝
- 任何闭环必须有硬件级急停旁路，软件无权覆盖

**资源**：X1 由 1 名 ML/全栈工程师兼职推进；X2 起需合作实验室 MOU 与专门预算，届时单独评审。

---

## 11. 数据模型详细设计（修订）

### 11.1 Material 对象

```typescript
interface Material {
  id: UUID;
  version: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;

  modalities: {
    text?: string;
    formula?: string;
    smiles?: string;
    file?: { path: string; format: 'cif' | 'poscar' | 'xyz' | 'json'; checksum: string };
    graph?: AtomGraph;
  };

  graph: AtomGraph;

  // 新增：结构来源显式记录（修订 #8）
  structureOrigin: {
    resolver: string;          // 'prototype-lib' | 'materials-project' | 'file' | 'generative'
    sourceRef?: string;        // 'mp-149' 等
    polymorphRank?: number;
    energyAboveHull?: number;
  };

  // 多尺度视图：仅 atomic 为内联视图；electronic/continuum 为计算产物引用
  views: {
    electronicCalculationId?: UUID;   // -> CalculationRecord
    continuumFieldRef?: ObjectRef;    // -> 对象存储
  };

  lineage: LineageNode[];
  embedding?: Vector;                  // Phase 4 检索服务写入

  metadata: {
    source: string;
    tags: string[];
    visibility: 'public' | 'private' | 'shared';
    classification?: string;           // 企业版数据分类（出口管制标记）
  };
}

interface AtomGraph {
  nodes: AtomNode[];
  edges: BondEdge[];
  periodic: boolean;
  cell?: Matrix3x3;
}

interface AtomNode {
  id: number;
  element: string;
  position: Vector3;
  properties: Record<string, number>;
}

interface BondEdge {
  source: number;
  target: number;
  type: 'covalent' | 'ionic' | 'metallic' | 'hbond';
  length?: number;
}
```

### 11.2 Calculation 记录（强化溯源）

```typescript
interface CalculationRecord {
  id: UUID;
  jobId: string;

  // 输入与幂等
  material: MaterialRef;
  engine: string;
  parameters: Record<string, unknown>;
  inputHash: string;              // 输入规范化后的哈希，幂等/缓存键

  // 环境溯源（新增，可重复性底线）
  provenance: {
    engineVersion: string;
    potentialHash?: string;       // POTCAR / 势函数文件哈希
    imageDigest?: string;         // 容器镜像 digest
    slurmJobId?: string;
    dshSessionId?: string;        // 关联 DSH Trajectory（修订 #14）
    traceId: string;
  };

  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: CalculationResult;
  error?: ErrorInfo;

  resources: { cpuHours: number; gpuHours: number; memoryGB: number; diskGB: number };
  timeline: { submitted: Timestamp; started?: Timestamp; completed?: Timestamp };
}

interface CalculationResult {
  energy?: number;
  forces?: MatrixNx3;
  stress?: Matrix3x3;
  bandgap?: number;
  dos?: ObjectRef;                // 大数组走对象存储
  trajectory?: ObjectRef;         // 轨迹走对象存储，见第 13 章

  files: OutputFile[];            // { name, objectKey, checksum, sizeBytes }
}
```

### 11.3 谱系与知识查询（Postgres 实现，Neo4j 按需）

Phase 1-2 谱系用 Postgres 递归 CTE 实现（`lineage` 表 + `parent_id`），覆盖"溯源/反查衍生"查询。Phase 3 评审：若内测用户的多跳知识查询（如"所有经 X 验证且衍生自 Y 的材料"）被验证为高频刚需，再引入 Neo4j，届时以只读镜像方式同步，**Postgres 始终为事实源**。

---

## 12. 事件协议详细规范

沿用 v3.1 第 8 章全部设计（标准头 / 计算事件 / 实验事件 / 融合事件 / 路由规则），三处修订：

1. `context.sessionId` 与 DSH 会话 ID 对齐：凡 Agent 会话内触发的计算，事件可经 `dshSessionId` 反查到 Trajectory 条目，形成双向链接。
2. 事件持久化：Postgres 分区表（按月），**弃用 TimescaleDB**（修订 #12）。
3. `fusion/human-in-loop` 事件的 `response` 由 DSH approval 机制回写，审批记录进入 Trajectory，天然可审计。

---

## 13. HPC/Slurm 集成与大对象存储（新增）

### 13.1 控制面与计算面分离

```
用户/Agent ──> API ──> BullMQ 队列（控制面：优先级、重试、预算截断）
                            │
                            ▼
                     SlurmAdapter（计算面）
                       1. 渲染 sbatch 脚本（资源、环境、输入暂存命令）
                       2. 数据暂存：输入 → $SCRATCH/<jobId>/in/
                       3. 提交：sbatch --parsable（批量走 job array）
                       4. 状态：sacct / slurmrestd 轮询，事件回写 BullMQ
                       5. 回收：out/ → 解析器 → 结果入库；大文件 → 对象存储
                       6. 清理：$SCRATCH 按策略回收
```

### 13.2 关键设计点

- **Job array 高通量**：MACE 筛选千级结构、VASP 验证批量，一个 array 一次提交，避免调度器洪泛；单任务失败不影响同 array 其他任务。
- **失败分类映射**：`TIMEOUT`（可加长 walltime 重提）/ `OUT_OF_MEMORY`（升 mem 重提）/ `NODE_FAIL`（原样重提）/ `计算不收敛`（引擎侧，不重提，交错误处理链）。重提次数与策略写入 CalculationRecord。
- **多集群抽象**：`ComputeBackend` 接口（local-subprocess / slurm / cloud-batch），Phase 1 的本地子进程与 Phase 2 的 Slurm 实现同一接口，Provider 无感知。
- **license 感知调度**：VASP 作业单独队列，并发上限 = license 允许的并发数，超限排队而非失败。

### 13.3 大对象存储策略

| 数据 | 量级 | 存储 | 索引 |
|---|---|---|---|
| MD 轨迹 | GB-百 GB/任务 | MinIO/S3，分块（帧块）上传 | `trajectory_index` 表：帧号 → 偏移，支持帧级随机读 |
| CHGCAR/WAVECAR | 百 MB-GB | MinIO/S3，默认不保留（可配置保留派生态） | CalculationRecord.files |
| 输出小文件（OUTCAR 等） | MB 级 | MinIO/S3 | 同上 |
| 结构化结果（能量/力/带隙） | KB 级 | Postgres JSONB | 直接可查 |

- 所有对象带 SHA-256 checksum，写入即校验
- 生命周期策略：原始轨迹 90 天热存储 → 冷存储/删除（用户可标记"保留"，计费区分）

---

## 14. API 接口设计

沿用 v3.1 第 9 章（REST + WebSocket + Python SDK），修订：

1. **删除 GraphQL**：无明确消费方，REST + WS 已覆盖（YAGNI）。
2. `/calculations` POST 响应补充 `inputHash`，客户端可凭此幂等重试。
3. 新增 `/calculations/{jobId}/provenance`：返回环境溯源块（引擎版本、势哈希、镜像 digest、Slurm job id、DSH session 链接）。
4. Python SDK 示例补充 `job.provenance()` 与轨迹帧级读取：

```python
job = client.calculations.submit(material_id=m.id, engine="vasp", parameters={"encut": 520})
result = job.wait(timeout=3600)
print(result.energy, job.provenance().slurm_job_id)

traj = client.trajectories.open(result.trajectory_key)
frame_500 = traj.frame(500)          # 帧级随机读，不下载全量
```

---

## 15. 性能基准与测试策略（修订）

### 15.1 性能基准

| 指标 | 目标 | 说明 |
|---|---|---|
| Material 创建（CIF） | < 100ms | 同 v3.1 |
| Provider 热切换 | < 1s，不影响在运行任务 | 增加回归断言 |
| 事件延迟（本地） | < 10ms | 同 v3.1 |
| 桥接开销 | < 5% | 对比直接运行引擎 |
| MACE 筛选吞吐 | 1000 结构 < 8h（单 GPU 工作站） | v3.1 的 24h 过松，收紧 |
| VASP 验证批量 | 50 结构 < 24h（Slurm array） | 新增 |
| 轨迹帧级随机读 | < 200ms | 新增 |
| 检索延迟（10 万库） | < 300ms | Phase 4 |
| WebSocket 推送 | < 100ms | 同 v3.1 |

### 15.2 测试策略（核心修订：mock 计算器分层）

| 层 | 计算器 | 运行环境 | 频率 |
|---|---|---|---|
| 单元测试 | EMT mock Provider | GitHub runner | 每次 push |
| 集成测试（引擎契约） | EMT + LAMMPS（开源可装） | GitHub runner | 每次 PR |
| 集成测试（VASP） | 真实 VASP | **自托管 runner（有 license 的内网环境）** | 每晚 |
| 端到端 | EMT 全程 + VASP 抽验 | 自托管 runner | 每周 + 发版前 |
| 负载/吞吐 | 真实引擎 | HPC 开发分区 | 每 Phase 验收 |

v3.1 的 CI 在 GitHub runner 上引用 `/opt/vasp/vasp_std` 不可行（license 与法律均不允许），上述分层是唯一现实方案。引擎契约测试（Contract Test）保证 EMT 与 VASP 走完全相同的 Provider 代码路径，仅计算器可执行体不同。

覆盖率门禁沿用 v3.1（lines/functions/statements 80%，branches 70%）。

---

## 16. 技术债务管理（更新）

| 债务 | 影响 | 偿还计划 |
|---|---|---|
| Python Bridge 同步调用 | 阻塞事件循环 | Phase 2 改异步 + 流式 |
| Material 全内存存储 | 大体系溢出 | Phase 3 分页 + 磁盘缓存 |
| 单节点事件总线 | 无法水平扩展 | Phase 2 末迁移 Redis Streams（从 v3.1 的 Phase 3 提前，HPC 规模化依赖它） |
| 多尺度仅文件导出 | 用户手动耦合 | Track X 或后续版本评估 |
| 检索依赖现成模型 | 上限受制于人 | Phase 4 决策点评审 |
| kernel 防腐层间接成本 | 少量性能/样板代码 | 接受——这是对冲 DSH 预览期风险的有意成本 |

代码质量门禁沿用 v3.1（ESLint strict-type-checked、复杂度 10、函数 50 行、vitest v8 覆盖率阈值）。

---

## 17. 风险缓解与回退方案（重写）

### 17.1 风险矩阵

| 风险 | 概率 | 影响 | 缓解 | 回退 |
|---|---|---|---|---|
| **DSH 破坏性升级** | 高 | 高 | 版本锁定 + 防腐层 + 兼容测试集 + 4 周升级节奏（第 0 章） | 停留在已验证版本，功能冻结直至适配完成 |
| **DSH 项目停止维护** | 低 | 极高 | MIT 协议可自维护；防腐层保证替换面可控 | 团队接管 fork，kernel 接口不变 |
| **VASP license 不足/合规** | 中 | 高 | license 感知调度；云服务 BYOL | MACE/LAMMPS 降级链 + 排队 |
| **Python Bridge 性能差** | 中 | 中 | ZeroMQ 序列化优化 | gRPC 或共享内存 |
| **检索质量不达标** | 中 | 中 | 现成模型 + 评测集持续监控 | 降级结构化过滤 + 关键词（用户体验底线已定义） |
| **HPC 不可用** | 中 | 中 | ComputeBackend 抽象，切本地/云 | 本地队列（MACE/LAMMPS 小体系） |
| **内测用户反馈推翻方向** | 中 | 高 | Week 26 即开始内测，试错成本前置 | Phase 2 评审会可砍功能重排 |
| **实验闭环安全事故** | 低 | 极高 | Track X 阶段门 + 安全红线硬编码 | 永久停留在"建议不执行"模式 |

### 17.2 回退方案

保留 v3.1 的 HPC 不可用回退（本地 MACE/LAMMPS）与仪器断连回退（手动文件上传，本就是 Phase 2 的默认路径）。**删除 v3.1 的 "Cordis 严重 bug → 自研插件系统" 回退**——DSH 是既定底座，自研底座不是回退而是另立项目；对应风险的正确缓解是版本锁定与防腐层，见第 0 章。

---

## 附录

### A. 依赖版本锁定（修订）

```jsonc
{
  "dependencies": {
    "@deepseek-ai/dsh": "0.1.0-rc.6",   // 精确锁定，升级走第 0 章流程
    "cordis": "4.x.x",                    // 与 dsh 传递依赖对齐
    "redis": "^4.6.0",
    "bullmq": "^4.12.0",
    "pg": "^8.11.0",
    "minio": "^7.1.0",
    "zod": "^3.22.0",
    "yaml": "^2.3.0",
    "expr-eval": "^2.0.2"
  },
  "devDependencies": {
    "typescript": "^5.2.0",
    "vitest": "^0.34.0",
    "@vitest/coverage-v8": "^0.34.0"
  }
}
// 注：v3.1 臆想的 @dsh/core、@dsh/agent-loop 包不存在，
// 真实接口为 @deepseek-ai/dsh + cordis，以 Phase 0《DSH 适配清单》为准。
```

### B. 环境变量配置

```bash
# DSH
DSH_HOME=~/.dsh
# LLM 经 dsh 的模型适配器配置，不在 Saturday 侧重复管理

# 数据库与存储
DATABASE_URL=postgres://localhost:5432/saturday
REDIS_URL=redis://localhost:6379
S3_ENDPOINT=http://localhost:9000
S3_BUCKET=saturday

# HPC
COMPUTE_BACKEND=slurm            # local-subprocess | slurm | cloud-batch
SLURM_PARTITION=gpu
SLURM_ACCOUNT=...
VASP_MAX_CONCURRENCY=4           # license 感知调度上限

# 计算引擎
VASP_COMMAND=/opt/vasp/vasp_std
LAMMPS_COMMAND=/opt/lammps/lmp
MACE_MODEL_PATH=/data/mace-models/

# 实验数据（Phase 2 文件导入模式）
EXPERIMENT_WATCH_DIR=/data/incoming
```

### C. 开发环境搭建

```bash
git clone https://github.com/saturday/saturday.git && cd saturday
pnpm install
docker-compose up -d postgres redis minio
pnpm build && pnpm test            # EMT mock，无需任何 license
pnpm dsh web                       # 经 dsh 加载 @saturday/dsh-bridge 开发
```

---

## 参考资料

[^1^]: DeepSeek Harness GitHub 仓库（开发者预览声明、安装方式、dsh-plugin 分发机制）: https://github.com/deepseek-ai/deepseek-harness
[^2^]: Cordis — The Plugin Kernel Behind DeepSeek Harness（ctx.effect 可逆效果、生命周期、Koishi 四年生产验证、Cordis v4）: https://floatboat.ai/blog/cordis-plugin-framework
[^3^]: DeepSeek Harness 能力组织方式（seam / Bundle / patch 层 / Creator 模式）: https://springbrand.ai/deepseek-harness
[^4^]: dsh 插件开发形态（导出 apply(ctx)、cordis.yml 装配、工具/服务/适配器/事件监听能力）: https://github.com/TrueHOOHA/dsh-plugin-dev-skill

---

**文档版本**: v3.3
**最后更新**: 2026-08-27
**维护者**: Saturday 技术团队
**反馈**: tech@saturday.org
