# 食谱索引：按意图找工具与参数

面向使用者的一页路由——"我想做 X → 调哪个工具 → 关键参数 → 有什么前提"。完整入参以各工具
声明的 schema 为准（MCP `tools/list` 自带；库调用见对应工具 `parameters`）。带 **🐍** 需 Python sidecar
（EMT/LAMMPS 真物理），**🔑** 需 `MP_API_KEY`，其余零依赖即可跑（无 ASE 走 lj-js 玩具势兜底，数值仍由引擎回算）。

## 1. 拿到/构造一个结构
| 我想… | 工具 | 关键入参 | 前提 |
|---|---|---|---|
| 按化学式取原型结构 | `material.load` | `query`（如 `"Cu"`、`"TiO2:rutile"`） | — |
| 由 SMILES 造 3D 分子 | `structure.fromSmiles` | `smiles`, `seed` | 🐍 RDKit |
| 贴 VASP POSCAR/CONTCAR 进来 | `structure.fromPoscar` | `text` | — |
| 贴 XYZ 分子进来 | `structure.fromXyz` | `text` | — |
| 贴 CIF（P1 显式原子）进来 | `structure.fromCif` | `text` | —（对称/disorder 显式拒） |
| 从 Materials Project 取 | `structure.resolve` | 见 schema | 🔑 |

产物都是一个 `materialId`，喂给下面所有分析工具。

## 2. 弛豫 / 回算能量力
| 我想… | 工具 | 关键入参 | 前提 |
|---|---|---|---|
| 结构弛豫 + 终态能量 | `potential.relax` | `materialId`, `engine`（`auto` 或具名） | — (🐍 升级 EMT/LAMMPS) |

引擎按声明能力路由；跨引擎结果不自动混拼（单位/指纹门禁，见 §7）。

## 3. 掺杂 / 生成候选 / 探索回算
| 我想… | 工具 | 关键入参 | 前提 |
|---|---|---|---|
| 基体 + N 掺杂批量弛豫排序 | `workflow.screen` | `materialId`, 掺杂表, 浓度扫描 见 schema | — |
| 生成一批候选→逐条回算→按能量排序 | `workflow.explore` | `referenceId`, `sampler`（`reference-perturbation`默认 / `rss` / `affine-flow` / `ou-perturbation`）, `n`, `seed`, `sigma`, `topK` | — |
| basin-hopping 多轮主动学习 | `workflow.activeLearning` | `referenceId`, `sampler`, `rounds`, `candidatesPerRound`, `seed` | — |

`workflow.explore`/`activeLearning` 的 `sampler` 一把切换提议器——一份 sampler seam、多种生成语义
（见 demo：`npm run demo:generative`）。

## 4. 生成式采样器（独立产候选）
| 我想… | 工具 | 关键入参 | 前提 |
|---|---|---|---|
| 成分约束随机结构（RSS） | `sampler.rss` | `referenceId` 或 `elements`+`counts`, `n`, `seed` | — |
| 仿射耦合流（可逆、精确似然） | `sampler.flow`, `sampler.flow.encode` | `referenceId`, `n`, `seed`, `sMax` | — |
| OU 恒温扰动 / 参考微扰 / 多锚点混合 | `sampler.ou`, `sampler.perturb`, `sampler.mixture` | 见 schema（种子确定性） | — |
| OU 锚点库工具链 | `sampler.anchor.*`（add/audit/export/import/load/repair/save/stats）、`sampler.trigger.snapshot.*` | 见 schema | — |

## 5. 势垒 / 自由能 / 遍历对账
| 我想… | 工具 | 关键入参 | 前提 |
|---|---|---|---|
| NEB 势垒 | `analysis.neb` | 见 schema | 🐍（需力/应力引擎） |
| 构型自由能曲线 | `workflow.freeEnergy` | 见 schema | — |
| 采样↔时间平均遍历对账 | `workflow.ergodic` | 见 schema | 🐍 |

