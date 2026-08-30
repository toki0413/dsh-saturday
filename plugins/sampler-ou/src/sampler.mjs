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
//
// 温度标定（③）：uEq 始终是采样行为的直接物理参数；温度标定函数只负责把温度换算成
// 谐波近似的建议涨落幅度（供调用方标定，不静默替换），且力常数必须显式注入——
// 没有势能面信息就没有涨落幅度，静默假设力常数 = 伪造涨落标度。
//
// 多锚点混合（④）：OU 单峰 = 局部采样器，跨盆地靠多参考加权混合。混合提案是有限高斯混合，
// 转移密度仍闭式（log Σ π_a N_a）→ 似然声明保持 'exact' 不降档；候选按锚点配比确定性分配，
// 交付的 logProb 是相对**全部锚点**的混合似然（不是单锚点似然，语义如实写进交付）。

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

export const KB_EV_PER_K = 8.617333262145e-5

/**
 * 谐波近似温度标定：平衡态涨落幅度 u_eq = √(k_B·T / k_eff)（每坐标，谐波近似）。
 * 力常数 k_eff（eV/Å²）必须显式注入（可来自谐波锚点的 Hessian 或显式声明）；
 * 缺力常数即报错——涨落幅度无来源时不得静默假设。
 */
export function uEqFromHarmonicTemperature({ temperatureK, forceConstantEVPerA2 }) {
  if (!Number.isFinite(temperatureK) || temperatureK <= 0) {
    throw samplerError('SAMPLER_UNAVAILABLE',
      `temperatureK 必须是正有限数；收到 ${temperatureK}`)
  }
  if (!Number.isFinite(forceConstantEVPerA2) || forceConstantEVPerA2 <= 0) {
    throw samplerError('SAMPLER_UNAVAILABLE',
      `forceConstantEVPerA2（有效力常数，eV/Å²）必须显式注入且为正有限数；收到 ${forceConstantEVPerA2}` +
      '（无势能面信息就没有涨落幅度，不静默假设）')
  }
  return Math.sqrt(KB_EV_PER_K * temperatureK / forceConstantEVPerA2)
}

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

/** 数值稳定的 log-sum-exp（纯层自含，不跨包依赖筛选层的组合律实现） */
function logSumExp(terms) {
  const m = Math.max(...terms)
  return m + Math.log(terms.reduce((acc, t) => acc + Math.exp(t - m), 0))
}

/**
 * 高斯混合转移对数密度（④）：候选相对各锚点的位移 → log Σ_a π_a · N(disp_a; 0, s²I)。
 * @param {number[][]} displacementsByAnchor 逐锚点的候选−锚点位移（扁平 3N，同拓扑）
 * @param {number[]} weights 锚点原始权重（正有限，内部归一；不必预先归一）
 */
export function ouMixtureLogProb(displacementsByAnchor, weights, { uEq, gammaDt }) {
  if (displacementsByAnchor.length === 0 || displacementsByAnchor.length !== weights.length) {
    throw samplerError('SAMPLER_UNAVAILABLE',
      '混合似然需要逐锚点位移与锚点权重一一对应（不得缺席或多出）')
  }
  const s = ouStd(uEq, gammaDt)
  const totalW = weights.reduce((a, b) => {
    if (!Number.isFinite(b) || b <= 0) {
      throw samplerError('SAMPLER_UNAVAILABLE',
        `锚点权重必须是正有限数；收到 ${b}（零权重锚点不得参与混合）`)
    }
    return a + b
  }, 0)
  const dims = displacementsByAnchor[0].length
  const norm = -dims * Math.log(s * Math.sqrt(2 * Math.PI))
  const terms = displacementsByAnchor.map((disp, a) => {
    let sumSq = 0
    for (const d of disp) sumSq += d * d
    return Math.log(weights[a] / totalW) - 0.5 * sumSq / (s * s)
  })
  return logSumExp(terms) + norm
}

/** 确定性配额：最大余数法分候选到锚点（同权重同结果，可复现） */
function allocateCounts(n, normalizedWeights) {
  const exact = normalizedWeights.map(p => n * p)
  const counts = exact.map(Math.floor)
  let remainder = n - counts.reduce((a, b) => a + b, 0)
  // 余数按小数部分降序补一；平手取靠前锚点（确定性）
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((x, y) => (y.frac - x.frac) || (x.i - y.i))
  for (let k = 0; k < remainder; k++) counts[order[k % order.length].i] += 1
  return counts
}

/**
 * 多锚点混合采样（④，纯层）：target.references = [{ reference, weight }]（同拓扑参考结构）。
 * OU 单峰是局部采样器；跨盆地探索 = 编排层选多锚点，混合权重经组合律诚实声明。
 * 交付的 logProb 是混合似然（相对全部锚点），source 记录所属锚点（谱系不断）。
 */
