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

**职责**：实现 `relax` / `calculate` 原语，并以 manifest 声明能力供路由。

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
    type: 'relax' | 'calculate'
    accuracy: number          // 0-1，越大越准
    speed: number             // 0-1，越大越快（修订 #7：统一"越大越好"）
    cost: number              // 0-1，越大越贵
    maxAtoms?: number
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
```

**规则**：
- **结果不可变**：返回后即为事实，进入谱系与 Trajectory，不得就地修改；
- **幂等**：相同 `material.graph + params` 应产生相同结果（允许经缓存命中）；
- **路由契约**：路由权在 `PotentialRegistry`（autoRoute 按任务画像评分），
  Provider 不得自行挑选替身；显式 `engine` 指定优先于路由；
- **长任务**：`relax`/`calculate` 是异步原语，Promise 在计算完成时 settle；
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
}): Promise<{
  ranked: ScreenEntry[]       // 按 energyPerAtom 升序，全部含谱系引用
  failed: { label: string, kind: string, error: string }[]
  note: string
}>
```

**规则**：
- **逐变体事件**：批量任务的每个变体发独立事件 → 各自落 Trajectory（可逐条溯源）；
- **不得吞错**：单变体失败计入 `failed`，不中断整体；整体性错误才抛出；
- 工作流暴露为工具时，工具层负责 schema 与描述，编排逻辑保持在纯函数中。

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

### 4.5 sampler —— 逆解插件（采样语义；条款冻结，签名待首个实现实证）

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
  reference?: string                 // 参考结构 materialId：微扰 / 插值邻域采样
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

### 8.2 演进方向（不构成本版承诺）

- 响应式协效应下沉：`getService` → 依赖声明 + 激活/去激活（活性上下文的地基）；
- 谱系驱动的失效传播与惰性重算（含重算预算控制）。

### 8.3 契约测试套件（@saturday/contract-tests）

兼容性由测试而非文档承诺。两条核心 seam 的标准断言集已独立成包：
`structureResolverContract`（§4.1：候选形状 / 多晶型排序 / 查无显式错 / 幂等）与
`potentialProviderContract`（§4.2 + §5.2：manifest 形状 / 粒度门禁 / 结果形状 /
幂等 / 显式失败）；新插件在自己的测试文件里调用套件即完成接入（当前基线：
套件自检 9 项 + bridge 14 项 + 六个插件各自套件，全仓 71/71）。映射见附录 A。
sampler seam（§4.5）条款已冻结，`samplerContract` 待首个实现落地后进入套件。

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
| 22 | sampler seam（§4.5）：采样语义强制声明 / 似然与可逆性诚实声明 / 回算验证闭环 / 生成失败显式错 | 待首个 sampler 插件实证（先在 LJ/EMT 小体系对账 MD；`samplerContract` 同期进套件） |
| 23 | analysis seam（§4.4）两个冻结点：输入/输出类型声明 + 谱系登记（分析结果落 Trajectory）；缺输入显式报错不静默 | plugin-neb 测试 6-8（含真实挂载与卸载回收） |

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
