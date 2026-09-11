# Saturday —— 材料计算的插件运行时

[![CI](https://github.com/toki0413/dsh-saturday/actions/workflows/ci.yml/badge.svg)](https://github.com/toki0413/dsh-saturday/actions/workflows/ci.yml)
[![Install on Smithery](https://smithery.ai/badge/toki0413/saturday-materials)](https://smithery.ai/servers/toki0413/saturday-materials)

简体中文 | [English](./README.en.md)

**Everything is a plugin。** Saturday 不是又一套材料计算引擎，不替代 DFT / MD / FEM / CFD 的任何求解器；
它是材料计算的**组合层**：引擎、结构源、工作流、分析工具全部以插件形态挂载到
**DeepSeek Harness (dsh) / `@deepseek-ai/cordis` v4** 运行时上，由 Agent 在运行时自由挂载、卸载与组合。

插件接口规范见 `packages/bridge/docs/plugin-contract-v0.md`（中文原本，英文摘要版同目录）。

## 核心范式

### 时空可组合性（Spatiotemporal Composability）

理论依据为 Cordis 配套论文：

> *A Programming Paradigm for Spatiotemporal Composability*，Yifan Shi, Wei Zhang, Tianyi Cui，
> arXiv:2608.25512 [cs.PL]（北京大学 / DeepSeek-AI）。

Saturday 把论文的两个正交维度落到材料计算域：

| 维度 | 论文原义 | Saturday 的领域落点 | 仓库中的形态 |
|---|---|---|---|
| 时间维 | 组件副作用可完全逆置（可逆效应） | 研发过程是可挂起/分叉/回放的事件流；可逆的是研究决策，不是物理 | 计算事件 → append-only Trajectory，逐变体溯源；`trajectory.replay` 回放重建索引 |
| 空间维 | 依赖声明 + 反应式管理（响应式协效应） | 跨引擎/跨尺度能力按需激活联动 | 引擎能力在 hello 握手声明，消费方按能力动态决策 |

### 材料计算 = 双通道事件流

各引擎（DFT/MD/FEM/CFD）的运行时行为投影为两类事件，Saturday 的总线只做路由不改物理：

- **瀑布事件（因果链）**：弛豫步、SCF 迭代、MD 步进——传递"当前状态接力棒"，全序、可回放，承载时间维；
- **广播事件（一对多）**：收敛达成、能量异常、属性算出——多消费方订阅联动，承载空间维。

事件粒度因引擎而异（迭代级 ↔ 任务级），由能力握手显式声明。

### 原子化操作（Atomic Operations）

一切研发动作分解为可独立调用、自由组合的原语（`relax` / `calculate` / `substitute` …），
同一组原语同时暴露给 Agent 工具、DSL 与编程 API。原子性按作用域分级：
软件资源域完全可逆（cordis effect）、计算任务域幂等 + 可取消、物理设备域永不回滚。

### 活的材料上下文

材料上下文 = 瀑布事件累积器之上的**响应式谱系图**：每个导出量声明推导来源，
上游变化沿谱系自动传播失效与重算。推导登记簿（`@toki0413/plugin-derivation`）
是这一形态的运行时载体，已接入真实筛选工作流（势函数热替换沿引擎引用全链失效）。
掺杂操作 `Material.substitute` 的不可变 fork 语义保证谱系全程可追溯。

## 能力（v0.3）

| 能力 | 工具 | 说明 |
|---|---|---|
| 材料加载 | `material.load` | 化学式 → 结构（原型库，TiO2 多晶型可选） |
| 分子结构源 | `structure.fromSmiles` | SMILES → 3D 构象（RDKit ETKDG + MMFF/UFF 预弛豫）→ 非周期 Material（pbc=False）；RDKit 缺失显式报错不降级 |
| 结构弛豫 | `potential.relax` | 周期性体系：ASE EMT 真实物理（UnitCellFilter + BFGS）；分子体系（pbc=False）：RDKit MMFF/UFF 力场引擎（体系-引擎自动匹配，错配显式拒绝）；纯 Node 环境走零依赖 lj-js 引擎（LJ 玩具势） |
| 掺杂筛选 | `workflow.screen` | 基体 + N 掺杂变体批量弛豫 → 能量排序 → 逐变体溯源；注入参考态后自动升级为严格形成焓 + 多组分凸包判据；支持多浓度扫描与共掺候选；采样候选可参与联合排序（能量证据 × 提议似然 → 重要性权重），证据源可扩展（凸包距离、理想混合熵等，注册表化接入） |
| MP 结构源 | `structure.resolve` | Materials Project 远端解析（`@toki0413/plugin-mp`，需 MP_API_KEY） |
| 轨迹回放 | `trajectory.replay` | 从 append-only 事件流重建计算索引（`@toki0413/plugin-replay`） |
| 势垒分析 | `analysis.neb` | NEB 最小能量路径与过渡态势垒（`@toki0413/plugin-neb`） |
| 状态方程 | `analysis.eos` | Birch-Murnaghan（三阶）EOS 拟合（`@toki0413/plugin-eos`） |
| 声子分析 | `analysis.phonon` | Γ 点声子：力注入式有限位移 + 声学和规则，频率/虚频/显式阈值稳定性判定（`@toki0413/plugin-phonon`） |
| 弹性张量 | `analysis.elasticity` | 完整 6×6 刚度张量：6 种 Voigt 应变 ± 中心差分（12 次引擎应力计算），VRH 多晶 K/G/E/ν、Born 正定判据、各向异性因子 A；应力源能力门禁（需引擎声明 calculate+stress，当前为 MACE 常驻档；无应力显式拒绝不近似）（`@toki0413/plugin-elasticity`） |
| 候选采样 | `sampler.perturb` | 参考结构微扰采样（`@toki0413/plugin-sampler-perturb`） |
| OU 候选采样 | `sampler.ou` | Ornstein-Uhlenbeck 参考结构采样：闭式转移核 + 精确提议似然；多锚点混合提案支持跨盆地探索（`@toki0413/plugin-sampler-ou`） |
| 流采样 | `sampler.flow` | 仿射耦合流采样：双射输运映射 `invertible:true` + 换元公式精确似然，`encode` 反演回潜空间（`@toki0413/plugin-sampler-flow`） |
| 随机结构搜索 | `sampler.rss` | RSS 均匀随机结构生成：成分/原子数/晶胞约束 + 最小间距门禁，种子确定性；§4.5 第二个生成式实现（非 flow 路线），似然诚实声明 none（`@toki0413/plugin-rss`） |
| 采样回算闭环 | `workflow.explore` | 候选逐送入引擎回算验证后按能量排序（引擎是唯一 oracle，`@toki0413/plugin-explore`） |
| 遍历对账 | `workflow.ergodic` | 采样系综平均 对 恒温 MD 时间平均；判定强度随采样器似然声明分级（`@toki0413/plugin-ergodic`） |
| 构型自由能 | `workflow.freeEnergy` | 温度网格逐点恒温 MD + 热力学积分出构型自由能曲线；自由能零点（锚点）显式注入，支持谐波近似物理化（`@toki0413/plugin-free-energy`） |
| 活性上下文 | `derivation.*` | 推导登记簿：导出量声明推导来源，失效沿推导图向下游传播，冻结结果只追加修正不重算（`@toki0413/plugin-derivation`） |
| 锚点库 | `sampler.anchor.*` | 弛豫收敛结构自动入库（谱系必填）→ 检索 → 混合提案；支持落盘/回填、血缘审计、修复与触发判据对账（数据治理工具链） |

### MCP server：任意 MCP 宿主接入

上述工具面经 `@toki0413/mcp-server` 以 Model Context Protocol 全量暴露（33 工具，
stdio 传输；工具面随环境如实收缩——无 `MP_API_KEY` 时 `structure.resolve` 不注册 = 32 工具，
环境不可用的引擎/结构源挂载即跳过并显式报告，不展示注定失败的能力）：
Claude Desktop / Cursor / Cline 等任何 MCP 宿主零代码接入，
参数 schema 由各工具的契约声明直通，工具失败以 MCP isError 携带结构化错误码。

```bash
npx @toki0413/mcp-server        # stdio；SATURDAY_DISABLE 可排除插件
```

宿主配置（Claude Desktop / Cursor / Cherry Studio 等通用 `mcpServers` 格式）：

```json
{
  "mcpServers": {
    "saturday-materials": {
      "command": "npx",
      "args": ["-y", "@toki0413/mcp-server"],
      "env": {
        "MP_API_KEY": "可选：Materials Project 远端结构解析需要"
      }
    }
  }
}
```

环境档位声明：纯 Node 环境下工具面为 lj-js 教学档（零依赖玩具势）；本地安装 Python ≥ 3.10 + ASE ≥ 3.22 后自动解锁 EMT 真物理与全量 31 工具（启动横幅如实呈报，非静默降级）。

宿主适配层边界：MCP server 只依赖 `@toki0413/kernel` 的无宿主引导
（`bootstrapPlugins`，cordis 的 import 收敛在 kernel 包内）与插件包，
插件本身对 MCP 无感知——防腐层纪律不变。

引擎插件矩阵（均接入 `@toki0413/contract-tests` 标准套件）：
`emt-mock`（核心，ASE EMT / LJ）、`lj-js`（零依赖纯 JS，玩具势教学档，优雅回退数据面）、`lammps`（批处理，粒度 job）、`mace`（ML 势，可用性预检）、`ase`（通用 ASE 计算器，自带 sidecar）。

EMT 能量零点为各元素平衡 fcc 晶体，energyPerAtom 近似形成焓。Cu 掺杂筛选实测：
**Cu3Pt (-0.10) < Cu3Au (-0.02) < Cu (0) < Cu3Ni (+0.01) < Cu3Ag (+0.02) eV/atom**——
有序化（Cu-Pt / Cu-Au）与相分离（Cu-Ni / Cu-Ag）倾向与实验冶金学一致。

## 环境矩阵

开箱即用：`git clone → npm install` 后，**纯 Node 环境即可跑全部 12 个演示**（无额外依赖）。
数据面形态随环境自适应，启动横幅如实呈报（非静默降级：回退引擎是显式注册的独立引擎）。

| 环境 | 数据面 / 可用引擎 | 说明 |
|---|---|---|
| 纯 Node（无 Python） | `lj-js`（零依赖纯 JS，LJ 玩具势） | 全部演示可跑；精度为教学档（玩具势声明在先，参考态为引擎自洽参考非实验值） |
| + Python ≥ 3.10 + ASE ≥ 3.22 | `emt-mock`（EMT 真物理）+ `ase` | 解锁 EMT 精度；sidecar 内缺 ASE 自动回退 LJ 玩具势（如实声明） |
| + LAMMPS / MACE | `lammps` / `mace` | 生产级引擎接入；缺失时可用性预检如实报告（不注册不降级）；MACE 另支持常驻 batch 模式（`resident: true`，模型加载一次，relax/calculate/md；transport 可指 SshTransport 跑远程 GPU） |
| + 远程集群（SSH） | sidecar 在远程执行 | 站点配置 `~/.saturday/clusters.json` + `bridge.cluster` 指定；连接失败显式上抛不回退本地（远程语义是算力选择） |

- **Node ≥ 22**（dsh 硬性要求；裸 cordis 测试可在 Node 20 运行）
- Python 数据面依赖：numpy + scipy（仅升级精度时需要）
- Windows 下默认使用 `python` 命令，可用 `bridge.python` 配置覆盖
- pnpm

## CI（数据面双档矩阵）

每次推送/PR 自动跑两档（`.github/workflows/ci.yml`），与上方环境矩阵一一对应：

| 档位 | 环境 | 验证目标 |
|---|---|---|
| zero-deps | 纯 Node（不装任何 Python 依赖） | 开箱即用承诺：数据面优雅回退 `lj-js`，全量测试 + 演示冒烟 + 发布形态核验 |
| full-fidelity | Node + Python + ASE + scipy | EMT 真物理精度档：真实弛豫/参考态/互转自检 + 摘要再生冒烟 |

两档跑同一份测试：套件内环境自适应（`HAS_ASE`/`dataPlane` 探测 + 显式 skip，诚实不静默）；
真物理断言（晶格常数、严格形成焓、互转自检）仅在精度档执行，零依赖档如实跳过不伪造。

## 结构（npm workspaces）

```
packages/
  kernel/                     # @toki0413/kernel —— 防腐层：全仓唯一接触 cordis 的文件
    src/cordis-adapter.mjs    #   SaturdayRuntime 接口 + append-only Trajectory
  core/                       # @toki0413/core —— 领域核心（零运行时依赖）
    src/material.mjs          #   Material 领域对象（谱系、视图、substitute 掺杂）
    src/potential.mjs         #   PotentialRegistry（引擎 seam + 评分路由 + 粒度门禁）
    src/structure-resolver.mjs#   结构解析 seam（原型库，含多晶型 + 7 种 fcc 金属）
    src/elements.mjs          #   元素表（Z/符号/电负性，化学式合成）
  python-bridge/              # @toki0413/python-bridge —— 通用 Python sidecar 客户端
    src/bridge.mjs            #   stdio JSON-lines，握手/超时/批量
    sidecar.py + adapters/    #   主 sidecar：按元素逐调用路由 ASE EMT / LJ 兜底
  contract-tests/             # @toki0413/contract-tests —— 契约测试套件（兼容性由测试承诺）
    src/index.mjs             #   structureResolver / potentialProvider / workflow / sampler / derivation
  bridge/                     # @toki0413/bridge —— dsh Bundle（saturday 主插件）
    src/saturday.plugin.mjs   #   cordis 插件入口 { name, apply }
    profiles/cordis.patch.yml #   挂载到 dsh profile 的示例
    docs/plugin-contract-v0.md#   Plugin Contract v0（插件契约，experimental）
plugins/                      # 插件生态（新插件必须过 contract-tests 套件）
  screening/                  #   @toki0413/plugin-screening —— 工作流：批量掺杂筛选
  mp-structure-source/        #   @toki0413/plugin-mp —— 结构源：Materials Project
  lammps/                     #   @toki0413/plugin-lammps —— 引擎：LAMMPS 批处理，粒度 job
  mace/                       #   @toki0413/plugin-mace —— 引擎：MACE ML 势，一次性/常驻 batch 双形态，可用性预检
  ase/                        #   @toki0413/plugin-ase —— 引擎：通用 ASE 计算器，自带 sidecar
  lennard-jones/              #   @toki0413/plugin-lj —— 引擎：零依赖纯 JS LJ（优雅回退数据面，指纹 lj-js）
  replay/                     #   @toki0413/plugin-replay —— 分析：Trajectory 回放与索引重建
  rss/                        #   @toki0413/plugin-rss —— 采样：RSS 随机结构搜索（§4.5 非 flow 生成式第二实证）
  neb/                        #   @toki0413/plugin-neb —— 分析：NEB 最小能量路径与势垒
  eos/                        #   @toki0413/plugin-eos —— 分析：Birch-Murnaghan 状态方程拟合
  phonon/                     #   @toki0413/plugin-phonon —— 分析：Γ 点声子（虚频与稳定性判定）
  elasticity/                 #   @toki0413/plugin-elasticity —— 分析：6×6 弹性张量 + Born 判据 + VRH
  sampler-perturb/            #   @toki0413/plugin-sampler-perturb —— 采样：参考结构微扰
  sampler-ou/                 #   @toki0413/plugin-sampler-ou —— 采样：OU 受控扩散 + 混合提案 + 锚点工具链
  sampler-flow/               #   @toki0413/plugin-sampler-flow —— 采样：仿射耦合流（可逆输运 + 换元精确似然）
  explore/                    #   @toki0413/plugin-explore —— 工作流：采样 → 回算闭环
  ergodic/                    #   @toki0413/plugin-ergodic —— 工作流：遍历对账
  free-energy/                #   @toki0413/plugin-free-energy —— 工作流：构型自由能曲线（热力学积分）
  derivation/                 #   @toki0413/plugin-derivation —— 活性上下文：失效传播与惰性重算
```

## 运行

```bash
npm install             # workspaces：@deepseek-ai/cordis（peer）+ 全部 @toki0413/* 包软链
npm test                # 全部 workspace 测试
npm run summary         # 再生项目摘要（实跑全部包测试 + 提取契约实证表 → SUMMARY.md/.json）
node scripts/pack-check.mjs   # 发布形态核验（逐包 pack 干跑：版本一致 + files 白名单）

# 端到端演示（均无需 API Key，纯 Node 环境全部可跑：
# 无 Python 时数据面自动回退零依赖 lj-js 引擎，横幅如实呈报）
npm run demo --workspace @toki0413/bridge                    # 基础端到端
npm run demo:screening --workspace @toki0413/bridge          # 掺杂筛选（环境自适应：EMT 或 lj-js）
npm run demo:screening-ternary --workspace @toki0413/bridge  # 三元混掺筛选（多组分凸包判据）
npm run demo:concentrations --workspace @toki0413/bridge     # 多浓度/共掺扫描（非退化凸包包络）
npm run demo:freeenergy --workspace @toki0413/bridge         # 构型自由能曲线（恒温 Langevin MD + 谐波锚点）
npm run demo:cross-engine --workspace @toki0413/bridge       # 跨引擎对照（单位/指纹门禁）
npm run demo:availability --workspace @toki0413/bridge       # 引擎可用性预检
npm run demo:mixture-sampling --workspace @toki0413/bridge   # 多锚点混合采样（闭式似然重算 + 回算闭环）
npm run demo:anchor-guided --workspace @toki0413/bridge      # 锚点引导闭环（入库→检索→提案→回算→排序）
npm run demo:anchor-auto --workspace @toki0413/bridge        # 全自动锚点闭环（弛豫产物自动入库）
npm run demo:anchor-resume --workspace @toki0413/bridge      # 跨会话恢复（落盘→回填→续供，谱系不断）
npm run demo:rss --workspace @toki0413/bridge                # RSS 随机结构搜索 → 回算闭环（环境自适应）
npm run demo:agent --workspace @toki0413/bridge              # Agent 会话端到端（mock LLM，十个阶段）
```

## 挂载到 dsh（完整运行时）

```bash
npm i @deepseek-ai/dsh                 # 需要 Node ≥ 22
export DSH_HOME=~/.dsh
dsh web --help                         # 首次运行自动初始化 web profile
# 1) 在 $DSH_HOME/profiles/web/package.json 的 dependencies 声明：
#    "@toki0413/bridge": "file:/path/to/Saturday/packages/bridge"
# 2) cd $DSH_HOME/profiles/web && pnpm install
# 3) 把 packages/bridge/profiles/cordis.patch.yml 的 - insert: 行写入 profile 的 cordis.patch.yml
dsh --profile web --dump-config        # 验证组合树包含 saturday 行
dsh web                                # 启动
```

`demo:agent` 展示 Agent 会话的完整编排能力：裸 cordis 进程内组装全部真实 dsh 服务 +
脚本化 mock 模型，覆盖材料加载、真实弛豫、采样联合排序、锚点持久化与恢复、血缘审计、
修复验收与回填十个阶段，全部以自然语言驱动。

## 设计原则

- **契约即宪法**：`@toki0413/contract-tests` 提供 structure-resolver / potential-provider /
  workflow / sampler / derivation 五条 seam 的标准断言集，新插件 `npm test` 即过宪法；
  兼容性由测试而非文档承诺
- **防腐层（依赖卫生）**：领域代码不 import cordis，上游变更的影响面收敛到适配层一个文件；
  dsh 为唯一官方宿主，裸 cordis 作为开发/CI 模式
- **单位与能力指纹入契约**：引擎注册即校验单位三元组与能力指纹；换算只能由调用方显式发起；
  异源/异单位能量进入比较路径前显式拒绝；实测版本可回读盖章（`demo:cross-engine` /
  `demo:availability` 展示全链）
- **热力学诚实**：能量零点显式声明——严格形成焓 + 凸包判据需要显式参考态，
  不可得时降级并明说；自由能零点（锚点）同理
- **采样语义**：逆解是对相容分布的采样而非求逆；似然可求值性显式声明；
  候选必须可回算验证，引擎是唯一 oracle
- **谱系即活性**：导出量登记推导来源，失效沿推导图传播；落盘载荷携带可追溯声明，
  跨会话可撤回
- **摘要可再生**：`npm run summary` 从测试输出与契约实证表机械汇编 `SUMMARY.md`，
  不手写、不人工维护

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
