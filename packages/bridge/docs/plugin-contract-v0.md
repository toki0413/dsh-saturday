# Saturday Plugin Contract

**版本**: v0（**experimental** —— 1.0 前允许破坏性变更，以契约测试套件为准）
**日期**: 2026-08-29
**状态**: 草案，与 monorepo（`packages/*`）Phase 0 实测代码对齐提炼
**上游依据**: 《Saturday 技术路线细化 v3.3》；Cordis 范式见 arXiv:2608.25512

---

## 1. 定位与适用范围

Saturday 是材料计算的**插件运行时**：引擎、结构源、工作流、分析工具全部以插件形态
挂载到宿主上。**dsh（DeepSeek Harness）是唯一官方宿主**——项目战略上押注 DSH 生态；
裸 cordis 不是另一个宿主，而是同一内核（Cordis v4）的开发/CI 运行模式。
本文档定义插件与运行时之间的接口规范（seam 契约）——它是生态的"宪法"，优先于任何单一功能。

**适用对象**：所有第一方与第三方插件作者、`@saturday/kernel` 维护者。

**不适用**：宿主自身的实现细节（cordis API 只在防腐层内出现，插件作者无需了解）。

### 1.1 三条纪律

| 纪律 | 内容 |
|---|---|
| **依赖卫生（防腐层）** | 插件只依赖 `@saturday/kernel` 暴露的 `SaturdayRuntime` 接口，禁止 import cordis / dsh。目的不是宿主中立，而是把上游破坏性变更的影响面收敛到适配层一个文件（v3.3 §0 治理策略） |
| **契约即宪法** | 本文档 + 契约测试套件共同构成兼容性承诺；文档与测试冲突时以测试为准 |
| **核心瘦削** | 默认一切是插件；功能进核心需要举证（跨插件一致性 / 性能 / 安全三选一） |

### 1.2 可逆性作用域（三级，不得混淆）

| 作用域 | 语义 | 机制 |
|---|---|---|
| 软件资源域 | 完全可逆 | 插件的一切注册动作都是 effect，卸载时自动回退（cordis 语义） |
| 计算任务域 | 幂等 + 可取消，**不承诺回滚已完成的计算** | `inputHash` 去重；任务可 cancel，无孤儿进程 |
| 物理设备域 | **永不回滚** | 审批 + 审计 + 参数白名单（v0 不涉及） |

---

## 2. 插件形态与生命周期

### 2.1 插件入口

每个插件是一个 npm 包，默认导出 `{ name, apply }`：

```typescript
export default {
  /** 全局唯一，建议与包名呼应：'mp-structure-source'、'lammps' … */
  name: string,

  /**
   * 挂载。ctx 为宿主的 cordis Context（经 kernel 约束使用）；
   * config 来自宿主的组合配置（cordis.patch.yml / registry.plugin 的 config 字段）。
   * 约束（cordis v4）：apply 只能返回 void / Promise<void> / disposer，
   * 返回任意对象会被当作 effect 拒绝。运行时句柄经 ctx.fiber.store 外挂。
   */
  async apply(ctx, config): Promise<void | (() => void)>,
}
```

### 2.2 生命周期规则

1. **注册即 effect**：服务注册、事件订阅、工具注册、外部进程（sidecar）拉起，全部
   必须包在可回退的效果里；插件卸载（`fiber.dispose()`）后不得有任何残留。
2. **卸载不得中断在运行任务**：引擎热切换只换"当前引擎"指针；已提交计算的收尾
   由任务域语义保证（取消或等待完成），不随插件卸载强行杀死。
3. **失败即不挂载**：`apply` 抛错则该插件不进入组合树，宿主继续启动其余插件；
   禁止"半挂载"状态。
4. **配置缺失走默认值或明确报错**，禁止静默降级到未声明的行为。

### 2.3 获取运行时

插件通过 `@saturday/kernel` 创建运行时适配器，而非直接触碰 ctx：

```javascript
import { createCordisAdapter } from '@saturday/kernel'
const rt = createCordisAdapter(ctx, config)   // config 含 trajectoryPath / bridge 等
```

---

## 3. SaturdayRuntime —— kernel 契约

插件唯一依赖的运行时接口（当前实现：`@saturday/kernel`，即 `packages/kernel/src/cordis-adapter.mjs`）：

```typescript
interface SaturdayRuntime {
  /** 注册服务（归属当前 fiber，卸载自动消失）；返回回收器 */
  provideService(name: string, impl: unknown): () => void
  /** 读取服务；不存在返回 undefined（反应式订阅语义由宿主演进，见 §8.2） */
  getService(name: string): unknown
  /** 订阅类型化事件；返回回收器 */
  on(event: string, handler: (payload: unknown) => void): () => void
  /** 发布事件 */
  emit(event: string, payload: unknown): Promise<unknown>
  /** 注册随插件卸载自动回退的效果 */
  effect(fn: () => unknown, label?: string): unknown
  /** 注册 Agent 工具（dsh 内走 harness 注册表；裸宿主走本地注册表） */
  registerTool(tool: SaturdayTool): () => void
  /** 追加溯源日志（append-only；dsh 内优先写 sessions 服务） */
  appendTrajectory(entry: object): Promise<void>
  /** 本地工具注册表（测试 / 无 dsh 环境）：list() / call(name, args) */
  tools: LocalToolRegistry
}
```

### 3.1 工具形态（SaturdayTool）

```typescript
interface SaturdayTool {
  name: string            // 'material.load' / 'potential.relax' …
  description: string
  /** schema 方言：schemastery 扁平式（官方工具插件实证格式，非 JSON Schema） */
  parameters: Record<string, { type: string, required?: boolean, description?: string, default?: unknown }>
  output: { schema: { type: 'object', additionalProperties: true } }
  execute(args: unknown): Promise<unknown>
}
```

---

## 4. 五类插件契约

### 4.1 structure-resolver —— 结构源插件

**职责**：把无结构信息的输入（化学式等）解析为候选结构。**修订 #8**：
formula-only 构建必须显式经过 resolver，结构来源必须写入材料谱系。

```typescript
interface StructureResolver {
  /** 全局唯一来源标识：'prototype-lib' | 'materials-project' | 'icsd' | 'generative' … */
  readonly name: string
  /**
   * 返回按稳定性排序（polymorphRank 升序）的候选结构；
   * 无结果时抛 code === 'STRUCTURE_NOT_FOUND' 的错误（附可用范围提示）。
   */
  resolve(formula: string, opts?: { polymorphRank?: number }): Promise<ResolvedStructure[]>
}

interface ResolvedStructure {
  graph: AtomGraph
  source: string              // 'prototype:A4-diamond' / 'mp-19017' …，将原样写入谱系
  polymorphRank: number       // 0 = 最稳定
  energyAboveHull?: number    // 已知则给出（eV/atom）
}

interface AtomGraph {
  nodes: { id: number, number: number, position: [number, number, number] }[]
  edges: unknown[]            // v0 恒为空；键图扩展保留字段
  periodic: boolean
  cell: [number, number, number][]   // 3×3 行向量
}
```

**规则**：
- `resolve` 必须幂等（同输入同输出；远端源自行缓存）；
- 结构一经交付即不可变；对结构的任何修改走 `Material.substitute` fork（见 §6）。

### 4.2 potential-provider —— 计算引擎插件

**职责**：实现 `relax` / `calculate` / `md` 原语，并以 manifest 声明能力供路由。
`md` 为可选能力（§4.5 遍历对账的时间平均侧）：`capabilities` 里声明 `md`
即承诺提供 `md()` 原语；未声明则工作流层对账工具对该引擎不可用（显式错误，不静默降级）。

```typescript
interface PotentialProvider {
  readonly name: string       // 'emt-mock' | 'lammps' | 'mace' | 'vasp' …
  readonly version: string
  readonly manifest: ProviderManifest
  relax(material: Material, params?: object): Promise<RelaxResult>
  calculate(material: Material, params?: object): Promise<CalculateResult>
}

interface ProviderManifest {
  capabilities: {
    type: 'relax' | 'calculate' | 'md'   // md：§4.5 遍历对账（时间平均侧）
    accuracy: number          // 0-1，越大越准
    speed: number             // 0-1，越大越快（修订 #7：统一"越大越好"）
    cost: number              // 0-1，越大越贵
    maxAtoms?: number
    /** calculate 专用：基线量（energy/forces）之外的可算性质声明。
        未声明的性质请求必须被显式拒绝（PROPERTY_UNSUPPORTED），绝不静默返回 null */
    properties?: ('stress' | 'bandgap' | 'dos' | string)[]
  }[]
  constraints: {
    requiresLicense?: boolean // 前置门禁（修订 #10）：激活前校验，失败抛 LICENSE_UNAVAILABLE
  }
  /** 事件粒度声明（v0 新增）：决定组合器能否插入细粒度监听，见 §5.2 */
  eventGranularity: 'iteration' | 'job'
}

interface RelaxResult {
  jobId: string               // Provider 生成的全局唯一任务 ID
  engine: string              // provider.name
  converged: boolean
  energy: number              // eV
  scale?: number              // 晶胞缩放因子
  n_steps: number
  calculator?: string         // 实际后端（如 'ase-emt' / 'lj-mock'）
  cell?: [number, number, number][]
  wall_seconds?: number
}

interface MdResult {
  jobId: string
  engine: string
  energies: number[]          // 逐采样步势能（eV），对账的原始观测
  kinetic: number[]           // 逐采样步动能（eV）
  temperatures: number[]      // 逐采样步瞬时温度（K）
  temperature_K: number       // 目标温度（thermostat 设定，非实测均值）
  n_steps: number
  calculator?: string
  wall_seconds?: number
}
```

**规则**：
- **性质能力门禁（修订 #9 配套）**：基线物理量（energy/forces）对任何 calculate 能力隐式成立；
  其余性质必须在 `capabilities[].properties` 显式声明。`PotentialRegistry.assertCalculable`
  在计算前拦截未声明者（`PropertyUnsupportedError`，与 §5.2 粒度门禁同款诚实纪律）；
  数据面对未声明性质报错是第二道防线，不得静默置 null。
- **计算产物记录（CalculationRecord）**：`Material.electronicView` 等异步视图的交付物是记录而非同步字段：
  谱系追加 `electronic-calculated` 条目（`detail.calculationId` 反查）；记录只收录引擎真实给出的性质（`values`）。
- **结果不可变**：返回后即为事实，进入谱系与 Trajectory，不得就地修改；
- **幂等**：相同 `material.graph + params` 应产生相同结果（允许经缓存命中）；
  `md` 例外：轨迹含随机积分，幂等仅在固定 `params.seed` 时成立（确定性采样纪律的延伸）；
- **路由契约**：路由权在 `PotentialRegistry`（autoRoute 按任务画像评分），
  Provider 不得自行挑选替身；显式 `engine` 指定优先于路由；
- **长任务**：`relax`/`calculate`/`md` 是异步原语，Promise 在计算完成时 settle；
  超时 / 取消语义由任务域承载，Provider 必须支持取消且不留孤儿进程。

### 4.3 workflow —— 工作流插件

**职责**：编排原子原语完成复合任务（如批量掺杂筛选）。**默认插件原则**：
工作流一律是独立插件，不进核心（`screenDopants` 已迁至 `plugins/screening`，即 `@saturday/plugin-screening`）。

```typescript
/** v0 形态：纯编排函数，由宿主或上层插件调用 */
function screenDopants(opts: {
  material: Material
  dopants: string[]
  potential: PotentialRegistry
  topK?: number
  engine?: string
  /** 事件回调：工作流不直接触碰运行时，事件由调用方路由（可测试性） */
  emit?: (type: string, event: object) => Promise<void>
  /** 可选注入：推导登记簿（活性上下文，§8.2）/ 批次号 */
  derivation?: DerivationRegistry
  batchId?: string
  /** 可选注入：元素参考态每原子能量（热力学第一档，显式计算所得） */
  references?: Record<string, number>
  /** 参考态不可得的原因（诚实记录，不静默降级） */
  thermoUnavailable?: string
}): Promise<{
  ranked: ScreenEntry[]       // 按 energyPerAtom 升序，全部含谱系引用；
                              // 注入 references 时附 formationEnthalpy / energyAboveHull
  failed: { label: string, kind: string, error: string }[]
  derivation?: { batchId: string, rankRef: string, energyRefs: string[] }
  thermo?: { level: string, references?: object, note?: string, reason?: string }
  note: string
}>
```

