// 仿射耦合流（affine coupling flow）纯函数层 —— 契约 §4.5 sampler seam 第三实证。
//
// 输运映射：潜变量 z ~ N(0, sMax²·I)（扁平 3N 维，基础分布尺度与窗口同量级——
// 声明即承诺：典型样本的 tanh 压缩处于良态区，浮点往返可机械对账）
// ↔ 相对参考结构的位移向量 d，RealNVP 风格耦合层堆叠：每层把坐标二分为两半（偶/奇下标交替），
// 一半恒等（条件半），另一半做条件仿射变换：
//   forward : y = b + a·sMax·tanh(z / sMax),  a = exp(Σ w·tanh(x / sMax) + b)
//   inverse : z = sMax·arctanh((y − b) / (a·sMax))
//   逐坐标 log|dy/dz| = log a − log sMax − 2·log cosh(z / sMax)（闭式，z 空间稳定求值）
//
// 与前两个实证的差别：映射是**双射**（每层可逆、层堆叠仍可逆）→
// invertible: true（seam 首个），encode 是 decode 的严格逆；
// 似然经换元公式 log p(d) = log N(z) − log|det J| 精确可求 → likelihood: 'exact'
// （与 OU 的 'exact' 语义不同：OU 是提议核闭式密度，flow 是输运映射换元密度）。
//
// 诚实边界（全部写进交付 note，不藏在注释里）：
//  - 流参数 (w, c, b) 由 seed 确定性派生，**不是数据训练产物**——seam 条款的实证载体，
//    不是学习势；真实 flow 模型（训练权重）挂载时替换参数来源即可，形态不变；
//  - exact 指输运映射自身的换元似然，不是能量面上的玻尔兹曼似然；
//    热力学加权仍须引擎回算（§4.5 oracle 条款：候选不自证）；
//  - 位移被 tanh 约束在微分同胚窗口内（窗口是声明即承诺：
//    窗口外结构不在输运映射覆盖范围内，encode 显式拒绝，不外推冒充）；
//  - 双射是数学性质；浮点往返精度随潜变量趋近窗口边界退化（逆雅可比 ~ cosh² 增长），
//    往返对账在 1e-5 量级内机械验证（测试断言，不靠注释承诺）。

export function samplerError(code, message) {
  const e = new Error(`${message} (${code})`)
  e.code = code
  return e
}

/** 确定性 PRNG（mulberry32）：同种子同序列，与 perturb/OU 同款（采样可复现） */
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

export const SAMPLER_NAME = 'affine-flow'

export const DEFAULT_LAYERS = 2

function assertSMax(sMax) {
  if (!Number.isFinite(sMax) || sMax <= 0) {
    throw samplerError('SAMPLER_UNAVAILABLE',
      `sMax（微分同胚窗口半宽，Å）必须是正有限数；收到 ${sMax}`)
  }
}

/** 耦合层参数：由 seed 确定性派生（逐层 w/c 条件半系数 + b 偏移；非训练产物，如实声明） */
export function flowParams(seed, layers, dims) {
  const rng = mulberry32(seed)
  return Array.from({ length: layers }, () => ({
    w: Array.from({ length: dims }, () => (rng() - 0.5)),      // 条件半系数 |w| ≤ 0.5（尺度有界）
    b: Array.from({ length: dims }, () => (rng() - 0.5) * 0.2), // 偏移 |b| ≤ 0.1
  }))
}

/** 数值稳定的 log cosh（大 |z| 不溢出：log cosh z = |z| + log(1 + e^{−2|z|}) − log 2） */
function logCosh(z) {
  const az = Math.abs(z)
  return az + Math.log1p(Math.exp(-2 * az)) - Math.LN2
}

/**
 * 正向输运 z → d（逐层累积 log|det J|）。
 * 每层：偶下标为条件半（恒等），奇下标做条件仿射；层间交替划分（信息跨半混合）。
 * 雅可比在 z 空间闭式稳定求值：log|dy/dz| = log a − log sMax − 2·log cosh(z/sMax)——
 * 不用 log(1 − tanh²)（tanh 浮点饱和到 ±1 时退化为 log 0 = −∞，尾部潜变量会毒化 logProb）。
 * @returns {{ d: number[], logDet: number }}
 */
export function flowForward(z, params, sMax) {
  assertSMax(sMax)
  let cur = z.slice()
  let logDet = 0
  for (let l = 0; l < params.length; l++) {
    const { w, b } = params[l]
    const next = cur.slice()
    for (let i = 0; i < cur.length; i++) {
      if ((i + l) % 2 === 0) continue                       // 条件半：恒等
      let cond = 0
      for (let j = 0; j < cur.length; j++) {
        if ((j + l) % 2 === 0) cond += w[j] * Math.tanh(cur[j] / sMax)
      }
      const a = Math.exp(cond + b[i])
      const zc = cur[i] / sMax
      next[i] = b[i] + a * sMax * Math.tanh(zc)
      // log|dy/dz| = log a − log sMax − 2·log cosh(z/sMax)（链式法则逐项：sMax 缩放不可省，
      // 省了就不是 d 空间的密度）
      logDet += Math.log(a) - Math.log(sMax) - 2 * logCosh(zc)
    }
    cur = next
  }
  return { d: cur, logDet }
}

