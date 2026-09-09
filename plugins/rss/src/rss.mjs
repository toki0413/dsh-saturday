// RSS（Random Structure Search）随机结构搜索采样器纯函数层 ——
// 契约 §4.5 sampler seam 第二个生成式实现（非 normalizing-flow 路线）。
// 语义是采样而非求逆：候选是成分/晶胞约束下均匀提议分布的采样点，不是"唯一解"。
// 诚实声明：提议分布本身可精确归一，但最小间距门禁使交付分布成为截断分布
// （归一化常数无闭式），按最保守口径整体声明 likelihood: 'none'，不伪造 exact；
// 输运非双射 → invertible: false，不提供 encode。
// 候选可回算：graph 形状兼容 §4.1（AtomGraph），可直接构造 Material 送入引擎
// 做 生成 → 弛豫 → 核对 闭环（引擎是唯一 oracle）。

import { Z, composeFormula } from '@toki0413/core'

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

export const SAMPLER_NAME = 'rss'

/** 最小像约定下的周期性原子间距（正交晶胞：逐轴折叠到最近像）；导出供测试门禁验算 */
export function periodicDistance(p1, p2, lengths) {
  let d2 = 0
  for (let k = 0; k < 3; k++) {
    let d = p1[k] - p2[k]
    d -= lengths[k] * Math.round(d / lengths[k])
    d2 += d * d
  }
  return Math.sqrt(d2)
}

/**
 * 解析目标成分：composition 显式给定（elements+counts 或 numbers），
 * 或从 reference 已解析结构继承（graph.nodes[].number）。
 * 两者皆缺 → SAMPLER_UNAVAILABLE（显式报错，不静默为空成功）。
 */
export function resolveComposition(target = {}) {
  const comp = target?.composition
  if (comp) {
    if (Array.isArray(comp.numbers) && comp.numbers.length >= 1) {
      if (!comp.numbers.every(z => Number.isInteger(z) && z >= 1)) {
        throw samplerError('SAMPLER_UNAVAILABLE', `composition.numbers must be positive integers (atomic numbers); got ${JSON.stringify(comp.numbers)}`)
      }
      return [...comp.numbers]
    }
    if (Array.isArray(comp.elements) && Array.isArray(comp.counts) &&
        comp.elements.length === comp.counts.length && comp.elements.length >= 1) {
      const numbers = []
      for (let i = 0; i < comp.elements.length; i++) {
        const z = Z[comp.elements[i]]
        if (!z) {
          throw samplerError('SAMPLER_UNAVAILABLE',
            `unknown element "${comp.elements[i]}" (supported: ${Object.keys(Z).join(', ')})`)
        }
        if (!Number.isInteger(comp.counts[i]) || comp.counts[i] < 1) {
          throw samplerError('SAMPLER_UNAVAILABLE', `composition.counts[${i}] must be a positive integer; got ${comp.counts[i]}`)
        }
        numbers.push(...Array(comp.counts[i]).fill(z))
      }
      return numbers
    }
    throw samplerError('SAMPLER_UNAVAILABLE',
      'composition requires either { elements, counts } or { numbers } (atomic numbers)')
  }
  const refNodes = target?.reference?.graph?.nodes
  if (Array.isArray(refNodes) && refNodes.length >= 1) {
    return refNodes.map(n => n.number)
  }
  throw samplerError('SAMPLER_UNAVAILABLE',
    `${SAMPLER_NAME} requires target.composition ({ elements, counts } or { numbers }) ` +
    `or target.reference (a resolved Material); supportedTargets: composition, reference`)
}

export const rssSampler = {
  name: SAMPLER_NAME,

  manifest: {
    semantics: 'sampling',        // 采样语义是唯一语义（核心条款）
    likelihood: 'none',           // 均匀提议经最小间距门禁后为截断分布，归一化常数无闭式：诚实声明 none，禁伪造
    invertible: false,            // 随机生成非双射输运：不得提供 encode
    supportedTargets: ['composition', 'reference'],
  },

  /**
   * §4.5 StructureSampler 形态。
   * target.composition：{ elements: ['Cu','Pt'], counts: [3,1] } 或 { numbers: [29,78,...] }；
   * target.reference：已解析 Material（成分自 graph.nodes[].number 继承，结构本身不参考）。
   * 选项：n 候选数；seed 随机种子；aMin/aMax 正交晶胞边长范围（Å）；
   * minDistance 最小原子间距门禁（Å，最小像约定）；maxAttempts 单原子放置重试上限。
   */
  async sample(target = {}, {
    n = 8,
    seed = 1,
    aMin = 2.5,
    aMax = 6.0,
    minDistance = 1.1,
    maxAttempts = 200,
  } = {}) {
    const numbers = resolveComposition(target)
    if (!Number.isInteger(n) || n < 1) {
      throw samplerError('SAMPLE_NOT_FOUND', `cannot produce ${n} candidates (n must be a positive integer)`)
    }
    for (const [k, v] of [['aMin', aMin], ['aMax', aMax]]) {
      if (!Number.isFinite(v) || v <= 0) {
        throw samplerError('SAMPLER_UNAVAILABLE', `${k} must be a positive finite number (Å); got ${v}`)
      }
    }
    if (!(aMax > aMin)) {
      throw samplerError('SAMPLER_UNAVAILABLE', `aMax must be greater than aMin; got [${aMin}, ${aMax}]`)
    }
    if (!Number.isFinite(minDistance) || minDistance < 0) {
      throw samplerError('SAMPLER_UNAVAILABLE', `minDistance must be a non-negative finite number (Å); got ${minDistance}`)
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw samplerError('SAMPLER_UNAVAILABLE', `maxAttempts must be a positive integer; got ${maxAttempts}`)
    }

    const rng = mulberry32(seed)
    // 谱系前缀统一为 'generative:<name>'（§4.5 交付即谱系）
    const source = `generative:${SAMPLER_NAME}#seed=${seed}`

    const candidates = []
    for (let c = 0; c < n; c++) {
      // 正交晶胞：三轴边长独立均匀采样（graph.cell 为 3×3 对角矩阵，与 §4.1 形状兼容）
      const lengths = [0, 0, 0].map(() => aMin + (aMax - aMin) * rng())
      const cell = [
        [lengths[0], 0, 0],
        [0, lengths[1], 0],
        [0, 0, lengths[2]],
      ]
      // 逐原子均匀放置（分数坐标 U[0,1)^3 → 笛卡尔），最小间距门禁不满足则重试该原子；
      // 重试耗尽仍放不下 = 按判据产不出候选：显式 SAMPLE_NOT_FOUND，不静默放宽门禁
      const positions = []
      for (let i = 0; i < numbers.length; i++) {
        let placed = false
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const pos = [rng() * lengths[0], rng() * lengths[1], rng() * lengths[2]]
          const ok = positions.every(p => periodicDistance(p, pos, lengths) >= minDistance)
          if (ok) {
            positions.push(pos)
            placed = true
            break
          }
        }
        if (!placed) {
          throw samplerError('SAMPLE_NOT_FOUND',
            `cannot place atom ${i} satisfying minDistance=${minDistance} Å within ` +
            `maxAttempts=${maxAttempts} (cell ${lengths.map(x => x.toFixed(2)).join('x')} Å, ` +
            `${numbers.length} atoms) — relax minDistance or enlarge the cell`)
        }
      }
      candidates.push({
        graph: {
          nodes: numbers.map((z, i) => ({ id: i, number: z, position: positions[i] })),
          edges: [],
          periodic: true,
          cell,
        },
        source,
        formula: composeFormula(numbers),
      })
    }
    return candidates
  },
}
