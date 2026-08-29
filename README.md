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
| 时间维 | 组件副作用可完全逆置（可逆效应） | 研发过程是可挂起/分叉/回放的事件流；**可逆的是研究决策，不是物理** | 计算事件 → append-only Trajectory，逐变体溯源；`trajectory.replay` 回放重建索引 |
| 空间维 | 依赖声明 + 反应式管理（响应式协效应） | 跨引擎/跨尺度能力按需激活联动 | 引擎能力在 hello 握手声明，测试按能力动态增强断言 |

### 材料计算 = 双通道事件流

各引擎（DFT/MD/FEM/CFD）的运行时行为投影为两类事件，Saturday 的总线只做路由不改物理：

- **瀑布事件（因果链）**：弛豫步、SCF 迭代、MD 步进——传递"当前状态接力棒"，全序、可回放 → 承载时间维；
- **广播事件（一对多）**：收敛达成、能量异常、属性算出——多消费方订阅联动 → 承载空间维。

事件粒度因引擎而异（迭代级 ↔ 任务级），由能力握手显式声明，不强行归一。

### 原子化操作（Atomic Operations）

一切研发动作分解为可独立调用、自由组合的原语（`relax` / `calculate` / `substitute` …），
同一组原语同时暴露给 Agent 工具、DSL 与编程 API 两种消费方。原子性按作用域分级：
软件资源域完全可逆（cordis effect）、计算任务域幂等 + 可取消、物理设备域永不回滚。

### 活的材料上下文（目标形态）

材料上下文 = 瀑布事件累积器之上的**响应式谱系图**：每个导出量声明推导来源，
上游变化沿谱系自动传播失效与重算。掺杂操作 `Material.substitute` 的不可变 fork
语义是这一方向上的第一个落地原语。

## 当前状态：Phase 0 结论 —— Go

- 裸 cordis：**175/175 测试通过**（16 个含测试包：bridge 27 项集成验收 + 契约测试套件自检 24 项 + core 热力学纯层 8 项 + 各插件契约测试，含 ASE EMT 真物理、真实 sidecar 集成、NEB 势垒对账、Cu EOS 拟合集成、首个采样器确定性验证、采样→回算闭环排序验证、遍历对账（Langevin MD 时间平均）真实链路、活性上下文失效传播（含势函数热替换→筛选候选全链失效）、严格形成焓+凸包判据与互转精度/电子结构门禁验证）
- **真实 dsh web 运行时：profile 级挂载验证通过（0 错误，工具通过真实注册表校验，Python sidecar 由 dsh 拉起）**
- 已验证最小闭环："Agent 工具调用 → 真实计算 → 事件回流 Trajectory → 回放重建索引"

详见《packages/bridge/DSH适配清单.md》（含 Node ≥ 22 硬性要求等实测结论）。

## 能力（v0.3）

| 能力 | 工具 | 说明 |
|---|---|---|
| 材料加载 | `material.load` | 化学式 → 结构（原型库，TiO2 多晶型可选） |
| 结构弛豫 | `potential.relax` | **ASE EMT 真实物理**（UnitCellFilter+BFGS），LJ 玩具势兜底 |
| 掺杂筛选 | `workflow.screen` | 基体 + N 掺杂变体批量弛豫 → 能量排序 → 逐变体 Trajectory 溯源（独立插件 `@saturday/plugin-screening`） |
| MP 结构源 | `structure.resolve` | Materials Project 远端解析（独立插件 `@saturday/plugin-mp`，需 MP_API_KEY） |
| 轨迹回放 | `trajectory.replay` | 从 append-only 事件流重建计算索引，回放事件带 `saturday/replay/` 防回灌前缀（独立插件 `@saturday/plugin-replay`） |
| 势垒分析 | `analysis.neb` | NEB 最小能量路径与过渡态势垒：§4.4 analysis seam 首个实证，纯 Node、能量/梯度注入式，内置 LJ 双阱玩具体系（独立插件 `@saturday/plugin-neb`） |
| 状态方程 | `analysis.eos` | Birch-Murnaghan（三阶）EOS 拟合：§4.4 第二个实证；显式 (V, E) 序列或按缩放体积静态单点自产，四参数联合辨识，收敛/rmse/r² 诚实声明（独立插件 `@saturday/plugin-eos`） |
| 候选采样 | `sampler.perturb` | 参考结构微扰采样：§4.5 sampler seam 首个实证；采样语义强制声明、似然诚实（none）、种子确定性、候选带 `generative:` 谱系前缀且可回算构造 Material（独立插件 `@saturday/plugin-sampler-perturb`） |
| 采样回算闭环 | `workflow.explore` | §4.5 oracle 条款首个实证：候选逐送入引擎回算验证后按能量排序，候选不自证；谱系标记 + 逐变体事件全程可溯源（独立插件 `@saturday/plugin-explore`） |
| 遍历对账 | `workflow.ergodic` | §4.5 oracle 条款对账实证：采样系综平均 对 同一能量函数恒温 MD 时间平均；判定强度随采样器似然声明诚实分级（likelihood:'none' 仅信息性）；依赖 `md` 能力（§4.2 契约化扩展，独立插件 `@saturday/plugin-ergodic`） |
| 活性上下文 | `derivation.*` | §8.2 首个实证：推导登记簿——导出量声明推导来源，失效沿推导图向下游传播（幂等），冻结结果只追加修正不重算（§7），重算惰性且预算受控（独立插件 `@saturday/plugin-derivation`） |