/**
 * 逆向输运 d → z（flowForward 的严格逆：层序反转、半划分一致、逐层 arctanh 回退）。
 * 双射是可执行声明：encode(decode(z)) ≡ z（数值精度内，测试逐坐标对账）。
 * @returns {{ z: number[], logDet: number }} logDet 与正向同值（同一映射的雅可比）
 */
export function flowInverse(d, params, sMax) {
  assertSMax(sMax)
  let cur = d.slice()
  let logDet = 0
  for (let l = params.length - 1; l >= 0; l--) {
    const { w, b } = params[l]
    const next = cur.slice()
    for (let i = 0; i < cur.length; i++) {
      if ((i + l) % 2 === 0) continue
      let cond = 0
      for (let j = 0; j < cur.length; j++) {
        if ((j + l) % 2 === 0) cond += w[j] * Math.tanh(cur[j] / sMax)
      }
      // 条件半在本层恒等 → 逆向时仍可用其当前值还原 a（与正向逐位一致）
      const a = Math.exp(cond + b[i])
      // 窗口门禁先归一再比较：y = b + a·sMax·tanh(z/sMax) → t = (y − b)/(a·sMax)，
      // |t| ≥ 1 即结构在微分同胚窗口外（arctanh 无定义）——显式拒绝，不外推
      const t = (cur[i] - b[i]) / (a * sMax)
      if (!Number.isFinite(t) || Math.abs(t) >= 1) {
        throw samplerError('SAMPLER_UNAVAILABLE',
          `坐标 ${i} 的位移超出微分同胚窗口（|d − b| 必须 < a·sMax，sMax=${sMax}）：` +
          '窗口外结构不在输运映射覆盖范围内，不静默外推')
      }
      const zc = Math.atanh(t)
      next[i] = sMax * zc
      // 与正向同款稳定形式（z 空间 log cosh，不碰 tanh 饱和退化；含 −log sMax 链式项）
      logDet += Math.log(a) - Math.log(sMax) - 2 * logCosh(zc)
    }
    cur = next
  }
  return { z: cur, logDet }
}

/** 标准正态对数密度（扁平向量） */
export function stdNormalLogProb(z) {
  let sumSq = 0
  for (const v of z) sumSq += v * v
  return -0.5 * sumSq - 0.5 * z.length * Math.log(2 * Math.PI)
}

/** 基础分布 N(0, sMax²·I) 对数密度（换元公式的潜变量项：尺度与窗口同量级，声明即承诺） */
export function baseLogProb(z, sMax) {
  let sumSq = 0
  for (const v of z) sumSq += v * v
  return -0.5 * sumSq / (sMax * sMax) - z.length * Math.log(sMax * Math.sqrt(2 * Math.PI))
}

function assertSampleArgs(target, { n, sMax }) {
  const reference = target?.reference
  if (!reference?.graph) {
    throw samplerError('SAMPLER_UNAVAILABLE',
      `${SAMPLER_NAME} requires target.reference (a resolved Material); ` +
      'supportedTargets: reference')
  }
  if (!Number.isInteger(n) || n < 1) {
    throw samplerError('SAMPLE_NOT_FOUND', `cannot produce ${n} candidates (n must be a positive integer)`)
  }
  assertSMax(sMax)
  return reference
}

/**
 * 参考绑定的 §4.5 StructureSampler 实例：encode 的位移空间相对 reference 定义
 * （契约 encode(structure) 单参形态 → 参考必须在构造时绑定，谱系随 encode 交付回传）。
 * seed 同时决定流参数与潜变量抽样（声明即承诺：异 seed = 异映射 + 异抽样）。
 */
