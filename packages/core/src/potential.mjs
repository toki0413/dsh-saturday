// PotentialRegistry —— 计算引擎 seam
// 要点（修订 #7/#10）：
//  - 评分公式修正：speed/cost 语义统一，screening 画像必须选出快引擎
//  - license 是前置门禁，不是可逆效果
//  - 引擎切换不影响在运行任务
//  - M1（单位与指纹）：注册即校验 manifest.units/fingerprint——无单位声明的
//    能量不得进入任何组合路径（凸包/焓比较），指纹不可追溯即不可组合。
//    校验结果以 _units/_fingerprint 挂在 provider 上（不改写原 manifest）。

import { validateEngineUnits, validateEngineFingerprint, fingerprintEqual, unitsError } from './units.mjs'
import { JobLedger, jobError } from './jobs.mjs'
import { createHash } from 'node:crypto'

/**
 * 引擎源标识（热替换状态连续性的地基）：engine:<name> 是稳定的失效手柄，
 * engineSourceId 额外把指纹（software|method|version|model）编入——计算结果
 * 记它就知道"是哪一档哪个版本产出的"；指纹变（如 mace medium→small、
 * 实测 version 盖章升级）→ 哈希变 → 下游失效有据可触发，不再同名即安全。
 */
export function engineSourceId(provider) {
  const fp = provider._fingerprint ?? provider.manifest?.fingerprint ?? {}
  const material = [fp.software ?? '?', fp.method ?? '?', fp.version ?? 'unknown', provider.model ?? ''].join('|')
  return `engine:${provider.name}@${createHash('sha256').update(material).digest('hex').slice(0, 8)}`
}

export class NoCapableProviderError extends Error {
  constructor(type) { super(`No provider can handle task type "${type}"`); this.code = 'NO_CAPABLE_PROVIDER' }
}
export class LicenseUnavailableError extends Error {
  constructor(name) { super(`License unavailable for provider "${name}"`); this.code = 'LICENSE_UNAVAILABLE' }
}
export class GranularityUnavailableError extends Error {
  constructor(name, requested, declared) {
    super(`Provider "${name}" declares eventGranularity "${declared}"; ` +
          `"${requested}" monitoring must be explicitly rejected, not silently degraded`)
    this.code = 'GRANULARITY_UNAVAILABLE'
  }
}
export class PropertyUnsupportedError extends Error {
  constructor(name, missing, declared) {
    super(`Provider "${name}" cannot compute [${missing.join(', ')}] ` +
          `(declared properties: [${declared.join(', ')}]); ` +
          `electronic views must be explicitly rejected, never silently approximated with null`)
    this.code = 'PROPERTY_UNSUPPORTED'
  }
}

// calculate 原语的基线物理量：任何势函数计算器按定义都能给出；
// 其余性质（stress / bandgap / dos …）必须在 capabilities[].properties 显式声明。
export const BASELINE_PROPERTIES = ['energy', 'forces']

const WEIGHT_PROFILES = {
  screening:  { accuracy: 0.2, speed: 0.5, cost: 0.3 },
  validation: { accuracy: 0.7, speed: 0.1, cost: 0.2 },
  balanced:   { accuracy: 0.4, speed: 0.3, cost: 0.3 },
}

export class PotentialRegistry {
  constructor(runtime) {
    this.rt = runtime
    this.providers = new Map()
    this.activeProvider = null
    this.licenseChecker = async () => true   // 默认放行；部署时注入真实检查
    // 作业台账：动态拆装的承载机制（卸载路径先查账再动手，§2.2 的机制化）
    this.jobs = new JobLedger()
  }

