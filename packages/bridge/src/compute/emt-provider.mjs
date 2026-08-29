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
}

/** 注册表条目：仅用于验证 autoRoute 画像逻辑（不产生真实计算） */
export const VASP_LIKE_MANIFEST = {
  name: 'vasp',
  manifest: {
    capabilities: [{ type: 'calculate', accuracy: 0.95, speed: 0.3, cost: 0.9, maxAtoms: 500, properties: ['stress', 'bandgap', 'dos'] },
                   { type: 'relax', accuracy: 0.95, speed: 0.3, cost: 0.9, maxAtoms: 500 }],
    constraints: { requiresLicense: true },
    eventGranularity: 'job',           // 批处理形态示意：仅任务级事件，拒绝细粒度监听
  },
}
