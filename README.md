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

- 裸 cordis：**回归 247/247**（19 个回归单元：18 个 workspace 240 项 + 摘要层脚本 7 项；含 bridge 30 项集成验收 + 契约测试套件自检 24 项 + core 热力学纯层 14 项 + 各插件契约测试，含 ASE EMT 真物理、真实 sidecar 集成、NEB 势垒对账、Cu EOS 拟合集成、采样器确定性/精确似然升档、温度标定与声明、多锚点混合采样闭式对账、遍历对账重要性重加权解析对账、活性上下文失效传播、严格形成焓+二元/多组分凸包判据（三元筛选与多浓度/共掺非退化闭式对账）、构型自由能热力学积分解析对账（真实 EMT 端到端演示 + 谐波锚点）、Logits 多证据源组合律与采样候选联合排序（真 OU + 真 EMT 完整工具链，第三证据源=凸包距离可扩展性实证，证据源已注册表化）、Agent 会话三阶段编排实证（含采样→联合排序）、可再生摘要机械汇编；回归/摘要脚本均包内串行防 sidecar 内存竞态）；项目级摘要见 `SUMMARY.md`（`npm run summary` 再生，勿手改）
- **真实 dsh web 运行时：profile 级挂载验证通过（0 错误，工具通过真实注册表校验，Python sidecar 由 dsh 拉起）**
- 已验证最小闭环："Agent 工具调用 → 真实计算 → 事件回流 Trajectory → 回放重建索引"

详见《packages/bridge/DSH适配清单.md》（含 Node ≥ 22 硬性要求等实测结论）。

## 能力（v0.3）

