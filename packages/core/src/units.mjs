// units.mjs —— 物理单位白名单与显式换算（量纲分析的最小落点，路线图 1）
//
// 动机：材料计算生态的单位异构（eV vs Ry vs Hartree、Å vs Bohr、fs vs ps）是
// 跨引擎组合的第一风险源——LAMMPS metal 与 real 单位制混入同一凸包即得"看起来
// 合法但物理无意义"的包络。单位入契约白名单，换算只能由调用方**显式发起**：
// 自动换算会掩盖"两个引擎的能量本不该直接比"的物理问题（与 §5.2 粒度门禁、
// 证据掩码禁零填充同款诚实纪律）。
//
// 纪律：
//  - 白名单外单位显式拒绝（不静默近似，与未知证据源同款）；
//  - assertSameUnits 不一致即抛带码异常——把"是否可比"的判断推回调用方；
//  - 换算系数以基准单位锚定（energy→eV，length→Å，time→fs），CODATA 常用值。

export function unitsError(code, message) {
  const e = new Error(`${message} (${code})`)
  e.code = code
  return e
}

// 白名单：每单位 → 基准单位的换算因子（乘因子得基准单位数值）
export const UNIT_WHITELIST = {
  energy: {
    eV: 1,
    Ry: 13.6056981335,
    Hartree: 27.211386245988,
    'kcal/mol': 1 / 23.060547830619,   // 1 eV ≈ 23.060547830619 kcal/mol
    J: 1 / 1.602176634e-19,
  },
  length: {
    'Å': 1,
    Angstrom: 1,          // ASCII 别名（输入侧宽容，输出侧规范为 'Å'）
    Bohr: 0.529177210903,
    nm: 10,
    m: 1e10,
  },
  time: {
    fs: 1,
    ps: 1000,
    s: 1e15,
  },
}

/** 基准单位（换算锚点） */
export const BASE_UNITS = { energy: 'eV', length: 'Å', time: 'fs' }

function dimensionOf(unit) {
  for (const [dim, table] of Object.entries(UNIT_WHITELIST)) {
    if (unit in table) return dim
  }
  return null
}

/**
 * 断言单位合法（白名单内）；返回所属维度。未知单位显式拒绝。
 */
export function assertValidUnit(unit) {
  const dim = dimensionOf(unit)
  if (!dim) {
    const known = Object.values(UNIT_WHITELIST).flatMap(t => Object.keys(t)).join(', ')
    throw unitsError('UNIT_UNKNOWN',
      `unknown unit "${unit}" (registered: ${known})——单位必须在白名单内，不静默近似`)
  }
  return dim
}

/**
 * 显式单位换算：value (from) → 基准单位（to 缺省）或指定 to。
 * 只在调用方显式发起时存在——绝不自动进入能量比较/凸包路径。
 */
export function unitConvert(value, from, to) {
  if (!Number.isFinite(value)) {
    throw unitsError('UNIT_INVALID_INPUT', `换算值必须是有限数；收到 ${value}`)
  }
  const dimFrom = assertValidUnit(from)
  const target = to ?? BASE_UNITS[dimFrom]
  const dimTo = assertValidUnit(target)
  if (dimFrom !== dimTo) {
    throw unitsError('UNIT_DIMENSION_MISMATCH',
      `cannot convert "${from}" (${dimFrom}) to "${target}" (${dimTo})——跨维度换算无定义`)
  }
  const fromTable = UNIT_WHITELIST[dimFrom]
  const toTable = UNIT_WHITELIST[dimTo]
  return value * fromTable[from] / toTable[target]
}

/**
 * 单位一致性门禁：一致放行；不一致抛带码异常（不自动换算——
 * 是否换算、按什么物理假设换算，是调用方的显式决策）。
 */
export function assertSameUnits(a, b, what = 'quantity') {
  const dimA = assertValidUnit(a)
  const dimB = assertValidUnit(b)
  if (a !== b) {
    throw unitsError('UNIT_MISMATCH',
      `${what}: unit "${a}" vs "${b}" 不一致——跨单位${dimA === dimB ? '比较' : '组合'}必须调用方显式换算后声明`)
  }
}

/**
 * 引擎单位声明校验（manifest.units）：三元组齐全 + 全部白名单内。
 * 返回归一后的声明（Angstrom → 'Å'）。
 */
export function validateEngineUnits(units) {
  if (!units || typeof units !== 'object') {
    throw unitsError('UNITS_MISSING', 'manifest.units 必填（{energy, length, time}）——无单位声明的能量不得参与组合')
  }
  const normalized = {}
  for (const dim of ['energy', 'length', 'time']) {
    const u = units[dim]
    if (u === undefined) {
      throw unitsError('UNITS_MISSING', `manifest.units.${dim} 缺失——单位三元组必须齐全`)
    }
    const realDim = assertValidUnit(u)
    if (realDim !== dim) {
      throw unitsError('UNIT_DIMENSION_MISMATCH',
        `manifest.units.${dim} 声明了 "${u}"，但它是 ${realDim} 单位——维度错位显式拒绝`)
    }
    normalized[dim] = u === 'Angstrom' ? 'Å' : u
  }
  return normalized
}

/**
 * 引擎指纹校验（manifest.fingerprint）：software/method 必填；
 * version 缺省降级 'unknown'（诚实声明，不冒充已知）。
 */
export function validateEngineFingerprint(fingerprint) {
  if (!fingerprint || typeof fingerprint !== 'object') {
    throw unitsError('FINGERPRINT_MISSING', 'manifest.fingerprint 必填（{software, method}）')
  }
  for (const key of ['software', 'method']) {
    if (typeof fingerprint[key] !== 'string' || fingerprint[key].length === 0) {
      throw unitsError('FINGERPRINT_MISSING',
        `manifest.fingerprint.${key} 必填且非空——能量来源不可追溯即不可组合`)
    }
  }
  return {
    software: fingerprint.software,
    method: fingerprint.method,
    version: typeof fingerprint.version === 'string' && fingerprint.version.length > 0
      ? fingerprint.version : 'unknown',
  }
}

/**
 * 指纹一致性判定：两指纹的 software + method 全同，且 version 维不矛盾才视为同源。
 * version 维 unknown 通配（① 实测态纪律）：'unknown' = 未探测/不可得，不构成差异证据——
 * 一侧 unknown 时不按 version 判异源，但 reason 如实声明"含未验证维"（声明 ≠ 放行冒充）；
 * 两侧皆已知且不同才判异源。返回 { same, reason }——不抛异常，
 * 由消费方决定拒绝还是声明（凸包拒绝，演示对照可声明后继续）。
 */
export function fingerprintEqual(a, b) {
  if (!a || !b) return { same: false, reason: '指纹缺失（至少一方未声明）' }
  if (a.software !== b.software) return { same: false, reason: `software 不同（${a.software} vs ${b.software}）` }
  if (a.method !== b.method) return { same: false, reason: `method 不同（${a.method} vs ${b.method}）` }
  const va = a.version ?? 'unknown'
  const vb = b.version ?? 'unknown'
  if (va !== 'unknown' && vb !== 'unknown' && va !== vb) {
    return { same: false, reason: `version 不同（${va} vs ${vb}）` }
  }
  if (va !== vb) {
    return { same: true, reason: `version 维一侧未探测（${va} vs ${vb}，unknown 通配）——同源判定成立但含未验证维` }
  }
  return { same: true, reason: null }
}
