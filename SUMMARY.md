# Saturday 项目摘要（自动生成，请勿手改）

生成时间：2026-08-30T04:53:04.821Z

**回归基线：252/252**（19 个包，其中 18 个含独立测试；重跑 `npm run summary` 即可再生本文件）

| 包 | 描述 | 测试 |
|---|---|---|
| `@saturday/bridge` | Saturday dsh Bundle：saturday 主插件（material.load / potential.relax / trajectory）+ Python sidecar 桥 | 30/30 |
| `@saturday/contract-tests` | Saturday 契约测试套件（契约 §8.3）：新插件进入生态必须通过的 seam 一致性测试。兼容性由测试而非文档承诺。 | 24/24 |
| `@saturday/core` | Saturday 领域核心：Material / MaterialService / PotentialRegistry / StructureResolver（零运行时依赖） | 25/25 |
| `@saturday/kernel` | Saturday kernel —— cordis 防腐层（全仓唯一接触 cordis 的文件），暴露 SaturdayRuntime 接口 | — 无独立测试（由契约套件覆盖） |
| `@saturday/python-bridge` | Saturday Python sidecar 通用客户端：stdio JSON-lines、握手、超时、批量任务。任何插件可借此挂接自己的 Python 数据平面。 | 5/5 |
| `@saturday/plugin-ase` | Saturday 通用 ASE 计算器引擎插件：计算器显式指定（lj|emt），自带 Python sidecar 数据面，缺失显式报错绝不隐式替换。 | 11/11 |
| `@saturday/plugin-derivation` | Saturday 推导登记簿插件（契约 §8.2 首个实证）：谱系驱动的失效传播与惰性重算（活性上下文地基）；冻结结果只追加修正、不重算。 | 15/15 |
| `@saturday/plugin-eos` | Saturday 分析插件（契约 §4.4 analysis seam 第二个实证）：Birch-Murnaghan 状态方程拟合，纯 Node 实现；支持显式 (V,E) 序列或经 material/potential 服务按缩放体积静态单点取数。 | 8/8 |
| `@saturday/plugin-ergodic` | Saturday 遍历对账工作流插件（契约 §4.5 oracle 条款）：采样系综平均对同一能量函数恒温 MD 时间平均；判定强度随采样器似然声明诚实分级。 | 14/14 |
| `@saturday/plugin-explore` | Saturday 采样 → 回算闭环工作流插件（契约 §4.5 oracle 条款 + §4.3）：候选经引擎回算验证后排序，候选不自证，全程谱系可溯源。 | 9/9 |
| `@saturday/plugin-free-energy` | Saturday 热力学第二档：构型自由能曲线（热力学积分，d(βF_conf)/dβ = ⟨U⟩，逐温度网格点恒温 MD + 显式锚点）。 | 12/12 |
| `@saturday/plugin-lammps` | Saturday 引擎插件：LAMMPS 批处理引擎（契约 §4.2，事件粒度 job） | 11/11 |
| `@saturday/plugin-mace` | Saturday ML 势引擎插件：MACE（mace-torch）Provider。与 LAMMPS 经典势对照的机器学习势路线；可用性预检失败显式抛错，绝不静默降级。 | 10/10 |
| `@saturday/plugin-mp` | Saturday 结构源插件：Materials Project（契约 §4.1，远端 StructureResolver 实现） | 8/8 |
| `@saturday/plugin-neb` | Saturday 分析插件（契约 §4.4 analysis seam 首个实证）：NEB 最小能量路径与过渡态势垒，纯 Node 实现、能量/梯度注入式；内置 LJ 双阱玩具体系。 | 8/8 |
| `@saturday/plugin-replay` | Saturday Trajectory 回放插件：从 append-only 事件流重建材料计算索引，回放事件加防回灌前缀。时间维可组合性的读侧落地。 | 5/5 |
| `@saturday/plugin-sampler-ou` | Saturday sampler 插件（契约 §4.5 sampler seam 第二实证）：OU（Ornstein-Uhlenbeck）参考结构采样。闭式转移核 + 精确提议似然（likelihood: exact 升档实证）、候选可回算验证。 | 17/17 |
| `@saturday/plugin-sampler-perturb` | Saturday 首个薄 sampler 插件（契约 §4.5 sampler seam 首个实证）：参考结构微扰采样。采样语义强制声明、似然诚实声明（none）、候选可回算验证。 | 9/9 |
| `@saturday/plugin-screening` | Saturday 工作流插件：批量掺杂筛选（契约 §4.3，逐变体事件 + 不吞错） | 31/31 |

