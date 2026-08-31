# Saturday Plugin Contract

**版本**: v0（**experimental** —— 1.0 前允许破坏性变更，以契约测试套件为准）
**上游依据**: Cordis 范式，arXiv:2608.25512

---

## 1. 定位与适用范围

Saturday 是材料计算的**插件运行时**：引擎、结构源、工作流、分析工具全部以插件形态
挂载到宿主上。**dsh（DeepSeek Harness）是唯一官方宿主**；裸 cordis 不是另一个宿主，
而是同一内核（Cordis v4）的开发/CI 运行模式。
本文档定义插件与运行时之间的接口规范（seam 契约）——它是生态的"宪法"，优先于任何单一功能。

**适用对象**：所有第一方与第三方插件作者、`@saturday/kernel` 维护者。

**不适用**：宿主自身的实现细节（cordis API 只在防腐层内出现，插件作者无需了解）。

### 1.1 三条纪律

| 纪律 | 内容 |
|---|---|
| **依赖卫生（防腐层）** | 插件只依赖 `@saturday/kernel` 暴露的 `SaturdayRuntime` 接口，禁止 import cordis / dsh；上游破坏性变更的影响面收敛到适配层一个文件 |
| **契约即宪法** | 本文档 + 契约测试套件共同构成兼容性承诺；文档与测试冲突时以测试为准 |
| **核心瘦削** | 默认一切是插件；功能进核心需要举证（跨插件一致性 / 性能 / 安全三选一） |

### 1.2 可逆性作用域（三级，不得混淆）

| 作用域 | 语义 | 机制 |
|---|---|---|
| 软件资源域 | 完全可逆 | 插件的一切注册动作都是 effect，卸载时自动回退（cordis 语义） |
| 计算任务域 | 幂等 + 可取消，不承诺回滚已完成的计算 | `inputHash` 去重；任务可 cancel，无孤儿进程 |
| 物理设备域 | 永不回滚 | 审批 + 审计 + 参数白名单（v0 不涉及） |

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

插件唯一依赖的运行时接口（实现：`@saturday/kernel`，即 `packages/kernel/src/cordis-adapter.mjs`）：

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
  /** schema 方言：schemastery 扁平式（官方工具插件格式，非 JSON Schema） */
  parameters: Record<string, { type: string, required?: boolean, description?: string, default?: unknown }>
  output: { schema: { type: 'object', additionalProperties: true } }
  execute(args: unknown): Promise<unknown>
}
```

工具出口要求无损 JSON：交付载荷必须可无损序列化为 JSON（全量 `graph` 等大对象照常透传），
不得携带无法序列化的字段。

---

## 4. 插件契约

### 4.1 structure-resolver —— 结构源插件

**职责**：把无结构信息的输入（化学式等）解析为候选结构。
formula-only 构建必须显式经过 resolver，结构来源写入材料谱系。

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
`md` 为可选能力（遍历对账的时间平均侧）：`capabilities` 里声明 `md`
即承诺提供 `md()` 原语；未声明则工作流层对账工具对该引擎不可用（显式错误）。

```typescript
interface PotentialProvider {
  readonly name: string       // 'emt-mock' | 'lj-js' | 'lammps' | 'mace' | 'vasp' …
  readonly version: string
  readonly manifest: ProviderManifest
  relax(material: Material, params?: object): Promise<RelaxResult>
  calculate(material: Material, params?: object): Promise<CalculateResult>
}