  /**
   * 注册门禁 M1：manifest.units（三元组）与 manifest.fingerprint（software/method）
   * 必须显式声明且白名单合法——异构引擎生态下"单位未声明/来源不可追溯"的
   * 能量一旦混入组合路径（凸包、焓排序）即产生"看起来合法但物理无意义"的结论。
   * 归一后的声明挂 _units/_fingerprint（消费方只读归一形态，原 manifest 不被改写）。
   */
  register(provider) {
    // 同名重注册防护：运行时 attach 可能撞上已在池的同名引擎（如宿主已挂过）——
    // 静默替换会让在途作业/激活指针指向被孤儿化的旧 provider，显式拒绝而非
    if (this.providers.has(provider.name) && this.providers.get(provider.name) !== provider) {
      throw jobError('PROVIDE_COLLISION',
        `engine "${provider.name}" already registered; refusing silent replacement (detach first, then attach)`)
    }
    provider._units = validateEngineUnits(provider.manifest.units)
    provider._fingerprint = validateEngineFingerprint(provider.manifest.fingerprint)
    provider._sourceId = engineSourceId(provider)
    // 台账鸭子注入：provider 想记账就用 this.jobs（可选参与，不破坏既有 provider）
    provider.jobs = this.jobs
    this.providers.set(provider.name, provider)
  }

  /**
   * 实测态回读升级：引擎运行时探测到自己的实际版本后，把归一指纹的
   * version 从声明态 'unknown' 升级为实测值。只允许丰富 version：software/method
   * 是注册时的静态声明，实测不符属引擎冒充身份，不在回读范畴；原 manifest 仍不
   * 被改写（与 M1 同款）。探测失败方应保持 'unknown'，不得拿 'unknown'/空值盖章。
   */
  async stampFingerprint(name, { version } = {}) {
    const provider = this.get(name)
    if (typeof version !== 'string' || version.length === 0 || version === 'unknown') {
      throw unitsError('FINGERPRINT_STAMP_INVALID',
        `stampFingerprint(${name})：version 必须是非空实测值（探测失败应保持 unknown 声明，不盖章）`)
    }
    const previousSourceId = provider._sourceId
    provider._fingerprint = { ...provider._fingerprint, version }
    provider._sourceId = engineSourceId(provider)
    // 源标识变 = 指纹实质变化（如 unknown→实测版本）：发广播事件，
    // 活性上下文据此沿 engine:<name> 传播失效——盖章不再只是局部升级
    if (previousSourceId !== provider._sourceId) {
      await this.rt?.emit?.('saturday/potential/refingerprinted', {
        type: 'saturday/potential/refingerprinted',
        payload: { engine: name, previousSourceId, sourceId: provider._sourceId, version },
      })
    }
    return provider._fingerprint
  }

  /** 注销（引擎插件卸载路径）；若注销的是当前激活引擎，重置激活指针 */
  unregister(name) {
    const p = this.providers.get(name)
    if (p) p.jobs = undefined
    this.providers.delete(name)
    if (this.activeProvider === name) this.activeProvider = null
  }

  /**
   * 带作业语义的拆下（动态拆装的正门）：先查台账再注销。
   * onActive：'refuse'（缺省，有在途作业即抛 ACTIVE_JOBS，绝不静默）
   *          | 'drain'（等到超时，超时仍显式 DRAIN_TIMEOUT）
   *          | 'cancel'（要求 provider.cancel 存在，没有即 CANCEL_UNSUPPORTED——不假装能停）
   */
  async detach(name, { onActive = 'refuse', timeoutMs = 60_000 } = {}) {
    const provider = this.get(name)
    const active = this.jobs.activeOf(name)
    let drained = true
    if (active.length > 0) {
      if (onActive === 'refuse') {
        throw jobError('ACTIVE_JOBS', `engine "${name}" has ${active.length} active job(s); refuse detach (choose onActive: drain|cancel|refuse explicitly)`)
      }
      if (onActive === 'cancel') {
        if (typeof provider.cancel !== 'function') {
          throw jobError('CANCEL_UNSUPPORTED', `engine "${name}" provides no cancel(); refusing to silently kill or orphan jobs`)
        }
        for (const rec of active) await provider.cancel(rec.jobId)
        drained = (await this.jobs.awaitDrain(name, { timeoutMs })).drained
      } else if (onActive === 'drain') {
        const r = await this.jobs.awaitDrain(name, { timeoutMs })
        if (!r.drained) {
          throw jobError('DRAIN_TIMEOUT', `engine "${name}" still has ${r.pending.length} active job(s) after ${timeoutMs}ms; detach refused (no silent kill)`)
        }
      } else {
        throw jobError('JOB_BAD_INPUT', `unknown onActive strategy: ${onActive}`)
      }
    }
    this.unregister(name)
    return { detached: name, hadActiveJobs: active.length > 0, drained }
  }