| 能力 | 工具 | 说明 |
|---|---|---|
| 材料加载 | `material.load` | 化学式 → 结构（原型库，TiO2 多晶型可选） |
| 结构弛豫 | `potential.relax` | **ASE EMT 真实物理**（UnitCellFilter+BFGS），LJ 玩具势兜底 |
| 掺杂筛选 | `workflow.screen` | 基体 + N 掺杂变体批量弛豫 → 能量排序 → 逐变体 Trajectory 溯源；注入参考态后元素数 ≥ 3 自动升级为统一成分空间多组分凸包判据（`thermo.mode/hullDimension` 声明形态）；多浓度扫描与共掺候选（`maxDopedSites/codopants`）让包络从端点弦演进为非退化判据；采样候选联合排序（`sampled`+`temperatureK`：逐候选单点回算不弛豫，能量证据 −βU × 提议似然 q 组合为重要性权重，独立性声明/覆盖掩码/ESS 诊断随交付呈现；`evidenceSources: ['hull']` 可加凸包距离第三证据源，包内点掩码不伪造稳定性梯度；证据源已注册表化（描述符 { name, requires, logWeights, independenceNote }，`evidenceSourceRegistry` 可注入自定义源，新源接入不改筛选代码）；采样器声明温度与目标不一致时温差诚实呈现）；演示 `demo:screening-ternary`（三元混掺）、`demo:concentrations`（多浓度非退化包络，独立插件 `@saturday/plugin-screening`） |
| MP 结构源 | `structure.resolve` | Materials Project 远端解析（独立插件 `@saturday/plugin-mp`，需 MP_API_KEY） |
| 轨迹回放 | `trajectory.replay` | 从 append-only 事件流重建计算索引，回放事件带 `saturday/replay/` 防回灌前缀（独立插件 `@saturday/plugin-replay`） |
| 势垒分析 | `analysis.neb` | NEB 最小能量路径与过渡态势垒：§4.4 analysis seam 首个实证，纯 Node、能量/梯度注入式，内置 LJ 双阱玩具体系（独立插件 `@saturday/plugin-neb`） |
| 状态方程 | `analysis.eos` | Birch-Murnaghan（三阶）EOS 拟合：§4.4 第二个实证；显式 (V, E) 序列或按缩放体积静态单点自产，四参数联合辨识，收敛/rmse/r² 诚实声明（独立插件 `@saturday/plugin-eos`） |
| 候选采样 | `sampler.perturb` | 参考结构微扰采样：§4.5 sampler seam 首个实证；采样语义强制声明、似然诚实（none）、种子确定性、候选带 `generative:` 谱系前缀且可回算构造 Material（独立插件 `@saturday/plugin-sampler-perturb`） |
| OU 候选采样 | `sampler.ou` | OU（Ornstein-Uhlenbeck）参考结构采样：§4.5 第二实证；闭式转移核 + 精确提议似然（`likelihood: 'exact'` 升档，逐候选附 `logProb`）；均值回归锚定参考的受控扩散，诚实声明提议核≠玻尔兹曼、局部采样器定位、γΔ 有效性窗口；温度标定闭式 `u_eq = √(k_B·T/k_eff)`（力常数显式注入）与显式温度声明（声明 ≠ 替换，进谱系不改序列）；多锚点混合采样纯层 `ouSampleMixture`（高斯混合转移密度仍闭式，跨盆地探索，似然不降档）（独立插件 `@saturday/plugin-sampler-ou`） |
| 采样回算闭环 | `workflow.explore` | §4.5 oracle 条款首个实证：候选逐送入引擎回算验证后按能量排序，候选不自证；谱系标记 + 逐变体事件全程可溯源（独立插件 `@saturday/plugin-explore`） |
| 遍历对账 | `workflow.ergodic` | §4.5 oracle 条款对账实证：采样系综平均 对 同一能量函数恒温 MD 时间平均；判定强度随采样器似然声明三档分级（升档实证：`sampler.ou` 接入后判据升为重要性重加权均值对时间平均，ESS 占比随判定呈现；声明与交付不一致降级并明说）；依赖 `md` 能力（§4.2 契约化扩展，独立插件 `@saturday/plugin-ergodic`） |
| 构型自由能 | `workflow.freeEnergy` | 热力学第二档：温度网格逐点恒温 MD（复用 `md` 原语）得 ⟨U⟩(β)，沿 β 热力学积分出构型自由能曲线（d(βF_conf)/dβ = ⟨U⟩）；自由能零点（锚点）显式注入不得静默假设，锚点来源声明随交付呈现；逐点附统计标准误，诚实声明不含动量部分；锚点支持谐波近似物理化（`anchorMode: 'harmonic'`：Hessian→简正模→量子谐振子闭式自由能，零模与虚频显式区分声明）；端到端演示 `demo:freeenergy`（真实 ASE/EMT Langevin，独立插件 `@saturday/plugin-free-energy`） |
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
  sampler-ou/                 #   @saturday/plugin-sampler-ou —— 采样：OU 受控扩散 + 精确提议似然（§4.5 第二实证）
  explore/                    #   @saturday/plugin-explore —— 工作流：采样→回算闭环（§4.5 oracle 首个实证）
  ergodic/                    #   @saturday/plugin-ergodic —— 工作流：遍历对账（采样系综 对 MD 时间平均，§4.5）
  free-energy/                #   @saturday/plugin-free-energy —— 工作流：构型自由能曲线（热力学积分，§9 第二档）
  derivation/                 #   @saturday/plugin-derivation —— 活性上下文：失效传播与惰性重算（§8.2 首个实证）
