// Materials Project 结构源 —— StructureResolver seam 的远端实现（契约 §4.1）
// 与 PrototypeLibResolver 同构：同样的输入/输出形状，同样的错误码，
// 差异只在结构来源（API 而非内置原型库）——这就是 seam 契约的价值。
//
// 可测试性：HTTP 传输经构造函数注入（默认 globalThis.fetch），
// 测试用 stub 替换，无需真实 API Key 也能验证契约形状。

import { Z } from '@toki0413/core/elements'

export class MpApiKeyMissingError extends Error {
  constructor() {
    super('Materials Project API key required: pass config.apiKey or set MP_API_KEY. ' +
          'Get one at https://next-gen.materialsproject.org/api')
    this.code = 'MP_API_KEY_MISSING'
  }
}

export class StructureNotFoundError extends Error {
  constructor(formula) {
    super(`No structure found for formula "${formula}" in Materials Project`)
    this.code = 'STRUCTURE_NOT_FOUND'
  }
}

const DEFAULT_ENDPOINT = 'https://api.materialsproject.org'

export class MaterialsProjectResolver {
  name = 'materials-project'

  /**
   * @param {Object}   opts
   * @param {string}  [opts.apiKey]    MP API Key（缺失时 resolve 显式报错，不静默降级）
   * @param {string}  [opts.endpoint]  API 基址
   * @param {Function}[opts.fetchImpl] HTTP 传输（可注入，测试用）
   */
  constructor({ apiKey, endpoint = DEFAULT_ENDPOINT, fetchImpl } = {}) {
    this.apiKey = apiKey
    this.endpoint = endpoint.replace(/\/$/, '')
    this.fetchImpl = fetchImpl ?? globalThis.fetch
  }

  /** @returns {Promise<ResolvedStructure[]>} 按 energy_above_hull 升序赋 polymorphRank */
  async resolve(formula) {
    if (!this.apiKey) throw new MpApiKeyMissingError()
    const url = `${this.endpoint}/summary/?formula=${encodeURIComponent(formula)}` +
                `&fields=material_id,structure,energy_above_hull`
    const res = await this.fetchImpl(url, { headers: { 'X-API-KEY': this.apiKey } })
    if (!res.ok) throw new Error(`Materials Project API error: HTTP ${res.status}`)
    const { data } = await res.json()
    if (!Array.isArray(data) || data.length === 0) throw new StructureNotFoundError(formula)

    return data
      .slice()
      .sort((a, b) => (a.energy_above_hull ?? 0) - (b.energy_above_hull ?? 0))
      .map((entry, rank) => toResolvedStructure(entry, rank))
  }
}

/** MP JSON 结构（lattice.matrix + sites[].xyz/species）→ AtomGraph（笛卡尔坐标） */
function toResolvedStructure(entry, polymorphRank) {
  const { structure } = entry
  const nodes = structure.sites.map((site, i) => ({
    id: i,
    number: Z[site.species[0].element],
    position: site.xyz,
  }))
  return {
    graph: {
      nodes,
      edges: [],
      periodic: true,
      cell: structure.lattice.matrix,
    },
    source: entry.material_id,       // 'mp-166' 等，原样写入材料谱系
    polymorphRank,
    energyAboveHull: entry.energy_above_hull,
  }
}