**规则**：
- **逐变体事件**：批量任务的每个变体发独立事件 → 各自落 Trajectory（可逐条溯源）；
- **不得吞错**：单变体失败计入 `failed`，不中断整体；整体性错误才抛出；
- 工作流暴露为工具时，工具层负责 schema 与描述，编排逻辑保持在纯函数中；
- **热力学诚实（第一档）**：排序类工作流的能量比较必须声明零点来源——
  注入 `references` 时升级为严格形成焓 + 形成焓空间凸包判据（`thermo.level` = 实际引擎，
  不冒充更高精度）；参考态不可得时保留“近似”声明并记录 `thermo.reason`，
  绝不静默假设零点；参考态由引擎辅助原语 `provider.referenceEnergy(symbol)` 显式计算
  （数据面算子 `reference_energy`，无承诺的后端诚实报错）。

### 4.4 analysis —— 分析插件（v0 占位，接口冻结于 v0.3）

**职责**：对材料 / 计算结果做后处理（EOS 拟合、弹性常数、声子谱…）。

```typescript
interface AnalysisPlugin {
  readonly name: string                    // 'eos-fit' | 'elastic-constants' …
  readonly inputs: string[]                // 声明依赖的数据类型（如 'relax-series'）
  readonly outputs: string[]               // 声明产出类型（如 'equation-of-state'）
  describe(): { description: string, parameters: object }
  run(inputs: object, rt: SaturdayRuntime): Promise<object>
}
```

v0 只冻结"输入/输出类型声明 + 谱系登记"两点；方法签名在薄插件冲刺（Phase 1c）
收集 3 个以上真实分析插件后定稿。

**首个实证实现**：`@saturday/plugin-neb`（NEB 最小能量路径与过渡态势垒；
能量/梯度注入式，内置 LJ 双阱玩具体系）。由它固化的实证点：
- `inputs` / `outputs` 是**数据类型字符串数组**（如 `['energy-model']` → `['minimum-energy-path']`）；
- `describe()` 返回 `{ description, parameters }`；`run(inputs, rt)` 接收运行时句柄；
- 谱系登记 = 分析结果同样落 append-only Trajectory（`type: 'analysis_complete'`）——
  分析产出与计算结果同为事实，不得只活在内存里；
- 分析结果不可自我认证：如势垒需由独立逐点求值（或更高精度引擎）对账，
  对账工具由工作流层（§4.3）编排。

**第二个实证实现**：`@saturday/plugin-eos`（Birch-Murnaghan 状态方程拟合；
纯 Node 拟合层 + 两条数据路）。它复核了上述冻结点，并新增实证：
- 数据面双路：显式 (V, E) 序列，或经 material/potential 服务按缩放体积做静态单点
  自产序列（`calculate` 而非弛豫——E(V) 标准取数法）；服务依赖在调用时解析，
  缺依赖显式报错不静默降级；
- 拟合质量诚实声明：收敛与否、rmse、r² 全部进结果与 Trajectory，不假装精确；
- 数值教训入档：法方程必须在参数缩放空间求解（JᵀJ 对角跨 8 个数量级）；
  收敛判据需梯度绝对阈值 + 停滞检测，纯步长判据在缩放空间不可达；
  求解器的低级索引 bug 曾伪装成“参数共线不可辨识”——诊断前先核对求解器本身。

### 4.5 sampler —— 逆解插件（采样语义；条款已冻结并由首个实证实现固化）

**职责**：给定目标约束（组分 / 性质 / 能量函数 / 参考结构），采样相容的候选结构。
本 seam 是生成式逆设计的唯一入口——Boltzmann 生成器、潜空间 normalizing flow、
晶体扩散模型等均挂载于此。**语义是采样而非求逆**：弛豫是多对一投影，原像本质非唯一；
sampler 交付的是与目标相容的候选分布，不是"某次计算的起点"（可逆性作用域见 §1.2）。

```typescript
interface StructureSampler {
  /** 全局唯一：'boltzmann-generator' | 'latent-flow' | 'crystal-diffusion' … */
  readonly name: string
  readonly manifest: SamplerManifest
  /**
   * 采样与 target 相容的候选；模型不可用 / 目标超出覆盖范围抛
   * code === 'SAMPLER_UNAVAILABLE'；按判据产不出候选抛 'SAMPLE_NOT_FOUND'——
   * 生成失败绝不静默为空成功。
   */
  sample(target: SampleTarget, opts?: { n?: number, seed?: number }): Promise<SampledStructure[]>
  /** 仅 manifest.invertible === true 必须提供（双射输运映射的反向）；未声明者调用必须抛 INVERTIBILITY_UNDECLARED */
  encode?(structure: AtomGraph): Promise<unknown>
}

interface SampleTarget {
  composition?: string               // 组分约束，允许部分指定（'Cu3Ag' / 'Cu-Ag-*'）
  properties?: Record<string, number> // 性质目标（如 energyAboveHull 上限）
  /** 能量函数引用（potential-provider 名）：按不变分布 ρ ∝ exp(−βU) 做 Boltzmann 采样 */
  energyModel?: string
  reference?: string | Material      // 参考结构：微扰 / 插值邻域采样（materialId；
                                     // 首个实证形态：插件工具层负责 id→Material 解析，
                                     // 纯层采样器直接接收已解析结构，id 语义不外溢）
  // 至少给定一项；支持的目标类型以 manifest.supportedTargets 声明
}

interface SamplerManifest {
  /** 采样语义（核心条款）：本 seam 与 §4.1 查表式结构源的本质区别 */
  semantics: 'sampling'
  /** 似然可求值性：exact = 双射精确似然（如 flow）；approximate 必须注明估计方式；none = 不提供 */
  likelihood: 'exact' | 'approximate' | 'none'
  /** 输运映射可逆性：true（如 normalizing flow 双射）必须提供 encode；false 不得提供 */
  invertible: boolean
  supportedTargets: ('composition' | 'properties' | 'energyModel' | 'reference')[]
}

interface SampledStructure {
  graph: AtomGraph
  logProb?: number             // likelihood !== 'none' 时必须提供，与 manifest 声明一致
  source: string               // 登记谱系时统一为 'generative:<name>'（如 'generative:latent-flow#seed=42'）
  polymorphRank?: number       // 不承诺稳定性排序；给出必须注明排序依据（如模型预测能量）
}
```

**规则**：
- **采样语义是唯一语义**：候选是学习/参数化分布上的采样点，不得呈现为"唯一解"；
  消费方（工作流 / Agent 工具）必须连同非唯一性与似然一起呈现；
- **候选必须可回算验证**：每个候选可送入 `PotentialProvider` 的 `relax` / `calculate`
  做性质核对（生成 → 弛豫 → 核对闭环）；核对失败是工作流级错误，sampler 不得自我认证；
- **诚实声明可执行**：似然不可精确求值时必须声明 `'none'`，禁止伪造伪似然；
  `invertible: false` 不得提供 `encode`，调用方得到显式错误（"不静默降级"纪律的延伸）；
- **遍历对账（oracle 条款）**：给定 `energyModel` 时，采样系综统计必须可与同一能量函数
  的 MD 时间平均对账（ergodic 对账）；对账工具落在工作流 seam（§4.3），不进 sampler 本体；
- **交付即谱系**：交付按 `ResolvedStructure` 兼容形态（§4.1）转换，`source` 以 `generative:`
  前缀写入谱系；不可变与 fork 语义继承 §6。

