// 参考结构微扰采样器纯函数层 —— 契约 §4.5 sampler seam 首个实证。
// 语义是采样而非求逆：候选是参考结构邻域上的微扰分布采样点，不是"唯一解"。
// 最薄实证形态：确定性（种子驱动）、诚实声明（似然不可求 → 'none'，不伪造；
// 输运非双射 → invertible: false，不提供 encode）、候选可回算（graph 形状
// 兼容 §4.1，可直接构造 Material 送入引擎做 生成→弛豫→核对 闭环）。

export function samplerError(code, message) {
  const e = new Error(`${message} (${code})`)
  e.code = code
  return e
}

/** 确定性 PRNG（mulberry32）：同种子同序列，采样可复现 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Box-Muller：从均匀分布造标准正态（确定性，消费 PRNG 两个数） */
function gaussian(rng) {
  const u1 = Math.max(rng(), 1e-12)
  const u2 = rng()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

export const SAMPLER_NAME = 'reference-perturbation'

/**
 * §4.5 StructureSampler 形态。target.reference 为已解析的参考结构（Material）；
 * 微扰幅度 sigma（Å）为笛卡尔位移的标准差。
 */
export const referencePerturbationSampler = {
  name: SAMPLER_NAME,

  manifest: {
    semantics: 'sampling',        // 采样语义是唯一语义（核心条款）
    likelihood: 'none',           // 微扰分布未归一化到可求值似然：诚实声明，禁伪造
    invertible: false,            // 微扰非双射输运：不得提供 encode
    supportedTargets: ['reference'],
  },

  async sample(target = {}, { n = 8, seed = 1, sigma = 0.05 } = {}) {
    const reference = target?.reference
    if (!reference?.graph) {
      // 缺目标 / 超覆盖范围：显式报错，绝不静默为空成功
      throw samplerError('SAMPLER_UNAVAILABLE',
        `${SAMPLER_NAME} requires target.reference (a resolved Material); ` +
        `supportedTargets: ${this.manifest.supportedTargets.join(', ')}`)
    }
    if (!Number.isInteger(n) || n < 1) {
      throw samplerError('SAMPLE_NOT_FOUND', `cannot produce ${n} candidates (n must be a positive integer)`)
    }
    if (!Number.isFinite(sigma) || sigma < 0) {
      throw samplerError('SAMPLER_UNAVAILABLE', `sigma must be a non-negative finite number; got ${sigma}`)
    }

    const rng = mulberry32(seed)
    // 谱系前缀统一为 'generative:<name>'（§4.5 交付即谱系）
    const source = `generative:${SAMPLER_NAME}#seed=${seed}`
    return Array.from({ length: n }, () => {
      const graph = structuredClone(reference.graph)
      for (const node of graph.nodes) {
        node.position = node.position.map(x => x + gaussian(rng) * sigma)
      }
      return { graph, source }
    })
  },
}
