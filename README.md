# Saturday —— 材料计算的插件运行时

**Everything is a plugin。** Saturday 不是又一套材料计算引擎，不替代 DFT / MD / FEM / CFD 的任何求解器；
它是材料计算的**组合层**：引擎、结构源、工作流、分析工具全部以插件形态挂载到
**DeepSeek Harness (dsh) / `@deepseek-ai/cordis` v4** 运行时上，由 Agent 在运行时自由挂载、卸载与组合。

> 仓库为 npm workspaces monorepo（Phase 1a 结构），对应《Saturday 技术路线细化 v3.3》。
> 完整产品路线见根目录 `Saturday_技术路线细化_v3.3.md`；插件接口规范见 `packages/bridge/docs/plugin-contract-v0.md`。

## 核心范式

### 时空可组合性（Spatiotemporal Composability）

理论依据为 Cordis 配套论文：

> *A Programming Paradigm for Spatiotemporal Composability*，Yifan Shi, Wei Zhang, Tianyi Cui，
> arXiv:2608.25512 [cs.PL]（北京大学 / DeepSeek-AI）。

Saturday 把论文的两个正交维度落到材料计算域：

| 维度 | 论文原义 | Saturday 的领域落点 | 本仓库的已验证形态 |
|---|---|---|---|
| 时间维 | 组件副作用可完全逆置（可逆效应） | 研发过程是可挂起/分叉/回放的事件流；**可逆的是研究决策，不是物理** | 计算事件 → append-only Trajectory，逐变体溯源 |
| 空间维 | 依赖声明 + 反应式管理（响应式协效应） | 跨引擎/跨尺度能力按需激活联动 | 引擎能力在 hello 握手声明，测试按能力动态增强断言 |

### 材料计算 = 双通道事件流

各引擎（DFT/MD/FEM/CFD）的运行时行为投影为两类事件，Saturday 的总线只做路由不改物理：

- **瀑布事件（因果链）**：弛豫步、SCF 迭代、MD 步进——传递"当前状态接力棒"，全序、可回放 → 承载时间维；
- **广播事件（一对多）**：收敛达成、能量异常、属性算出——多消费方订阅联动 → 承载空间维。

事件粒度因引擎而异（迭代级 ↔ 任务级），由能力握手显式声明，不强行归一。

### 原子化操作（Atomic Operations）

一切研发动作分解为可独立调用、自由组合的原语（`relax` / `calculate` / `substitute` …），
同一组原语同时暴露给 Agent 工具、DSL 与编程 API 三种消费方。原子性按作用域分级：
软件资源域完全可逆（cordis effect）、计算任务域幂等 + 可取消、物理设备域永不回滚。

### 活的材料上下文（目标形态）

材料上下文 = 瀑布事件累积器之上的**响应式谱系图**：每个导出量声明推导来源，
上游变化沿谱系自动传播失效与重算。掺杂操作 `Material.substitute` 的不可变 fork
语义是这一方向上的第一个落地原语。

## 当前状态：Phase 0 结论 —— Go

- 裸 cordis：**28/28 测试通过**（14 项集成验收含 ASE EMT 真物理 + 3 个首发插件各自契约测试）
- **真实 dsh web 运行时：profile 级挂载验证通过（0 错误，工具通过真实注册表校验，Python sidecar 由 dsh 拉起）**
- 已验证最小闭环："Agent 工具调用 → 真实计算 → 事件回流 Trajectory"

详见《packages/bridge/DSH适配清单.md》（含 Node ≥ 22 硬性要求等实测结论）。

## 能力（v0.3）

| 能力 | 工具 | 说明 |
|---|---|---|
| 材料加载 | `material.load` | 化学式 → 结构（原型库，TiO2 多晶型可选） |
| 结构弛豫 | `potential.relax` | **ASE EMT 真实物理**（UnitCellFilter+BFGS），LJ 玩具势兜底 |
| 掺杂筛选 | `workflow.screen` | 基体 + N 掺杂变体批量弛豫 → 能量排序 → 逐变体 Trajectory 溯源（独立插件 `@saturday/plugin-screening`） |
| MP 结构源 | `structure.resolve` | Materials Project 远端解析（独立插件 `@saturday/plugin-mp`，需 MP_API_KEY） |

EMT 能量零点为各元素平衡 fcc 晶体，energyPerAtom 近似形成焓。实测 Cu 掺杂筛选：
**Cu3Pt (-0.10) < Cu3Au (-0.02) < Cu (0) < Cu3Ni (+0.01) < Cu3Ag (+0.02) eV/atom**——
有序化（Cu-Pt/Cu-Au）与相分离（Cu-Ni/Cu-Ag）倾向与实验冶金学一致。
掺杂操作（`Material.substitute`）为不可变 fork 语义，谱系全程可追溯。

## 环境要求

- **Node ≥ 22**（dsh 硬性要求；Node 20 启动即崩，实测。裸 cordis 测试可在 Node 20 跑）
- Python ≥ 3.10 + numpy + scipy；**ASE ≥ 3.22**（EMT 真物理；缺 ASE 自动回退 LJ 玩具势）
- Windows 下默认使用 `python` 命令（无 `python3` 时），可用 `bridge.python` 配置覆盖
- pnpm（弱网环境建议 `fetch-retries 10`）

