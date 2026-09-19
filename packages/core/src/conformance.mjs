// 一致性合规报告（conformance report）—— @toki0413/core，SDK 信任层（发布即门禁的凭证）。
//
// 目的：给一个 provider（手写或 descriptor 装配）跑一遍**静态**契约不变量检查，产出机器可读
//   报告——单位三元组、指纹可追溯、能力良构（accuracy/speed/cost∈[0,1] + maxAtoms）、事件粒度、
//   声明的能力是否真有对应方法、金标准状态。这是"发布一个不合规模块即被拒"的门禁依据，
//   也是 SDK 作者接完立刻能拿的"可展示合规凭证"。
// 与 contract-tests 的分工：contract-tests 是运行时行为套件（需跑 seam 全流程）；本模块是
//   不依赖执行的静态一致性核验（对 descriptor 型引擎尤其有用——作者只写了配置）。两者互补。
// 真相源：单位/指纹校验复用 units.mjs 的 validateEngineUnits / validateEngineFingerprint，
//   不另立白名单（防"多张表各自漂移"）。诚实：任一检查失败如实列，不整体放行；缺金标准标 declared=false
//   （有机制无参考值不算通过证据）。

import { validateEngineUnits, validateEngineFingerprint } from './units.mjs'

const CAP_TYPES = new Set(['relax', 'calculate', 'md', 'elasticity', 'phonon'])
const GRANULARITIES = new Set(['iteration', 'job'])

function one(id, fn) {
  try { const detail = fn(); return { id, ok: true, detail: detail ?? null } }
  catch (e) { return { id, ok: false, detail: `${e.code ?? 'ERROR'}: ${e.message}` } }
}

/**
 * 对 provider 生成一致性合规报告。
 * @param {{provider:object, goldens?:{declared:boolean, passed:boolean, results?:Array}}} [p]
 * @returns {{subject:string, passed:boolean, checks:Array<{id,ok,detail}>,
 *            units?:object, fingerprint?:object, eventGranularity?:string,
 *            goldens:object, note:string}}
 */
export function conformanceReport({ provider, goldens } = {}) {
  if (!provider || typeof provider !== 'object') {
    return { subject: '(none)', passed: false, checks: [{ id: 'SUBJECT', ok: false, detail: 'provider required' }], goldens: { declared: false, passed: false }, note: '无 provider 可核验' }
  }
  const m = provider.manifest
  const checks = []

  checks.push(one('SUBJECT', () => {
    if (typeof provider.name !== 'string' || provider.name.length === 0) throw err('CONF_BAD_NAME', 'provider.name 必填非空')
    return provider.name
  }))
  checks.push(one('MANIFEST', () => {
    if (!m || typeof m !== 'object') throw err('CONF_MANIFEST_MISSING', 'provider.manifest 必填')
    return null
  }))

  let units = null, fingerprint = null, granularity = null
  checks.push(one('UNITS', () => { units = validateEngineUnits(m?.units); return units }))
  checks.push(one('FINGERPRINT', () => { fingerprint = validateEngineFingerprint(m?.fingerprint); return fingerprint }))
  checks.push(one('CAPABILITIES', () => {
    const caps = m?.capabilities
    if (!Array.isArray(caps) || caps.length === 0) throw err('CONF_NO_CAPABILITIES', '至少声明一项能力')
    for (const [i, c] of caps.entries()) {
      if (typeof c?.type !== 'string' || c.type.length === 0) throw err('CONF_BAD_CAP', `capabilities[${i}].type 必填`)
      for (const k of ['accuracy', 'speed', 'cost']) {
        if (!Number.isFinite(c[k]) || c[k] < 0 || c[k] > 1) throw err('CONF_BAD_CAP', `capabilities[${i}].${k} 必须在 [0,1]（对比值），收到 ${c[k]}`)
      }
      if (c.maxAtoms !== undefined && !(Number.isFinite(c.maxAtoms) && c.maxAtoms > 0)) throw err('CONF_BAD_CAP', `capabilities[${i}].maxAtoms 必须为正数`)
    }
    return caps.map(c => c.type)
  }))
  checks.push(one('EVENT_GRANULARITY', () => {
    const g = m?.eventGranularity
    if (!GRANULARITIES.has(g)) throw err('CONF_BAD_GRANULARITY', `eventGranularity 必须是 iteration|job，收到 ${g}（§5.2 要求显式声明）`)
    granularity = g; return g
  }))
  checks.push(one('CAPABILITY_METHODS', () => {
    if (!Array.isArray(m?.capabilities)) throw err('CONF_NO_CAPABILITIES', '能力未声明')
    for (const c of m.capabilities) {
      if (!CAP_TYPES.has(c.type)) continue  // 分析类等非核心方法名不在此强检
      if (typeof provider[c.type] !== 'function') throw err('CONF_METHOD_MISSING', `声明能力 ${c.type} 但 provider.${c.type}() 不存在`)
    }
    return m.capabilities.filter(c => CAP_TYPES.has(c.type)).map(c => c.type)
  }))

  const goldensSummary = goldens
    ? { declared: !!goldens.declared, passed: !!goldens.passed, n: goldens.results?.length ?? 0 }
    : { declared: false, passed: false, n: 0 }
  checks.push(one('GOLDENS', () => {
    if (!goldens) return '未提供金标准结果（机制可后置）'
    if (goldens.declared && !goldens.passed) throw err('CONF_GOLDEN_FAIL', '金标准回归未通过（版本/单位漂移信号）')
    return goldens.declared ? `金标准 ${goldens.results?.length ?? 0} 项通过` : '未声明金标准（不作通过证据）'
  }))

  const passed = checks.every(c => c.ok)
  return {
    subject: provider.name ?? '(unnamed)',
    engineKind: 'potential-provider',
    passed,
    checks,
    units: units ?? m?.units ?? null,
    fingerprint: fingerprint ?? m?.fingerprint ?? null,
    eventGranularity: granularity ?? m?.eventGranularity ?? null,
    goldens: goldensSummary,
    note: '静态一致性核验（单位/指纹/能力/粒度/方法/金标准）；运行时契约行为另见 contract-tests。' +
      (passed ? '全部检查通过 → 可发布' : '存在不合规项 → 发布门禁应拒绝'),
  }
}

function err(code, msg) { const e = new Error(`${msg}`); e.code = code; return e }
