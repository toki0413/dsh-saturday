// PotentialRegistry —— 计算引擎 seam
// 要点（修订 #7/#10）：
//  - 评分公式修正：speed/cost 语义统一，screening 画像必须选出快引擎
//  - license 是前置门禁，不是可逆效果
//  - 引擎切换不影响在运行任务

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
  }

  register(provider) {
    this.providers.set(provider.name, provider)
  }

  /** 注销（引擎插件卸载路径）；若注销的是当前激活引擎，重置激活指针 */
  unregister(name) {
    this.providers.delete(name)
    if (this.activeProvider === name) this.activeProvider = null
  }

  get(name) {
    const p = this.providers.get(name)
    if (!p) throw new Error(`Provider ${name} not registered`)
    return p
  }

  /** 热切换：只换"当前引擎"指针，在运行任务不受影响（修订 #10） */
  async activate(name) {
    if (this.activeProvider === name) return
    const provider = this.get(name)
    await this.preflight(provider)
    this.activeProvider = name
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