export async function ouSampleMixture(target = {}, { n = 8, seed = 1, uEq = 0.05, gammaDt = 1.0, temperatureK } = {}) {
  const refs = target?.references
  if (!Array.isArray(refs) || refs.length < 1) {
    throw samplerError('SAMPLER_UNAVAILABLE',
      'ouSampleMixture requires target.references = [{ reference, weight }] (至少一个锚点)')
  }
  if (!Number.isInteger(n) || n < 1) {
    throw samplerError('SAMPLE_NOT_FOUND', `cannot produce ${n} candidates (n must be a positive integer)`)
  }
  assertParams({ uEq, gammaDt })
  if (temperatureK !== undefined && (!Number.isFinite(temperatureK) || temperatureK <= 0)) {
    throw samplerError('SAMPLER_UNAVAILABLE',
      `temperatureK（采样器自身温度声明）必须是正有限数；收到 ${temperatureK}`)
  }
  for (const [i, a] of refs.entries()) {
    if (!a?.reference?.graph) {
      throw samplerError('SAMPLER_UNAVAILABLE', `锚点 ${i} 缺 reference（已解析结构）`)
    }
  }
  // 混合位移需同拓扑：跨锚点逐坐标位移仅在节点数一致时有定义（不静默近似）
  const nNodes = refs[0].reference.graph.nodes.length
  if (refs.some(a => a.reference.graph.nodes.length !== nNodes)) {
    throw samplerError('SAMPLER_UNAVAILABLE',
      '混合锚点必须同拓扑（节点数一致）：跨锚点位移否则无定义')
  }
  const rawWeights = refs.map(a => a.weight)
  const totalW = rawWeights.reduce((acc, w) => {
    if (!Number.isFinite(w) || w <= 0) {
      throw samplerError('SAMPLER_UNAVAILABLE',
        `锚点权重必须是正有限数；收到 ${w}（零/负权重锚点不得参与混合）`)
    }
    return acc + w
  }, 0)
  const normWeights = rawWeights.map(w => w / totalW)
  const counts = allocateCounts(n, normWeights)

  const rng = mulberry32(seed)
  const s = ouStd(uEq, gammaDt)
  const candidates = []
  refs.forEach((a, anchorIdx) => {
    for (let k = 0; k < counts[anchorIdx]; k++) {
      const graph = structuredClone(a.reference.graph)
      const displacement = []
      for (const node of graph.nodes) {
        node.position = node.position.map(x => {
          const d = gaussian(rng) * s
          displacement.push(d)
          return x + d
        })
      }
      // 混合似然：候选相对全部锚点的位移 → log Σ π_a N_a（如实语义，非单锚点似然）
      const dispsAll = refs.map(r2 => {
        const out = []
        graph.nodes.forEach((node, i) => {
          const refPos = r2.reference.graph.nodes[i].position
          node.position.forEach((x, c) => out.push(x - refPos[c]))
        })
        return out
      })
      const source = `generative:${SAMPLER_NAME}#mixture#seed=${seed}#anchor=${anchorIdx}` +
        (Number.isFinite(temperatureK) ? `&T=${temperatureK}K` : '')
      candidates.push({
        graph, source,
        logProb: ouMixtureLogProb(dispsAll, rawWeights, { uEq, gammaDt }),
        anchorIndex: anchorIdx,
        mixtureWeights: normWeights,
        ...(Number.isFinite(temperatureK) ? { samplerTemperatureK: temperatureK } : {}),
      })
    }
  })
  return candidates
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

  /**
   * §4.5 StructureSampler 形态。target.reference 为已解析的参考结构（Material）。
   * 参数：uEq（Å，平衡态每坐标涨落幅度）、gammaDt（γΔ 无量纲；→0 贴近参考，→∞ 达平稳）。
   * temperatureK（可选）：声明采样器自身温度。声明 ≠ 替换：不改变采样行为（uEq 仍是
   * 直接参数）——只随交付呈现，供消费方做温差诚实核对（筛选层 ⑳ 的 samplerTemperatureK）；
   * 标定建议值可用 uEqFromHarmonicTemperature 换算（力常数显式注入）。
   */
  async sample(target = {}, { n = 8, seed = 1, uEq = 0.05, gammaDt = 1.0, temperatureK } = {}) {
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
    if (temperatureK !== undefined && (!Number.isFinite(temperatureK) || temperatureK <= 0)) {
      throw samplerError('SAMPLER_UNAVAILABLE',
        `temperatureK（采样器自身温度声明）必须是正有限数；收到 ${temperatureK}`)
    }

    const rng = mulberry32(seed)
    const s = ouStd(uEq, gammaDt)
    // 谱系前缀统一为 'generative:<name>'（§4.5 交付即谱系）；温度声明进谱系（同温不同声明 = 不同批）
    const source = `generative:${SAMPLER_NAME}#seed=${seed}` +
      (Number.isFinite(temperatureK) ? `&T=${temperatureK}K` : '')
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
      return {
        graph, source, logProb: ouLogProb(displacement, { uEq, gammaDt }),
        // 温度声明随逐候选交付（筛选层采样入口读入 → 温差诚实声明 ⑳）
        ...(Number.isFinite(temperatureK) ? { samplerTemperatureK: temperatureK } : {}),
      }
    })
  },
}