**条款依据**（由可逆性讨论固化）：① 逆解是对相容分布的采样，不是对计算的求逆——
求逆的障碍是多对一映射本身，与近似精度无关；② 材料域的独特优势是能量函数逐点可求值
（现有引擎即逐点 U）：训练可零数据（KL 直接按能量算），验证有第一性 oracle（MD 时间平均），
且双射流是本契约下真正可逆的计算——呼应 §1.2：Trajectory 记账保存物理丢弃的比特，
flow 双射则在构型空间内保持比特。
**锚点工具链契约审查（⑭，结论入档）**：`sampler.anchor.add` / `sampler.mixture` 属工具层编排，
**不新增进 `StructureSampler` seam**：库存的是已验证结构的参考，提案层复用既有采样实现，
交付仍是 `SampledStructure` 形态（`logProb` 与 `'exact'` 声明、`generative:` 前缀、候选可回算）；
现有条款已充分约束（谱系门禁在工具层生效、候选不自证、诚实声明），形态审查见附录 A 61。
同批裁决（⑬，不做并说明理由）：`workflow.screen` 不直收 `anchors` 参数——直收意味着筛选插件
内嵌采样逻辑并依赖 `plugin-sampler-ou`，破坏插件边界；两步编排（`sampler.mixture` →
`workflow.screen(sampled=…)`）正是组合律本身，seam 不折叠。
**闭环轨迹自动入库（⑮，自监督数据管道第二段）**：弛豫收敛且引擎交付终态结构时，弛豫后结构自动入会话锚点库，
谱系自动声明（`job:<jobId>#engine=<name>`，能量随锚点记录）；三道门禁：未收敛不入库（不收敛的结构不是盆地底）、
引擎未交付终态不入库（不拿输入结构冒充弛豫产物，旧协议诚实缺省）、同谱系重复事件幂等（重放安全）；
引擎 `relax` 交付协议扩展终态坐标/晶胞（ase sidecar 补齐，旧版按字段存在性诚实缺省）；薄事件纪律：
结构体不重复落 Trajectory（只记 `relaxedStructureDelivered` 在场标记）；自动入库只积累数据燃料，
不引入任何学习式组件（自监督进场的触发条件见工程决策，未满足前管道先行）。
**锚点库规模纪律裁决（⑱，不实现并说明理由）**：会话锚点库不引入淘汰/上限机制——库与闭环运行同生命周期（不跨会话持久化），当前闭环为演示规模，会话内增长有限，淘汰是为尚未出现的瓶颈写逻辑；淘汰属持久化锚点库的关注点，持久化引入时再议（裁决依据与自监督进场触发条件同款：先见数据再谈机制）；检索的 `topK` 上限已构成提案侧参与上限（库可增长，参与混合的锚点数有显式声明）。
**自监督进场条件裁决（㉘，对照触发条件逐项呈报后维持“不引入”）**：触发条件为“采样→回算闭环持续运行积累足够轨迹、且探索效率成为瓶颈（锚点集需学习/生成）”。数据管道现状：第一段（⑦ 锚点库，谱系必填入库）与第二段（⑮ 自动入库）已就位，跨会话续供机制（㉓ 搬运原语 + ㉔ 文件端 + ㉗ 回填即刻参与闭环）也已就位——触发条件第一项的基础设施已全部备齐，但“足够轨迹”本身仍未出现（当前仍为演示规模：个位数锚点、单点候选批次，无持续积累的运行事实）；第二项“探索效率成为瓶颈”未出现（闭式提案 + 检索配额在当前规模下无瓶颈证据）。裁决：维持不引入自监督组件（同 ⑬/⑱ 同款“先见数据再谈机制”）；进场挂载点不变（sampler seam 学习式提案插件，似然声明降档 'estimated'；证据源注册表代理势能作第 N 源；模型指纹走实测态回读同构路径）；不变纪律：候选不自证（引擎是唯一 oracle）、训练数据即闭环轨迹（进谱系）、管道只积累数据燃料。
**提案层谱系登记（㉑，活性上下文 §8.2）**：`sampler.mixture` 注入 `derivation` 服务时登记一层提案推导——输入 = 可追溯锚点来源归一化（自动入库谱系 `job:<id>#engine=<name>` 取 # 前段为 `job:<id>`；手动入库 `material:<id>` 原样），输出 = `result:mixture-<batchId>`，producer = `sampler.mixture`；锚点失效沿推导图传播到提案（谱系不只是字符串，是活性推导图）；不可追溯来源不冒充推导输入，随交付以 `untrackedSources` 如实声明；全部不可追溯时不伪登记；未注入服务时行为不变（纯编排层零依赖，与 `workflow.screen` 同款）。
**持久化锚点库原型（㉓，库间搬运原语）**：`sampler.anchor.export`（导出 = 无损 JSON 全量条目，含 graph 本体，版本号 `saturday-anchor-store/1`）与 `sampler.anchor.import`（导入复用库层谱系/本体门禁；同谱系幂等跳过——重放安全，与 ⑮ 同款；单条拒绝不中断整批，如实记录）；诚实边界：库自身仍是会话级内存库，落盘与跨会话回填由调用方负责（原型不引入文件 I/O，不伪造库外数据）。
**持久化落盘侧（㉔，搬运原语的文件端）**：`sampler.anchor.save`（落盘 = 导出载荷写调用方显式声明的路径）与 `sampler.anchor.load`（回填 = 读载荷后走与导入工具同款的共享导入循环：谱系/本体/幂等门禁不另开旁路）；错误路径如实：文件缺失/损坏/非载荷形态显式报错（`ANCHOR_PERSIST`，不静默返回空库冒充成功）；路径由调用方显式声明（库不自作主张读写文件系统）。
**落盘载荷完整性校验（㉜）**：`load` 版本门禁（仅支持 `saturday-anchor-store/1`，未知/缺失版本不静默接受——不猜测兼容）+ `size` 声明对账（声明 ≠ 实质即拒，不猜测补齐）；单条损坏不连坐：单条问题由共享导入循环逐条拒绝如实记录（与 ㉓ 同款纪律，完整性门禁不开旁路）。
**落盘侧谱系可追溯声明（㉛，磁盘数据起点的失效传播）**：`load` 交付附 `lineageRefs`——载荷内可追溯来源的归一化声明（与 ㉑ 归一规则同款：取 # 前段，只含 `material:`/`job:` 形态）；消费方不必翻库即可从磁盘数据起点发起失效传播（声明不是装饰：沿 `lineageRefs` 起点 invalidate，提案推导如实失效——谱系从“跨会话保留”升为“跨会话可撤回”）。
**条目级版本戳（㉝，损坏定位到条目级）**：载荷形态升版 `saturday-anchor-store/2`（㉜ 版本门禁声明同步升级）——`export`/`save` 逐条目附 `entryVersion: 'saturday-anchor-entry/1'`；`load` 逐条校验版本戳：缺失/未知版本戳的条目按条目级损坏处理，定位到载荷原位索引拒绝（过滤后不丢定位能力）；合法条目照常入库（不连坐）——损坏检测从“整体非载荷”下沉到条目级（与 ㉓ 单条拒绝纪律对齐）。
**多载荷合并回填（㉞，门禁先行）**：`load`/`audit` 接受 `path`（单载荷）或 `paths`（多载荷合并）二选一（不静默猜测调用方意图）；门禁先行——全部文件先过完整性检查（读/解析/版本/size/条目版本戳），全过才开始回填（任一文件不过 → 整批拒绝，出错时库零污染）；同谱系幂等门禁天然兜底跨载荷重复（数据燃料的多源汇聚形态）；逐文件明细随交付呈现。
**载荷血缘审计（㉟，只读观测面）**：`sampler.anchor.audit` 声明载荷谱系三态——可追溯（来源可归一化为 `material:`/`job:`）/不可追溯（有来源但非可追溯形态）/损坏（版本戳缺失或来源缺失，回填必拒）；审计为只读观测（不回填、不污染库）；异常文件如实入报告不连坐其余文件——回填前的一手数据质量观测面（为未来“足够轨迹”出现后的自监督进场提供数据质量观测地基）。
**审计接 Agent 层（㊱，观测先于行动）**：`demo:agent` 阶段 G：自然语言“先审计落盘载荷的血缘再决定回填” → tool_call(sampler.anchor.audit)：只读三态报告回流（全部可追溯、无损坏），库状态不变（观测先于行动的数据纪律在 Agent 层实证，㉕ 教训延续：新工具的宿主出口实证）。
**多载荷合并后的活性保持（㊲，汇聚不糊化谱系边界）**：两份不同来源的载荷经 ㉞ 合并回填后——跨载荷汇聚的谱系各自独立可撤回（沿某一来源失效，提案推导如实失效；失效不删数据，另一来源与库内条目照常在场：可撤回的是推导活性，不是库内数据）；合并后提案的锚点归属与载荷谱系逐条一致（汇聚不冒充、不丢、不改写谱系）。
**锚点库容量观测（㊳，库内观测面）**：`sampler.anchor.stats` 只读声明库内状态——条目数 + 归一化谱系形态分布（`material:`/`job:`/其他）+ 组分声明覆盖；观测不变更库；与 ㉟ 载荷审计构成“库内 + 库外”双观测面（为 ㉘ 触发条件的“足够轨迹”提供量化读数）。
**审计驱动的合流回填决策链（㊴，观测先于行动升级为决策链）**：`demo:agent` 阶段 H：自然语言“审计两份候选载荷，只回填达标的那份” → audit（一份全可追溯 / 一份含不可追溯条目 + 修复建议）→ 按报告只回填达标载荷（不达标载荷不进数据燃料）；诚实声明：决策本身由 mock 脚本编码，阶段实证的是“报告 → 行动”链路的运行时效果。
**“足够轨迹”触发判据原型（㊵，先见数据再谈机制的机器化第一步）**：`trajectoryTriggerAssessment(readings, thresholds)` 纯层函数——把 ㊳ 容量观测读数与调用方显式声明的阈值（`minSize`/`minCompositionCoverage`）对账：判据是声明式对账不是门禁（达标与否只如实呈报，机制是否进场仍由裁决者决定，同 ⑬/⑱/㉘）；阈值不硬编码、不设默认，未显式声明即拒绝（不替调用方猜测进场门槛）；两项缺口各自独立呈报不合并糊化；空库覆盖率定义为 0（不除零崩溃）。
**审计修复建议通道（㊶，指明出路不代改）**：`sampler.anchor.audit` 对非可追溯条目随报告交付可操作的修复声明（`repairHints`：载荷原位索引 + 三态 + 建议）——版本戳缺失/未知与来源缺失区分于不可追溯（前者回填必拒，后者可回填但建议声明可追溯起源）；仍保持只读（审计从不修改载荷文件），观测面从“呈现问题”走向“指明出路”。
**收尾判据快照（㊷，裁决依据机器可读）**：`demo:anchor-resume` 会话二收尾：`stats` 读数 → `trajectoryTriggerAssessment` 对账 → 判据快照随日志呈现（`met=false`，缺口如实：条目数 2 低于 minSize 100）——“足够轨迹”裁决从人工对照触发条件升级为机器可读的判据快照（读数 → 阈值 → 结论可追溯可复算）；阈值由调用方显式声明（演示声明的原型阈值，非内置常量），结论如实呈报不是门禁（维持 ㉘ 裁决）。
**载荷侧修复原语（㊸，观测/修复权责分离）**：`sampler.anchor.repair`——审计只指明出路（㊶），修复是独立原语且必须调用方逐条显式授权（`repairs: [{index, source}]`）；修复写新载荷不碰原件（原件留作证据，`out` 与 `path` 相同即拒）；只可修复不可追溯条目——损坏条目修复即伪造数据燃料必拒，已可追溯条目修复即替调用方做决定亦拒；修复来源必须为可追溯形态；修复全程不回填（库零污染）；审计是修复的验收面（修复后重新审计验收）。
**判据对账谱系化（㊹，裁决依据可撤回）**：`trajectoryTriggerAssessment` 可选接推导登记簿（未注入行为不变，同 ㉑ 零依赖纪律）——对账结论登记为推导（`result:trigger-<batchId>`，输入 = 调用方声明的可追溯证据引用，归一化取 # 前段同 ㉑ 规则）；证据引用失效 → 对账结论沿推导图如实失效（裁决依据可撤回，不是永久真理）；无可追溯证据引用不伪登记（同 ㉑ 提案登记纪律）；判据结论与谱系登记正交（登记与否不影响 `met` 如实呈报）。
**修复链接 Agent 层（㊺，观测→修复→验收三步链）**：`demo:agent` 阶段 I——自然语言“按审计建议为不可追溯条目修复并重新审计验收” → tool_call(sampler.anchor.repair)：修复逐条显式授权、写新载荷不碰原件 → tool_call(sampler.anchor.audit)：修复后载荷重新审计全可追溯、原件保持原状（审计是修复的验收面）；修复声明由 mock 脚本编码（诚实声明），阶段实证的是“观测→修复→验收”链路的运行时效果。
**判据快照落盘/回填原语（㊻，裁决依据跨会话续供）**：`sampler.trigger.snapshot.save`/`load`——判据对账结论整体原样落盘（读数/阈值/结论一并保留，落盘不改判：不替调用方改写结论）；回填只读校验版本戳（`saturday-trigger-snapshot/1`）与形态后原样交付（未知版本戳/形态不完整/缺批次标识均如实拒）；快照不是锚点条目——不进锚点库、不进数据燃料（裁决依据可续供、可复算，与结构数据燃料正交）。
**判据的谱系质量维（㊼，足够轨迹还要够可追溯）**：`trajectoryTriggerAssessment` 可选阈值 `minTrackableRatio`（可追溯占比：㊳ 观测交付的 `lineage` 中 material + job 除以条目数）由调用方显式声明——未声明行为不变（不硬编码、不设默认）；声明了但读数缺谱系分布维 → 显式拒绝（`TRAJECTORY_TRIGGER_LINEAGE_REQUIRED`，不替调用方猜测质量读数）；质量维缺口与数量/覆盖维各自独立呈报不合并糊化；空库占比定义为 0（不除零崩溃）。
**判据快照跨会话续供（㊽，裁决依据成磁盘证据）**：`demo:anchor-resume` 会话二收尾：判据快照经 `sampler.trigger.snapshot.save` 落盘（会话内日志升级为磁盘证据，落盘不改判）→ 会话终结 → 会话三全新挂载经 `sampler.trigger.snapshot.load` 回填，续供对账逐字段一致（读数/阈值/结论与会话二原样一致，可复算不重新估算）；快照不进锚点库（会话三库内仍空：证据载荷与结构数据燃料正交）。
**修复后载荷的活性闭环（㊾，观测→修复→验收→入库四环）**：不可追溯载荷经 ㊸ 修复 + 审计验收后回填——修复达标的数据成为数据燃料：提案照常登记推导（谱系用修复后的来源，不冒充原件；归一化同 ㉑ 规则），沿修复后谱系失效 → 提案推导如实失效（可追溯即意味着可撤回，活性不因修复史降级）；失效不删数据（库内条目照常在场）。
**质量维观测对账（㊿，观测→判据不断链）**：判据回呈的可追溯占比 = ㊳ 观测的库内逐条谱系计数（不重新估算）；观测读数变化 → 对账结论如实变化（占比达阈即翻转，结论不硬编码）；观测/判据全程不变更库。
**排序层提案引用（㉖，全链活性）**：`workflow.screen` 可选直收 `proposalRef`（来自 `sampler.mixture` 交付的提案推导引用）：声明后登记为排序层推导输入——锚点失效沿推导图传播到提案、再传播到排序（锚点→提案→排序三级链全活性）；未声明行为不变（不伪造推导输入）；非法引用由登记簿 `parseRef` 显式拒绝（不静默）。注意与 ⑬ 裁决的分工：不直收的是 `anchors`（结构本体 + 采样逻辑），直收的是 `proposalRef`（推导引用，编排层谱系接线）——组合律不破。

