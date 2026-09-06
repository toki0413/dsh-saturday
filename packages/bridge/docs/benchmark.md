# 全链闭环对账基线（benchmark.md）

**Status:** 回归可重复的对账基线（demo:fullchain 的验收判据）
**场景:** Cu 基体掺杂筛选（Ag / Ni / Pt）+ OU 采样候选联合排序 + Γ 声子稳定性 + 谱系登记
**数据面:** 环境自适应（EMT 真物理 / lj-js 零依赖），判据跨档一致

## 场景与判据

demo:fullchain 每次运行必须通过以下对账清单（机械可判，非主观评价）：

| # | 判据 | 断言方式 |
| --- | --- | --- |
| 1 | 采样候选参与联合排序 | `sampledJoint.entries.length > 0`（ESS 分数随交付呈现） |
| 2 | 失败变体如实呈报 | `failed` 数组逐项携带 error（不静默丢弃） |
| 3 | 声子判定显式交付 | Top-2 候选 verdict ∈ {stable, unstable}，虚频支数与阈值随结果 |
| 4 | 谱系登记成立 | `derivation.status(reportRef)` = valid；inputs 指向基体材料 |
| 5 | 排序物理合理 | EMT 档：Cu3Pt 有序化倾向排在 Cu3Ag 相分离倾向之前（与实验冶金学一致） |

判据 5 仅在 `calculator === 'emt-mock'` 档执行；lj-js 玩具势档如实跳过（玩具势不承诺实验对账）。

## 场景固定

- 基体：Cu（fcc conventional，4 原子）
- 掺杂：Ag / Ni / Pt（各 1 位点）
- 采样：sampler.ou，n=3，temperatureK=300（与筛选目标温度一致，温差核对零声明）
- 声子：analysis.phonon 默认超胞 3×3×3（簇边界伪影修复后判据，见契约附录 A 第 81 条）

## 对照叙事（AICC 评测思路的本地化）

AICC 用脱敏审稿任务考 agent；本基准考**运行时**：同一个场景下，静默降级、伪虚频、
断链的 materialId、未声明的能量零点，任何一项都会让判据失败。运行时是考题的一部分——
环境自适应路径（zero-deps 回退）必须与精度档通过同一套对账结构，只是物理断言按档位
诚实分级（判据 5）。

## 运行

```bash
npm run demo:fullchain --workspace @toki0413/bridge
```

输出末尾的对账清单 4 项全部 ✓ 即通过；EMT 档额外隐含判据 5。
