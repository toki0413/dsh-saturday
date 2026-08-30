// 混合提案锚点库（⑦）：自监督进场的管道铺路——不是学习本身，是学习的数据地基。
//
// 定位：自监督学习的自然落点是 sampler seam（Boltzmann 生成器 / 潜空间提案），
// 进场前提是采样→回算闭环积累了真实轨迹数据。锚点库是这条管道的第一段：
//   add            闭环产出的锚点入库（必须携带谱系：无谱系数据不入库）
//   retrieve       拓扑硬门禁（同节点数）+ 组分距离排序（L1 分数距离）
//   toMixtureTarget 检索结果 → ouSampleMixture 可直接消费的 target 形态
//
// 诚实纪律：
//  - 锚点必须携带来源声明（source）：数据出处不明即拒绝入库（谱系不断）；
//  - 空库/无匹配检索返回空集：不伪造锚点（伪造 = 拿不存在的证据喂提案）；
//  - 拓扑不匹配直接过滤不近似：跨锚点位移仅在节点数一致时有定义
//    （与 ouSampleMixture 同拓扑门禁同款，库里先筛一道是诚实不是冗余）；
//  - 锚点缺组分信息：距离声明为不可考（null），排尾呈现不冒充可比。

import { samplerError } from './sampler.mjs'

/** 组分（计数或分数形态均可）归一为分数向量（键序稳定：按元素名排序） */
function compositionFractions(composition) {
  const keys = Object.keys(composition ?? {}).sort()
  if (keys.length === 0) return null
  const total = keys.reduce((acc, k) => acc + composition[k], 0)
  if (!(total > 0)) return null
  return { keys, frac: keys.map(k => composition[k] / total) }
}

/** 分数向量 L1 距离（支撑取并集：缺项按 0，概率单纯形上 L1 ∈ [0, 2]） */
function compositionL1(a, b) {
  const keys = [...new Set([...a.keys, ...b.keys])].sort()
  let d = 0
  for (const k of keys) {
    const va = a.frac[a.keys.indexOf(k)] ?? 0
    const vb = b.frac[b.keys.indexOf(k)] ?? 0
    d += Math.abs(va - vb)
  }
  return d
}

/**
 * 创建锚点库（纯层，无副作用依赖）。
 * @returns {{ add: Function, size: Function, entries: Function, retrieve: Function, toMixtureTarget: Function }}
 */
export function createAnchorStore() {
  const anchors = []

  return {
    /**
     * 锚点入库。锚点 = 闭环产出的参考结构（采样→回算轨迹中值得驻留的构型）。
     * @param {{ graph: Object, source: string, formula?: string,
     *           composition?: Object<string, number>, energy?: number }} anchor
     *        graph 必须含非空 nodes；source 谱系声明必填（数据出处可追溯）
     */
    add(anchor = {}) {
      if (!anchor.graph || !Array.isArray(anchor.graph.nodes) || anchor.graph.nodes.length === 0) {
        throw samplerError('ANCHOR_INVALID', '锚点必须携带含非空 nodes 的 graph（结构是锚点的本体）')
      }
      if (typeof anchor.source !== 'string' || anchor.source.trim().length === 0) {
        throw samplerError('ANCHOR_INVALID',
          '锚点必须携带来源声明（source）：无谱系数据不入库（锚点来自闭环轨迹，出处必须可追溯）')
      }
      const entry = {
        graph: structuredClone(anchor.graph),
        source: anchor.source,
        addedAt: anchors.length,
        ...(anchor.formula ? { formula: anchor.formula } : {}),
        ...(anchor.composition ? { composition: anchor.composition } : {}),
        ...(Number.isFinite(anchor.energy) ? { energy: anchor.energy } : {}),
      }
      anchors.push(entry)
      return entry
    },

    size() { return anchors.length },

    /** 库内锚点快照（浅拷贝数组，条目本体不外泄可变引用） */
    entries() { return anchors.slice() },

    /**
     * 按查询检索锚点：拓扑硬门禁（节点数一致）+ 组分距离升序（L1 分数距离）。
     * @param {{ nAtoms: number, composition?: Object<string, number>, topK?: number }} query
     *        nAtoms 必填（拓扑门禁即混合采样的同拓扑前置）；
     *        composition 缺省 = 只按拓扑过滤不排序偏好；
     *        锚点缺组分信息：距离 = null（不可考），排尾呈现不冒充可比
     * @returns {Array<{ anchor: Object, distance: number|null }>} 空集即如实无匹配（不伪造锚点）
     */
    retrieve({ nAtoms, composition, topK } = {}) {
      if (!Number.isInteger(nAtoms) || nAtoms < 1) {
        throw samplerError('ANCHOR_INVALID', 'retrieve 必须提供正整数 nAtoms（拓扑门禁是混合采样的同拓扑前置）')
      }
      const q = composition ? compositionFractions(composition) : null
      if (composition && !q) {
        throw samplerError('ANCHOR_INVALID', '查询组分为空或全零：无法构成成分点（不外推）')
      }
      const hits = []
      for (const a of anchors) {
        if (a.graph.nodes.length !== nAtoms) continue   // 拓扑硬门禁：不匹配直接过滤（不近似）
        let distance = null
        if (q) {
          const af = a.composition ? compositionFractions(a.composition) : null
          distance = af ? compositionL1(q, af) : null   // 锚点缺组分 = 距离不可考（诚实声明）
        }
        hits.push({ anchor: a, distance })
      }
      // 距离升序；不可考（null）排尾；平手按入库序（确定性）
      hits.sort((x, y) =>
        ((x.distance ?? Infinity) - (y.distance ?? Infinity)) || (x.anchor.addedAt - y.anchor.addedAt))
      return Number.isInteger(topK) && topK >= 0 ? hits.slice(0, topK) : hits
    },

    /**
     * 检索结果 → ouSampleMixture 的 target 形态（{ references: [{ reference: { graph }, weight }] }）。
     * @param {Array<{ anchor: Object }>} retrieved retrieve 的交付
     * @param {{ weights?: number[] }} [opts] 混合权重（缺省均匀；长度必须与检索结果一致，不静默归一补全）
     */
    toMixtureTarget(retrieved, { weights } = {}) {
      if (!Array.isArray(retrieved) || retrieved.length === 0) {
        throw samplerError('ANCHOR_EMPTY',
          '检索结果为空：不得构造混合目标（不伪造锚点——先让闭环积累数据，再谈混合提案）')
      }
      if (weights !== undefined) {
        if (!Array.isArray(weights) || weights.length !== retrieved.length) {
          throw samplerError('ANCHOR_INVALID',
            `weights 长度必须与检索结果一致（${retrieved.length}）：混合权重是显式声明不是静默补全`)
        }
      }
      return {
        references: retrieved.map((r, i) => ({
          reference: { graph: r.anchor.graph },
          weight: weights?.[i] ?? 1,
        })),
      }
    },
  }
}
