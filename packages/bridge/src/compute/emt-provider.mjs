// EMT-mock Provider —— 零 license 依赖的占位引擎
// 计算实体在 Python sidecar（MVP 用 numpy/scipy 实现的 LJ 玩具势；
// 生产环境替换为 ASE EMT，接口不变）。
// 价值：除真实引擎适配外的全部开发、CI、演示都不依赖 VASP/LAMMPS。

import { randomUUID } from 'node:crypto'

export class EmtMockProvider {
  constructor(bridge) {
    this.bridge = bridge
    this.name = 'emt-mock'
    this.version = '0.1.0'
    this.manifest = {
      capabilities: [
        { type: 'relax', accuracy: 0.5, speed: 0.99, cost: 0.05, maxAtoms: 200 },
        // 势函数引擎只有基线物理量 + 应力相关量；电子结构性质不声明（诚实纪律）
        { type: 'calculate', accuracy: 0.5, speed: 0.99, cost: 0.05, maxAtoms: 200, properties: ['stress'] },
      ],
      constraints: { requiresLicense: false },
      eventGranularity: 'iteration',   // 契约 §5.2：逐迭代回调可用（sidecar 同步调用形态）
      // M1（单位与指纹）：sidecar 实现 LJ 玩具势（eV/Å/fs）；method 如实声明
      // LJ-mock——与真实 EMT 指纹不同，跨引擎组合时门禁会拦下混用（这正是目的）
      units: { energy: 'eV', length: 'Å', time: 'fs' },
      fingerprint: { software: 'emt-mock', method: 'LJ-mock', version: 'unknown' },
    }
  }

  /** 运行期可用性探针：sidecar hello 握手通过即可用（布尔语义，不抛） */
  async available() {
    try {
      const h = await this.bridge.call('hello', {}, { timeoutMs: 10_000 })
      return Boolean(h?.sidecar)
    } catch {
      return false
    }
  }

  async relax(material, params = {}) {
    const jobId = randomUUID()
    const result = await this.bridge.call('relax', {
      structure: material.toDict(),
      params,
    })
    return {
      jobId,
      engine: this.name,
      material: { id: material.id, formula: material.formula },
      ...result,
    }
  }

  async calculate(material, params = {}) {
    const jobId = randomUUID()
    const result = await this.bridge.call('calculate', {
      structure: material.toDict(),
      params,
    })
    return { jobId, engine: this.name, ...result }
  }

  /**
   * 元素参考态每原子能量（热力学第一档）：形成焓的显式能量零点。
   * 数据面承诺：真 EMT fcc 单胞全弛豫；无 ASE 或元素不支持时错误原样传播，
   * 调用方诚实降级（不附热力学字段），绝不静默假设零点。
   */
  async referenceEnergy(symbol, params = {}) {
    return this.bridge.call('reference_energy', { symbol, params })
  }
}

/** 注册表条目：仅用于验证 autoRoute 画像逻辑（不产生真实计算） */
export const VASP_LIKE_MANIFEST = {
  name: 'vasp',
  manifest: {
    capabilities: [{ type: 'calculate', accuracy: 0.95, speed: 0.3, cost: 0.9, maxAtoms: 500, properties: ['stress', 'bandgap', 'dos'] },
                   { type: 'relax', accuracy: 0.95, speed: 0.3, cost: 0.9, maxAtoms: 500 }],
    constraints: { requiresLicense: true },
    eventGranularity: 'job',           // 批处理形态示意：仅任务级事件，拒绝细粒度监听
    units: { energy: 'eV', length: 'Å', time: 'fs' },
    fingerprint: { software: 'vasp', method: 'DFT-PBE', version: 'unknown' },
  },
}
