// Material —— 材料领域对象
// 要点（对应 v3.3 设计原则与修订 #8/#9）：
//  - formula-only 构建必须显式提供 StructureResolver，结构来源写入谱系
//  - electronicView 是异步计算产物，不是同步 getter

import { randomUUID } from 'node:crypto'
import { Z, composeFormula } from './elements.mjs'
import { makeCalculationRecord } from './calculation-record.mjs'

export class Material {
  constructor(data, graph) {
    this.id = data.id ?? randomUUID()
    this.modalities = data.modalities
    this._graph = graph
    this._lineage = data.lineage ?? [{
      operation: 'creation',
      timestamp: Date.now(),
    }]
  }

  /**
   * 统一入口：file/graph 直接解析；formula 必须经 Resolver。
   * @param {Object} data { modalities }
   * @param {StructureResolver} [resolver] formula 模态时必填
   * @param {Object} [opts] { polymorphRank } 多晶型选择，默认 0（最稳定）
   */
  static async create(data, resolver, opts = {}) {
    const m = data.modalities
    if (m.graph) return new Material(data, m.graph)
    if (m.formula) {
      if (!resolver) {
        throw new Error('Formula-only construction requires a StructureResolver ' +
                        '(prototype-lib | materials-project | generative)')
      }
      const candidates = await resolver.resolve(m.formula)
      const rank = opts.polymorphRank ?? 0
      const chosen = candidates.find(c => c.polymorphRank === rank)
      if (!chosen) {
        throw new Error(`Polymorph rank ${rank} not available for ${m.formula}; ` +
                        `got ranks ${candidates.map(c => c.polymorphRank).join(', ')}`)
      }
      const material = new Material(data, chosen.graph)
      material._lineage.push({
        operation: 'structure-resolved',
        detail: {
          resolver: resolver.name,
          source: chosen.source,
          polymorphRank: chosen.polymorphRank,
          // resolver 未给出的字段不入谱系：带 undefined 字段的谱系会被
          // dsh 工具出口的 lossless-JSON 边界拒绝（Agent 会话实证）
          ...(chosen.energyAboveHull !== undefined ? { energyAboveHull: chosen.energyAboveHull } : {}),
        },
        timestamp: Date.now(),
      })
      return material
    }
    throw new Error('No valid modality provided (file 模态在 MVP 中未实现)')
  }

  get formula() { return this.modalities.formula }
  get nAtoms() { return this._graph.nodes.length }
  get cell() { return this._graph.cell }
  get graph() { return this._graph }
  get lineage() { return [...this._lineage] }

  /** atomicView：廉价内联视图 */
  get atomicView() {
    return {
      nAtoms: this.nAtoms,
      elements: [...new Set(this._graph.nodes.map(n => n.number))],
      cell: this._graph.cell,
      positions: this._graph.nodes.map(n => n.position),
    }
  }

  /**
   * electronicView：DFT 计算产物，走异步计算管线（修订 #9）。
   * 交付物 = CalculationRecord（计算产物引用）+ 谱系条目，而非同步字段：
   *  - 能力门禁先行：引擎未声明的性质显式拒绝（绝不静默返回 null）
   *  - 记录经谱系 'electronic-calculated' 条目反查（append-only 溯源）
   */
  async electronicView(potential, params = {}) {
    const requested = params.properties ?? ['bandgap', 'dos']
    const provider = potential.resolveProvider(params, { type: 'calculate', nAtoms: this.nAtoms })
    potential.assertCalculable(provider, requested)
    const result = await provider.calculate(this, { properties: requested })
    const record = makeCalculationRecord({
      material: this, engine: provider.name, requested, result,
    })
    this._lineage.push({
      operation: 'electronic-calculated',
      detail: { calculationId: record.id, engine: record.engine, requested },
      timestamp: Date.now(),
    })
    return { source: 'calculation', calculationId: record.id, record }
  }

  /**
   * 掺杂/取代：把 nodes[siteIndex] 的原子换成 element，返回新 Material（不可变 fork 语义）。
   * 化学式自动重算，谱系记录 'substitute' 事件（来源、位点、取代元素）。
   * @param {number} siteIndex 原子位点下标
   * @param {string} element 取代元素符号（须在元素表内）
   */
  substitute(siteIndex, element) {
    const z = Z[element]
    if (!z) throw new Error(`Unknown element "${element}" (元素表子集：${Object.keys(Z).join(' ')})`)
    const nodes = this._graph.nodes.map(n => ({ ...n }))
    if (siteIndex < 0 || siteIndex >= nodes.length) {
      throw new Error(`siteIndex ${siteIndex} out of range (0..${nodes.length - 1})`)
    }
    nodes[siteIndex] = { ...nodes[siteIndex], number: z }
    const formula = composeFormula(nodes.map(n => n.number))
    const graph = { ...structuredClone(this._graph), nodes }
    const child = new Material(
      { id: randomUUID(), modalities: { graph, formula } },
      graph,
    )
    child._lineage = [
      ...this._lineage,
      {
        operation: 'substitute',
        detail: { parent: this.id, siteIndex, element, formula },
        timestamp: Date.now(),
      },
    ]
    return child
  }

  /** 谱系分叉 */
  fork(operation) {
    return new Material(
      { modalities: { graph: structuredClone(this._graph), formula: this.formula } },
      structuredClone(this._graph),
    )
  }

  /** 序列化（跨进程/引擎传递的统一中间表示） */
  toDict() {
    return {
      id: this.id,
      modalities: this.modalities,
      positions: this._graph.nodes.map(n => n.position),
      numbers: this._graph.nodes.map(n => n.number),
      cell: this._graph.cell,
    }
  }
}

/** Material 服务（经 kernel 注册为 cordis 服务） */
export class MaterialService {
  constructor(resolver) {
    this.resolver = resolver
    this.store = new Map()
  }

  async load(query, opts = {}) {
    const material = await Material.create(
      { modalities: { formula: query } },
      this.resolver,
      opts,
    )
    this.store.set(material.id, material)
    return material
  }

  async get(id) {
    const m = this.store.get(id)
    if (!m) throw new Error(`Material ${id} not found in session store`)
    return m
  }
}