## 实证条款（契约文档附录 A，48 条）

- **#1** 服务注册即 effect，卸载全回收（证据：测试 1、8）
- **#2** formula-only 必须显式 resolver，来源写谱系（证据：测试 2、4）
- **#3** 多晶型排序与选择（证据：测试 3）
- **#4** autoRoute 画像评分（修订 #7）（证据：测试 5）
- **#5** 长任务异步原语语义（证据：测试 6）
- **#6** 事件 → Trajectory 落盘（证据：测试 7、11）
- **#7** 能力握手驱动断言强度（证据：测试 9）
- **#8** 不可变 fork 与谱系（证据：测试 10）
- **#9** 逐变体事件与批量溯源（证据：测试 11）
- **#10** license 前置门禁（修订 #10）（证据：测试 12（含失败不污染状态、门禁可重入））
- **#11** 事件粒度声明：job 级显式拒绝细粒度监听（证据：测试 13）
- **#12** 载荷引用语义（无内联大对象）（证据：测试 14）
- **#13** 工作流插件：缺服务显式报错 / 逐变体事件 / 不吞错（证据：plugin-screening 测试 1-4）
- **#14** 结构源 seam 可互换：远端来源写谱系（修订 #8）（证据：plugin-mp 测试 1-4）
- **#15** 引擎插件：注册即 effect，卸载注销且激活指针重置（证据：plugin-lammps 测试 5、6）
- **#16** 批处理引擎：缺二进制显式报 ENGINE_UNAVAILABLE，不静默降级（证据：plugin-lammps 测试 3）
- **#17** seam 标准断言集（§4.1/§4.2）自检与复用（证据：contract-tests self.test（9 项，mp/lammps/mace/ase 已接入））
- **#18** ML 势引擎：可用性预检（`import mace` 探测），不可用显式报 ENGINE_UNAVAILABLE（证据：plugin-mace 测试 1、2）
- **#19** 跨引擎画像路由：validation 选高精度（mace），screening 选低成本（lammps）（证据：plugin-mace 测试 5）
- **#20** 插件自带数据面：计算器显式指定，缺失显式报错绝不隐式替换（证据：plugin-ase 测试 1-3（含真实 sidecar））
- **#21** 时间维回放：从事件流重建索引；回放事件带防回灌前缀，不产生新轨迹（证据：plugin-replay 测试 1-5（含真实筛选对账））
- **#22** sampler seam（§4.5）：采样语义强制声明 / 似然与可逆性诚实声明 / 回算验证闭环 / 生成失败显式错（证据：plugin-sampler-perturb 测试 1-8（首个实证：微扰采样器；MD 对账已由 #28 补齐））
- **#23** analysis seam（§4.4）两个冻结点：输入/输出类型声明 + 谱系登记（分析结果落 Trajectory）；缺输入显式报错不静默（证据：plugin-neb 测试 6-8（含真实挂载与卸载回收））
- **#24** analysis seam（§4.4）第二实证：双数据路（显式序列 / 服务自产）+ 拟合质量诚实声明（converged/rmse/r²）+ 服务依赖调用时解析（证据：plugin-eos 测试 1-8（含真实桥 Cu EOS 集成））
- **#25** workflow seam（§4.3）套件化：结果形状与排序（energyPerAtom 升序）/ 逐变体事件（薄载荷含引用）/ 不吞错 / 缺依赖显式报错（证据：`workflowContract`（套件自检 + plugin-screening 测试 5-8））
- **#26** sampler seam（§4.5）套件化：manifest 自洽（invertible⇔encode）/ generative: 谱系前缀 / 似然诚实（none 禁伪造 logProb）/ 种子确定性 / 两码显式失败 / 候选可回算构造 Material（证据：`samplerContract`（套件自检 mock-sampler + plugin-sampler-perturb 测试 1-4））
- **#27** §4.5 oracle 条款首个实证：采样 → 回算闭环（候选不自证，引擎是唯一 oracle）；候选 Material 带 sampled-candidate 谱系标记，事件薄载荷含谱系 source；基线缺失时 dE 诚实置 null（证据：plugin-explore 测试 1-9（含排序非透传验证 + `workflowContract` 第三个接入者））
- **#28** §4.5 遍历对账（oracle 条款）实证：采样系综平均 对 同一能量函数恒温 MD 时间平均；`md` 能力契约化（§4.2 枚举扩展，声明即承诺原语）；判定强度随采样器似然声明三档分级（none 仅信息性；声明可求且候选附 logProb 时重要性重加权后直接检验；声明与交付不一致降级并明说）（证据：plugin-ergodic 测试 1-14（纯层统计判定 + 升档解析对账 + 插件层挂载/缺服务显式错/非透传 + 真实 ASE sidecar Langevin MD 全链路））
- **#29** §8.2 活性上下文地基首个实证：登记即声明推导来源 / 失效沿推导图向下游传递（幂等）/ 冻结只追加修正且传播不吞（§7）/ 查无显式错 / 惰性重算预算受控 + 拓扑序 + append-only / substitute fork 非失效源（§6）（证据：`derivationContract`（套件自检 mock-derivation + plugin-derivation 测试 1-14））
- **#30** §8.2 活性上下文接真实工作流：排序 = f(基体, 引擎)——筛选完成即登记两层推导（候选能量/排序，`engine:<id>` 契约化入推导输入）；势函数热替换（`activate` 发 `saturday/potential/activated`）即失效源，全链失效 + 重算拓扑序；推导插件可选（未挂载优雅降级）（证据：`derivationContract` 引擎条款 + bridge live-context 测试 1-4）
- **#31** 热力学第一档（§9 欠账清偿）：能量零点显式化——数据面 `reference_energy` 算子（fcc 单胞全弛豫，无承诺后端诚实报错）+ 纯层严格形成焓/二元凸包（缺参考态/超范围显式错，不静默假设零点）；筛选接严格形成焓 + `energyAboveHull` 凸包判据，`thermo.level` 声明精度等级；参考态不可得时诚实降级保留“近似”声明（证据：core thermo 测试 1-8 + python-bridge 参考态 4-5 + bridge thermo 端到端 1-4）
- **#32** sampler seam（§4.5）第二实证：OU（Ornstein-Uhlenbeck）参考结构采样——闭式转移核 + 精确提议似然（`likelihood: 'exact'` 升档，`samplerContract` 第三个接入者）；诚实边界写进交付：exact 指提议核自身（非玻尔兹曼，热力学加权仍须引擎回算）、OU 单峰定位为局部采样器、γΔ 有效性窗口门禁（非正/非有限显式错）（证据：plugin-sampler-ou 测试 1-13（契约 5 + 似然自洽独立重算 + 平稳幅度闭式统计验证 + 均值回归语义 + 插件层挂载/缺依赖/端到端/确定性））
- **#33** §4.5 升档实证：判定强度随似然声明实质升档——`workflow.ergodic` 接 `sampler.ou`（likelihood: 'exact'）后判据从原始均值对比升为重要性重加权（log w = −βU − log q，log-sum-exp 归一）均值对 MD 时间平均；ESS 占比作为重叠度诊断随判定/事件载荷呈现；解析对账体系（σ_q = σ_t 时权重均匀、ESS=1、重加权均值不变，⟨‖u‖²⟩ 落能量均分闭式）不靠数值巧合（证据：plugin-ergodic 测试 4/4a-4c/6/7b（三档判定 + 重加权纯层 + checkErgodic 解析引擎端到端 + 工具层升档））
- **#34** 热力学第二档（§9 从焓到自由能）：`workflow.freeEnergy` 温度网格逐点恒温 MD（复用 `md` 原语）得 ⟨U⟩(β)，沿 β 热力学积分出构型自由能曲线（d(βF_conf)/dβ = ⟨U⟩）；自由能零点延续第一档纪律——锚点必须显式注入（缺锚点 `THERMO_REFERENCE_MISSING`），锚点物理来源声明随交付呈现；诚实声明不含动量部分、逐点附统计标准误；解析对账双核（线性核梯形精确闭式 1e-9 + 谐波核密网格截断收敛），测试首跑即抓出定向积分符号 bug（锚点升温侧不得取绝对值）；曲线型工作流不接 `workflowContract`（变体排序形态不适配，强套会扭曲契约，诚实声明而非冒充合规）（证据：plugin-free-energy 测试 1-9（锚点门禁 + 双核解析对账 + 统计诚实 + 挂载/缺服务/端到端/真实 ASE 冒烟））
- **#35** 多组分凸包（第 1.5 档，二元→d 维推广）：成分空间维度 d = 元素数−1，显式穷举 d-单形（d+1 点仿射无关子集）构造下包络，重心坐标插值 + 最小包络；二元退化与既有实现数值一致（1e-12 对账）；非轴对齐单形闭式核验；端点纪律延续（缺纯元素端点 `THERMO_REFERENCE_MISSING`，不外推）；组合上限显式门禁（`THERMO_TOO_MANY_COMBINATIONS`，不静默换近似算法）；包络单形只用包上点构造（包外点不得参与包络，测试首跑抓出）；包外成分查询显式报错（证据：core thermo 测试 9-14（二元退化对账 + 三元四边形 + 重心闭式 + 端点纪律 + 门禁））
- **#36** 摘要层（可再生产物而非手写文档）：`npm run summary` 实跑全部包测试 + 扫描 package.json + 提取附录 A 实证表 → 机械汇编 `SUMMARY.md`/`SUMMARY.json`；计数对账门禁（有测试但缺结果显式报错）；无独立测试的包（防腐层）诚实标记不计数；失败用例显式标记不隐藏；子进程不继承 `NODE_TEST_*` 环境（嵌套 runner 防御）；摘要只含来源可追溯字段（证据：scripts/summary 测试 1-7（TAP 解析 + 附录 A 表解析 + 组装门禁/确定性 + 真实小包冒烟））
- **#37** 多组分凸包接真实工作流 + 自由能端到端演示 + 分析事件溯源闭环：筛选注入参考态后元素数 ≥ 3 自动升级为统一成分空间凸包（每个元素参考态是端点——形成焓按定义 = 0，是定义事实而非外推），`thermo.mode/hullDimension` 声明判据形态；端点全零时包络即 z=0 超平面，判据与二元弦数值一致（闭式对账）；≤2 元素保持二元 0-0 弦路径不变；自由能端到端演示（真实 ASE/EMT Langevin，`demo:freeenergy`）F(T) 曲线物理一致（⟨U⟩ 随温单调升、ΔF 单调降）；分析事件 `saturday/analysis/complete` 落 Trajectory（`analysis_complete`，与计算事件同一溯源链）；dsh profile 示例补齐工作流插件挂载行（工具自动暴露给 Agent）（证据：plugin-screening 测试 5-6（三元升级闭式对账 + 二元路径保持）+ bridge thermo 测试 3（真实 EMT 多组分）+ demo:freeenergy 端到端验证）
- **#38** 三元混掺真实筛选演示（⑬）：Cu + Ag/Au/Ni/Pt 五元素统一成分空间（d=4），真实 EMT 弛豫 + 全元素参考态显式计算；Cu-Pt/Cu-Au 负 ΔH_f 候选成为稳定相顶点；几何诚实声明：单点掺杂候选位于"基体端点→掺杂端点"连线上，该连线内包络由 0-0 弦主导，判据保持 max(0, ΔH_f) 退化形——非退化判据需共掺内点（见第 39 条），不夸大多组分凸包在单点候选上的作用（证据：demo:screening-ternary 端到端验证（真实 EMT，0.2 s））
- **#39** 多浓度 + 共掺候选接筛选（⑮）：`maxDopedSites` 浓度扫描（每掺杂 k=1..max 各一个变体，越界显式报错：全取代 = 纯掺杂端点属参考态而非候选）+ `codopants` 共掺变体（元素重复/位点冲突/单元素显式报错）；二元分支泛化为逐掺杂系多内点构包，单内点退化为 0-0 弦（行为兼容）；非退化判据闭式对账：共掺候选由单形 (Cu3Pt,Pt,Ni) 包含，包络插值 = −4/75，距离 = 7/75（1e-9 精确）；真实演示（demo:concentrations）：EMT Cu-Pt-Ni 全候选负/正 ΔH_f 分区，Cu2NiPt 共掺有序化（−0.0895）成为稳定相顶点（证据：plugin-screening 测试 7-10（多浓度闭式 0.075 + 越界报错 + 共掺闭式 7/75 + 参数校验）+ demo:concentrations 端到端）
- **#40** 谐波锚点物理化（⑭）：sidecar 新增 harmonic 算子（弛豫→中心差分 Hessian→质量加权简正模；平动零模与真虚频分开计数，零模不进振动闭式，虚频拒绝锚点——两种情况都不静默修正）；量子谐振子闭式在 JS 纯层（单一闭式来源，低温→零点能/高温→经典极限/模间线性叠加/虚频拒收）；`anchorMode='harmonic'` 接线（引擎无原语显式报错，锚点来源声明物理化随交付呈现）；LJ 谱形对账：匹配晶格参数下横模 6 重/纵模 3 重简并（fcc 立方对称）+ ν_L/ν_T ≈ √2（中心力+张力对称比，实测 0.1% 内）（证据：plugin-free-energy 测试 10-12（纯层闭式 + 接线纪律 + 端到端对账）+ plugin-ase 测试 6（真实 sidecar 谱形）+ demo:freeenergy 升级（EMT Cu 谐波锚点端到端））
- **#41** Logits 组合律纯层 + 联合排序接线（⑯）：`combineEvidence` 把仓库既有孤立 log 权重实例（ergodic 重加权/OU logProb/自由能 βF/谐波锚点局部配分）的组合本身立为纯层——独立证据源 log 权重相加（独立性声明必填，缺失即拒 `EVIDENCE_INDEPENDENCE_UNDECLARED`）；候选级证据掩码：缺失即缺失，零填充禁止（log 权重 0 = 伪造中立证据），全源缺失候选拒排（`EVIDENCE_NO_COVERAGE`）；log-sum-exp 归一（整体偏移不变）+ 组合爆炸门禁 + 源名重复防证据重复计数；`screenDopants` 接 `sampled`+`temperatureK`：采样候选逐候选单点回算（不弛豫——弛豫抹掉待加权的涨落信息；不入凸包——成分点与基体重合，候选不自证 §4.5），能量证据 −βU × 提议似然 q → 重要性权重（与 ergodic 升档同形），`sampledJoint` 段附逐候选覆盖/独立性/ESS 诊断；闭式对账：双源权重 2e/(1+2e)、log 权重差 βΔE+ΔlogProb；测试首跑抓出 β 算术错（kB·300≈1/38.7 非 1/1000，换 β=100 eV⁻¹ 良态条件）（证据：plugin-screening evidence 测试 1-8（组合律闭式 + 五条拒绝路径 + ESS）+ screening 测试 11-14（联合排序闭式 + 掩码 + 门禁 + 工具层解析））
- **#42** 采样器 → 筛选真实接线（⑰，候选来自系综而非枚举）：`workflow.screen` 接受 `{materialId, logProb}` 或 `{graph, source, logProb}`（§4.5 SampledStructure 透传，纯层 graph 模态构造 + 谱系登记采样来源；缺结构显式报错不静默丢弃）；OU 候选真实 EMT 单点回算 → 联合权重归一 + 逐候选双源覆盖 + ESS 诊断；缺似然候选保留并标 null 掩码（覆盖子集组合，权重仍归一）；logProb 可由位移闭式独立重算（1e-9，exact 似然声明的实证）；Agent 编排链：sampler.ou → workflow.screen，谱系在编排层不断（证据：bridge sampled-screen 测试 1-3（真 OU + 真 EMT 完整工具链 + 混合覆盖 + 双门禁））
- **#43** 组合律可扩展性实证（⑲⑳，第三证据源）：枚举候选联合排序显式启用 `evidenceSources: ['hull']`——凸包距离作为逐候选稳定性证据（−β·max(0,energyAboveHull)，包内点掩码 0：不伪造“越稳越好”的梯度），焓证据 + 凸包证据双源叠加把包外候选罚分翻倍（闭式 e⁻² 对账）；独立性声明如实含退化关联（包上点凸包证据恒 0，不冒充独立）；无参考态即无凸包即无稳定性证据（显式拒绝不静默近似）；缺省不启用行为与既有完全一致（既有消费方零影响）；温差诚实声明（⑳）：采样器声明自身温度与目标不一致时 `temperatureMismatch` 随交付呈现（声明而非拒绝，不静默纠正）（证据：plugin-screening 测试 15-17（闭式对账 + 三门禁 + 温差三态））
- **#44** Agent 编排链扩展到采样→联合排序（㉑）：`demo:agent` 阶段 C——自然语言 → tool_call(workflow.screen，args 携带 OU 采样交付 {graph, source, logProb}）→ 逐候选真实单点回算 + 联合权重归一（谱系在编排层不断）；dsh 工具三连坑实证入纪律：工作流插件需自行动态 import `defineTool`（否则工具落本地注册表对 dsh 不可见）、`output.render` 必填（工具出口投影）、object 型 `items` 必须显式 `additionalProperties`（UNSUPPORTED_SCHEMA）；根依赖补 `@deepseek-ai/dsh-timeout`（dsh-llm 导入但未声明的隐性依赖）（证据：demo:agent 阶段 C 端到端（真实 EMT，三阶段全绿））
- **#45** 证据源注册表化（②）：`evidenceSources` 白名单分支重构为描述符注册表（{ name, requires, logWeights, independenceNote } 四要素，缺一即接入即坏）；筛选层只做通用循环（解析 → 校验输入要求 → 取逐候选 log 权重 → 追加独立性声明），新证据源在 evidence-sources.mjs 注册描述符即可接入不改筛选代码；`evidenceSourceRegistry` 可注入（第三方自定义源端到端参与组合律，闭式对账），未知源仍显式拒绝（注入注册表不绕过门禁）；组合律三条诚实纪律由 combineEvidence 强制，与源的数量和种类无关——这就是可扩展性本身（证据：plugin-screening 测试 18（解析三态 + 描述符闭式 + 自定义源端到端注入））
- **#46** 采样温度标定与声明（③）：`uEqFromHarmonicTemperature` 闭式 u_eq = √(k_B·T/k_eff)（能量均分语义：温度翻倍幅度 ×√2；力常数必须显式注入——无势能面信息就没有涨落幅度，静默假设力常数 = 伪造涨落标度）；`sampler.ou` 接受显式 `temperatureK` 声明：声明 ≠ 替换（不改变采样行为，uEq 仍是直接参数）——随逐候选交付 `samplerTemperatureK`（⑳ 温差诚实声明的消费源落地）并进谱系（&T=300K，同参数不同声明 = 不同批）；声明前后采样序列与似然逐位一致（闭式回归）（证据：plugin-sampler-ou 测试 14-15（标定闭式 + 五门禁 + 声明不改行为））
- **#47** 多锚点混合采样（④）：OU 单峰 = 局部采样器，跨盆地探索 = 多参考加权混合（`ouSampleMixture`）。混合提案是有限高斯混合，转移密度仍闭式（log Σ π_a N_a，log-sum-exp 数值稳定）→ 似然声明保持 'exact' 不降档；交付的 logProb 是相对**全部锚点**的混合似然（非单锚点似然冒充，可独立重算 1e-9）；候选按锚点配比最大余数法确定性分配（平手取靠前）；归一混合权重随交付呈现（诚实声明的输入）；谱系记所属锚点（#mixture#anchor=k，可追到具体盆地）；同拓扑门禁（跨锚点位移仅在节点数一致时有定义，不静默近似）；单锚点退化与单核采样逐坐标一致（严格推广无隐式行为变化）（证据：plugin-sampler-ou 测试 16-17（一维双锚点手算闭式 + 配额/似然自洽/谱系/四门禁））
- **#48** 单位与能力指纹入契约（异构引擎生态的泛化地基，量纲分析最小落点）：M1 注册门禁——`PotentialRegistry.register` 即校验 `manifest.units`（energy/length/time 三元组，白名单外/维度错位显式拒绝）与 `manifest.fingerprint`（software/method 必填，version 不可得诚实降级 'unknown'），归一声明挂 `_units/_fingerprint`（不改写原 manifest）；换算只能由调用方**显式发起**（`unitConvert`，跨维度/未知单位/非有限值均拒），绝不自动进入能量比较路径（自动换算会掩盖"两个引擎的能量本不该直接比"的物理问题）；契约套件 §4.2 manifest 断言同步加严（新插件接入即验）；M3 能量组合门禁——筛选层参考态升级形态 `{ energyPerAtom, fingerprint?, energyUnit? }` 声明了就对账：异源/异单位进凸包前显式拒绝（不静默混源、不静默换算），纯数值形态诚实降级（声明 ≠ 强制，旧路径不追溯拦截），`referenceProvenance` 与 `providerFingerprint/providerUnits` 随交付呈现（能量来源可追溯性即消费方可核对的交付物）（证据：core units.test 8 项 + potential.test 3 项（M1 自检）、契约套件 §4.2 断言（四引擎 + 自检全绿）、plugin-screening 测试 19（同源/异源/异单位/降级/空壳五态））

> 诚实声明：本摘要由生成器从测试输出、package.json 与契约文档机械汇编；
> 未包含在以上来源中的内容一律不出现。失败用例显式标记，不隐藏。