引擎插件矩阵（均接入 `@saturday/contract-tests` 标准套件）：
`emt-mock`（核心，ASE EMT/LJ）、`lammps`（批处理，粒度 job）、`mace`（ML 势，可用性预检）、`ase`（通用 ASE 计算器，自带 sidecar）。

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
  python-bridge/              # @saturday/python-bridge —— 通用 Python sidecar 客户端
    src/bridge.mjs            #   stdio JSON-lines，握手/超时/批量（可换 ZeroMQ）
    sidecar.py + adapters/    #   主 sidecar：按元素逐调用路由 ASE EMT / LJ 兜底
  contract-tests/             # @saturday/contract-tests —— 契约测试套件（§8.3：兼容性由测试承诺，三条 seam）
    src/index.mjs             #   structureResolverContract / potentialProviderContract / workflowContract
  bridge/                     # @saturday/bridge —— dsh Bundle（saturday 主插件）
    src/saturday.plugin.mjs   #   cordis 插件入口 { name, apply }（2 个工具）
    src/compute/emt-provider.mjs#  EMT Provider（零 license 依赖）
    profiles/cordis.patch.yml #   挂载到 dsh profile 的示例
    test/spike.test.mjs       #   14 项验收 + 契约测试
    docs/plugin-contract-v0.md#   Plugin Contract v0（插件契约，experimental）
plugins/                      # 插件生态（新插件必须过 contract-tests 套件）
  screening/                  #   @saturday/plugin-screening —— 工作流：批量掺杂筛选（§4.3）
  mp-structure-source/        #   @saturday/plugin-mp —— 结构源：Materials Project（§4.1）
  lammps/                     #   @saturday/plugin-lammps —— 引擎：LAMMPS 批处理，粒度 job（§4.2）
  mace/                       #   @saturday/plugin-mace —— 引擎：MACE ML 势，可用性预检（§4.2）
  ase/                        #   @saturday/plugin-ase —— 引擎：通用 ASE 计算器，自带 sidecar（§4.2）
  replay/                     #   @saturday/plugin-replay —— 分析：Trajectory 回放与索引重建（时间维读侧）
  neb/                        #   @saturday/plugin-neb —— 分析：NEB 最小能量路径与势垒（§4.4 首个实证）
  eos/                        #   @saturday/plugin-eos —— 分析：Birch-Murnaghan 状态方程拟合（§4.4 第二实证）
  sampler-perturb/            #   @saturday/plugin-sampler-perturb —— 采样：参考结构微扰（§4.5 首个实证）
  explore/                    #   @saturday/plugin-explore —— 工作流：采样→回算闭环（§4.5 oracle 首个实证）
  ergodic/                    #   @saturday/plugin-ergodic —— 工作流：遍历对账（采样系综 对 MD 时间平均，§4.5）
  derivation/                 #   @saturday/plugin-derivation —— 活性上下文：失效传播与惰性重算（§8.2 首个实证）