### 4.6 derivation —— 推导登记簿（活性上下文地基）

**职责**：让材料上下文成为响应式谱系图——每个导出量声明推导来源，
上游失效沿推导图向下游传播，重算惰性且预算受控（§8.2 首个实证）。
独立插件 `@saturday/plugin-derivation`，不依赖其他服务（纯提供方）。

```typescript
/** ref 形如 'material:<id>' | 'job:<id>' | 'result:<id>' | 'engine:<id>'（事件薄、数据厚，§7.2） */
interface DerivationRegistry {
  /** 登记推导：导出量由哪些输入经哪个生产者得出；冻结结果传 frozen（§7） */
  record(d: { inputs: string[], output: string, producer: string, frozen?: boolean }): Derivation
  /** 查活性状态；未登记显式抛 DERIVATION_NOT_FOUND */
  status(ref: string): { ref: string, status: 'valid' | 'invalid', frozen: boolean,
                         producer: string, corrections: Correction[],
                         invalidatedBy: object | null, recomputedAt: number | null }
  /** 失效传播：沿推导图向下游传递；一次传播发一条事件（薄载荷） */
  invalidate(ref: string, reason: string): Promise<{
    source: string, reason: string, invalidated: string[], corrections: string[] }>
  /** 惰性重算：只重算失效且未冻结的推导，拓扑序推进；超预算显式抛 BUDGET_EXCEEDED */
  recompute(o: { recompute: (d: Derivation) => Promise<void>, budget?: number }): Promise<{ recomputed: string[] }>
}
```

**规则**：
- **冻结语义（§7 冻结标记）**：`frozen` 推导失效时只追加修正记录（`corrections`）、
  状态不改、永不进入重算集；传播越过冻结节点继续向下游（不吞失效）；
- **登记簿 append-only**：失效过的记录永不删除；重算以状态迁移 + `recomputedAt`
  时间戳追加表达，不改写历史；
- **失效源只有显式 `invalidate`**：不可变 fork（§6）不是失效源——`substitute`
  产生新对象，原结构及其推导不受影响，新结构要进入活性上下文须自行登记；
- **预算是资源承诺**：超预算显式抛 `BUDGET_EXCEEDED`，不静默部分执行（惰性语义：预算不足就不动）；
- **重复失效幂等**：已失效节点不重复传播，不重复发事件；
- **引擎是推导输入（活性上下文接真实工作流）**：排序类导出量 = f(基体, 引擎)，
  登记时引擎以 `engine:<id>` 入输入；势函数热替换（`PotentialRegistry.activate`
  发 `saturday/potential/activated` 事件）即失效源，沿旧引擎 ref 传播到依赖它的
  全部导出量；工作流插件按需登记（`derivation` 可选注入，未挂载则行为不变）；
- 事件 `saturday/derivation/invalidated` 薄载荷：只放 `source` / `reason` /
  失效与修正的引用清单，不放推导记录本体。
错误码：`DERIVATION_NOT_FOUND`（查无）/ `INVALID_REF`（引用形非法）/ `BUDGET_EXCEEDED`（超预算）。

---

## 5. 能力握手与事件粒度

### 5.1 hello 握手（计算桥）

TS 控制面与 Python 数据面建立连接后的第一帧：

```json
{
  "sidecar": "saturday-python-bridge",
  "version": "0.2.0",
  "calculators": { "ase-emt": true, "lj-mock": true },
  "eventGranularity": { "ase-emt": "iteration", "lj-mock": "iteration" }
}
```

- `calculators`：后端可用性，消费方依此**动态决定断言/降级策略**（测试 9 的模式）；
- 能力变化（后端中途可用/不可用）必须重新握手并广播能力变更事件（§7.2）。

### 5.2 事件粒度声明

引擎事件粒度天然异构（ASE 可逐迭代回调；批处理引擎只有任务级）。声明规则：

| 粒度 | 允许的事件形态 | 组合器行为 |
|---|---|---|
| `iteration` | 瀑布事件可含步进级中间态 | 允许插入细粒度监听（早停、in-situ 分析） |
| `job` | 仅任务开始/结束/失败 | 细粒度监听请求必须被显式拒绝，不得静默降级 |

---

## 6. 领域对象契约：Material

- **不可变 fork**：`substitute(site, element)` 返回新对象，原对象不变；
  一切修改操作同语义。这是谱系可追溯与"活性上下文"失效传播的基础；
- **谱系（lineage）**：append-only 操作序列；每条含 `operation`、`detail`
  （含结构 `source`、掺杂 `parent` 引用等），禁止改写历史条目；
- **跨插件传递用 id**：工具与事件载荷中传 `materialId`，不传整图（事件薄、数据厚，§7.3）。

---

## 7. 双通道事件协议

### 7.1 命名与分类

事件名格式：`saturday/<domain>/<event>`（如 `saturday/simulation/converged`）。

| 通道 | 语义 | 特征 | 承载 |
|---|---|---|---|
| **瀑布事件** | 因果链（弛豫步、任务接力） | 全序、可回放、携带状态接力 | Trajectory（append-only） |
| **广播事件** | 一对多通知（收敛、异常、能力变更） | 并发、订阅式 | 类型化事件总线 |

同一事实通常两者都发：广播用于即时联动，瀑布用于事后回放。

### 7.2 载荷规则

```javascript
await rt.emit('saturday/simulation/converged', {
  type: 'saturday/simulation/converged',   // 与事件名一致，冗余以支持落盘自描述
  payload: { jobId, material: { id, formula }, result: {...}, engine, wallSeconds },
})
```

- **事件薄、数据厚**：载荷只放标量与引用（`materialId` / `jobId` / 存储 URI），
  GB 级对象走对象存储；
- **回放确定性（v0.1 引入）**：每个生产者维护独立 `seq` 单调序号，写入事件头；
  多订阅者回放按 `(producer, seq)` 归并；
- **冻结标记**：实验数据、已交付结果标记 `frozen: true`，失效传播（§8.2）
  对其只追加修正记录，不重算。

### 7.3 多分辨率视图（宿主提供，插件可消费，v0.2+）

原始事件全量保留（永不丢弃）；宿主在其上生成摘要层：
L1 段落摘要（收敛趋势/极值/异常）→ L2 任务摘要 → L3 研究摘要。
里程碑判定 v0 用规则（收敛、失败、决策、3σ 异常），学习式注意力后置。

---

## 8. 兼容性与版本治理

### 8.1 版本语义

- 契约版本独立演进：`@saturday/contract`（本包），语义化版本；
- **1.0 前（当前）**：一切接口标注 `experimental`，minor 升级允许破坏性变更，
  但每次变更必须：更新本文档 → 更新契约测试 → 在 CHANGELOG 声明迁移路径；
- 1.0 后：接口冻结，扩展走**新 seam**或**可选字段**，禁止修改既有字段语义。

### 8.2 演进方向（部分已实证）

- 谱系驱动的失效传播与惰性重算（含重算预算控制）：**首个实证已落地**，见 §4.6 derivation seam（`@saturday/plugin-derivation`：登记/失效传播/冻结修正/预算重算）；
- **活性上下文接真实工作流：已实证**——`workflow.screen` 完成即登记两层推导（候选能量/筛选排序，引擎入输入），势函数热替换沿 `engine:<id>` 全链失效（bridge wiring 监听 `saturday/potential/activated`，未挂推导插件时优雅降级）；
- 响应式协效应下沉：`getService` → 依赖声明 + 激活/去激活（活性上下文的另一块地基，仍不构成本版承诺）。

### 8.3 契约测试套件（@saturday/contract-tests）

兼容性由测试而非文档承诺。四条核心 seam 的标准断言集已独立成包：
`structureResolverContract`（§4.1：候选形状 / 多晶型排序 / 查无显式错 / 幂等）、
`potentialProviderContract`（§4.2 + §5.2：manifest 形状 / 粒度门禁 / 结果形状 /
幂等 / 显式失败）、`workflowContract`（§4.3：结果形状与排序 / 逐变体事件 /
不吞错 / 缺依赖显式报错）与 `samplerContract`（§4.5：manifest 自洽（采样语义 /
似然三选一 / invertible 与 encode 一致）/ generative: 谱系前缀 / 似然诚实（none 禁伪造）/
种子确定性 / 两码显式失败 / 候选可回算构造 Material）与 `derivationContract`（§4.6/§8.2：
登记与状态 / 失效向下游传递传播与幂等 / 冻结只追加修正且传播不吞 / 查无显式错 /
引擎引用合法（热替换即失效源）/
惰性重算预算受控 + 拓扑序）；`workflowContract` 另支持可选 `failWhen(material)`
断言（默认“首个掺杂变体”），供同构变体工作流（如采样回算）按谱系标记选中失败变体；`potentialProviderContract` 的能力枚举含 `md`（§4.5 遍历对账时间平均侧，声明即承诺提供 `md()` 原语）；新插件在自己的测试文件里调用套件即完成接入（当前基线：
套件自检 24 项 + bridge 50 项 + core 28 项 + 十一个插件各自套件 + 其余插件各自契约测试，
全仓 workspace 328/328；另有摘要层脚本测试 7 项（非 workspace，由回归脚本覆盖）；回归脚本与摘要脚本均强制包内串行（--test-concurrency=1：并发各拉 sidecar + OpenBLAS 线程内存竞态实证）。发布形态（⑧/⑪）：MIT LICENSE 落盘（19 包 license 声明自此有文档实体）+ 本契约英文摘要版（`plugin-contract-v0.en.md`，忠实摘要而非有损全译，权威文本以中文原本与本套件为准）+ 19 包 `files` 白名单（发布物只含实现与必要数据面，测试/日志/临时产物不外泄）；`repository` 元数据诚实空缺（仓库无远程，不编造 URL）。以上文档/配置交付无测试映射故不入附录 A。映射见附录 A。

---

## 附录 A：契约测试映射（基线）

