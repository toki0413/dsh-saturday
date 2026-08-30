// 证据源注册表 —— 枚举候选联合排序的额外证据源描述符（⑲ 白名单分支的注册表化）。
//
// 形态：描述符 = { name, requires, logWeights, independenceNote }。
// 筛选纯层只做通用循环（查找 → 校验输入要求 → 取逐候选 log 权重 → 追加独立性声明），
// 新证据源接入不再改筛选代码：在此注册一个描述符即可（组合律的三条诚实纪律
// 由 combineEvidence 强制，与源的数量和种类无关——这就是可扩展性本身）。
//
// 描述符纪律：
//  - logWeights(ctx) 返回逐候选 log 权重（null = 该源对此候选无证据，掩码语义）；
//  - requires(ctx) 输入不满足即抛错（无输入即无证据，不静默近似）；
//  - independenceNote 必须如实声明该源与既有证据源的（条件）独立性或退化关联。

import { evidenceError } from './evidence.mjs'

/** 凸包距离证据（⑲ 首个实证）：逐候选稳定性证据，−β·max(0, energyAboveHull) */
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
}

/** 内置证据源注册表（名字 → 描述符）；第三方插件可构造自己的注册表传入筛选 */
export const builtinEvidenceSources = {
  hull: hullEvidenceSource,
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