```

## 运行

```bash
# 裸 cordis 验证（无需 dsh、无需 LLM/API Key）
npm install             # workspaces：@deepseek-ai/cordis（peer）+ 全部 @saturday/* 包软链
npm test                # 全部 workspace 测试（当前 175 项，16 个包）
npm run demo --workspace @saturday/bridge            # 端到端演示
npm run demo:screening --workspace @saturday/bridge  # 掺杂筛选演示（ASE EMT 真物理）
npm run demo:agent --workspace @saturday/bridge      # Agent 会话端到端（mock LLM，无需 API Key）
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

Agent 会话演示（无真实 API Key）：`npm run demo:agent --workspace @saturday/bridge`——裸 cordis 进程内组装全部真实 dsh 服务 + `dsh-llm-mock-server@0.0.1-rc.1` 脚本化模型，两段实证（自然语言 → material.load → 结果回流；自然语言 → potential.relax → 真实 ASE EMT 计算），详见适配清单 §9/§10。

## 设计锚点（与 v3.3 方案对应）

- **防腐层（依赖卫生）**：领域代码不 import cordis，上游破坏性变更影响面 = 1 个文件；dsh 为唯一官方宿主，裸 cordis 仅作开发/CI 模式
- **修订 #7**：autoRoute 评分修正，screening 画像选快引擎（测试 5 固化）
- **修订 #8**：formula-only 构建必须显式 StructureResolver，来源写谱系（测试 2/4）
- **修订 #10**：license 是前置门禁不是可逆效果；工具注册即 effect，卸载自动回收（测试 8）
- **契约即宪法**：`@saturday/contract-tests` 提供 structure-resolver / potential-provider / workflow / sampler / derivation 五条 seam 的标准断言集，新插件 `npm test` 即过宪法；兼容性由测试而非文档承诺（§8.3）
- **sampler seam（§4.5，首个实证落地）**：生成式逆设计的唯一入口——采样语义强制声明、似然与可逆性诚实声明、候选必须可回算验证（生成 → 弛豫 → 核对闭环）；`samplerContract` 套件已随首个实现（plugin-sampler-perturb 微扰采样）入包，闭环由 `workflow.explore` 首个实证（候选不自证，引擎是唯一 oracle），遍历对账由 `workflow.ergodic` 补齐（采样系综平均 对 同一能量函数恒温 MD 时间平均，判定强度随似然声明诚实分级）；Boltzmann 生成器 / 潜空间 normalizing flow 后续挂载于此
- **活性上下文地基（§8.2，首个实证落地）**：plugin-derivation 把“响应式谱系图”从目标形态变成测试——每个导出量登记推导来源，上游失效沿推导图向下游传播（重复失效幂等），冻结结果（实验数据/已交付，§7）只追加修正不重算，重算惰性且预算受控（超预算显式报错）；不可变 fork（§6）不是失效源；`derivationContract` 第五套件同步入包；**已接真实工作流：排序 = f(基体, 引擎)——`workflow.screen` 完成即登记两层推导，势函数热替换（`activate` 事件）沿 `engine:<id>` 全链失效**；响应式依赖声明（`getService` 下沉）仍为演进方向
- **热力学第一档（§9 欠账清偿）**：能量零点显式化——筛选排序从“近似形成焓”升级为严格形成焓（能量零点 = 各元素参考态经引擎显式弛豫，数据面 `reference_energy` 算子）+ 形成焓空间凸包判据（`energyAboveHull`）；`thermo.level` 声明凸包精度等级（不冒充更高精度），参考态不可得时诚实降级保留“近似”声明；纯层 `formationEnthalpy/convexHull/energyAboveHull` 入 `@saturday/core`（缺参考态/超成分范围显式报错）
- **analysis seam 实证（§4.4，两例）**：plugin-neb（NEB 势垒）与 plugin-eos（EOS 拟合）把“输入/输出类型声明 + 谱系登记”两个冻结点从占位变成测试；分析结果同样落 Trajectory——势垒由独立逐点求值 oracle 对账，EOS 以双数据路 + 拟合质量诚实声明补充实证
- **时空可组合性（时间维）**：计算事件 → append-only Trajectory（测试 7/11：批量任务逐变体溯源）；`trajectory.replay` 从事件流重建计算索引，回放事件带防回灌前缀（可逆的是决策不是物理）
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
