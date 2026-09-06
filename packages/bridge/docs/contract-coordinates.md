# 契约坐标化声明（Contract Coordinates）

**Status:** 声明层产物，不改变任何运行时行为
**坐标命名空间:** `saturday.contract/v0`
**机器可读声明:** [`contract-coordinates.json`](./contract-coordinates.json)
**权威文本:** [plugin-contract-v0.md](./plugin-contract-v0.md)（本文件与其冲突时以契约为准）

## 1. 动机与边界

dsh 生态正在形成以坐标（`apiVersion + kind`）标识契约的互操作共识
（[T-Auto/dsh-ecosystem-spec](https://github.com/T-Auto/dsh-ecosystem-spec)，
Community Consensus v0.15 基线）。Saturday 的六个 seam 本身就是显式契约，
坐标化只是把它们按该共识的坐标格式发布出去，让生态里其他参与者可以
**引用** Saturday 的能力面，而不必运行或了解 Saturday 的实现。

坐标化的边界与三纪律同样适用：

- **坐标化 ≠ 准入申报。** 本声明不把 Saturday 提交进 dsh-TUI 插件目录，
  也不承诺对齐 dsh-std 的 manifest 生命周期。申报与否是独立的产品决策，
  门前条件见 §4 自检。
- **不引入 dsh-std 依赖。** 坐标只是格式约定；Saturday 插件的依赖卫生
  纪律（仅依赖 `@toki0413/kernel`，禁止 import cordis/dsh）不变。
  引入 `@dsh-std/*` 运行时依赖需另行评估，本声明不构成该承诺。
- **权威文本仍在契约文档。** 坐标条目的语义以契约文档对应章节与
  契约测试套件为准；坐标是索引，不是第二套规范。

## 2. 坐标格式

坐标沿用 dsh-std 惯例（`apiVersion + kind`），`evidenceLevel` 枚举借自
ecosystem-spec 的 conformance-claim schema
（`Declared < Parsed < Negotiated < Tested < Observed < Attested`）。

| 坐标 | kind | 契约章节 | 契约测试 | 证据级别 |
| --- | --- | --- | --- | --- |
| `saturday.contract/v0` | `StructureResolver` | §4.1 | `structureResolverContract` | Tested |
| `saturday.contract/v0` | `PotentialProvider` | §4.2 + §5.2 | `potentialProviderContract` | Tested |
| `saturday.contract/v0` | `Workflow` | §4.3 | `workflowContract` | Tested |
| `saturday.contract/v0` | `Analysis` | §4.4 | （无专项断言） | Declared |
| `saturday.contract/v0` | `Sampler` | §4.5 | `samplerContract` | Tested |
| `saturday.contract/v0` | `DerivationLedger` | §4.6 | `derivationContract` | Tested |

横切关注点（§4.7 单位与能力指纹、§4.8 证据组合律）不是独立 seam，
不单独占坐标，经 potential-provider 握手与筛选层生效。

证据级别的含义：`Tested` 表示该 seam 的标准断言集在
`@toki0413/contract-tests` 中可执行，且当前基线（全仓回归 391/391，
22 包）全绿；`Declared` 表示契约条款在册但套件未含专项断言。
Saturday 的证据级别只会向上走：Analysis seam 补套件断言后升 Tested，
无需变更坐标本身。

## 3. 与 dsh-std 坐标体系的关系

- dsh-std 公共协议占用 `*.dsh/*` 命名空间（如 `commands.dsh/v1alpha1`）；
  TUI 私有定义占用 `tui.dsh/v1alpha1`。`saturday.contract/v0` 是
  Saturday 自治命名空间，与两者无重叠，也不进入其注册表
  （`registry-0.15.json` 的收录是 dsh-TUI 准入流程的一部分，见 §4）。
- 若未来某宿主希望通过 dsh-std 的 `ProtocolCatalog` 协商 Saturday 能力，
  需要一份 profile 定义文件（JSON schema + 契约测试映射）。坐标声明
  里的 `contractTests` 字段就是为这一步预留的锚点，但 profile 文件
  本身待首个真实消费方出现后再产出——不为不存在的消费方预造规范。

## 4. TUI 准入规范七条自检

对 [TUI Admission v0.15](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/old/docs/plugin-admission-and-development.md)
七条准入的诚实自检（基线：规范 `/old` 全量备份；规范主分支正在修订，
对账日期 2026-09-06）。逐条详证见 JSON 声明的 `admissionSelfCheck` 段。

| 条款 | 状态 | 一句话结论 |
| --- | --- | --- |
| TUI-PKG-001 Package identity | gated | 以 dsh 原生 bundle 机制挂载，未提供 `dsh-plugin.json`；申报前需补静态 manifest |
| TUI-PKG-002 Declaration closure | partial | 依赖卫生纪律与声明闭包精神一致；未提供 dsh-std 形状的静态声明 |
| TUI-HOST-001 Host descriptor | not-applicable | 宿主侧义务；Saturday 是插件集合，不作宿主 |
| TUI-RUN-001 Remote determinism | partial | 无 GUI 假定，headless 端到端已实证；remote attach 场景未验证 |
| TUI-OBS-001 Ownership and cleanup | partial | effect 生命周期由 cordis 可逆效应承载；未做 deactivate 残留系统审计 |
| TUI-DEP-001 Dependency closure | partial | pack-check 机械核验 22 包 artifact + CI 双档；dsh-std revision 项不适用 |
| TUI-TRUST-001 Trust disclosure | partial | 同进程信任模型适用且有诚实声明纪律；无面向终端用户的披露面 |

七条无一完全满足，这不是疏漏而是立场：**坐标化解决"可被引用"，
准入申报解决"进目录"，两者解耦。** 若未来决定申报，门前条件按
状态排序：gated（补 manifest）> partial 中影响协商结果的（声明闭包、
remote attach）> 审计与披露类。

## 5. 维护规则

- 契约文档章节变更时，本文件 §2 表与 JSON `definitions` 同步更新；
  附录 A 的里程碑编号是坐标条目变更的证据锚点。
- `evidenceLevel` 只升不降；降级意味着契约测试失效，属于回归事故
  而非声明变更。
- admission 自检每次对账更新 `selfCheckDate`；规范主分支修订定稿后
  应重跑一次对账。