interface ProviderManifest {
  capabilities: {
    type: 'relax' | 'calculate' | 'md'
    accuracy: number          // 0-1，越大越准
    speed: number             // 0-1，越大越快
    cost: number              // 0-1，越大越贵
    maxAtoms?: number
    /** calculate 专用：基线量（energy/forces）之外的可算性质声明。
        未声明的性质请求必须被显式拒绝（PROPERTY_UNSUPPORTED） */
    properties?: ('stress' | 'bandgap' | 'dos' | string)[]
  }[]
  constraints: {
    requiresLicense?: boolean // 前置门禁：激活前校验，失败抛 LICENSE_UNAVAILABLE
  }
  /** 单位三元组（energy/length/time）与能力指纹（software/method/version），注册即校验，见 §4.7 */
  units?: { energy: string, length: string, time: string }
  fingerprint?: { software: string, method: string, version: string }
  /** 事件粒度声明：决定组合器能否插入细粒度监听，见 §5.2 */
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
  /** 弛豫终态坐标/晶胞（供自动入库等下游消费；旧协议按字段存在性缺省） */
  positions?: [number, number, number][]
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
- **性质能力门禁**：基线物理量（energy/forces）对任何 calculate 能力隐式成立；
  其余性质必须在 `capabilities[].properties` 显式声明，`PotentialRegistry.assertCalculable`
  在计算前拦截未声明者（`PropertyUnsupportedError`）；
- **计算产物记录（CalculationRecord）**：`Material.electronicView` 等异步视图的交付物是记录而非同步字段：
  谱系追加 `electronic-calculated` 条目（`detail.calculationId` 反查）；记录只收录引擎真实给出的性质；
- **结果不可变**：返回后即为事实，进入谱系与 Trajectory，不得就地修改；
- **幂等**：相同 `material.graph + params` 应产生相同结果（允许经缓存命中）；
  `md` 例外：轨迹含随机积分，幂等仅在固定 `params.seed` 时成立；
- **路由契约**：路由权在 `PotentialRegistry`（autoRoute 按任务画像评分：
  validation 类任务选高精度，screening 类任务选低成本）；
  Provider 不得自行挑选替身；显式 `engine` 指定优先于路由；
- **长任务**：`relax`/`calculate`/`md` 是异步原语，Promise 在计算完成时 settle；
  超时 / 取消语义由任务域承载，Provider 必须支持取消且不留孤儿进程；
- **参考态辅助原语**：`provider.referenceEnergy(symbol)` 显式计算元素参考态每原子能量
  （数据面算子 `reference_energy`），供热力学判据消费（§4.3）。

参考实现：`@saturday/plugin-lj`（零依赖纯 JS 引擎，指纹 `lj-js/LJ`）——
截断+平移 LJ（Lorentz-Berthelot 混合）声明 `relax`/`calculate`/`md` 能力，
另提供 `harmonic` 辅助原语（与 sidecar 同规格：零模/虚频如实计数）与 `referenceEnergy`
（本引擎自洽参考态，非实验值，随交付声明）；玩具势教学档精度声明在先。
Python 数据面缺失时由桥层显式注册为回退数据面（非静默降级，见附录 A 第 78 条）。

### 4.3 workflow —— 工作流插件

**职责**：编排原子原语完成复合任务（如批量掺杂筛选）。工作流一律是独立插件，不进核心。

```typescript
/** 纯编排函数，由宿主或上层插件调用 */
function screenDopants(opts: {
  material: Material
  dopants: string[]
  potential: PotentialRegistry
  topK?: number
  engine?: string
  /** 事件回调：工作流不直接触碰运行时，事件由调用方路由（可测试性） */
  emit?: (type: string, event: object) => Promise<void>
  /** 可选注入：推导登记簿（活性上下文，§8.2）/ 批次标识 */
  derivation?: DerivationRegistry
  batchId?: string
  /** 可选注入：元素参考态每原子能量（显式计算所得） */
  references?: Record<string, number>
  /** 参考态不可得的原因（随交付记录） */
  thermoUnavailable?: string
  /** 可选：采样候选参与联合排序（§4.5 交付透传）与证据源扩展（§4.8） */
  sampled?: { materialId?: string, graph?: AtomGraph, source: string, logProb?: number | null }[]
  temperatureK?: number
  evidenceSources?: string[]
  /** 可选：提案推导引用（来自 `sampler.mixture` 交付），登记为排序层推导输入 */
  proposalRef?: string
}): Promise<{
  ranked: ScreenEntry[]       // 按 energyPerAtom 升序，全部含谱系引用；
                              // 注入 references 时附 formationEnthalpy / energyAboveHull
  failed: { label: string, kind: string, error: string }[]
  derivation?: { batchId: string, rankRef: string, energyRefs: string[] }
  thermo?: { level: string, mode?: string, hullDimension?: number, references?: object, note?: string, reason?: string }
  note: string
}>
```

**规则**：
- **逐变体事件**：批量任务的每个变体发独立事件 → 各自落 Trajectory（可逐条溯源）；
- **不吞错**：单变体失败计入 `failed`，不中断整体；整体性错误才抛出；
- 工作流暴露为工具时，工具层负责 schema 与描述，编排逻辑保持在纯函数中；
- **边界纪律**：`workflow.screen` 不直收锚点结构本体与采样逻辑（那是
  `sampler.mixture` 的职责，两步编排即组合律）；直收的是推导引用 `proposalRef`
  （编排层谱系接线）；
- **热力学判据**：注入 `references` 时，排序升级为严格形成焓 + 形成焓空间凸包判据
  （`thermo.level` 声明实际精度）；元素数 ≥ 3 自动升级为统一成分空间多组分凸包
  （`thermo.mode` / `hullDimension` 声明形态）；参考态不可得时保留"近似"声明并记录原因；
- **采样候选联合排序**：`sampled` 候选逐候选单点回算（不弛豫、不入凸包），
  能量证据与提议似然组合为重要性权重（§4.8 组合律）；候选不自证，引擎是唯一 oracle。

### 4.4 analysis —— 分析插件

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

冻结的两个接口点：
- `inputs` / `outputs` 是**数据类型字符串数组**（如 `['energy-model']` → `['minimum-energy-path']`）；
- 谱系登记：分析结果同样落 append-only Trajectory（`type: 'analysis_complete'`）——
  分析产出与计算结果同为事实，与计算事件同一溯源链。

参考实现：`@saturday/plugin-neb`（NEB 最小能量路径与过渡态势垒；能量/梯度注入式，
内置 LJ 双阱玩具体系）与 `@saturday/plugin-eos`（Birch-Murnaghan 状态方程拟合；
显式 (V, E) 序列或按缩放体积静态单点自产，四参数联合辨识，
收敛 / rmse / r² 随结果与 Trajectory 交付）。分析结果不可自我认证：
势垒类产出需由独立逐点求值（或更高精度引擎）对账，对账由工作流层编排。

### 4.5 sampler —— 逆解插件（采样语义）

**职责**：给定目标约束（组分 / 性质 / 能量函数 / 参考结构），采样相容的候选结构。
本 seam 是生成式逆设计的唯一入口——Boltzmann 生成器、潜空间 normalizing flow、
晶体扩散模型等均挂载于此。**语义是采样而非求逆**：弛豫是多对一投影，原像本质非唯一；
sampler 交付的是与目标相容的候选分布。

```typescript
interface StructureSampler {
  /** 全局唯一：'boltzmann-generator' | 'latent-flow' | 'crystal-diffusion' … */
  readonly name: string
  readonly manifest: SamplerManifest
  /**
   * 采样与 target 相容的候选；模型不可用 / 目标超出覆盖范围抛
   * code === 'SAMPLER_UNAVAILABLE'；按判据产不出候选抛 'SAMPLE_NOT_FOUND'。
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
  reference?: string | Material      // 参考结构：微扰 / 插值邻域采样
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
- **似然声明可执行**：似然不可精确求值时声明 `'none'`；`invertible: false` 不得提供 `encode`；
- **遍历对账（oracle 条款）**：给定 `energyModel` 时，采样系综统计必须可与同一能量函数
  的 MD 时间平均对账（`workflow.ergodic`）；判定强度随似然声明分级——
  候选附精确 `logProb` 时升为重要性重加权均值对时间平均（ESS 占比作重叠度诊断）；
- **交付即谱系**：交付按 `ResolvedStructure` 兼容形态（§4.1）转换，`source` 以 `generative:`
  前缀写入谱系；不可变与 fork 语义继承 §6。

参考实现两个层级：微扰采样器（`@saturday/plugin-sampler-perturb`，`likelihood: 'none'`）
与 OU 采样器（`@saturday/plugin-sampler-ou`，闭式转移核 + 精确提议似然 `likelihood: 'exact'`，
逐候选附可独立重算的 `logProb`；OU 单峰定位为局部采样器，跨盆地探索由多锚点混合提案承担）。

#### 4.5.1 锚点库与混合提案（工具层）

锚点库（`createAnchorStore` 纯层 + `sampler.anchor.*` / `sampler.mixture` 工具）
属工具层编排，**不进 `StructureSampler` seam**：库存的是已验证结构的参考，
提案层复用既有采样实现，交付仍是 `SampledStructure` 形态。

- **入库**：谱系必填（无来源声明的数据不入库）；弛豫收敛且引擎交付终态时自动入库
  （谱系 `job:<jobId>#engine=<name>`）；未收敛不入库、无终态不入库、同谱系幂等；
- **检索**：拓扑硬门禁（节点数一致）+ 组分 L1 距离升序；组分不可考的锚点
  `distance: null` 排尾（不参与距离比较，但不被排除出混合）；空检索显式拒绝；
- **混合提案**：检索 / 内联锚点两路径共用同一条纯层目标构造；配额按最大余数法
  确定性分配（只依赖 (n, 归一权重)，与 seed 无关）；混合似然是相对全部锚点的
  高斯混合转移密度（闭式，`likelihood` 保持 `'exact'`）；谱系记所属锚点；
- **推导登记**：注入推导服务时登记提案推导（锚点来源归一化为 `material:<id>` / `job:<id>`，
  取谱系 # 前段）；锚点失效沿推导图传播到提案；不可追溯来源不冒充推导输入；未注入行为不变。

#### 4.5.2 锚点持久化（载荷形态）

落盘载荷形态 `saturday-anchor-store/2`（条目附 `entryVersion: 'saturday-anchor-entry/1'`）：

- **导出/导入**（`sampler.anchor.export` / `import`）：无损 JSON 全量条目（含 graph 本体）；
  导入复用库层门禁，同谱系幂等，单条拒绝不中断整批；
- **落盘/回填**（`sampler.anchor.save` / `load`）：路径由调用方显式声明；
  回填走与导入同款的共享循环（门禁不另开旁路）；文件缺失/损坏/非载荷形态显式报错；
- **完整性校验**：版本门禁（未知/缺失版本不接受）+ `size` 声明对账；
  条目级版本戳逐条校验——损坏定位到载荷原位索引拒绝，合法条目照常入库不连坐；
- **多载荷合并**：`path`（单载荷）或 `paths`（多载荷合并）二选一；门禁先行——
  全部文件先过完整性检查，全过才开始回填（任一不过即整批拒绝，库零污染）；
- **血缘声明**：回填交付附 `lineageRefs`（载荷内可追溯来源的归一化声明）——
  消费方可从磁盘数据起点发起失效传播，跨会话可撤回。

#### 4.5.3 数据治理：审计、修复与触发判据

围绕锚点数据质量的观测与治理工具链（观测面只读、修复面显式授权）：

- **血缘审计**（`sampler.anchor.audit`，只读）：逐文件三态声明——可追溯 /
  不可追溯 / 损坏；对不可追溯条目附 `repairHints`（原位索引 + 建议）；审计不回填不污染库；
- **容量观测**（`sampler.anchor.stats`，只读）：条目数 + 归一化谱系形态分布
  （`material:` / `job:` / 其他）+ 组分声明覆盖；
- **修复原语**（`sampler.anchor.repair`）：修复必须调用方逐条显式授权；
  写新载荷不碰原件（原件留作证据）；只修复不可追溯条目（损坏条目修复即伪造，拒；
  已可追溯条目无需修复，拒）；审计是修复的验收面；修复达标载荷回填后照常参与提案与推导
  （谱系用修复后来源）；
- **触发判据**（`trajectoryTriggerAssessment` 纯层）：容量观测读数对调用方显式声明的阈值
  （`minSize` / `minCompositionCoverage` / `minTrackableRatio`）做声明式对账——
  阈值不内置不设默认，未声明即拒；各维缺口独立呈报；判据是呈报不是门禁；
  对账结论可选登记为推导（证据引用失效则结论沿推导图失效，结论依据可撤回）；
- **判据快照**（`sampler.trigger.snapshot.save` / `load`）：对账结论整体原样落盘
  （版本戳 `saturday-trigger-snapshot/1`，读数/阈值/结论一并保留，落盘不改判）；
  快照可选携带推导引用（`triggerRef`，结论 ↔ 证据文件双向可追溯）；
  快照不是锚点条目——不进锚点库、不进数据燃料；跨会话回填逐字段一致（可复算）；
- **就绪度报告**（`trajectoryTriggerReadiness` 纯层）：触发条件基础设施各面
  （观测/判据/快照/修复/推导）由调用方逐项显式声明，报告如实汇总在场/缺口；呈报不是门禁。

### 4.6 derivation —— 推导登记簿（活性上下文）

**职责**：让材料上下文成为响应式谱系图——每个导出量声明推导来源，
上游失效沿推导图向下游传播，重算惰性且预算受控。
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
- **冻结语义**：`frozen` 推导失效时只追加修正记录（`corrections`）、状态不改、
  永不进入重算集；传播越过冻结节点继续向下游；
- **登记簿 append-only**：失效过的记录永不删除；重算以状态迁移 + `recomputedAt`
  时间戳追加表达，不改写历史；
- **失效源只有显式 `invalidate`**：不可变 fork（§6）不是失效源——`substitute`
  产生新对象，原结构及其推导不受影响，新结构要进入活性上下文须自行登记；
- **预算是资源承诺**：超预算显式抛 `BUDGET_EXCEEDED`；
- **重复失效幂等**：已失效节点不重复传播，不重复发事件；
- **引擎是推导输入**：排序类导出量 = f(基体, 引擎)，登记时引擎以 `engine:<id>` 入输入；
  势函数热替换（`PotentialRegistry.activate` 发 `saturday/potential/activated` 事件）
  即失效源，沿旧引擎 ref 传播到依赖它的全部导出量；工作流插件按需登记
  （`derivation` 可选注入，未挂载则行为不变）；
- 事件 `saturday/derivation/invalidated` 薄载荷：只放 `source` / `reason` /
  失效与修正的引用清单，不放推导记录本体。

错误码：`DERIVATION_NOT_FOUND`（查无）/ `INVALID_REF`（引用形非法）/ `BUDGET_EXCEEDED`（超预算）。

### 4.7 单位与能力指纹（异构引擎生态的泛化地基）

量纲分析的最小落点，三层门禁：

- **M1 注册门禁**：`PotentialRegistry.register` 即校验 `manifest.units`
  （energy/length/time 三元组，白名单外/维度错位显式拒绝）与 `manifest.fingerprint`
  （software/method 必填，version 不可得降级 `'unknown'`）；
- **M2 激活门禁**：`activate` 热切换事件载荷携带 `fingerprintChange`（{ same, reason }）
  差异声明——按维度归因（首个不同维即落）；失效传播照常沿 `engine:<id>` 走；
- **M3 能量组合门禁**：筛选层参考态升级为声明形态 `{ energyPerAtom, fingerprint?, energyUnit? }`
  ——声明了就对账：异源/异单位进凸包前显式拒绝；引擎自产参考态按定义同源，
  直接携带本引擎归一指纹（`referenceProvenance` 随交付呈现）。

配套机制：
- **显式换算**：单位换算只能由调用方显式发起（`unitConvert`），不自动进入能量比较路径；
  参考态 `convertedFrom` 审计通道声明换算来源（因子白名单机械重算可复现）；
- **实测态回读**：`stampFingerprint` 把 version 从 `'unknown'` 升级为探测实测值
  （各引擎探测路径按形态各异：ase 走 sidecar 握手、lammps 解析二进制横幅、mace 读 `__version__`）；
  version 维 `'unknown'` 通配——未探测不构成差异证据；
- **可用性预检**：`engine.availability` 逐引擎报告——注册 = 声明层，可用 = 运行时层；
  预检是查询不是变更（`stamp` 默认 false）。

### 4.8 证据组合律（多证据源联合排序）

`combineEvidence` 纯层：独立证据源的 log 权重相加，三条纪律强制——

1. **独立性声明必填**（缺失即拒 `EVIDENCE_INDEPENDENCE_UNDECLARED`）；
   证据源可选声明依赖变量词表（`variables`），机器审计三态
   （independent / degenerate / unverifiable）：检出的共享变量必须在声明文本中被解释；
2. **候选级证据掩码**：缺失即缺失，零填充禁止（log 权重 0 = 伪造中立证据）；
   全源缺失候选拒排（`EVIDENCE_NO_COVERAGE`）；
3. **log-sum-exp 归一**（整体偏移不变）+ 组合上限门禁 + 源名去重。

证据源是注册表化的：描述符 `{ name, requires, logWeights, independenceNote }`
（可选 `variables`），`evidenceSourceRegistry` 可注入自定义源，新源接入不改筛选代码。
内置源：能量（枚举/采样候选回算）、凸包距离（`hull`，包内点掩码 0）、
理想混合熵（`mixing-entropy`，逐候选组分先验 −Σ x·ln x）。

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

- `calculators`：后端可用性，消费方依此动态决定断言/降级策略；
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
  一切修改操作同语义。这是谱系可追溯与失效传播的基础；
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
- **回放确定性**：每个生产者维护独立 `seq` 单调序号，写入事件头；
  多订阅者回放按 `(producer, seq)` 归并；回放事件带 `saturday/replay/` 防回灌前缀；
- **冻结标记**：实验数据、已交付结果标记 `frozen: true`，失效传播（§8.2）
  对其只追加修正记录，不重算。

### 7.3 多分辨率视图（宿主提供，插件可消费）

原始事件全量保留（永不丢弃）；宿主在其上生成摘要层：
L1 段落摘要（收敛趋势/极值/异常）→ L2 任务摘要 → L3 研究摘要。

---

## 8. 兼容性与版本治理

### 8.1 版本语义

- 契约版本独立演进，语义化版本；
- **1.0 前（当前）**：一切接口标注 `experimental`，minor 升级允许破坏性变更，
  但每次变更必须：更新本文档 → 更新契约测试 → 在 CHANGELOG 声明迁移路径；
- 1.0 后：接口冻结，扩展走**新 seam**或**可选字段**，禁止修改既有字段语义。

### 8.2 演进方向

- 谱系驱动的失效传播与惰性重算（含重算预算控制）：已落地，见 §4.6；
- 活性上下文接真实工作流：已落地——`workflow.screen` 完成即登记推导
  （候选能量/筛选排序，引擎入输入），势函数热替换沿 `engine:<id>` 全链失效；
- 响应式协效应下沉：`getService` → 依赖声明 + 激活/去激活（演进中，不构成本版承诺）。

### 8.3 契约测试套件（@saturday/contract-tests）

兼容性由测试而非文档承诺。五条核心 seam 的标准断言集独立成包：
`structureResolverContract`（§4.1）、`potentialProviderContract`（§4.2 + §5.2，
能力枚举含 `md`：声明即承诺提供原语）、`workflowContract`（§4.3，另支持可选
`failWhen(material)` 断言供同构变体工作流选中失败变体）、`samplerContract`（§4.5）、
`derivationContract`（§4.6）。新插件在自己的测试文件里调用套件即完成接入。

当前基线：全仓 workspace 回归 335/335（19 包），另有摘要层脚本测试 7 项
（非 workspace，由回归脚本覆盖）；回归与摘要脚本强制包内串行
（`--test-concurrency=1`：并发各拉 sidecar + OpenBLAS 线程会内存竞态）。

发布形态：19 包 `files` 白名单（发布物只含实现与必要数据面，
测试/日志/临时产物不外泄，`scripts/pack-check.mjs` 机械核验）；
`repository` / `bugs` 元数据指向真实仓库（github.com/toki0413/dsh-saturday）；
本契约英文摘要版（`plugin-contract-v0.en.md`，权威文本以中文原本与本套件为准）。

---

## 附录 A：契约测试映射（基线）

| # | 契约条款 | 现有测试 |
|---|---|---|
| 1 | 服务注册即 effect，卸载全回收 | 测试 1、8 |
| 2 | formula-only 必须显式 resolver，来源写谱系 | 测试 2、4 |
| 3 | 多晶型排序与选择 | 测试 3 |
| 4 | autoRoute 画像评分 | 测试 5 |
| 5 | 长任务异步原语语义 | 测试 6 |
| 6 | 事件 → Trajectory 落盘 | 测试 7、11 |
| 7 | 能力握手驱动断言强度 | 测试 9 |
| 8 | 不可变 fork 与谱系 | 测试 10 |
| 9 | 逐变体事件与批量溯源 | 测试 11 |
| 10 | license 前置门禁：失败不污染状态、门禁可重入 | 测试 12 |
| 11 | 事件粒度声明：job 级显式拒绝细粒度监听 | 测试 13 |
| 12 | 载荷引用语义（无内联大对象） | 测试 14 |
| 13 | 工作流插件：缺服务显式报错 / 逐变体事件 / 不吞错 | plugin-screening 测试 1-4 |
| 14 | 结构源 seam 可互换：远端来源写谱系 | plugin-mp 测试 1-4 |
| 15 | 引擎插件：注册即 effect，卸载注销且激活指针重置 | plugin-lammps 测试 5、6 |
| 16 | 批处理引擎：缺二进制显式报 ENGINE_UNAVAILABLE | plugin-lammps 测试 3 |
| 17 | seam 标准断言集（§4.1/§4.2）：自检与跨插件复用 | contract-tests self.test（9 项，mp/lammps/mace/ase 已接入） |
| 18 | ML 势引擎：可用性预检，不可用显式报 ENGINE_UNAVAILABLE | plugin-mace 测试 1、2 |
| 19 | 跨引擎画像路由：validation 选高精度（mace），screening 选低成本（lammps） | plugin-mace 测试 5 |
| 20 | 插件自带数据面：计算器显式指定，缺失显式报错 | plugin-ase 测试 1-3（含真实 sidecar） |
| 21 | 时间维回放：从事件流重建索引；回放事件带防回灌前缀，不产生新轨迹 | plugin-replay 测试 1-5（含真实筛选对账） |
| 22 | sampler seam：采样语义强制声明 / 似然与可逆性声明 / 回算验证闭环 / 生成失败显式错 | plugin-sampler-perturb 测试 1-8（微扰采样器） |
| 23 | analysis seam 冻结点：输入/输出类型声明 + 谱系登记（分析结果落 Trajectory）；缺输入显式报错 | plugin-neb 测试 6-8（含真实挂载与卸载回收） |
| 24 | analysis seam 双数据路（显式序列 / 服务自产）+ 拟合质量声明（converged/rmse/r²）+ 服务依赖调用时解析 | plugin-eos 测试 1-8（含真实桥 Cu EOS 集成） |
| 25 | workflow seam 套件化：结果形状与排序 / 逐变体事件（薄载荷含引用）/ 不吞错 / 缺依赖显式报错 | `workflowContract`（套件自检 + plugin-screening 测试 5-8） |
| 26 | sampler seam 套件化：manifest 自洽（invertible⇔encode）/ generative: 谱系前缀 / 似然声明与实际一致 / 种子确定性 / 显式失败 / 候选可回算构造 Material | `samplerContract`（套件自检 mock-sampler + plugin-sampler-perturb 测试 1-4） |
| 27 | 采样 → 回算闭环：候选不自证，引擎是唯一 oracle；候选带 sampled-candidate 谱系标记；基线缺失时 dE 置 null | plugin-explore 测试 1-9（含排序非透传验证 + `workflowContract` 第三个接入者） |
| 28 | 遍历对账：采样系综平均 对 同一能量函数恒温 MD 时间平均；`md` 能力契约化；判定强度随似然声明三档分级 | plugin-ergodic 测试 1-14（纯层统计判定 + 升档解析对账 + 插件层挂载/缺服务显式错/非透传 + 真实 ASE sidecar Langevin MD 全链路） |
| 29 | 活性上下文地基：登记即声明推导来源 / 失效沿推导图向下游传递（幂等）/ 冻结只追加修正且传播不吞 / 查无显式错 / 惰性重算预算受控 + 拓扑序 / substitute fork 非失效源 | `derivationContract`（套件自检 mock-derivation + plugin-derivation 测试 1-14） |
| 30 | 活性上下文接真实工作流：筛选完成即登记两层推导（`engine:<id>` 入推导输入）；势函数热替换即失效源，全链失效 + 重算拓扑序；推导插件可选（未挂载优雅降级） | `derivationContract` 引擎条款 + bridge live-context 测试 1-4 |
| 31 | 能量零点显式化：数据面 `reference_energy` 算子 + 纯层严格形成焓/二元凸包；筛选接严格形成焓 + `energyAboveHull` 凸包判据，`thermo.level` 声明精度等级 | core thermo 测试 1-8 + python-bridge 参考态 4-5 + bridge thermo 测试 1-4 |
| 32 | OU 参考结构采样：闭式转移核 + 精确提议似然（`likelihood: 'exact'`）；交付边界：exact 指提议核自身（非玻尔兹曼分布）、单峰局部采样器定位、γΔ 有效性窗口门禁 | plugin-sampler-ou 测试 1-13（契约 5 + 似然自洽独立重算 + 平稳幅度闭式统计验证 + 均值回归语义 + 插件层挂载/缺依赖/全流程/确定性） |
| 33 | 遍历对账升档：接精确似然采样器后判据升为重要性重加权（log w = −βU − log q，log-sum-exp 归一）均值对时间平均；ESS 占比作重叠度诊断；解析对账体系不依赖数值巧合 | plugin-ergodic 测试 4/4a-4c/6/7b（三档判定 + 重加权纯层 + checkErgodic 解析引擎全流程 + 工具层升档） |
| 34 | 构型自由能：温度网格逐点恒温 MD 得 ⟨U⟩(β)，沿 β 热力学积分出曲线（d(βF_conf)/dβ = ⟨U⟩）；锚点必须显式注入（缺锚点 `THERMO_REFERENCE_MISSING`）；逐点附统计标准误；解析对账双核（线性核梯形闭式 + 谐波核截断收敛）；曲线型工作流不接 `workflowContract`（形态不适配） | plugin-free-energy 测试 1-9（锚点门禁 + 双核解析对账 + 统计不确定性如实呈报 + 挂载/缺服务/全流程/真实 ASE 冒烟） |
| 35 | 多组分凸包：成分空间维度 d = 元素数−1，显式穷举 d-单形构造下包络 + 重心坐标插值；二元退化形态与既有实现数值一致；端点纪律（缺纯元素端点不外推）；组合上限显式门禁；包络单形只用包上点构造 | core thermo 测试 9-14（二元退化对账 + 三元四边形 + 重心闭式 + 端点纪律 + 门禁） |
| 36 | 摘要层（可再生产物）：实跑全部包测试 + 扫描 package.json + 提取附录 A 实证表 → 机械汇编 `SUMMARY.md`/`SUMMARY.json`；计数对账门禁；无独立测试的包标记不计数；失败用例显式标记；子进程不继承 `NODE_TEST_*` 环境 | scripts/summary 测试 1-7（TAP 解析 + 附录 A 表解析 + 组装门禁/确定性 + 真实小包冒烟） |
| 37 | 多组分凸包接真实工作流 + 自由能全链路 + 分析事件溯源：元素数 ≥ 3 自动升级统一成分空间凸包（元素参考态是端点——形成焓按定义 = 0），`thermo.mode/hullDimension` 声明形态；≤2 元素保持二元路径；自由能曲线物理一致（⟨U⟩ 随温单调升、ΔF 单调降）；分析事件 `analysis_complete` 与计算事件同一溯源链 | plugin-screening 测试 5-6（三元升级闭式对账 + 二元路径保持）+ bridge thermo 测试 3（真实 EMT 多组分）+ demo:freeenergy 全流程验证 |
| 38 | 三元混掺真实筛选：五元素统一成分空间（d=4），真实 EMT 弛豫 + 全元素参考态显式计算；负形成焓候选成为稳定相顶点；单点掺杂候选位于端点连线上（包络由 0-0 弦主导，非退化判据需共掺内点，见第 39 条） | demo:screening-ternary 全流程验证（真实 EMT，0.2 s） |
| 39 | 多浓度 + 共掺候选：`maxDopedSites` 浓度扫描（越界显式报错：全取代 = 纯掺杂端点属参考态）+ `codopants` 共掺变体（元素重复/位点冲突/单元素显式报错）；二元分支泛化为逐掺杂系多内点构包；非退化判据闭式对账（共掺候选由单形包含，包络插值 −4/75，距离 7/75） | plugin-screening 测试 7-10（多浓度闭式 + 越界报错 + 共掺闭式 + 参数校验）+ demo:concentrations 全流程 |
| 40 | 谐波锚点物理化：sidecar `harmonic` 算子（弛豫→中心差分 Hessian→质量加权简正模；平动零模与真虚频分开计数，都不静默修正）；量子谐振子闭式在 JS 纯层（单一闭式来源）；`anchorMode='harmonic'` 接线；LJ 谱形对账（横模 6 重/纵模 3 重简并 + ν_L/ν_T ≈ √2） | plugin-free-energy 测试 10-12（纯层闭式 + 接线纪律 + 全流程对账）+ plugin-ase 测试 6（真实 sidecar 谱形）+ demo:freeenergy 谐波锚点形态（EMT Cu） |
| 41 | 证据组合律纯层 + 联合排序接线：`combineEvidence` 独立证据源 log 权重相加（独立性声明必填）；候选级证据掩码（缺失即缺失，零填充禁止，全源缺失拒排）；log-sum-exp 归一 + 组合爆炸门禁 + 源名去重；筛选接 `sampled`+`temperatureK`：采样候选逐候选单点回算，能量证据 −βU × 提议似然 → 重要性权重，`sampledJoint` 段附逐候选覆盖/独立性/ESS 诊断；闭式对账：双源权重 2e/(1+2e) | plugin-screening evidence 测试 1-8（组合律闭式 + 五条拒绝路径 + ESS）+ screening 测试 11-14（联合排序闭式 + 掩码 + 门禁 + 工具层解析） |
| 42 | 采样器 → 筛选接线：候选来自系综而非枚举——`workflow.screen` 接受 SampledStructure 透传（纯层 graph 模态构造 + 谱系登记采样来源；缺结构显式报错）；候选真实单点回算 → 联合权重归一 + 双源覆盖 + ESS 诊断；缺似然候选保留并标 null 掩码；logProb 可由位移闭式独立重算（1e-9） | bridge sampled-screen 测试 1-3（真 OU + 真 EMT 完整工具链 + 混合覆盖 + 双门禁） |
| 43 | 组合律可扩展性（第三证据源）：`evidenceSources: ['hull']`——凸包距离作逐候选稳定性证据（−β·max(0,energyAboveHull)，包内点掩码 0），双源叠加把包外候选罚分翻倍（闭式 e⁻² 对账）；独立性声明如实呈报退化关联；无参考态即无凸包即无稳定性证据；温差声明：采样器声明温度与目标不一致时 `temperatureMismatch` 随交付呈现 | plugin-screening 测试 15-17（闭式对账 + 三门禁 + 温差三态） |
| 44 | Agent 编排链覆盖采样→联合排序：工具调用携带采样交付 {graph, source, logProb} → 逐候选真实单点回算 + 联合权重归一（谱系在编排层不断）；dsh 工具出口纪律：工作流插件需自行动态 import `defineTool`、`output.render` 必填、object 型 `items` 必须显式 `additionalProperties` | demo:agent 阶段 C 全流程（真实 EMT） |
| 45 | 证据源注册表化：`evidenceSources` 描述符注册表（{ name, requires, logWeights, independenceNote } 四要素）；筛选层只做通用循环，新源在 evidence-sources.mjs 注册即可接入；`evidenceSourceRegistry` 可注入（第三方自定义源全链路参与组合律），未知源仍显式拒绝 | plugin-screening 测试 18（解析三态 + 描述符闭式 + 自定义源全链路注入） |
| 46 | 采样温度标定与声明：闭式 u_eq = √(k_B·T/k_eff)（能量均分语义；力常数必须显式注入）；`sampler.ou` 接受显式 `temperatureK` 声明（声明不改采样行为，随交付 `samplerTemperatureK` 并进谱系）；声明前后采样序列与似然逐位一致 | plugin-sampler-ou 测试 14-15（标定闭式 + 五门禁 + 声明不改行为） |
| 47 | 多锚点混合采样：跨盆地探索 = 多参考加权混合（`ouSampleMixture`）。混合提案是有限高斯混合，转移密度闭式（log Σ π_a N_a，log-sum-exp 数值稳定）→ 似然保持 'exact'；交付 logProb 是相对全部锚点的混合似然（可独立重算 1e-9）；配额按最大余数法确定性分配；谱系记所属锚点（#mixture#anchor=k）；同拓扑门禁；单锚点退化形态与单核采样逐坐标一致 | plugin-sampler-ou 测试 16-17（一维双锚点闭式对账 + 配额/似然自洽/谱系/四门禁） |
| 48 | 单位与能力指纹：注册即校验 `manifest.units` 三元组与 `manifest.fingerprint`（version 不可得降级 'unknown'）；换算只能由调用方显式发起（`unitConvert`）；参考态升级形态声明即对账——异源/异单位进凸包前显式拒绝，纯数值形态降级，`referenceProvenance` 与 `providerFingerprint/providerUnits` 随交付呈现 | core units.test 8 项 + potential.test 3 项（注册自检）、契约套件 §4.2 断言（四引擎 + 自检全绿）、plugin-screening 测试 19（同源/异源/异单位/降级/空壳五态） |
| 49 | 激活门禁：`activate` 热切换事件载荷携带 `fingerprintChange`（{ same, reason }）——按维度归因（首个不同维即落）；首次激活无前驱 → same=true | packages/core potential.test 测试 4（同源/异 software/异 method 三态） |
| 50 | 跨引擎对照：同一候选链经两个指纹不同的引擎回算——交付自带能量来源可追溯性；异源参考态混入凸包前显式拦截；热切换携带指纹差异声明；双引擎交付并排（跨引擎比较须调用方显式声明换算与可比性假设） | demo:cross-engine 四段全流程（真实运行，packages/bridge/demo-cross-engine.mjs） |
| 51 | 工具层自产参考态声明形态：引擎 `referenceEnergy` 显式产出的参考态按定义同源——直接升级为声明形态（携带本引擎归一指纹与能量单位），凸包能量全链同源可比；`referenceProvenance='declared'` 与指纹投影随交付呈现；引擎未声明指纹时降级不投影 | plugin-screening 测试 21（provenance 声明态 + 指纹投影断言） |
| 52 | 单位换算审计通道：参考态 `convertedFrom` 声明原值单位与显式换算——声明不改消费、不绕过单位门禁，换算因子由白名单机械重算随交付呈现；未知单位/跨维度声明即拒 | plugin-screening 测试 20（因子闭式对账 + 声明不改消费 + 不绕过门禁三态） |
| 53 | 指纹实测态回读：`stampFingerprint` 把归一指纹 version 从 'unknown' 升级为探测实测值（只丰富 version；非实测值/空值/再盖 unknown 均拒，探测失败方不盖章）；三引擎探测路径按形态各异（ase 走 sidecar 握手、lammps 解析二进制横幅、mace 读 `__version__`）；version 维 unknown 通配（未探测不构成差异证据） | core units.test 9（通配三态）+ potential.test 5（盖章三态）；ase/lammps/mace 各自探测测试（隔离测试替身） |
| 54 | 可用性预检：对四引擎逐一探测 + 实测态回读——注册 = 声明层（不可用不移除注册），可用 = 运行时层（使用时 ENGINE_UNAVAILABLE 拦）；同一份代码在不同环境给出不同的报告（环境依赖的报告即预检的意义） | demo:availability 四引擎三态全流程（真实运行，packages/bridge/demo-availability.mjs） |
| 55 | 多锚点混合采样演示：双锚点按 [0.6,0.4] 配额采样（锚点归属随谱系 #anchor=k）；混合似然逐一独立重算（相对全部锚点，最大偏差 0：'exact' 声明机械可验）；回算闭环（候选经真实 ASE EMT 单点作为唯一 oracle 裁定，生成 → 回算 → 核对谱系不断） | demo:mixture-sampling 全流程（真实 EMT 回算，packages/bridge/demo-mixture-sampling.mjs） |
| 56 | 证据源注册表第二内置源：理想混合熵 `mixing-entropy`——逐候选组分先验，log w = ΔS_mix/k_B = −Σ x·ln x（每点位，与 β 无关）；纯元素候选按定义 0；独立性声明如实呈报与凸包共享组分变量的退化关联；接入不改筛选代码；全链路闭式（焓 [0,+1,−1] + 熵 [0, S1, S1]，S1 = 0.5623351446188083 闭式解析） | plugin-screening 测试 22（每点位熵闭式 + 双源相加闭式 + 独立性声明） |
| 57 | 证据源独立性的机器校验：可选第五要素 `variables`（依赖变量词表）；`auditEvidenceIndependence` 三态（independent / degenerate / unverifiable）；机械检出的共享变量必须在 `independence` 声明文本中被解释，否则 `EVIDENCE_INDEPENDENCE_UNDECLARED`；`maskCounts` 随交付呈现；内置源全部携带变量声明 | plugin-screening evidence 测试 9-11（三态审计 + 门禁拒绝 + 掩码计数）+ screening 测试 23（双源全链路退化关联闭环） |
| 58 | 可用性预检工具化：`engine.availability` 逐引擎报告——有 `probeVersion` 则探测（失败 → `unknown-or-missing`，注册表不因探测失败缩减）；`stamp` 默认 false（查询性工具不携带副作用默认值）；仅 `stamp=true` 且 version 实测才走 `stampFingerprint` | bridge availability 测试 1-2（默认只报告不盖章 + 按需盖章三态） |
| 59 | 混合提案锚点库：`createAnchorStore` 纯层——`add` 谱系必填；`retrieve` 拓扑硬门禁 + 组分分数向量 L1 距离升序（缺组分 → `distance: null` 排尾；平手按入库序，确定性）；`toMixtureTarget` 空检索 `ANCHOR_EMPTY` 拒绝、`weights` 长度必须一致 | plugin-sampler-ou anchor-store 测试 1-5（入库门禁 + 检索排序三态 + 全链路接 `ouSampleMixture` 配额闭环） |
| 60 | 锚点工具化：`sampler.anchor.add`（材料入库来源声明缺省 = 材料身份，组分从原子序机械提取；直交付无谱系即拒）与 `sampler.mixture`（会话库检索 / 内联锚点二路径 → 配额 → OU 混合提案；`anchorOrigin` 声明来源层；空库拒绝伪造，两路径共用同一条纯层目标构造——门禁不另开旁路）；会话级内存库与闭环运行同生命周期 | plugin-sampler-ou plugin-anchor-tools 测试 1-3（谱系门禁工具层生效 + 内联配额/似然/确定性 + 会话库拓扑门禁/空库拒伪造/检索排序闭式对账） |
| 61 | 锚点引导闭环全链路 + 工具链形态：锚点入库 → 会话库检索（cu3ag L1 距离 0、cu4 距离 0.5）→ 配额 [5,3]（0.6/0.4×8 最大余数法）→ 混合提案 → 工具间只传交付接 `workflow.screen` 联合排序：8 候选真实 EMT 回算，双源证据 × 组合、Σw = 1；候选 `generative:` 前缀 + 可回算构造 Material；`workflow.screen` 不直收锚点本体（两步编排即组合律） | demo:anchor-guided 全流程 + plugin-sampler-ou plugin-anchor-tools 测试 4（形态延续：前缀纪律 + 可回算构造） |
| 62 | 闭环轨迹自动入库：弛豫收敛 + 引擎交付终态 → 弛豫后结构自动入会话锚点库（谱系 `job:<id>#engine=<name>`，能量随锚点记录，组分从终态原子序机械提取）；三道门禁：未收敛不入库、无终态交付不入库、同谱系重复事件幂等；引擎 `relax` 交付协议扩展 `positions`/`cell`（旧版按字段存在性缺省）；薄事件纪律：结构体不重复落 Trajectory | bridge anchor-autoingest 测试 1-3（自动入库谱系/组分/幂等 + 未收敛门禁 + 旧协议门禁，引擎测试替身验证） |
| 63 | 锚点工具 Agent 层暴露 + 配额闭式对账：`sampler.anchor.add`/`sampler.mixture` 经 dsh harness 暴露（工具出口无损 JSON 关卡）；自动入库后会话库命中双锚点 → 混合提案来源层 `session-store`；最大余数法配额：只依赖 (n, 归一权重) 与 seed 无关；余数按小数降序补一、平手取靠前锚点（[0.5,0.5]×5 → [3,2]、[1,1,1]×10 → [4,3,3]）；未归一与归一形态同配额 | demo:agent 阶段 D 全流程 + plugin-sampler-ou plugin-mixture-quota 测试 1-4（配额闭式 + 平手确定性 + 归一不变 + seed 无关扫描） |
| 64 | 全自动锚点引导闭环 + 不可考组分降级链：无人工入库形态——真实弛豫（收敛 + 终态交付）→ 自动入库 → 检索（距离 0/0.5）→ 配额 [5,3] → 提案 → 回算 + 联合排序（Σw = 1，谱系不断）；组分不可考（`distance: null`）排尾但不排除（均匀配额参与混合）；会话锚点库不引入淘汰/上限（库与闭环同生命周期，`topK` 已是提案侧参与上限） | demo:anchor-auto 全流程 + plugin-sampler-ou plugin-null-distance 测试 1-2（纯层排尾 + 目标构造照常；工具层距离透传 + 配额参与实证） |
| 65 | 提案谱系接推导登记簿 + 三元系可扩展性 + 持久化锚点库原型：`sampler.mixture` 注入推导服务时登记提案推导（锚点来源归一化 `material:<id>`/`job:<id>`，取谱系 # 前段），锚点失效沿推导图传播到提案，不可追溯来源不冒充输入，未注入行为不变；三元系 {Cu,Ag,Au} 全链路：检索排序/配额闭式 [0.5,0.3,0.2]×9 → [4,3,2]（多 seed 不变）/确定性复现；`sampler.anchor.export`/`import`（无损 JSON 全量导出 + 库层门禁复用 + 同谱系幂等 + 单条拒绝不中断整批），回填锚点即刻可参与混合提案 | plugin-sampler-ou plugin-mixture-derivation 测试 1-4（登记 + 失效传播 + 不伪登记 + 未注入不变）+ plugin-ternary 测试 1-3（检索排序 + 配额闭式 + 确定性）+ plugin-anchor-persist 测试 1-3（往返无损 + 幂等 + 门禁） |
| 66 | 持久化落盘侧 + 排序层提案引用全链活性 + 持久化原语 Agent 层暴露：`sampler.anchor.save`/`load`——落盘→跨会话回填逐字段一致且即刻可提案；文件缺失/损坏/非载荷形态显式报错（`ANCHOR_PERSIST`）；路径调用方显式声明；同库重载同谱系幂等；导入走共享循环（门禁不另开旁路）；`save`/`load` 经 dsh harness 暴露（含全量 graph 的无损 JSON 出口关卡 + 落盘→回填→跳过重放幂等）；`workflow.screen` 直收 `proposalRef` 登记为排序层推导输入——锚点失效 → 提案失效 → 排序失效三级链全活性；非法引用登记簿显式拒绝 | plugin-sampler-ou plugin-anchor-save-load 测试 1-3（往返 + 错误路径 + 幂等门禁）+ demo:agent 阶段 E 全流程 + bridge proposal-chain 测试 1-3（三级传播 + 未声明不变 + 非法引用拒绝） |
| 67 | 跨会话恢复全链路 + 回填后活性保持：会话一真实弛豫 → 自动入库 → `save` 落盘（路径调用方显式声明）→ 会话终结全部回收；会话二全新挂载空库回填 → 检索（谱系跨会话保留）→ 提案 → 回算 + 联合排序（Σw = 1）；行为级无损：落盘往返不改变任何采样行为（同参数逐候选结构/似然/归属/谱系严格一致）；两“会话”是同一进程内两次独立挂载，跨会话唯一通道是磁盘载荷；回填锚点照常登记提案推导，锚点失效沿推导图传播到提案、再传播到排序（全链活性跨会话不降级） | demo:anchor-resume 全流程 + bridge anchor-resume 测试 1-2（跨会话闭环参与 + 行为级无损对账）+ bridge anchor-resume-liveness 测试 1-2（全链活性跨会话不降级 + 谱系登记如实） |
| 68 | 恢复闭环接 Agent 层 + 落盘侧谱系声明 + 落盘载荷完整性校验：回填锚点即刻参与提案（来源层/谱系跨恢复保留），`lineageRefs` 随交付呈现；`load` 交付附 `lineageRefs`（可追溯来源的归一化声明）——沿声明起点 invalidate，提案推导如实失效（跨会话可撤回）；完整性：版本门禁（仅 `saturday-anchor-store/1`，未知/缺失不接受）+ `size` 声明对账；单条损坏不连坐（共享导入循环逐条拒绝，合法条目照常入库） | demo:agent 阶段 F 全流程 + bridge anchor-lineage-refs 测试 1-2（声明与载荷一致 + 沿声明起点失效传播实证）+ plugin-sampler-ou plugin-anchor-save-load 测试 4-5（版本/无版本/size 三态拒绝 + 单条损坏不连坐） |
| 69 | 条目级版本戳 + 多载荷合并回填 + 载荷血缘审计：载荷形态 `saturday-anchor-store/2`（条目附 `entryVersion: 'saturday-anchor-entry/1'`）——`load` 逐条校验版本戳：缺失/未知版本戳按条目级损坏定位到原位索引拒绝，合法条目照常入库不连坐；`load`/`audit` 支持 `path`（单载荷）或 `paths`（多载荷合并）二选一；门禁先行——全部文件先过完整性检查，全过才开始回填（任一不过 → 整批拒绝，库零污染）；同谱系幂等兜底跨载荷重复；`sampler.anchor.audit` 只读血缘三态审计（可追溯/不可追溯/损坏），审计不回填不污染库，异常文件入报告不连坐 | plugin-sampler-ou plugin-anchor-save-load 测试 6-8（条目版本戳定位 + 多载荷合并/门禁先行/二选一门禁 + 审计三态与库零污染）+ plugin-anchor-persist 测试 1（版本戳随导出交付） |
| 70 | 审计接 Agent 层 + 合并回填后的活性保持 + 锚点库容量观测：只读三态报告回流，库状态不变（观测先于行动）；两份不同来源载荷合并回填后谱系各自独立可撤回（沿某一来源失效 → 提案失效；失效不删数据）；合并后提案锚点归属与载荷谱系逐条一致；`sampler.anchor.stats` 只读库内容量观测（条目数 + 归一化谱系形态分布 + 组分声明覆盖），观测不变更库 | demo:agent 阶段 G 全流程 + bridge anchor-merge-liveness 测试 1-2（谱系独立可撤回 + 归属逐条一致）+ plugin-sampler-ou plugin-anchor-save-load 测试 9（库容量观测如实与不变更） |
| 71 | 审计驱动的合流回填决策链 + “足够轨迹”触发判据 + 审计修复建议通道：按审计报告只回填达标载荷；`trajectoryTriggerAssessment` 纯层判据：读数对调用方显式声明的阈值（`minSize`/`minCompositionCoverage`）为声明式对账不是门禁，阈值不硬编码不设默认（未声明即拒），各维缺口独立呈报，空库覆盖率为 0；审计对非可追溯条目随报告交付修复声明（`repairHints`：原位索引 + 三态 + 建议），损坏与不可追溯区分，保持只读不代改 | demo:agent 阶段 H 全流程 + plugin-sampler-ou plugin-anchor-trigger 测试 1-3（达标/缺口独立呈报/未声明阈值拒绝 + 空库）+ plugin-anchor-save-load 测试 8 扩展（修复建议定位与可操作）与测试 10（统计读数直喂判据） |
| 72 | 判据快照 + 载荷侧修复原语 + 判据对账谱系化：`stats` 读数 → 判据对账 → 判据快照（读数 → 阈值 → 结论可追溯可复算，阈值调用方显式声明）；`sampler.anchor.repair`：审计只指明出路，修复必须调用方逐条显式授权，写新载荷不碰原件，只修复不可追溯条目（损坏修复即伪造必拒，已可追溯修复亦拒），修复全程不回填，审计是修复的验收面；判据对账结论可选登记为推导（输入 = 可追溯证据引用），证据引用失效 → 对账结论沿推导图如实失效（结论依据可撤回），无可追溯证据引用不伪登记 | demo:anchor-resume 收尾判据快照 + plugin-sampler-ou plugin-anchor-save-load 测试 11-12（修复原语正路 + 四类门禁拒绝）+ bridge anchor-trigger-derivation 测试 1-2（结论可撤回 + 不伪登记与零依赖） |
| 73 | 修复链接 Agent 层 + 判据快照落盘/回填原语 + 判据谱系质量维：修复逐条显式授权、写新载荷不碰原件，重新审计验收（修复后载荷全可追溯、原件保持原状：审计是修复的验收面）；`sampler.trigger.snapshot.save`/`load`：对账结论整体原样落盘（落盘不改判）→ 回填只读校验版本戳（`saturday-trigger-snapshot/1`）与形态后原样交付；快照不进锚点库、不进数据燃料；可选阈值 `minTrackableRatio`（可追溯占比）由调用方显式声明，声明后读数缺谱系分布维显式拒绝，质量维缺口与数量/覆盖维独立呈报 | demo:agent 阶段 I 全流程 + plugin-sampler-ou plugin-anchor-save-load 测试 13（快照落盘/回填原样 + 三道门禁拒绝 + 不进锚点库）+ plugin-anchor-trigger 测试 4（质量维对账如实与门禁） |
| 74 | 判据快照跨会话续供 + 修复后载荷活性闭环 + 质量维观测对账：判据快照落盘 → 全新挂载回填续供对账逐字段一致（可复算不重新估算），快照不进锚点库（证据载荷与结构数据燃料正交）；不可追溯载荷经修复 + 审计验收后回填：提案照常登记推导（谱系用修复后的来源不冒充原件），沿修复后谱系失效 → 提案如实失效（可追溯即意味着可撤回），失效不删数据；判据回呈的可追溯占比 = 库内逐条谱系计数（不重新估算），观测读数变化 → 对账结论如实翻转，观测/判据全程不变更库 | demo:anchor-resume 会话三续供对账 + bridge anchor-repair-liveness 测试 1-2（修复达标数据成燃料 + 归属如实不冒充原件）+ plugin-sampler-ou plugin-anchor-save-load 测试 14（观测→判据不断链与结论随读数翻转） |
| 75 | 修复四环接 Agent 层 + 判据证据链接线 + 触发条件就绪度报告：验收达标后回填修复后载荷——修复达标数据即刻成为数据燃料（谱系用修复后来源不冒充原件），不可追溯原件全程不入库——观测→修复→验收→入库四环在 Agent 层全链接；快照可选携带推导引用（`triggerRef`）：声明即原样随快照落盘/回填，回填后沿引用可查活性、证据失效沿引用如实传播（结论 ↔ 证据文件双向可追溯），未声明不伪造；`trajectoryTriggerReadiness` 纯层：触发条件基础设施五面（观测/判据/快照/修复/推导）由调用方逐项显式声明，报告如实汇总在场/缺口——呈报不是门禁 | demo:agent 阶段 J 全流程 + bridge anchor-trigger-derivation 测试 3（快照携带推导引用：双向可追溯与失效传播 + 不伪造）+ plugin-sampler-ou plugin-anchor-trigger 测试 5（就绪度报告如实与拒伪造） |
| 76 | 可靠性验证：故障注入 + 性能基线 + 发布形态核验——截断载荷（中断写/断电模拟）→ 回填拒绝且库零污染；截断判据快照 → 回填拒绝；多载荷合并一好一坏 → 整批拒绝（门禁先行）；对照面完好载荷照常回填；千级规模量级读数如实呈报（入库 2000 锚点/检索/混合提案/落盘回填往返）——读数即事实不设阈值不做门禁；`scripts/pack-check.mjs` 逐包 `npm pack --dry-run` 干跑：版本一致性 + files 白名单核验 + 清单如实呈报，违规非零退出，不产生 .tgz 不触网 | plugin-sampler-ou failure-drill 测试 1-3（截断拒绝 + 库零污染 + 门禁先行）+ perf-baseline 测试 1-2（纯层/往返量级读数如实）+ scripts/pack-check 实跑（19 包全过） |
| 77 | 零依赖引擎插件入生态：契约套件全真跑 + 闭式对账——manifest/M1 注册门禁/路由激活/指纹声明经 potentialProviderContract 套件在任何环境全量真实执行（零依赖引擎无 skip 路径）；闭式对账：力 = 能量负梯度（数值有限差分）、Langevin 恒温 MD 能量均分对账 ⟨K⟩ = 3/2 kT、谐振子配分函数闭式一致性（纯谐波势上）；谐波原语零模/虚频如实计数不静默修正；玩具势性质声明在先（LJ 为教学档精度；参考态为本引擎自洽参考，非实验值） | plugin-lj lj 测试 1-15（契约套件全真跑 + 闭式对账 + 插件形态） |
| 78 | 数据面优雅回退（开箱即用核心机关）：Python 缺失时显式注册零依赖纯 JS 引擎 lj-js 切换数据面（非静默降级：指纹 lj-js 独立，能量进组合路径前照常过 M1 门禁），横幅如实报告数据面形态与升级路径；回退后 material.load → potential.relax 工具链完整可用（交付引擎指纹如实）；Python 可用时数据面保持 emt-mock 不变（零漂移回归守护）；store.saturday.dataPlane 如实声明当前数据面形态 | bridge fallback-lj 测试 1-4（回退注册 + 工具链可用 + 横幅如实 + Python 在场不漂移） |


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