## 6. 声子 / 热力学 / 状态方程 / 衍射 / 弹性
| 我想… | 工具 | 关键入参 | 前提 |
|---|---|---|---|
| Γ 点声子（稳定性） | `analysis.phonon` | `materialId`, `engine`（全保真需声明力的引擎） | 🐍 |
| 全布里渊区声子热力学 F(T)/Cv | `analysis.phonon.thermo` | `materialId`, 温度区间 | 🐍 |
| 准谐热膨胀 α(T) | `analysis.quasiharmonic` | `materialId`, 温度区间 | 🐍 |
| XRD 粉末衍射谱 | `analysis.xrd` | `materialId`, 波长/角度窗 | — |
| 相鉴定（实测谱↔候选库） | `analysis.xrd.phaseIdentify` | 实测峰, 候选结构, 容差 | — |
| 弹性张量 + VRH K/G/E/ν + Born 稳定 + 声速/θ_D + 单晶各向异性 | `analysis.elasticity` | `materialId`, `engine`（须声明 stress）, `eps` | 🐍（需应力输出） |
| 状态方程拟合 E(V)→E0/V0/B0 | `analysis.eos` | `materialId` 或 `series`, `scales`, `equation`（`birch-murnaghan` / `vinet`） | — |

## 7. 跨引擎对账 / 信任 / 失效传播
| 我想… | 工具 | 关键入参 | 前提 |
|---|---|---|---|
| 同一材料两引擎回算、逐对差与可比性 | `runtime.engine.crossCheck` | `materialId`, `engines`（≥2）, `kind`（calculate/relax） | — |
| 一批候选在两引擎下排序是否一致（便宜引擎能否代贵引擎） | `runtime.engine.rank` | `materialIds`（≥2）, `engines`（≥2，缺省=在册全部）, `kind`, `k` | — |
| 有哪些引擎/能力 | `runtime.capability.list`, `engine.availability` | — | — |
| 热插拔引擎 | `runtime.engine.attach`, `runtime.engine.detach` | 见 schema | — |
| 登记推导 / 查失效 / 触发重算 | `derivation.record`, `derivation.status`, `derivation.invalidate` | 见 schema | — |

可比性只按单位三元组判（不自动换算）；指纹差异如实标注不阻断——差值即引擎/版本分歧信号。

## 8. 会话分支（可回退的规划树）
| 我想… | 工具 | 关键入参 | 前提 |
|---|---|---|---|
| 分一条决策线 / 记一步算得的值 / 并列比对各支 / 选主干 / 看全树 | `session.fork` · `session.record` · `session.compare` · `session.trunk` · `session.status` | `record`: `branch`,`subject`,`key`,`value`；`compare`: `subject`,`key` | — |

add-only、可见性沿祖先链、非破坏式合并——把"模拟是可回退的搜索树"落成原语。

## 9. 回放与接自己的引擎
| 我想… | 怎么做 | 前提 |
|---|---|---|
| 从事件流重建计算索引 | `trajectory.replay` | — |
| 把我的 CLI 引擎接成插件 | `npx @toki0413/plugin-sdk`（`create-saturday-plugin`）填一份引擎描述符（选 codec：`lammps-data`/`xyz`/`poscar`/`cif`），过 `contract-tests` + `conformanceReport`——零 provider 代码 | 见 `packages/sdk/README.md` |

## 诚实边界（通用）
- 候选是采样/生成的分布点，非唯一解；能量/力一律由引擎回算，工具不自证。
- 无 Python 时是 lj-js 玩具势档位（manifest 如实标低精度）；要定量请装 EMT/LAMMPS/MACE 并锁引擎。
- 结构格式支持子集（CIF 仅 P1、lammps-data 仅正交盒等），越界显式报错不静默展开。
- 完整工具清单与参数以运行时的 `tools/list` / 契约附录 A（`plugin-contract-v0.md`）为准。
