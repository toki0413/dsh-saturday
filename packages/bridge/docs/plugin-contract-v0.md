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
套件自检 24 项 + bridge 32 项 + core 28 项 + 十一个插件各自套件 + 其余插件各自契约测试，
全仓 workspace 272/272；另有摘要层脚本测试 7 项（非 workspace，由回归脚本覆盖）；回归脚本与摘要脚本均强制包内串行（--test-concurrency=1：并发各拉 sidecar + OpenBLAS 线程内存竞态实证）。发布形态（⑧）：MIT LICENSE 落盘（19 包 license 声明自此有文档实体）+ 本契约英文摘要版（`plugin-contract-v0.en.md`，忠实摘要而非有损全译，权威文本以中文原本与本套件为准——文档交付无测试映射故不入附录 A）。映射见附录 A。

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