## 结构（npm workspaces）

```
packages/
  kernel/                     # @saturday/kernel —— 防腐层：全仓唯一接触 cordis 的文件
    src/cordis-adapter.mjs    #   SaturdayRuntime 接口 + append-only Trajectory
  core/                       # @saturday/core —— 领域核心（零运行时依赖）
    src/material.mjs          #   Material 领域对象（谱系、视图、substitute 掺杂）
    src/potential.mjs         #   PotentialRegistry（引擎 seam + 评分路由 + 粒度门禁）
    src/structure-resolver.mjs#   结构解析 seam（原型库，含多晶型 + 7 种 fcc 金属）
    src/elements.mjs          #   元素表（Z/符号/电负性，化学式合成）
  bridge/                     # @saturday/bridge —— dsh Bundle（saturday 主插件）
    src/saturday.plugin.mjs   #   cordis 插件入口 { name, apply }（3 个工具）
    src/compute/bridge.mjs    #   TS ↔ Python 桥（stdio JSON-lines，可换 ZeroMQ）
    src/compute/emt-provider.mjs#  EMT Provider（零 license 依赖）
    src/workflows/screening.mjs#  批量掺杂筛选工作流
    python-bridge/sidecar.py  #   stdio JSON-lines 服务（按元素逐调用路由后端）
    python-bridge/adapters/   #   ase_emt.py（真物理）/ emt_mock.py（LJ 兜底）
    profiles/cordis.patch.yml #   挂载到 dsh profile 的示例
    test/spike.test.mjs       #   14 项验收 + 契约测试
    docs/plugin-contract-v0.md#   Plugin Contract v0（插件契约，experimental）
plugins/                      # 首发插件（契约压力测试）
  screening/                  #   @saturday/plugin-screening —— 工作流：批量掺杂筛选（§4.3）
  mp-structure-source/        #   @saturday/plugin-mp —— 结构源：Materials Project（§4.1）
  lammps/                     #   @saturday/plugin-lammps —— 引擎：LAMMPS 批处理，事件粒度 job（§4.2）
```

## 运行

```bash
# 裸 cordis 验证（无需 dsh、无需 LLM/API Key）
npm install             # workspaces：@deepseek-ai/cordis（peer）+ 六个 @saturday/* 包软链
npm test                # 全部 workspace 测试（当前 28 项）
npm run demo --workspace @saturday/bridge            # 端到端演示
npm run demo:screening --workspace @saturday/bridge  # 掺杂筛选演示（ASE EMT 真物理）
```

## 挂载到 dsh（完整运行时，已实测验证）

```bash
npm i @deepseek-ai/dsh                 # 需要 Node ≥ 22
export DSH_HOME=~/.dsh
dsh web --help                         # 首次运行自动初始化 web profile
# 1) 在 $DSH_HOME/profiles/web/package.json 的 dependencies 声明：
#    "@saturday/bridge": "file:/path/to/Saturday/packages/bridge"
# 2) cd $DSH_HOME/profiles/web && pnpm install
# 3) 把 packages/bridge/profiles/cordis.patch.yml 的 - insert: 行写入 profile 的 cordis.patch.yml
dsh --profile web --dump-config        # 验证组合树包含 saturday 行
dsh web                                # 启动（本仓库已实测：0 错误挂载）
```

Agent 会话演示（无真实 API Key）：可配 `dsh-llm-mock-server@0.0.1-rc.1`，见适配清单 §7/§9。

## 设计锚点（与 v3.3 方案对应）

- **防腐层（依赖卫生）**：领域代码不 import cordis，上游破坏性变更影响面 = 1 个文件；dsh 为唯一官方宿主，裸 cordis 仅作开发/CI 模式
- **修订 #7**：autoRoute 评分修正，screening 画像选快引擎（测试 5 固化）
- **修订 #8**：formula-only 构建必须显式 StructureResolver，来源写谱系（测试 2/4）
- **修订 #10**：license 是前置门禁不是可逆效果；工具注册即 effect，卸载自动回收（测试 8）
- **时空可组合性（时间维）**：计算事件 → append-only Trajectory（测试 7/11：批量任务逐变体溯源）
- **原子化操作**：relax/calculate 原语同时暴露给工具与编程 API；substitute 为不可变 fork（测试 10）
- **后端路由**：sidecar 按结构元素逐调用选择 ASE EMT / LJ 兜底，能力声明在 hello 握手（测试 9 依此跳过或断言真物理）

## 引用

Saturday 的架构范式基于以下工作：

```bibtex
@misc{shi2026cordis,
  title         = {A Programming Paradigm for Spatiotemporal Composability},
  author        = {Shi, Yifan and Zhang, Wei and Cui, Tianyi},
  year          = {2026},
  eprint        = {2608.25512},
  archivePrefix = {arXiv},
  primaryClass  = {cs.PL},
  url           = {https://arxiv.org/abs/2608.25512}
}
```

## 许可

MIT