```

## 运行

```bash
# 裸 cordis 验证（无需 dsh、无需 LLM/API Key）
npm install             # workspaces：@deepseek-ai/cordis（peer）+ 全部 @saturday/* 包软链
npm test                # 全部 workspace 测试（当前 315 项，19 个包）
npm run summary         # 再生项目摘要（实跑全部包测试 + 提取契约实证表 → SUMMARY.md/.json）
npm run demo --workspace @saturday/bridge            # 端到端演示
npm run demo:screening --workspace @saturday/bridge  # 掺杂筛选演示（ASE EMT 真物理）
npm run demo:screening-ternary --workspace @saturday/bridge  # 三元混掺筛选演示（多组分凸包判据）
npm run demo:concentrations --workspace @saturday/bridge     # 多浓度/共掺扫描演示（非退化凸包包络）
npm run demo:freeenergy --workspace @saturday/bridge # 构型自由能曲线演示（真实 ASE/EMT Langevin MD）
npm run demo:agent --workspace @saturday/bridge      # Agent 会话端到端（mock LLM，无需 API Key）
npm run demo:cross-engine --workspace @saturday/bridge # 跨引擎对照演示（单位/指纹门禁四段实证）
npm run demo:availability --workspace @saturday/bridge # 可用性预检演示（四引擎环境诚实报告 + 实测态版本回读）
npm run demo:mixture-sampling --workspace @saturday/bridge # 多锚点混合采样演示（闭式似然重算 + 真实 EMT 回算闭环）
npm run demo:anchor-guided --workspace @saturday/bridge # 锚点引导闭环演示（入库 → 检索 → 提案 → 回算 → 联合排序）
npm run demo:anchor-auto --workspace @saturday/bridge  # 全自动锚点引导闭环（弛豫自动入库 → 检索 → 提案 → 回算 → 联合排序，零手动锚点操作）
npm run demo:anchor-resume --workspace @saturday/bridge # 跨会话恢复闭环（会话一弛豫→落盘→终结；会话二回填→检索→提案→回算→联合排序，谱系不断）
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

Agent 会话演示（无真实 API Key）：`npm run demo:agent --workspace @saturday/bridge`——裸 cordis 进程内组装全部真实 dsh 服务 + `dsh-llm-mock-server@0.0.1-rc.1` 脚本化模型，**三段实证**（自然语言 → material.load → 结果回流；自然语言 → potential.relax → 真实 ASE EMT 计算；自然语言 → 采样交付透传 → workflow.screen 联合排序），详见适配清单 §9/§10。

## 设计锚点（与 v3.3 方案对应）