| # | 契约条款 | 现有测试 |
|---|---|---|
| 1 | 服务注册即 effect，卸载全回收 | 测试 1、8 |
| 2 | formula-only 必须显式 resolver，来源写谱系 | 测试 2、4 |
| 3 | 多晶型排序与选择 | 测试 3 |
| 4 | autoRoute 画像评分（修订 #7） | 测试 5 |
| 5 | 长任务异步原语语义 | 测试 6 |
| 6 | 事件 → Trajectory 落盘 | 测试 7、11 |
| 7 | 能力握手驱动断言强度 | 测试 9 |
| 8 | 不可变 fork 与谱系 | 测试 10 |
| 9 | 逐变体事件与批量溯源 | 测试 11 |
| 10 | license 前置门禁（修订 #10） | 测试 12（含失败不污染状态、门禁可重入） |
| 11 | 事件粒度声明：job 级显式拒绝细粒度监听 | 测试 13 |
| 12 | 载荷引用语义（无内联大对象） | 测试 14 |
| 13 | 工作流插件：缺服务显式报错 / 逐变体事件 / 不吞错 | plugin-screening 测试 1-4 |
| 14 | 结构源 seam 可互换：远端来源写谱系（修订 #8） | plugin-mp 测试 1-4 |
| 15 | 引擎插件：注册即 effect，卸载注销且激活指针重置 | plugin-lammps 测试 5、6 |
| 16 | 批处理引擎：缺二进制显式报 ENGINE_UNAVAILABLE，不静默降级 | plugin-lammps 测试 3 |
| 17 | seam 标准断言集（§4.1/§4.2）自检与复用 | contract-tests self.test（9 项，mp/lammps/mace/ase 已接入） |
| 18 | ML 势引擎：可用性预检（`import mace` 探测），不可用显式报 ENGINE_UNAVAILABLE | plugin-mace 测试 1、2 |
| 19 | 跨引擎画像路由：validation 选高精度（mace），screening 选低成本（lammps） | plugin-mace 测试 5 |
| 20 | 插件自带数据面：计算器显式指定，缺失显式报错绝不隐式替换 | plugin-ase 测试 1-3（含真实 sidecar） |
| 21 | 时间维回放：从事件流重建索引；回放事件带防回灌前缀，不产生新轨迹 | plugin-replay 测试 1-5（含真实筛选对账） |
| 22 | sampler seam（§4.5）：采样语义强制声明 / 似然与可逆性诚实声明 / 回算验证闭环 / 生成失败显式错 | plugin-sampler-perturb 测试 1-8（首个实证：微扰采样器；MD 对账已由 #28 补齐） |
| 23 | analysis seam（§4.4）两个冻结点：输入/输出类型声明 + 谱系登记（分析结果落 Trajectory）；缺输入显式报错不静默 | plugin-neb 测试 6-8（含真实挂载与卸载回收） |
| 24 | analysis seam（§4.4）第二实证：双数据路（显式序列 / 服务自产）+ 拟合质量诚实声明（converged/rmse/r²）+ 服务依赖调用时解析 | plugin-eos 测试 1-8（含真实桥 Cu EOS 集成） |
| 25 | workflow seam（§4.3）套件化：结果形状与排序（energyPerAtom 升序）/ 逐变体事件（薄载荷含引用）/ 不吞错 / 缺依赖显式报错 | `workflowContract`（套件自检 + plugin-screening 测试 5-8） |
| 26 | sampler seam（§4.5）套件化：manifest 自洽（invertible⇔encode）/ generative: 谱系前缀 / 似然诚实（none 禁伪造 logProb）/ 种子确定性 / 两码显式失败 / 候选可回算构造 Material | `samplerContract`（套件自检 mock-sampler + plugin-sampler-perturb 测试 1-4） |
| 27 | §4.5 oracle 条款首个实证：采样 → 回算闭环（候选不自证，引擎是唯一 oracle）；候选 Material 带 sampled-candidate 谱系标记，事件薄载荷含谱系 source；基线缺失时 dE 诚实置 null | plugin-explore 测试 1-9（含排序非透传验证 + `workflowContract` 第三个接入者） |
| 28 | §4.5 遍历对账（oracle 条款）实证：采样系综平均 对 同一能量函数恒温 MD 时间平均；`md` 能力契约化（§4.2 枚举扩展，声明即承诺原语）；判定强度随采样器似然声明三档分级（none 仅信息性；声明可求且候选附 logProb 时重要性重加权后直接检验；声明与交付不一致降级并明说） | plugin-ergodic 测试 1-14（纯层统计判定 + 升档解析对账 + 插件层挂载/缺服务显式错/非透传 + 真实 ASE sidecar Langevin MD 全链路） |
| 29 | §8.2 活性上下文地基首个实证：登记即声明推导来源 / 失效沿推导图向下游传递（幂等）/ 冻结只追加修正且传播不吞（§7）/ 查无显式错 / 惰性重算预算受控 + 拓扑序 + append-only / substitute fork 非失效源（§6） | `derivationContract`（套件自检 mock-derivation + plugin-derivation 测试 1-14） |
| 30 | §8.2 活性上下文接真实工作流：排序 = f(基体, 引擎)——筛选完成即登记两层推导（候选能量/排序，`engine:<id>` 契约化入推导输入）；势函数热替换（`activate` 发 `saturday/potential/activated`）即失效源，全链失效 + 重算拓扑序；推导插件可选（未挂载优雅降级） | `derivationContract` 引擎条款 + bridge live-context 测试 1-4 |
| 31 | 热力学第一档（§9 欠账清偿）：能量零点显式化——数据面 `reference_energy` 算子（fcc 单胞全弛豫，无承诺后端诚实报错）+ 纯层严格形成焓/二元凸包（缺参考态/超范围显式错，不静默假设零点）；筛选接严格形成焓 + `energyAboveHull` 凸包判据，`thermo.level` 声明精度等级；参考态不可得时诚实降级保留“近似”声明 | core thermo 测试 1-8 + python-bridge 参考态 4-5 + bridge thermo 端到端 1-4 |
| 32 | sampler seam（§4.5）第二实证：OU（Ornstein-Uhlenbeck）参考结构采样——闭式转移核 + 精确提议似然（`likelihood: 'exact'` 升档，`samplerContract` 第三个接入者）；诚实边界写进交付：exact 指提议核自身（非玻尔兹曼，热力学加权仍须引擎回算）、OU 单峰定位为局部采样器、γΔ 有效性窗口门禁（非正/非有限显式错） | plugin-sampler-ou 测试 1-13（契约 5 + 似然自洽独立重算 + 平稳幅度闭式统计验证 + 均值回归语义 + 插件层挂载/缺依赖/端到端/确定性） |
| 33 | §4.5 升档实证：判定强度随似然声明实质升档——`workflow.ergodic` 接 `sampler.ou`（likelihood: 'exact'）后判据从原始均值对比升为重要性重加权（log w = −βU − log q，log-sum-exp 归一）均值对 MD 时间平均；ESS 占比作为重叠度诊断随判定/事件载荷呈现；解析对账体系（σ_q = σ_t 时权重均匀、ESS=1、重加权均值不变，⟨‖u‖²⟩ 落能量均分闭式）不靠数值巧合 | plugin-ergodic 测试 4/4a-4c/6/7b（三档判定 + 重加权纯层 + checkErgodic 解析引擎端到端 + 工具层升档） |
| 34 | 热力学第二档（§9 从焓到自由能）：`workflow.freeEnergy` 温度网格逐点恒温 MD（复用 `md` 原语）得 ⟨U⟩(β)，沿 β 热力学积分出构型自由能曲线（d(βF_conf)/dβ = ⟨U⟩）；自由能零点延续第一档纪律——锚点必须显式注入（缺锚点 `THERMO_REFERENCE_MISSING`），锚点物理来源声明随交付呈现；诚实声明不含动量部分、逐点附统计标准误；解析对账双核（线性核梯形精确闭式 1e-9 + 谐波核密网格截断收敛），测试首跑即抓出定向积分符号 bug（锚点升温侧不得取绝对值）；曲线型工作流不接 `workflowContract`（变体排序形态不适配，强套会扭曲契约，诚实声明而非冒充合规） | plugin-free-energy 测试 1-9（锚点门禁 + 双核解析对账 + 统计诚实 + 挂载/缺服务/端到端/真实 ASE 冒烟） |
| 35 | 多组分凸包（第 1.5 档，二元→d 维推广）：成分空间维度 d = 元素数−1，显式穷举 d-单形（d+1 点仿射无关子集）构造下包络，重心坐标插值 + 最小包络；二元退化与既有实现数值一致（1e-12 对账）；非轴对齐单形闭式核验；端点纪律延续（缺纯元素端点 `THERMO_REFERENCE_MISSING`，不外推）；组合上限显式门禁（`THERMO_TOO_MANY_COMBINATIONS`，不静默换近似算法）；包络单形只用包上点构造（包外点不得参与包络，测试首跑抓出）；包外成分查询显式报错 | core thermo 测试 9-14（二元退化对账 + 三元四边形 + 重心闭式 + 端点纪律 + 门禁） |
| 36 | 摘要层（可再生产物而非手写文档）：`npm run summary` 实跑全部包测试 + 扫描 package.json + 提取附录 A 实证表 → 机械汇编 `SUMMARY.md`/`SUMMARY.json`；计数对账门禁（有测试但缺结果显式报错）；无独立测试的包（防腐层）诚实标记不计数；失败用例显式标记不隐藏；子进程不继承 `NODE_TEST_*` 环境（嵌套 runner 防御）；摘要只含来源可追溯字段 | scripts/summary 测试 1-7（TAP 解析 + 附录 A 表解析 + 组装门禁/确定性 + 真实小包冒烟） |
| 37 | 多组分凸包接真实工作流 + 自由能端到端演示 + 分析事件溯源闭环：筛选注入参考态后元素数 ≥ 3 自动升级为统一成分空间凸包（每个元素参考态是端点——形成焓按定义 = 0，是定义事实而非外推），`thermo.mode/hullDimension` 声明判据形态；端点全零时包络即 z=0 超平面，判据与二元弦数值一致（闭式对账）；≤2 元素保持二元 0-0 弦路径不变；自由能端到端演示（真实 ASE/EMT Langevin，`demo:freeenergy`）F(T) 曲线物理一致（⟨U⟩ 随温单调升、ΔF 单调降）；分析事件 `saturday/analysis/complete` 落 Trajectory（`analysis_complete`，与计算事件同一溯源链）；dsh profile 示例补齐工作流插件挂载行（工具自动暴露给 Agent） | plugin-screening 测试 5-6（三元升级闭式对账 + 二元路径保持）+ bridge thermo 测试 3（真实 EMT 多组分）+ demo:freeenergy 端到端验证 |
| 38 | 三元混掺真实筛选演示（⑬）：Cu + Ag/Au/Ni/Pt 五元素统一成分空间（d=4），真实 EMT 弛豫 + 全元素参考态显式计算；Cu-Pt/Cu-Au 负 ΔH_f 候选成为稳定相顶点；几何诚实声明：单点掺杂候选位于"基体端点→掺杂端点"连线上，该连线内包络由 0-0 弦主导，判据保持 max(0, ΔH_f) 退化形——非退化判据需共掺内点（见第 39 条），不夸大多组分凸包在单点候选上的作用 | demo:screening-ternary 端到端验证（真实 EMT，0.2 s） |
| 39 | 多浓度 + 共掺候选接筛选（⑮）：`maxDopedSites` 浓度扫描（每掺杂 k=1..max 各一个变体，越界显式报错：全取代 = 纯掺杂端点属参考态而非候选）+ `codopants` 共掺变体（元素重复/位点冲突/单元素显式报错）；二元分支泛化为逐掺杂系多内点构包，单内点退化为 0-0 弦（行为兼容）；非退化判据闭式对账：共掺候选由单形 (Cu3Pt,Pt,Ni) 包含，包络插值 = −4/75，距离 = 7/75（1e-9 精确）；真实演示（demo:concentrations）：EMT Cu-Pt-Ni 全候选负/正 ΔH_f 分区，Cu2NiPt 共掺有序化（−0.0895）成为稳定相顶点 | plugin-screening 测试 7-10（多浓度闭式 0.075 + 越界报错 + 共掺闭式 7/75 + 参数校验）+ demo:concentrations 端到端 |
| 40 | 谐波锚点物理化（⑭）：sidecar 新增 harmonic 算子（弛豫→中心差分 Hessian→质量加权简正模；平动零模与真虚频分开计数，零模不进振动闭式，虚频拒绝锚点——两种情况都不静默修正）；量子谐振子闭式在 JS 纯层（单一闭式来源，低温→零点能/高温→经典极限/模间线性叠加/虚频拒收）；`anchorMode='harmonic'` 接线（引擎无原语显式报错，锚点来源声明物理化随交付呈现）；LJ 谱形对账：匹配晶格参数下横模 6 重/纵模 3 重简并（fcc 立方对称）+ ν_L/ν_T ≈ √2（中心力+张力对称比，实测 0.1% 内） | plugin-free-energy 测试 10-12（纯层闭式 + 接线纪律 + 端到端对账）+ plugin-ase 测试 6（真实 sidecar 谱形）+ demo:freeenergy 升级（EMT Cu 谐波锚点端到端） |
| 41 | Logits 组合律纯层 + 联合排序接线（⑯）：`combineEvidence` 把仓库既有孤立 log 权重实例（ergodic 重加权/OU logProb/自由能 βF/谐波锚点局部配分）的组合本身立为纯层——独立证据源 log 权重相加（独立性声明必填，缺失即拒 `EVIDENCE_INDEPENDENCE_UNDECLARED`）；候选级证据掩码：缺失即缺失，零填充禁止（log 权重 0 = 伪造中立证据），全源缺失候选拒排（`EVIDENCE_NO_COVERAGE`）；log-sum-exp 归一（整体偏移不变）+ 组合爆炸门禁 + 源名重复防证据重复计数；`screenDopants` 接 `sampled`+`temperatureK`：采样候选逐候选单点回算（不弛豫——弛豫抹掉待加权的涨落信息；不入凸包——成分点与基体重合，候选不自证 §4.5），能量证据 −βU × 提议似然 q → 重要性权重（与 ergodic 升档同形），`sampledJoint` 段附逐候选覆盖/独立性/ESS 诊断；闭式对账：双源权重 2e/(1+2e)、log 权重差 βΔE+ΔlogProb；测试首跑抓出 β 算术错（kB·300≈1/38.7 非 1/1000，换 β=100 eV⁻¹ 良态条件） | plugin-screening evidence 测试 1-8（组合律闭式 + 五条拒绝路径 + ESS）+ screening 测试 11-14（联合排序闭式 + 掩码 + 门禁 + 工具层解析） |
| 42 | 采样器 → 筛选真实接线（⑰，候选来自系综而非枚举）：`workflow.screen` 接受 `{materialId, logProb}` 或 `{graph, source, logProb}`（§4.5 SampledStructure 透传，纯层 graph 模态构造 + 谱系登记采样来源；缺结构显式报错不静默丢弃）；OU 候选真实 EMT 单点回算 → 联合权重归一 + 逐候选双源覆盖 + ESS 诊断；缺似然候选保留并标 null 掩码（覆盖子集组合，权重仍归一）；logProb 可由位移闭式独立重算（1e-9，exact 似然声明的实证）；Agent 编排链：sampler.ou → workflow.screen，谱系在编排层不断 | bridge sampled-screen 测试 1-3（真 OU + 真 EMT 完整工具链 + 混合覆盖 + 双门禁） |
| 43 | 组合律可扩展性实证（⑲⑳，第三证据源）：枚举候选联合排序显式启用 `evidenceSources: ['hull']`——凸包距离作为逐候选稳定性证据（−β·max(0,energyAboveHull)，包内点掩码 0：不伪造“越稳越好”的梯度），焓证据 + 凸包证据双源叠加把包外候选罚分翻倍（闭式 e⁻² 对账）；独立性声明如实含退化关联（包上点凸包证据恒 0，不冒充独立）；无参考态即无凸包即无稳定性证据（显式拒绝不静默近似）；缺省不启用行为与既有完全一致（既有消费方零影响）；温差诚实声明（⑳）：采样器声明自身温度与目标不一致时 `temperatureMismatch` 随交付呈现（声明而非拒绝，不静默纠正） | plugin-screening 测试 15-17（闭式对账 + 三门禁 + 温差三态） |
| 44 | Agent 编排链扩展到采样→联合排序（㉑）：`demo:agent` 阶段 C——自然语言 → tool_call(workflow.screen，args 携带 OU 采样交付 {graph, source, logProb}）→ 逐候选真实单点回算 + 联合权重归一（谱系在编排层不断）；dsh 工具三连坑实证入纪律：工作流插件需自行动态 import `defineTool`（否则工具落本地注册表对 dsh 不可见）、`output.render` 必填（工具出口投影）、object 型 `items` 必须显式 `additionalProperties`（UNSUPPORTED_SCHEMA）；根依赖补 `@deepseek-ai/dsh-timeout`（dsh-llm 导入但未声明的隐性依赖） | demo:agent 阶段 C 端到端（真实 EMT，三阶段全绿） |
| 45 | 证据源注册表化（②）：`evidenceSources` 白名单分支重构为描述符注册表（{ name, requires, logWeights, independenceNote } 四要素，缺一即接入即坏）；筛选层只做通用循环（解析 → 校验输入要求 → 取逐候选 log 权重 → 追加独立性声明），新证据源在 evidence-sources.mjs 注册描述符即可接入不改筛选代码；`evidenceSourceRegistry` 可注入（第三方自定义源端到端参与组合律，闭式对账），未知源仍显式拒绝（注入注册表不绕过门禁）；组合律三条诚实纪律由 combineEvidence 强制，与源的数量和种类无关——这就是可扩展性本身 | plugin-screening 测试 18（解析三态 + 描述符闭式 + 自定义源端到端注入） |
| 46 | 采样温度标定与声明（③）：`uEqFromHarmonicTemperature` 闭式 u_eq = √(k_B·T/k_eff)（能量均分语义：温度翻倍幅度 ×√2；力常数必须显式注入——无势能面信息就没有涨落幅度，静默假设力常数 = 伪造涨落标度）；`sampler.ou` 接受显式 `temperatureK` 声明：声明 ≠ 替换（不改变采样行为，uEq 仍是直接参数）——随逐候选交付 `samplerTemperatureK`（⑳ 温差诚实声明的消费源落地）并进谱系（&T=300K，同参数不同声明 = 不同批）；声明前后采样序列与似然逐位一致（闭式回归） | plugin-sampler-ou 测试 14-15（标定闭式 + 五门禁 + 声明不改行为） |
| 47 | 多锚点混合采样（④）：OU 单峰 = 局部采样器，跨盆地探索 = 多参考加权混合（`ouSampleMixture`）。混合提案是有限高斯混合，转移密度仍闭式（log Σ π_a N_a，log-sum-exp 数值稳定）→ 似然声明保持 'exact' 不降档；交付的 logProb 是相对**全部锚点**的混合似然（非单锚点似然冒充，可独立重算 1e-9）；候选按锚点配比最大余数法确定性分配（平手取靠前）；归一混合权重随交付呈现（诚实声明的输入）；谱系记所属锚点（#mixture#anchor=k，可追到具体盆地）；同拓扑门禁（跨锚点位移仅在节点数一致时有定义，不静默近似）；单锚点退化与单核采样逐坐标一致（严格推广无隐式行为变化） | plugin-sampler-ou 测试 16-17（一维双锚点手算闭式 + 配额/似然自洽/谱系/四门禁） |
| 48 | 单位与能力指纹入契约（异构引擎生态的泛化地基，量纲分析最小落点）：M1 注册门禁——`PotentialRegistry.register` 即校验 `manifest.units`（energy/length/time 三元组，白名单外/维度错位显式拒绝）与 `manifest.fingerprint`（software/method 必填，version 不可得诚实降级 'unknown'），归一声明挂 `_units/_fingerprint`（不改写原 manifest）；换算只能由调用方**显式发起**（`unitConvert`，跨维度/未知单位/非有限值均拒），绝不自动进入能量比较路径（自动换算会掩盖"两个引擎的能量本不该直接比"的物理问题）；契约套件 §4.2 manifest 断言同步加严（新插件接入即验）；M3 能量组合门禁——筛选层参考态升级形态 `{ energyPerAtom, fingerprint?, energyUnit? }` 声明了就对账：异源/异单位进凸包前显式拒绝（不静默混源、不静默换算），纯数值形态诚实降级（声明 ≠ 强制，旧路径不追溯拦截），`referenceProvenance` 与 `providerFingerprint/providerUnits` 随交付呈现（能量来源可追溯性即消费方可核对的交付物） | core units.test 8 项 + potential.test 3 项（M1 自检）、契约套件 §4.2 断言（四引擎 + 自检全绿）、plugin-screening 测试 19（同源/异源/异单位/降级/空壳五态） |
| 49 | M2 激活门禁（⑤）：`PotentialRegistry.activate` 热切换事件载荷携带 `fingerprintChange`（{ same, reason }）——声明而非拒绝：§8.2 失效传播照常沿 `engine:<id>` 走，差异声明让消费方知晓"为何旧能量不再可比"；reason 按维度归因（software/method/version 逐维对账，首个不同维即落）；首次激活无前驱 → same=true（不伪造差异，与温度声明同款诚实纪律） | packages/core potential.test 测试 4（同源/异 software/异 method 三态） |
| 50 | 跨引擎对照演示（⑥）：同一条候选链（Cu + Ag 掺杂）分别经两个指纹不同的引擎回算，四段实证异构引擎生态泛化地基——A 交付自带能量来源可追溯性（providerFingerprint/providerUnits + 参考态 provenance 声明态）；B M3 拦截（异源参考态混入凸包前显式拒绝，不静默混源）；C M2 事件（热切换携带指纹差异声明）；D 双引擎交付并排（两份能量不直接可比是诚实声明，不是缺陷——跨引擎比较须调用方显式声明换算与可比性假设） | demo:cross-engine 端到端（四段如实运行，packages/bridge/demo-cross-engine.mjs） |
| 51 | 工具层自产参考态声明形态（⑦）：引擎 `referenceEnergy` 显式产出的参考态按定义同源——直接升级为声明形态（携带本引擎归一指纹与能量单位），凸包能量全链同源可比（M3 消费）；`referenceProvenance='declared'` 与指纹投影随交付呈现（消费方可独立核对"这批能量从哪来、能否互比"）；引擎未声明指纹时诚实降级不投影（不冒充可追溯） | plugin-screening 测试 21（provenance 声明态 + 指纹投影断言） |
| 52 | 单位换算审计通道（⑧）：参考态 `convertedFrom` 声明"原值为该单位、调用方已显式换算到引擎单位"——声明 ≠ 替换（不改变 energyPerAtom 的消费、不绕过单位门禁），换算因子由白名单机械重算随交付呈现（审计可复现，与温度声明同款诚实纪律）；未知单位/跨维度声明即拒（带码），换算痕迹从此不落在暗处 | plugin-screening 测试 20（因子闭式对账 + 声明≠替换 + 不绕过门禁三态） |
| 53 | 指纹实测态回读（①）：声明态 ≠ 实测态，两态各自诚实——`stampFingerprint` 把归一指纹 version 从 'unknown' 升级为探测实测值（只丰富 version：software/method 是静态声明不在回读范畴；非实测值/空值/再盖 unknown 均拒，探测失败方不盖章）；三引擎探测路径按形态各异：ase 走 sidecar 握手（aseVersion）、lammps 解析 `binary -h` 横幅、mace 读 `mace.__version__`，探测失败一律 null 保持声明态；配套 version 维 unknown 通配：未探测不构成差异证据（一侧 unknown 同源放行但 reason 声明"含未验证维"，两侧实测不同才判异源）——实测态升级不破坏既有组合，拦截能力不丢 | core units.test 9（通配三态）+ potential.test 5（盖章三态）；ase/lammps/mace 各自探测测试（伪桥/伪子进程） |
| 54 | 可用性预检演示（②）：`demo:availability` 对四引擎逐一探测 + 实测态回读——注册 = 声明层（M1 注册即验，不可用不移除注册），可用 = 运行时层（使用时 ENGINE_UNAVAILABLE 拦，绝不静默替换）；同一份代码在装了/没装 LAMMPS/MACE 的机器上给出不同的表，两种输出都正确（环境依赖的诚实报告即预检的意义；本机实测：ase 3.28.0 / mace 0.3.16 盖章实测态，lammps 缺失保持 unknown） | demo:availability 端到端（四引擎三态如实运行，packages/bridge/demo-availability.mjs） |
| 55 | 多锚点混合采样真实演示（③）：`demo:mixture-sampling` 三段——A 双锚点（Cu / Cu3Ag 同拓扑）按 [0.6,0.4] 最大余数法配额采样 10 个（锚点归属随谱系 #anchor=k）；B 混合似然逐一独立重算（相对全部锚点，最大偏差 0：'exact' 声明机械可验）；C 回算闭环（候选不自证：采样似然 ≠ 物理能量，候选[0] 经真实 ASE EMT 单点 oracle 裁定，生成 → 回算 → 核对谱系不断） | demo:mixture-sampling 端到端（真实 EMT 回算，packages/bridge/demo-mixture-sampling.mjs） |
| 56 | 证据源注册表第二内置源（④）：理想混合熵 `mixing-entropy`——逐候选组分先验，log w = ΔS_mix/k_B = −Σ x·ln x（每点位，与 β 无关：−β·(−TΔS) 的温度线性在 log 权重中消去）；纯元素候选按定义 0（不伪造梯度）；只消费组分与焓/凸包证据零能量信息共享，独立性声明如实含"与凸包共享组分变量"退化关联；接入不改筛选代码（注册表化实证：第二源 = 可扩展性本身的第二次实证）；端到端闭式：焓 [0,+1,−1] + 熵 [0, S1, S1]（S1 = 0.5623351446188083 手算），排序不变但权重位移如实呈现 | plugin-screening 测试 22（每点位熵闭式 + 双源相加闭式 + 独立性声明） |
| 57 | 证据源独立性声明的机器校验升档（⑤）：可选第五要素 `variables`（依赖变量词表）；`auditEvidenceIndependence` 三态——全声明且两两不交 `independent` / 全声明但检出共享 `degenerate` / 存在未声明者 `unverifiable`（未声明者不冒充独立也不拒绝）；门禁牙齿：机械检出的共享变量必须在 `independence` 声明文本中被解释，否则 `EVIDENCE_INDEPENDENCE_UNDECLARED`（声明是人写的，交集是机器算的，对不上即拒绝）；`maskCounts`（逐源掩码计数）随交付呈现（掩码拒绝可核验）；内置源全部携带变量声明（hull [能量,组分] / mixing-entropy [组分] / 枚举 [能量] / 采样 [能量,坐标] + proposal [坐标]，共享"坐标"由声明文本"给定坐标下条件独立"解释——机械可验） | plugin-screening evidence 测试 9-11（三态审计 + 门禁拒绝 + 掩码计数）+ screening 测试 23（双源端到端退化关联闭环） |
| 58 | 可用性预检工具化（⑥）：`engine.availability` 逐引擎如实报告——有 `probeVersion` 则探测（失败 → `unknown-or-missing`，注册表不因探测失败缩减：注册 = 声明层不因运行时不可用而回收）；`stamp` 默认 false（预检是查询不是变更——查询性工具不得携带副作用默认值）；仅 `stamp=true` 且 version 实测才走 `stampFingerprint`（实测态回读纪律复用，见本表第 53 条）；status 不区分未知与缺失（区分需真实计算，超出预检权限——诚实不区分） | bridge availability 测试 1-2（默认只报告不盖章 + 按需盖章三态） |
| 59 | 混合提案锚点库（⑦，自监督进场的数据管道第一段）：`createAnchorStore` 纯层——`add` 谱系必填（无来源声明的数据不入库：锚点来自闭环轨迹，出处必须可追溯）；`retrieve` 拓扑硬门禁（节点数一致，与 `ouSampleMixture` 同款，库里先筛一道是诚实不是冗余）+ 组分分数向量 L1 距离升序（锚点缺组分 → `distance: null` 排尾：不可考不冒充可比；平手按入库序，确定性）；`toMixtureTarget` 空检索 `ANCHOR_EMPTY` 拒绝（不伪造锚点——先让闭环积累数据再谈混合提案）、`weights` 长度必须一致（混合权重是显式声明不是静默补全） | plugin-sampler-ou anchor-store 测试 1-5（入库门禁 + 检索排序三态 + 端到端接 `ouSampleMixture` 配额闭环） |
| 60 | 锚点引导混合提案的工具化（⑩，锚点库接 Agent 层）：`sampler.anchor.add`（材料入库来源声明缺省 = 材料身份，组分从原子序机械提取；直交付无谱系即拒——谱系门禁在工具层生效，锚点本体不外泄）与 `sampler.mixture`（会话库检索 / 内联锚点二路径 → 配额 → OU 混合提案；`anchorOrigin` 声明锚点来源层，检索距离随交付呈现；空库 `ANCHOR_EMPTY` 拒伪造，拓扑门禁先于采样，权重不静默补全；两路径共用同一条纯层目标构造 `mixtureTargetFromRetrieved`——门禁不另开旁路）；会话级内存库与闭环运行同生命周期（不跨会话持久化，不伪造库外数据）；候选不自证声明随交付（回算后接 `workflow.screen` 的 `sampled` 透传，谱系在编排层不断） | plugin-sampler-ou plugin-anchor-tools 测试 1-3（谱系门禁工具层生效 + 内联配额/似然/确定性 + 会话库拓扑门禁/空库拒伪造/检索排序闭式对账） |
| 61 | 锚点引导闭环端到端 + 工具链契约审查（⑫/⑬/⑭）：`demo:anchor-guided` 全程工具层四段——A 锚点入库（材料入库缺省来源声明，无谱系不入库在工具层生效）；B 会话库检索（cu3ag L1 距离 0、cu4 距离 0.5，权重按检索序映射）→ 配额 [5,3]（0.6/0.4×8 最大余数法）→ 混合提案（温度声明随交付呈现）；C 工具间只传交付（{graph, source, logProb}）接 `workflow.screen` 联合排序：8 候选真实 EMT 回算全部成功，双源证据 × 组合、Σw = 1（配分函数归一）、独立性声明如实——入库 → 检索 → 提案 → 回算 → 排序谱系不断；形态审查（⑭）：候选 `generative:` 前缀 + 可回算构造 Material（§4.5 条款的工具层延续）；裁决（⑬）：`workflow.screen` 不直收 `anchors`（见 §4.5 裁决段，两步编排即组合律） | demo:anchor-guided 端到端 + plugin-sampler-ou plugin-anchor-tools 测试 4（形态延续：前缀纪律 + 可回算构造） |
| 62 | 闭环轨迹自动入库（⑮，自监督数据管道第二段）：弛豫收敛 + 引擎交付终态 → 弛豫后结构自动入会话锚点库（谱系自动声明 `job:<id>#engine=<name>`，能量随锚点记录，组分从终态原子序机械提取）；三道门禁否定路径同样实证：未收敛不入库（终态在场也不被诱导）、旧协议无终态交付不入库（不拿输入结构冒充）、同谱系重复事件幂等（重放安全）；引擎 `relax` 交付协议扩展 `positions`/`cell`（ase sidecar 补齐；emt-mock 原生已含；旧版按字段存在性诚实缺省）；薄事件纪律：结构体不重复落 Trajectory（只记 `relaxedStructureDelivered` 在场标记） | bridge anchor-autoingest 测试 1-3（自动入库谱系/组分/幂等 + 未收敛门禁 + 旧协议门禁，假引擎桩验证） |
| 63 | 锚点工具 Agent 层暴露 + 配额闭式对账补强（⑯/⑰）：⑯ `demo:agent` 阶段 D——`sampler.anchor.add`/`sampler.mixture` 经 dsh harness 暴露给 Agent（工具出口关卡实证：`graph: undefined` 覆盖触发 'not lossless JSON' 拒付，改显式剔除），阶段 B 弛豫收敛结构由 ⑮ 自动入库后会话库命中双锚点（自动 + 手动，同拓扑）→ 混合提案来源层 `session-store` 随交付呈现；⑰ 最大余数法配额闭式对账：配额只依赖 (n, 归一权重) 与 seed 无关（多 seed 扫描）；余数按小数降序补一、小数平手取靠前锚点（[0.5,0.5]×5 → [3,2]、[1,1,1]×10 → [4,3,3]）；未归一权重与归一形态同配额；三锚点余数顺次补一（[0.5,0.3,0.2]×9 → [4,3,2]） | demo:agent 阶段 D 端到端 + plugin-sampler-ou plugin-mixture-quota 测试 1-4（配额闭式 + 平手确定性 + 归一不变 + seed 无关扫描） |
| 64 | 全自动锚点引导闭环 + 不可考组分诚实降级链（⑱/⑲/⑳）：⑲ `demo:anchor-auto` 无人工入库形态——Cu/Cu3Ag 真实弛豫（收敛 + 终态交付）→ ⑮ 自动入库（谱系 `job:<id>#engine=<name>`，全程零手动锚点操作）→ 会话库检索（距离 0/0.5）→ 配额 [5,3] → 提案 → 回算 + 联合排序（Σw = 1，谱系不断）；⑳ 组分不可考（`distance: null`）诚实降级链：缺组分锚点检索排尾（不冒充可比不编造数值）→ 混合提案不因不可考拒绝（排尾不是排除：目标构造照常、均匀配额实证参与混合不是陪跑）→ 距离声明随工具层交付如实透传；⑱ 裁决：会话锚点库不引入淘汰/上限（库与闭环同生命周期，淘汰属持久化关注点；`topK` 已是提案侧参与上限） | demo:anchor-auto 端到端 + plugin-sampler-ou plugin-null-distance 测试 1-2（纯层排尾 + 目标构造照常；工具层距离透传 + 配额参与实证） |
| 65 | 提案谱系接推导登记簿 + 三元系可扩展性 + 持久化锚点库原型（㉑/㉒/㉓）：㉑ `sampler.mixture` 提案层谱系登记（活性上下文 §8.2）——注入推导服务时登记一层提案推导（锚点来源归一化为 `material:<id>`/`job:<id>` 输入，输出 `result:mixture-<batchId>`）；锚点失效沿推导图传播到提案（活性接通实证）；不可追溯来源不冒充输入（全不可追溯不伪登记）；未注入行为不变；㉒ 三元系端到端：{Cu,Ag,Au} 三锚点检索排序（含不可考排尾不回归）、三权重配额闭式 [0.5,0.3,0.2]×9 → [4,3,2]（余数降序顺次补一）+ 多 seed 扫描不变、同参数两次提案逐候选严格一致（确定性复现）；㉓ 持久化原型：`sampler.anchor.export`（无损 JSON 全量导出，序列化往返不丢信息）/ `sampler.anchor.import`（库层门禁复用 + 同谱系幂等跳过 + 单条拒绝不中断整批），回填锚点即刻可参与混合提案（数据燃料跨会话续供）；诚实边界：库自身仍会话级，落盘由调用方负责 | plugin-sampler-ou plugin-mixture-derivation 测试 1-4（登记 + 失效传播 + 不伪登记 + 未注入不变）+ plugin-ternary 测试 1-3（检索排序 + 配额闭式 + 确定性）+ plugin-anchor-persist 测试 1-3（往返无损 + 幂等 + 门禁） |
| 66 | 持久化落盘侧 + 排序层提案引用全链活性 + 持久化原语 Agent 层暴露（㉔/㉕/㉖）：㉔ `sampler.anchor.save`/`load`（搬运原语的文件端）——落盘→跨会话回填逐字段一致且即刻可提案；错误路径如实：文件缺失/损坏/非载荷形态显式报错（`ANCHOR_PERSIST`，不静默冒充成功）；路径调用方显式声明；同库重载同谱系幂等；导入循环提取为共享助手（导入工具与文件回填门禁不另开旁路）；㉕ `demo:agent` 阶段 E：`save`/`load` 经 dsh harness 暴露（含全量 graph 的无损 JSON 出口关卡压测，⑯ 教训延续：新工具的宿主出口实证是必要验收环节）+ 落盘→回填→跳过重放幂等在 Agent 层实证；㉖ `workflow.screen` 直收 `proposalRef` 登记为排序层推导输入：锚点失效 → 提案失效 → 排序失效三级链全活性实证；未声明行为不变（不伪造推导输入）；非法引用登记簿显式拒绝；与 ⑬ 裁决分工：不直收的是 `anchors`（结构本体 + 采样逻辑），直收的是推导引用（编排层谱系接线），组合律不破 | plugin-sampler-ou plugin-anchor-save-load 测试 1-3（往返 + 错误路径 + 幂等门禁）+ demo:agent 阶段 E 端到端 + bridge proposal-chain 测试 1-3（三级传播 + 未声明不变 + 非法引用拒绝） |
| 67 | 跨会话恢复端到端 + 回填后活性保持 + 自监督进场条件裁决（㉗/㉘/㉙）：㉗ `demo:anchor-resume` 编排层兑现“落盘由调用方负责”的诚实边界——会话一真实弛豫（收敛 + 终态交付）→ ⑮ 自动入库 → `save` 落盘（路径调用方显式声明）→ 会话终结全部回收；会话二全新挂载（空库不伪造库外数据）→ `load` 回填 → 检索（谱系跨会话保留）→ 提案 → 回算 + 联合排序（Σw = 1）；行为级无损对账：落盘往返不改变任何采样行为（同参数逐候选结构/似然/归属/谱系严格一致）；两“会话”是同一进程内两次独立挂载，跨会话唯一通道是磁盘载荷（诚实声明入演示注释）；㉙ 回填后活性不降级：回填锚点的提案照常登记推导（㉑ 归一规则不因回填改变），锚点失效沿推导图传播到提案、再传播到排序（㉖ 全链活性跨会话不降级）；归一引用与检索来源与原会话逐条一致（不冒充、不丢、不改写）；材料会话级：跨会话引用不冒充在场（会话 B 内重新加载基体）；㉘ 裁决：对照触发条件逐项呈报后维持“不引入自监督”——管道两段 + 跨会话续供机制已备齐（触发条件第一项的基础设施全部就位），但“足够轨迹”与“探索效率瓶颈”均未出现（先见数据再谈机制，同 ⑬/⑱）；进场挂载点与不变纪律重申 | demo:anchor-resume 端到端 + bridge anchor-resume 测试 1-2（跨会话闭环参与 + 行为级无损对账）+ bridge anchor-resume-liveness 测试 1-2（全链活性跨会话不降级 + 谱系登记如实） |
| 68 | 恢复闭环接 Agent 层 + 落盘侧谱系可追溯声明 + 落盘载荷完整性校验（㉚/㉛/㉜）：㉚ `demo:agent` 阶段 F——自然语言“对恢复后的锚点库做混合提案” → tool_call(sampler.mixture)：回填锚点即刻参与提案（来源层/谱系跨恢复保留），回填交付的 `lineageRefs` 随阶段日志呈现（恢复闭环在 Agent 层收口，㉕ 教训延续：新编排形态的宿主出口实证）；㉛ `load` 交付附 `lineageRefs`（载荷内可追溯来源的归一化声明，与 ㉑ 归一规则同款：取 # 前段）——声明不是装饰：沿 `lineageRefs` 起点 invalidate，提案推导如实失效（谱系从“跨会话保留”升为“跨会话可撤回”，消费方不必翻库）；㉜ 完整性校验：版本门禁（仅 `saturday-anchor-store/1`，未知/缺失不静默接受）+ `size` 声明对账（声明 ≠ 实质即拒，不猜测补齐）；单条损坏不连坐（共享导入循环逐条拒绝，合法条目照常入库，与 ㉓ 同款）；三条门禁都不得污染库 | demo:agent 阶段 F 端到端 + bridge anchor-lineage-refs 测试 1-2（声明与载荷一致 + 沿声明起点失效传播实证）+ plugin-sampler-ou plugin-anchor-save-load 测试 4-5（版本/无版本/size 三态拒绝 + 单条损坏不连坐） |
| 69 | 条目级版本戳 + 多载荷合并回填 + 载荷血缘审计（㉝/㉞/㉟）：㉝ 载荷形态升版 `saturday-anchor-store/2`（条目附 `entryVersion: 'saturday-anchor-entry/1'`）——`load` 逐条校验版本戳：缺失/未知版本戳按条目级损坏定位到载荷原位索引拒绝（过滤后不丢定位能力），合法条目照常入库不连坐（损坏检测从“整体非载荷”下沉到条目级）；㉞ `load`/`audit` 支持 `path`（单载荷）或 `paths`（多载荷合并）二选一（不静默猜测调用方意图）；门禁先行——全部文件先过完整性检查，全过才开始回填（任一文件不过 → 整批拒绝，出错时库零污染）；同谱系幂等门禁天然兜底跨载荷重复（数据燃料多源汇聚）；逐文件明细随交付；㉟ `sampler.anchor.audit` 只读血缘三态审计（可追溯/不可追溯/损坏）：审计不回填不污染库，异常文件如实入报告不连坐——回填前的一手数据质量观测面 | plugin-sampler-ou plugin-anchor-save-load 测试 6-8（条目版本戳定位 + 多载荷合并/门禁先行/二选一门禁 + 审计三态与库零污染）+ plugin-anchor-persist 测试 1（版本戳随导出交付） |
| 70 | 审计接 Agent 层 + 多载荷合并后的活性保持 + 锚点库容量观测（㊱/㊲/㊳）：㊱ `demo:agent` 阶段 G——自然语言“先审计落盘载荷的血缘再决定回填” → tool_call(sampler.anchor.audit)：只读三态报告回流（全部可追溯、无损坏），库状态不变（观测先于行动的数据纪律在 Agent 层实证，㉕ 教训延续）；㊲ 多载荷合并后的活性保持：两份不同来源载荷经 ㉞ 合并回填后，跨载荷汇聚的谱系各自独立可撤回（沿某一来源失效 → 提案失效；失效不删数据，另一来源与库内条目照常在场）；合并后提案锚点归属与载荷谱系逐条一致（汇聚不冒充、不丢、不改写）；㊳ `sampler.anchor.stats` 只读库内容量观测（条目数 + 归一化谱系形态分布 + 组分声明覆盖）：观测不变更库，与 ㉟ 载荷审计构成“库内 + 库外”双观测面（为 ㉘ 触发条件的“足够轨迹”提供量化读数） | demo:agent 阶段 G 端到端 + bridge anchor-merge-liveness 测试 1-2（谱系独立可撤回 + 归属逐条一致）+ plugin-sampler-ou plugin-anchor-save-load 测试 9（库容量观测如实与不变更） |
| 71 | 审计驱动的合流回填决策链 + “足够轨迹”触发判据原型 + 审计修复建议通道（㊴/㊵/㊶）：㊴ `demo:agent` 阶段 H——自然语言“审计两份候选载荷，只回填达标的那份” → audit（含修复建议）→ 按报告只回填达标载荷（不达标载荷不进数据燃料；决策由 mock 脚本编码，实证的是“报告 → 行动”链路的运行时效果）；㊵ `trajectoryTriggerAssessment` 纯层判据：㊳ 读数对调用方显式声明的阈值（`minSize`/`minCompositionCoverage`）为声明式对账不是门禁，阈值不硬编码不设默认（未声明即拒），两项缺口各自独立呈报，空库覆盖率为 0（不除零崩溃）；㊶ `sampler.anchor.audit` 对非可追溯条目随报告交付修复声明（`repairHints`：原位索引 + 三态 + 建议），损坏与不可追溯区分（前者回填必拒，后者可回填但建议声明可追溯起源），仍保持只读不代改 | demo:agent 阶段 H 端到端 + plugin-sampler-ou plugin-anchor-trigger 测试 1-3（达标/缺口独立呈报/未声明阈值拒绝 + 空库）+ plugin-anchor-save-load 测试 8 扩展（修复建议定位与可操作）与测试 10（统计读数直喂判据） |
| 72 | 收尾判据快照 + 载荷侧修复原语 + 判据对账谱系化（㊷/㊸/㊹）：㊷ `demo:anchor-resume` 会话二收尾：`stats` 读数 → 判据对账 → 判据快照随日志呈现（`met=false`，缺口如实：条目数 2 低于 minSize 100）——“足够轨迹”裁决从人工对照升级为机器可读的判据快照（读数 → 阈值 → 结论可追溯可复算），阈值调用方显式声明（原型阈值非内置常量），维持 ㉘ 裁决；㊸ `sampler.anchor.repair` 载荷侧修复原语（观测/修复权责分离）：审计只指明出路，修复必须调用方逐条显式授权；修复写新载荷不碰原件（原件留作证据，`out` 与 `path` 相同即拒）；只修复不可追溯条目（损坏修复即伪造必拒，已可追溯修复即替调用方做决定亦拒）；修复全程不回填，审计是修复的验收面；㊹ 判据对账谱系化：对账结论可选登记为推导（输入 = 可追溯证据引用，归一化同 ㉑），证据引用失效 → 对账结论沿推导图如实失效（裁决依据可撤回）；无可追溯证据引用不伪登记；未注入推导服务行为不变 | demo:anchor-resume 收尾判据快照 + plugin-sampler-ou plugin-anchor-save-load 测试 11-12（修复原语正路 + 四类门禁拒绝）+ bridge anchor-trigger-derivation 测试 1-2（结论可撤回 + 不伪登记与零依赖） |
| 73 | 修复链接 Agent 层 + 判据快照跨会话续供 + 判据谱系质量维（㊺/㊻/㊼）：㊺ `demo:agent` 阶段 I——自然语言“按审计建议修复不可追溯条目并重新审计验收” → repair（逐条显式授权，写新载荷不碰原件）→ 重新审计验收（修复后载荷全可追溯、原件保持原状：审计是修复的验收面）——观测→修复→验收三步链在 Agent 层链接（修复声明由 mock 脚本编码，诚实声明）；㊻ `sampler.trigger.snapshot.save`/`load` 判据快照落盘/回填原语：对账结论整体原样落盘（读数/阈值/结论一并保留，落盘不改判）→ 回填只读校验版本戳（`saturday-trigger-snapshot/1`）与形态后原样交付（未知版本戳/形态不完整/缺批次标识均如实拒）；快照不是锚点条目（不进锚点库、不进数据燃料）——裁决依据跨会话可续供、可复算；㊼ 判据谱系质量维：可选阈值 `minTrackableRatio`（可追溯占比）由调用方显式声明——未声明行为不变，声明后读数缺谱系分布维则显式拒绝（不替调用方猜测质量读数），质量维缺口与数量/覆盖维独立呈报不合并糊化（“足够轨迹”不只够多还要够可追溯） | demo:agent 阶段 I 端到端 + plugin-sampler-ou plugin-anchor-save-load 测试 13（快照落盘/回填原样 + 三道门禁拒绝 + 不进锚点库）+ plugin-anchor-trigger 测试 4（质量维对账如实与门禁） |
| 74 | 判据快照跨会话续供 + 修复后载荷活性闭环 + 质量维观测对账（㊽/㊾/㊿）：㊽ `demo:anchor-resume` 会话二收尾判据快照经 `snapshot.save` 落盘（会话内日志升级为磁盘证据，落盘不改判）→ 会话三全新挂载经 `snapshot.load` 回填，续供对账逐字段一致（可复算不重新估算），快照不进锚点库（证据载荷与结构数据燃料正交）；㊾ 修复后载荷的活性闭环（观测→修复→验收→入库四环）：不可追溯载荷经修复 + 审计验收后回填，提案照常登记推导（谱系用修复后的来源不冒充原件），沿修复后谱系失效 → 提案如实失效（可追溯即意味着可撤回），失效不删数据；㊿ 质量维观测对账：判据回呈的可追溯占比 = ㊳ 观测的库内逐条谱系计数（不重新估算），观测读数变化 → 对账结论如实翻转（结论不硬编码），观测/判据全程不变更库 | demo:anchor-resume 会话三续供对账 + bridge anchor-repair-liveness 测试 1-2（修复达标数据成燃料 + 归属如实不冒充原件）+ plugin-sampler-ou plugin-anchor-save-load 测试 14（观测→判据不断链与结论随读数翻转） |

## 附录 B：插件骨架模板

```javascript
// my-plugin.mjs —— 第三方插件最小骨架
import { createCordisAdapter } from '@saturday/kernel'

export default {
  name: 'my-analysis',
  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    // 服务 / 订阅 / 工具全部经 rt —— 卸载自动回收
    const disposer = rt.provideService('my-analysis', impl)
    rt.on('saturday/simulation/converged', handler)

    // 外部资源绑定到 fiber 生命周期
    rt.effect(() => () => cleanup(), 'my-analysis:resource')

    ctx.fiber.store['my-analysis'] = { /* 运行时句柄 */ }
  },
}
```

---

## 引用

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
