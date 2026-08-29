// OU（Ornstein-Uhlenbeck）参考结构采样器纯函数层 —— 契约 §4.5 sampler seam 第二实证。
//
// 物理：OU 是唯一"既马尔可夫又平稳可逆"的高斯过程，转移核闭式：
//   x_{t+Δ} = x₀ + (x_t − x₀)·e^{−γΔ} + u_eq·√(1 − e^{−2γΔ})·ξ,  ξ ~ N(0, I)
// 均值回归锚定参考结构 x₀，平稳分布 N(x₀, u_eq²)。起步取 x_t = x₀（参考本身）。
//
// 与首个实证（微扰采样，似然 'none'）的差别：OU 转移密度是精确高斯，
// 逐点可求值 → likelihood: 'exact'（契约"似然可求值性诚实声明"的升档实证）。
//
// 诚实边界（全部写进交付 note，不藏在注释里）：
//  - exact 指**提议核自身**的似然，不是能量面上的玻尔兹曼似然；
//    热力学加权仍须引擎回算（§4.5 oracle 条款：候选不自证）；
//  - OU 单峰：定位是**局部采样器**（盆地内受控扩散），跨盆地靠编排层多锚点；
//  - 有效性窗口：gammaDt = γΔ 为无量纲摩擦时间尺度积（声明即承诺），
//    u_eq 为平衡态每坐标涨落幅度（谐波近似的涨落量级，非势能面全局性质）。

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

export const SAMPLER_NAME = 'ou-perturbation'

/** 转移核标准差（每坐标）：闭式，仅依赖参数 */
export function ouStd(uEq, gammaDt) {
  const decay = Math.exp(-gammaDt)
  return uEq * Math.sqrt(1 - decay * decay)
}

/**
 * 精确转移对数密度：候选相对参考的逐坐标独立高斯对数似然。
 * @param {number[]} displacement 候选 − 参考的逐笛卡尔坐标位移（扁平 3N）
 */
export function ouLogProb(displacement, { uEq, gammaDt }) {
  const s = ouStd(uEq, gammaDt)
  let sumSq = 0
  for (const d of displacement) sumSq += d * d
  return -0.5 * sumSq / (s * s) - displacement.length * Math.log(s * Math.sqrt(2 * Math.PI))
}

function assertParams({ uEq, gammaDt }) {
  if (!Number.isFinite(uEq) || uEq <= 0) {
    throw samplerError('SAMPLER_UNAVAILABLE',
      `uEq（平衡态每坐标涨落幅度）必须是正有限数；收到 ${uEq}`)
  }
  if (!Number.isFinite(gammaDt) || gammaDt <= 0) {
    throw samplerError('SAMPLER_UNAVAILABLE',
      `gammaDt（γΔ，无量纲摩擦时间尺度积）必须是正有限数；收到 ${gammaDt}`)
  }
}

/**
 * §4.5 StructureSampler 形态。target.reference 为已解析的参考结构（Material）。
 * 参数：uEq（Å，平衡态每坐标涨落幅度）、gammaDt（γΔ 无量纲；→0 贴近参考，→∞ 达平稳）。
 */
export const ouSampler = {
  name: SAMPLER_NAME,

  manifest: {
    semantics: 'sampling',        // 采样语义是唯一语义（核心条款）
    likelihood: 'exact',          // OU 转移密度闭式高斯，逐点精确可求值（升档实证）
    invertible: false,            // 注噪转移非双射：不得提供 encode
    supportedTargets: ['reference'],
  },

  async sample(target = {}, { n = 8, seed = 1, uEq = 0.05, gammaDt = 1.0 } = {}) {
    const reference = target?.reference
    if (!reference?.graph) {
      throw samplerError('SAMPLER_UNAVAILABLE',
        `${SAMPLER_NAME} requires target.reference (a resolved Material); ` +
        `supportedTargets: ${this.manifest.supportedTargets.join(', ')}`)
    }
    if (!Number.isInteger(n) || n < 1) {
      throw samplerError('SAMPLE_NOT_FOUND', `cannot produce ${n} candidates (n must be a positive integer)`)
    }
    assertParams({ uEq, gammaDt })

    const rng = mulberry32(seed)
    const s = ouStd(uEq, gammaDt)
    // 谱系前缀统一为 'generative:<name>'（§4.5 交付即谱系）
    const source = `generative:${SAMPLER_NAME}#seed=${seed}`
    return Array.from({ length: n }, () => {
      const graph = structuredClone(reference.graph)
      const displacement = []
      for (const node of graph.nodes) {
        node.position = node.position.map(x => {
          const d = gaussian(rng) * s
          displacement.push(d)
          return x + d
        })
      }
      return { graph, source, logProb: ouLogProb(displacement, { uEq, gammaDt }) }
    })
  },
}