export function createFlowSampler({ reference, seed = 1, sMax = 0.1, layers = DEFAULT_LAYERS } = {}) {
  if (!reference?.graph?.nodes?.length) {
    throw samplerError('SAMPLER_UNAVAILABLE',
      'createFlowSampler requires reference (a resolved Material with non-empty graph)：' +
      '输运映射的位移空间相对参考结构定义，无参考即无 encode 的定义域')
  }
  assertSMax(sMax)
  if (!Number.isInteger(layers) || layers < 1) {
    throw samplerError('SAMPLER_UNAVAILABLE', `layers（耦合层数）必须是正整数；收到 ${layers}`)
  }
  const dims = reference.graph.nodes.length * 3
  const params = flowParams(seed, layers, dims)

  return {
    name: SAMPLER_NAME,

    manifest: {
      semantics: 'sampling',        // 采样语义是唯一语义（核心条款）
      likelihood: 'exact',          // 换元公式闭式：log N(z) − log|det J|（双射精确）
      invertible: true,             // seam 首实证：双射输运映射，必须提供 encode
      supportedTargets: ['reference'],
    },

    /**
     * 潜变量抽样 → 正向输运 → 位移叠加参考位置；logProb 经换元公式逐候选可独立重算。
     * 映射（params + sMax）在构造时固定：per-call seed 只重播潜变量抽样（不改双射），
     * 保证 encode∘sample ≡ id 对任意抽样种子成立；per-call sMax 与构造不一致即拒
     * （改 sMax = 改双射映射，encode 无从反演——不静默用新映射采样再假装可逆）。
     */
    async sample(target = {}, { n = 8, seed: sampleSeed = seed, sMax: sampleSMax = sMax } = {}) {
      const ref = assertSampleArgs(target, { n, sMax })
      if (sampleSMax !== sMax) {
        throw samplerError('SAMPLER_UNAVAILABLE',
          `绑定实例的 sMax 在构造时固定为 ${sMax}（改 sMax = 改双射映射，encode 无从反演）；收到 per-call sMax=${sampleSMax}`)
      }
      const rng = mulberry32(sampleSeed)
      const sampleSource = `generative:${SAMPLER_NAME}#seed=${sampleSeed}#sMax=${sMax}`
      return Array.from({ length: n }, () => {
        // 基础分布 N(0, sMax²·I)：z/sMax ~ N(0,1) → tanh 压缩处于良态区（典型样本不碰浮点饱和）
        const z = Array.from({ length: ref.graph.nodes.length * 3 }, () => gaussian(rng) * sMax)
        const { d, logDet } = flowForward(z, params, sMax)
        const graph = structuredClone(ref.graph)
        graph.nodes.forEach((node, i) => {
          node.position = node.position.map((x, c) => x + d[i * 3 + c])
        })
        return {
          graph,
          source: sampleSource,
          logProb: baseLogProb(z, sMax) - logDet,   // 换元公式：精确，非近似
          latent: z,                                // 潜变量随交付（encode 往返对账的一手证据）
        }
      })
    },

    /**
     * 双射输运映射的反向（契约：仅 invertible === true 提供）。
     * 同拓扑门禁（节点数一致，位移否则无定义）；窗口外显式拒绝（不外推冒充覆盖）。
     */
    async encode(structure) {
      if (!structure?.nodes?.length) {
        throw samplerError('SAMPLER_UNAVAILABLE',
          'encode 需要非空 graph（AtomGraph 形态：nodes[].position 逐坐标）')
      }
      if (structure.nodes.length !== reference.graph.nodes.length) {
        throw samplerError('SAMPLER_UNAVAILABLE',
          `encode 要求与参考结构同拓扑（节点数 ${reference.graph.nodes.length}，收到 ${structure.nodes.length}）：` +
          '跨拓扑位移无定义，不静默截断/补零')
      }
      const d = []
      structure.nodes.forEach((node, i) => {
        const pos = node?.position
        if (!Array.isArray(pos) || pos.length !== 3 || pos.some(x => !Number.isFinite(x))) {
          throw samplerError('SAMPLER_UNAVAILABLE', `节点 ${i} 的 position 必须是三个有限数（收到 ${JSON.stringify(pos)}）`)
        }
        pos.forEach((x, c) => d.push(x - reference.graph.nodes[i].position[c]))
      })
      const { z, logDet } = flowInverse(d, params, sMax)   // 窗口门禁在 flowInverse 内
      return { latent: z, logDet, reference: `material:${reference.id ?? 'inline'}` }
    },
  }
}

/**
 * 未绑定参考的基础实例：sample 照常（target.reference 逐调用提供）；
 * encode 缺参考绑定时显式拒绝——位移空间无定义，不猜测参考冒充可逆。
 */
export const affineFlowSampler = {
  name: SAMPLER_NAME,

  manifest: {
    semantics: 'sampling',
    likelihood: 'exact',
    invertible: true,
    supportedTargets: ['reference'],
  },

  async sample(target = {}, { n = 8, seed = 1, sMax = 0.1, layers = DEFAULT_LAYERS } = {}) {
    const reference = assertSampleArgs(target, { n, sMax })
    return createFlowSampler({ reference, seed, sMax, layers }).sample(target, { n, seed, sMax })
  },

  async encode() {
    throw samplerError('SAMPLER_UNAVAILABLE',
      'encode 需要参考绑定（位移空间相对参考结构定义）：用 createFlowSampler({ reference, seed, sMax }) 创建绑定实例')
  },
}