- **防腐层（依赖卫生）**：领域代码不 import cordis，上游破坏性变更影响面 = 1 个文件；dsh 为唯一官方宿主，裸 cordis 仅作开发/CI 模式
- **修订 #7**：autoRoute 评分修正，screening 画像选快引擎（测试 5 固化）
- **修订 #8**：formula-only 构建必须显式 StructureResolver，来源写谱系（测试 2/4）
- **修订 #10**：license 是前置门禁不是可逆效果；工具注册即 effect，卸载自动回收（测试 8）
- **契约即宪法**：`@saturday/contract-tests` 提供 structure-resolver / potential-provider / workflow / sampler / derivation 五条 seam 的标准断言集，新插件 `npm test` 即过宪法；兼容性由测试而非文档承诺（§8.3）
- **单位与能力指纹入契约（M1/M2/M3，异构引擎生态的泛化地基）**：量纲分析最小落点——引擎注册即校验 `manifest.units`（energy/length/time 三元组，白名单外/维度错位显式拒绝）与 `manifest.fingerprint`（software/method 必填，version 不可得诚实降级 'unknown'）；换算只能由调用方显式发起（`unitConvert`），绝不自动进入能量比较路径；筛选层参考态升级形态声明了指纹/单位就对账，异源/异单位进凸包前显式拒绝（不静默混源、不静默换算），`providerFingerprint/providerUnits` 与 `referenceProvenance` 随交付呈现；M2 激活门禁：热切换事件携带 `fingerprintChange` 差异声明（声明为何旧能量不再可比，§8.2 失效传播闭环）；工具层自产参考态按定义同源直接升级为声明形态；`convertedFrom` 换算审计通道（声明≠替换，因子白名单机械重算可复现）；四段实证见 `demo:cross-engine`（交付声明 → M3 拦截 → M2 事件 → 双引擎对照）；**实测态回读升级**：声明态 ≠ 实测态两态各自诚实——`stampFingerprint` 把 version 从 'unknown' 盖章升级为探测实测值（只丰富 version，非实测值拒盖，探测失败方不盖章），三引擎探测按形态各异（ase 走 sidecar 握手、lammps 解析二进制横幅、mace 读 `__version__`），配套 version 维 unknown 通配（未探测不构成差异证据，同源放行但声明"含未验证维"）；四引擎环境诚实报告见 `demo:availability`（注册 = 声明层，可用 = 运行时层，两层各自诚实）
- **sampler seam（§4.5，两个实证落地）**：生成式逆设计的唯一入口——采样语义强制声明、似然与可逆性诚实声明、候选必须可回算验证（生成 → 弛豫 → 核对闭环）；`samplerContract` 套件已随首个实现（plugin-sampler-perturb 微扰采样）入包，第二实证（plugin-sampler-ou）把似然声明从 'none' 升档到 'exact'（OU 闭式转移核，逐候选附可独立重算的 `logProb`；诚实声明提议核≠玻尔兹曼、局部采样器定位）；闭环由 `workflow.explore` 首个实证（候选不自证，引擎是唯一 oracle），遍历对账由 `workflow.ergodic` 补齐并**已实质升档**（OU 接入后判据升为重要性重加权均值对 MD 时间平均，解析对账体系不靠数值巧合）；Boltzmann 生成器 / 潜空间 normalizing flow 后续挂载于此
- **活性上下文地基（§8.2，首个实证落地）**：plugin-derivation 把“响应式谱系图”从目标形态变成测试——每个导出量登记推导来源，上游失效沿推导图向下游传播（重复失效幂等），冻结结果（实验数据/已交付，§7）只追加修正不重算，重算惰性且预算受控（超预算显式报错）；不可变 fork（§6）不是失效源；`derivationContract` 第五套件同步入包；**已接真实工作流：排序 = f(基体, 引擎)——`workflow.screen` 完成即登记两层推导，势函数热替换（`activate` 事件）沿 `engine:<id>` 全链失效**；响应式依赖声明（`getService` 下沉）仍为演进方向
- **热力学第一档（§9 欠账清偿）**：能量零点显式化——筛选排序从“近似形成焓”升级为严格形成焓（能量零点 = 各元素参考态经引擎显式弛豫，数据面 `reference_energy` 算子）+ 形成焓空间凸包判据（`energyAboveHull`）；`thermo.level` 声明凸包精度等级（不冒充更高精度），参考态不可得时诚实降级保留“近似”声明；纯层 `formationEnthalpy/convexHull/energyAboveHull` 入 `@saturday/core`（缺参考态/超成分范围显式报错）
- **热力学第二档（§9 从焓到自由能）**：plugin-free-energy 把 E→G 缺口补上——`workflow.freeEnergy` 逐温度网格点恒温 MD（复用 `md` 原语）得 ⟨U⟩(β)，沿 β 热力学积分出构型自由能曲线；**自由能零点延续第一档纪律：锚点必须显式注入（缺锚点 `THERMO_REFERENCE_MISSING`），锚点物理来源声明随交付呈现**；诚实声明不含动量部分、逐点附统计标准误；解析对账双核（线性核梯形精确闭式 1e-9 + 谐波核密网格截断收敛），测试首跑即抓出定向积分符号 bug（锚点升温侧不取绝对值）；曲线型工作流不接 `workflowContract`（强套会扭曲契约形态，诚实声明入附录 A）
- **多组分凸包（第 1.5 档，已接真实工作流）**：二元凸包推广到 d = 元素数−1 维成分空间——显式穷举 d-单形下包络 + 重心坐标插值（纯层 `multiConvexHull/energyAboveHullMulti` 入 `@saturday/core`）；二元退化与既有实现 1e-12 数值一致；端点纪律延续（缺纯元素端点显式报错不外推）、组合上限显式门禁（不静默换近似算法）；测试首跑即抓出包外点污染包络（包络单形只用包上点构造）；**筛选注入参考态后元素数 ≥ 3 自动升级（每个元素参考态是端点——形成焓按定义 = 0，是定义事实而非外推），≤2 元素保持二元弦路径不变**
- **自由能端到端演示 + 分析事件溯源闭环**：`demo:freeenergy` 用真实 ASE/EMT Langevin MD 跑出 Cu 构型自由能曲线（⟨U⟩ 随温单调升、ΔF 单调降，锚点显式声明）；分析事件 `saturday/analysis/complete` 落 Trajectory（`analysis_complete`，与计算事件同一溯源链）；dsh profile 示例补齐工作流插件挂载行（新工具自动暴露给 Agent）
- **多组分凸包走到真实候选（三元 + 多浓度）**：`demo:screening-ternary` 五元素统一成分空间真实 EMT 筛选（Cu-Pt/Cu-Au 负形成焓候选成为稳定相顶点；单点掺杂位于端点连线上，包络内仍由 0-0 弦主导——几何诚实声明入演示注释）；`demo:concentrations` 以多浓度内点 + 共掺候选把包络从退化弦推向非退化包络（闭式对账：4 元素共掺插值 −0.08·(2/3)，距离 7/75）；筛选纯层新增 `maxDopedSites`（浓度扫描）与 `codopants`（共掺）两参数，二元分支同步泛化为多内点构包
- **谐波锚点（自由能零点物理化）**：`anchorMode: 'harmonic'` 把演示锚点从“显式零点声明”升级为谐波近似计算——ase sidecar 新增 `harmonic` 算子（有限差分 Hessian→质量加权对角化→简正模），纯层量子谐振子闭式自由能（含零点能项）入 free-energy 插件；周期体系平动零模与真虚频显式区分声明；谱形对账不靠数值巧合（LJ 单原子胞无横向恢复力的物理事实入注释，数值对账而非构造论证）；`demo:freeenergy` 已端到端切至谐波锚点（F₀ 由闭式计算而非声明零点，⟨U⟩ 随温单调升、ΔF 单调降）
- **Logits 组合律（多证据源联合排序）**：仓库既有孤立 log 权重实例（遍历重加权/OU logProb/自由能 βF/谐波锚点局部配分）的组合本身立为纯层 `combineEvidence`——独立证据源 log 权重相加，三条诚实纪律强制：独立性声明必填（缺失即拒）、候选级证据掩码缺失即缺失（零填充禁止）、全源缺失候选拒排；筛选接 `sampled`+`temperatureK`：采样候选逐候选单点回算（不弛豫/不入凸包/不自证），能量证据 × 提议似然 → 重要性权重；候选来自系综而非枚举（`sampler.ou` → `workflow.screen` 真实接线，logProb 可闭式独立重算）；**可扩展性已实证：第三证据源 = 凸包距离（`evidenceSources: ['hull']`，包内点 max(0,·) 掩码不伪造稳定性梯度，退化关联如实声明），且证据源已注册表化（描述符四要素 + 可注入注册表，新源接入不改筛选代码——组合律纪律与源的数量/种类无关）；采样器声明温度与目标不一致时温差随交付诚实呈现不纠正，采样温度标定闭式（u_eq = √(k_B·T/k_eff)，力常数显式注入）与显式温度声明（声明 ≠ 替换）已落地，多锚点混合采样（`ouSampleMixture`）把局部采样器推广为跨盆地的高斯混合提案（似然保持 exact，端到端演示 `demo:mixture-sampling`：配额采样 → 似然独立重算 → 真实 EMT 回算）；第二内置证据源 = 理想混合熵（`mixing-entropy`，逐候选组分先验 −Σ x·ln x 与 β 无关，纯元素按定义 0，独立性声明如实含与凸包共享组分变量的退化关联，接入不改筛选代码——可扩展性本身的第二次实证）**
- **证据独立性的机器校验 + 预检工具化 + 锚点库 + 发布准备（⑤⑥⑦⑧）**：⑤证据源可选第五要素 `variables`（依赖变量词表），`auditEvidenceIndependence` 三态审计（未声明者不冒充独立也不拒绝），门禁牙齿：机械检出的共享变量必须在独立性声明文本中被解释否则拒绝（声明是人写的，交集是机器算的），`maskCounts` 随交付呈现；⑥预检从演示升为工具：`engine.availability` 逐引擎如实报告（`stamp` 默认 false——预检是查询不是变更；注册表不因探测失败缩减）；⑦混合提案锚点库 `createAnchorStore`（自监督进场的数据管道第一段：谱系必填入库 + 拓扑硬门禁检索 + 组分 L1 排序，空检索拒伪造锚点）；⑧发布准备：MIT LICENSE 落盘（19 包 license 声明自此有文档实体）+ 契约英文摘要版（忠实摘要而非有损全译，权威文本以中文原本与测试套件为准）
- **锚点库接 Agent 层 + 发布打磨（⑩⑪）**：⑩锚点引导混合提案工具化——`sampler.anchor.add`（材料入库来源声明缺省 = 材料身份，组分从原子序机械提取，直交付无谱系即拒）与 `sampler.mixture`（会话库检索 / 内联锚点二路径 → 配额 → OU 混合提案，`anchorOrigin` 声明来源层，空库拒伪造，两路径共用同一条纯层目标构造——门禁不另开旁路）；会话级内存库与闭环运行同生命周期（不跨会话持久化，不伪造库外数据）；候选回算后经 `workflow.screen` 的 `sampled` 透传，谱系在编排层不断；⑪发布打磨：19 包 `files` 白名单（发布物只含实现与必要数据面：python-bridge 含 sidecar.py/adapters，ase 含 python-sidecar，bridge 含 docs/profiles/demo）；`repository` 元数据诚实空缺（仓库无远程，不编造 URL）
- **锚点引导闭环端到端 + 工具链契约审查（⑫/⑬/⑭）**：⑫`demo:anchor-guided` 全程工具层四段（入库 → 会话库检索 → 混合提案 → 工具间只传交付接 `workflow.screen` 联合排序：真实 EMT 回算、双源证据组合、Σw = 1 配分函数归一，谱系不断）；⑬裁决：`workflow.screen` 不直收 `anchors`（直收 = 筛选插件内嵌采样逻辑破坏插件边界；两步编排即组合律）；⑭审查：锚点工具不新增进 `StructureSampler` seam，交付仍是 `SampledStructure` 形态（`generative:` 前缀 + 可回算构造形态测试）
- **闭环轨迹自动入库 + 锚点工具 Agent 层暴露 + 配额闭式对账（⑮/⑯/⑰）**：⑮自监督数据管道第二段——弛豫收敛且引擎交付终态时弛豫后结构自动入会话锚点库（谱系自动声明 `job:<id>#engine=<name>`）；三道门禁：未收敛不入库 / 旧协议无终态不入库（不拿输入结构冒充）/ 同谱系幂等；引擎 `relax` 交付协议扩展终态坐标/晶胞（ase sidecar 补齐，旧版诚实缺省）；薄事件纪律：结构体不重复落 Trajectory；只积累数据燃料不引入学习组件；⑯`demo:agent` 阶段 D：锚点工具经 dsh harness 暴露给 Agent（工具出口关卡实证：`graph: undefined` 触发 'not lossless JSON' 拒付 → 改显式剔除），阶段 B 弛豫产物自动入库后会话库命中双锚点；⑰最大余数法配额闭式对账：配额只依赖 (n, 归一权重) 与 seed 无关，小数平手取靠前锚点，未归一与归一形态同配额
- **全自动锚点引导闭环 + 不可考组分诚实降级链（⑱/⑲/⑳）**：⑲`demo:anchor-auto` 无人工入库形态——真实弛豫（收敛 + 终态交付）→ ⑮自动入库 → 会话库检索 → 配额 → 提案 → 回算 + 联合排序，全程零手动锚点操作谱系不断；⑳`distance: null` 诚实降级链：缺组分锚点检索排尾（不冒充可比不编造数值）→ 混合提案不因不可考拒绝（排尾不是排除：均匀配额实证参与混合不是陪跑）→ 距离声明随工具层交付如实透传；⑱裁决：会话锚点库不引入淘汰/上限（库与闭环同生命周期，淘汰属持久化关注点；`topK` 已是提案侧参与上限）
- **提案谱系接推导登记簿 + 三元系可扩展性 + 持久化锚点库原型（㉑/㉒/㉓）**：㉑ `sampler.mixture` 注入推导服务时登记一层提案推导（锚点来源归一化 `material:<id>`/`job:<id>`，锚点失效沿推导图传播到提案）；不可追溯来源不冒充输入，全不可追溯不伪登记；未注入行为不变（与 `workflow.screen` 同款）；㉒三元系 {Cu,Ag,Au} 端到端：检索排序/配额闭式 [0.5,0.3,0.2]×9 → [4,3,2]（多 seed 不变）/ 确定性复现——配额与提案不为二元系特化；㉓持久化原型：`sampler.anchor.export`/`import`（无损 JSON 全量导出 + 库层门禁复用 + 同谱系幂等 + 单条拒绝不中断整批），回填锚点即刻可参与混合提案；诚实边界：库自身仍会话级，落盘由调用方负责。
- **持久化落盘侧 + 排序层提案引用全链活性 + 持久化原语 Agent 层暴露（㉔/㉕/㉖）**：㉔ `sampler.anchor.save`/`load`（搬运原语的文件端：落盘→跨会话回填逐字段一致且即刻可提案；错误路径如实——文件缺失/损坏/非载荷形态显式报错 `ANCHOR_PERSIST`，不静默冒充成功；路径调用方显式声明；同库重载同谱系幂等；导入走共享循环，门禁不另开旁路）；㉕ `demo:agent` 阶段 E：`save`/`load` 经 dsh harness 暴露（含全量 graph 的无损 JSON 出口关卡压测 + 落盘→回填→跳过重放幂等）；㉖ `workflow.screen` 直收 `proposalRef` 登记为排序层推导输入——锚点→提案→排序全链活性（三级传播实证）；未声明行为不变，非法引用登记簿显式拒绝；与 ⑬ 分工：不直收的是 `anchors`（结构本体 + 采样逻辑），直收的是推导引用（编排层谱系接线），组合律不破。
- **跨会话恢复端到端 + 回填后活性保持 + 自监督进场条件裁决（㉗/㉘/㉙）**：㉗ `demo:anchor-resume` 编排层兑现“落盘由调用方负责”的诚实边界——会话一真实弛豫 → ⑮自动入库 → `save` 落盘（路径调用方显式声明）→ 会话终结全部回收；会话二全新挂载空库回填 → 检索 → 提案 → 回算 → 联合排序（Σw = 1），谱系跨会话不断；落盘往返行为级无损（同参数逐候选结构/似然/归属/谱系严格一致，无损不只是字段齐全）；两“会话”是同一进程内两次独立挂载，跨会话唯一通道是磁盘载荷（诚实声明）；㉙回填后活性不降级：回填锚点照常登记提案推导（㉑ 归一规则不因回填改变），锚点失效仍沿推导图传播到提案、再传播到排序（㉖ 全链活性跨会话不降级）；材料会话级：跨会话引用不冒充在场；㉘裁决：对照触发条件逐项呈报后维持“不引入自监督”——管道两段（⑦/⑮）+ 跨会话续供机制（㉓/㉔/㉗）已备齐（触发条件第一项的基础设施全部就位），但“足够轨迹”与“探索效率瓶颈”均未出现（先见数据再谈机制，同 ⑬/⑱ 同款裁决模式）
- **恢复闭环接 Agent 层 + 落盘侧谱系可追溯声明 + 落盘载荷完整性校验（㉚/㉛/㉜）**：㉚ `demo:agent` 阶段 F：自然语言“对恢复后的锚点库做混合提案” → 回填锚点即刻参与提案（来源层/谱系跨恢复保留），回填交付的 `lineageRefs` 随阶段日志呈现（恢复闭环在 Agent 层收口）；㉛ `load` 交付附 `lineageRefs`（载荷内可追溯来源的归一化声明，与 ㉑ 归一规则同款）——声明不是装饰：沿 `lineageRefs` 起点 invalidate，提案推导如实失效（谱系从“跨会话保留”升为“跨会话可撤回”，消费方不必翻库）；㉜完整性校验：版本门禁（仅 `saturday-anchor-store/1`，未知/缺失不静默接受）+ `size` 声明对账（声明 ≠ 实质即拒）；单条损坏不连坐（共享导入循环逐条拒绝，合法条目照常入库，与 ㉓ 同款）；三条门禁都不得污染库。
- **条目级版本戳 + 多载荷合并回填 + 载荷血缘审计（㉝/㉞/㉟）**：㉝ 载荷形态升版 `saturday-anchor-store/2`（条目附 `entryVersion: 'saturday-anchor-entry/1'`）——`load` 逐条校验版本戳：缺失/未知版本戳按条目级损坏定位到载荷原位索引拒绝（过滤后不丢定位能力），合法条目照常入库不连坐（损坏检测从“整体非载荷”下沉到条目级）；㉞ `load`/`audit` 支持 `path`（单载荷）或 `paths`（多载荷合并）二选一（不静默猜测调用方意图）；门禁先行——全部文件先过完整性检查，全过才开始回填（任一文件不过 → 整批拒绝，出错时库零污染）；同谱系幂等门禁天然兜底跨载荷重复（数据燃料多源汇聚）；逐文件明细随交付；㉟ `sampler.anchor.audit` 只读血缘三态审计（可追溯/不可追溯/损坏）：审计不回填不污染库，异常文件如实入报告不连坐——回填前的一手数据质量观测面。
- **审计接 Agent 层 + 多载荷合并后的活性保持 + 锚点库容量观测（㊱/㊲/㊳）**：㊱ `demo:agent` 阶段 G：自然语言“先审计落盘载荷的血缘再决定回填” → 只读三态报告回流（全部可追溯、无损坏），库状态不变（观测先于行动的数据纪律在 Agent 层实证）；㊲ 多载荷合并后谱系各自独立可撤回：沿某一来源失效 → 提案推导如实失效，失效不删数据，另一来源与库内条目照常在场（汇聚不糊化谱系边界）；合并后提案锚点归属与载荷谱系逐条一致（不冒充、不丢、不改写）；㊳ `sampler.anchor.stats` 只读库内容量观测（条目数 + 归一化谱系形态分布 + 组分声明覆盖）：观测不变更库，与 ㉟ 载荷审计构成“库内 + 库外”双观测面。
- **Agent 编排链三段实证**：`demo:agent` 阶段 C 把采样→联合排序推到 Agent 层（OU 交付打包进工具参数，谱系在编排层不断）；dsh 工具三连坑入纪律：工作流插件需自行动态 import `defineTool`、`output.render` 必填、object 型 `items` 必须显式 `additionalProperties`；回归/摘要脚本包内串行（并发拉 sidecar + OpenBLAS 线程内存竞态实证，确定性优先于耗时）
- **摘要层（可再生产物）**：`npm run summary` 实跑全部包测试 + 扫描 package.json + 提取契约文档附录 A 实证表 → 机械汇编 `SUMMARY.md`/`SUMMARY.json`；不手写不人工维护，任何状态变更后重跑即同步；计数对账门禁、无测试包诚实标记、失败显式呈现（诚实优先于好看）
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
