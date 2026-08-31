// 证据源注册表 —— 枚举候选联合排序的额外证据源描述符（白名单分支的注册表化）。
//
// 形态：描述符 = { name, requires, logWeights, independenceNote }（四要素，缺一即接入即坏）；
// 可选第五要素 variables（机器审计）：该源依赖的变量词表——成对交集由机器检出，
// 检出的共享变量必须在组合的独立性声明文本中被解释，否则拒绝组合（不依赖人工自觉）。
// 筛选纯层只做通用循环（查找 → 校验输入要求 → 取逐候选 log 权重 → 追加独立性声明），
// 新证据源接入不再改筛选代码：在此注册一个描述符即可（组合律的诚实纪律
// 由 combineEvidence 强制，与源的数量和种类无关——这就是可扩展性本身）。
//
// 描述符纪律：
//  - logWeights(ctx) 返回逐候选 log 权重（null = 该源对此候选无证据，掩码语义）；
//  - requires(ctx) 输入不满足即抛错（无输入即无证据，不静默近似）；
//  - independenceNote 必须如实声明该源与既有证据源的（条件）独立性或退化关联。

import { evidenceError } from './evidence.mjs'

/** 凸包距离证据：逐候选稳定性证据，−β·max(0, energyAboveHull) */
export const hullEvidenceSource = {
  name: 'hull',
  requires({ thermo, ranked }) {
    if (!thermo || thermo.level === 'unavailable' || ranked.some(r => r.energyAboveHull === undefined)) {
      throw evidenceError('EVIDENCE_INVALID_INPUT',
        'hull evidence requires references (convex hull must be built from ' +
        'explicit reference states—no hull, no stability evidence)')
    }
  },
  logWeights({ ranked, betaEVInv }) {
    // 包内点（energyAboveHull<0）掩码 0：“已稳定”不再提供额外区分证据
    //（禁止零填充伪造稳定性梯度）
    return ranked.map(r => -betaEVInv * Math.max(0, r.energyAboveHull))
  },
  independenceNote:
    '凸包证据 −β·max(0,energyAboveHull) 由同一批候选能量构造，声明为给定候选能量下条件独立' +
    '（凸包距离是候选能量的确定性函数，无额外随机性）；与焓证据存在退化关联' +
    '（包上点凸包证据恒 0），组合仅在有区分度的包外点上实质生效——如实声明不冒充独立',
  variables: ['能量', '组分'],   // 机器审计：能量→与焓证据退化关联（包上点恒 0）；组分→凸包坐标，与混合熵共享
}

/** 理想混合熵证据（注册表第二内置源）：逐候选组分先验，log w = ΔS_mix/k_B = −Σ x·ln x（每点位，无量纲）。
 *  熵增有利的无序固溶候选获提升；纯元素候选按定义 = 0（无混合可言，不伪造梯度）。
 *  只消费组分——与焓/凸包证据零能量信息共享，无需参考态/温度之外的任何输入。 */
export const mixingEntropyEvidenceSource = {
  name: 'mixing-entropy',
  requires({ ranked }) {
    for (const r of ranked) {
      if (!r.composition || typeof r.composition !== 'object' || Object.keys(r.composition).length === 0) {
        throw evidenceError('EVIDENCE_INVALID_INPUT',
          `mixing-entropy evidence requires candidates to carry composition (候选 ${r.label ?? r.formula ?? '?'} 缺组分)`)
      }
    }
  },
  logWeights({ ranked }) {
    // composition 是计数形态（与凸包构造同源）→ 先归一为分数再求每点位熵；
    // −β·(−TΔS) = ΔS/k_B 与 β 无关（理想混合熵的温度线性恰好在 log 权重中消去）
    return ranked.map(r => {
      const total = Object.values(r.composition).reduce((acc, n) => acc + n, 0)
      let s = 0
      for (const n of Object.values(r.composition)) {
        const x = n / total
        s -= x * Math.log(x)
      }
      return s
    })
  },
  independenceNote:
    '混合熵证据 −Σ x·ln x 只依赖候选组分（组合简并度先验，与 β 无关），' +
    '与焓证据不共享任何能量信息；声明为给定组分下条件独立——' +
    '与凸包证据共享组分变量（凸包坐标即组分），如实声明非全独立',
  variables: ['组分'],           // 机器审计：只消费组分——与焓证据机械不交，与凸包共享组分如实检出
}

/** 内置证据源注册表（名字 → 描述符）；第三方插件可构造自己的注册表传入筛选 */
export const builtinEvidenceSources = {
  hull: hullEvidenceSource,
  'mixing-entropy': mixingEntropyEvidenceSource,
}

/**
 * 按名字解析证据源描述符（未知源显式拒绝：证据源须显式实现，不静默近似）。
 * @param {string[]} names 请求启用的证据源名
 * @param {Object<string, Object>} [registry] 注册表（默认内置）
 */
export function resolveEvidenceSources(names, registry = builtinEvidenceSources) {
  const resolved = []
  for (const name of names ?? []) {
    const descriptor = registry[name]
    if (!descriptor) {
      throw evidenceError('EVIDENCE_INVALID_INPUT',
        `unknown evidence source "${name}" (registered: ${Object.keys(registry).join(', ') || 'none'})` +
        '——证据源须显式实现，不静默近似')
    }
    resolved.push(descriptor)
  }
  return resolved
}