  get(name) {
    const p = this.providers.get(name)
    if (!p) throw new Error(`Provider ${name} not registered`)
    return p
  }

  /**
   * 热切换：只换“当前引擎”指针，在运行任务不受影响（修订 #10）。
   * 热替换（previous 非空）是失效源（§8.2）：发 saturday/potential/activated
   * 事件，推导登记簿侧据此沿 engine:<id> 传播失效；首次激活不发。
   * M2（激活门禁）：事件载荷携带指纹差异声明（fingerprintChange）——
   * 新旧引擎不同源时消费方据此知晓“为何旧能量不再可比”（声明而非拒绝：
   * 热切换本身合法，可比性判断随事件呈现，与 §8.2 失效传播闭环）。
   */
  async activate(name) {
    if (this.activeProvider === name) return
    const provider = this.get(name)
    await this.preflight(provider)
    const previous = this.activeProvider
    this.activeProvider = name
    if (previous !== null) {
      const previousProvider = this.providers.get(previous)
      const fingerprintChange = fingerprintEqual(provider._fingerprint, previousProvider?._fingerprint)
      await this.rt?.emit?.('saturday/potential/activated', {
        type: 'saturday/potential/activated',
        payload: { engine: name, previous, fingerprintChange },
      })
    }
  }

  async preflight(provider) {
    if (provider.manifest.constraints?.requiresLicense) {
      const ok = await this.licenseChecker(provider.name)
      if (!ok) throw new LicenseUnavailableError(provider.name)
    }
  }

  /**
   * 细粒度监听门禁（契约 §5.2）：事件粒度不足的引擎必须显式拒绝，
   * 不得静默降级为任务级监听。未声明粒度按 'iteration' 对待。
   */
  assertCanMonitor(provider, granularity = 'iteration') {
    const declared = provider.manifest.eventGranularity ?? 'iteration'
    if (granularity === 'iteration' && declared === 'job') {
      throw new GranularityUnavailableError(provider.name, granularity, declared)
    }
  }

  /**
   * 性质能力门禁（修订 #9 配套）：请求的性质必须被引擎能力声明覆盖。
   * 基线物理量（energy/forces）隐式成立；电子结构等未声明者显式拒绝，
   * 绝不静默返回 null（诚实纪律：与 §5.2 粒度门禁同款）。
   */
  assertCalculable(provider, properties = []) {
    const caps = provider.manifest.capabilities.find(c => c.type === 'calculate')
    const declared = [...BASELINE_PROPERTIES, ...(caps?.properties ?? [])]
    const missing = properties.filter(p => !declared.includes(p))
    if (missing.length) throw new PropertyUnsupportedError(provider.name, missing, declared)
  }

  /** 自动路由：任务画像决定权重 */
  autoRoute(task) {
    const w = WEIGHT_PROFILES[task.profile ?? 'balanced']
    const candidates = [...this.providers.values()].filter(p => this.canHandle(p, task))
    if (candidates.length === 0) throw new NoCapableProviderError(task.type)
    return candidates.sort((a, b) => this.score(b, task, w) - this.score(a, task, w))[0]
  }

  canHandle(provider, task) {
    return provider.manifest.capabilities.some(
      c => c.type === task.type && (c.maxAtoms ?? Infinity) >= (task.nAtoms ?? 0),
    )
  }

  score(provider, task, w) {
    const caps = provider.manifest.capabilities.find(c => c.type === task.type)
    if (!caps) return 0
    // 修订 #7：v3.1 的 1/speed 奖励慢引擎；统一为"越大越好"后直接加权
    return caps.accuracy * w.accuracy + caps.speed * w.speed + (1 - caps.cost) * w.cost
  }

  /** 当前引擎（显式指定优先，否则 autoRoute）；profile 属任务画像，两个入参位置都认 */
  resolveProvider(params = {}, task = {}) {
    if (params.engine && params.engine !== 'auto') return this.get(params.engine)
    return this.autoRoute({ type: task.type ?? 'calculate', nAtoms: task.nAtoms ?? 0, profile: task.profile ?? params.profile })
  }
}
