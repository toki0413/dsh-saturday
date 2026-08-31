// LjProvider —— PotentialProvider seam 的零依赖纯 JS 实现（契约 §4.2）
// 定位：开箱即用的数据面。任何装了 Node 的环境都能跑出真实数值结果；
// 物理档位是玩具势（manifest 如实声明低精度档），不冒充任何真实引擎——
// 指纹独立为 'lj-js'，跨引擎组合时 M1 门禁按既有纪律拦下混用。
// 无外部进程、无可选依赖：不存在 ENGINE_UNAVAILABLE 路径（始终可用）；
// 元素超参数表时抛 LJ_ELEMENT_UNSUPPORTED（显式失败，绝不编参数）。

import { randomUUID } from 'node:crypto'
import {
  ljCalculate, ljRelax, ljMd, ljHarmonic, ljReferenceEnergy, symbolsOf,
} from './lj-engine.mjs'

export class LjProvider {
  name = 'lj-js'
  version = '0.1.0'
  manifest = {
    capabilities: [
      // 玩具势档位：精度如实声明为低（0.3），速度/成本与所有纯势函数同级
      { type: 'relax', accuracy: 0.3, speed: 0.99, cost: 0.01, maxAtoms: 1_000 },
      // 基线物理量（能量+力）之外的性质不声明（诚实纪律：电子结构性质不在声明内）
      { type: 'calculate', accuracy: 0.3, speed: 0.99, cost: 0.01, maxAtoms: 1_000 },
      // §4.5 遍历对账的时间平均侧：Langevin 恒温 MD（BAOAB，种子确定性）
      { type: 'md', accuracy: 0.3, speed: 0.95, cost: 0.01, maxAtoms: 1_000 },
    ],
    constraints: { requiresLicense: false },
    eventGranularity: 'iteration',   // 契约 §5.2：进程内同步形态，逐迭代回调可用
    // M1（单位与指纹）：eV/Å/fs；fingerprint 的 version 即本包版本（进程内
    // 恒可回读，无探测失败态）——与 sidecar 引擎的 'unknown' 声明态不同
    units: { energy: 'eV', length: 'Å', time: 'fs' },
    fingerprint: { software: 'lj-js', method: 'LJ', version: '0.1.0' },
  }

  constructor(config = {}) {
    this.cutoffFactor = config.cutoffFactor ?? 2.5
    this._refCache = new Map()   // 元素参考态缓存（幂等：相同输入相同结果）
  }

  /** 进程内引擎：版本恒可回读（无外部进程，无探测失败态） */
  async probeVersion() {
    return this.version
  }

  async relax(material, params = {}) {
    const jobId = randomUUID()
    const t0 = Date.now()
    const dict = material.toDict()
    const symbols = symbolsOf(dict.numbers)
    const result = ljRelax(
      { positions: dict.positions, cell: dict.cell },
      symbols,
      { fmax: params.fmax, maxSteps: params.max_steps },
    )
    return {
      jobId,
      engine: this.name,
      material: { id: material.id, formula: material.formula },
      converged: result.converged,
      energy: result.energy,
      energy_initial: result.energy_initial,
      n_steps: result.n_steps,
      calculator: 'lj-js',
      positions: result.positions,
      cell: result.cell,
      wall_seconds: (Date.now() - t0) / 1000,
    }
  }

  /** 静态单点（能量 + 力）：遍历对账系综侧与常规分析共用 */
  async calculate(material, params = {}) {
    const jobId = randomUUID()
    const dict = material.toDict()
    const symbols = symbolsOf(dict.numbers)
    const result = ljCalculate(
      { positions: dict.positions, cell: dict.cell },
      symbols,
      { cutoffFactor: this.cutoffFactor },
    )
    // 基线物理量之外显式拒绝（诚实纪律：与注册表 assertCalculable 同款）
    for (const p of params.properties ?? []) {
      if (p !== 'energy' && p !== 'forces') {
        const e = new Error(
          `lj-js cannot compute property "${p}" (declared baseline only: energy, forces); ` +
          'electronic views must be explicitly rejected, never silently approximated')
        e.code = 'PROPERTY_UNSUPPORTED'
        throw e
      }
    }
    return { jobId, engine: this.name, calculator: 'lj-js', energy: result.energy, forces: result.forces }
  }

  /**
   * Langevin 恒温 MD（§4.5 遍历对账时间平均侧）。
   * @param {Material} material
   * @param {Object}   params { temperature_K, steps, dt_fs, sample_every, friction, seed }
   */
  async md(material, params = {}) {
    const jobId = randomUUID()
    const t0 = Date.now()
    const dict = material.toDict()
    const symbols = symbolsOf(dict.numbers)
    const result = ljMd(
      { positions: dict.positions, cell: dict.cell },
      symbols,
      {
        temperatureK: params.temperature_K,
        steps: params.steps,
        dtFs: params.dt_fs,
        sampleEvery: params.sample_every,
        friction: params.friction,
        seed: params.seed,
      },
    )
    return { jobId, engine: this.name, calculator: 'lj-js', ...result, wall_seconds: (Date.now() - t0) / 1000 }
  }

  /**
   * 谐波锚点数据面（§9 第二档锚点物理化）：弛豫 → 有限差分 Hessian → 简正模。
   * 与 ase_calc.harmonic 同规格：只交付 u0 与频率表；振动自由能闭式在
   * JS 纯层（单一闭式来源）。零模/虚频如实计数，绝不静默修正。
   */
  async harmonic(material, params = {}) {
    const jobId = randomUUID()
    const t0 = Date.now()
    const dict = material.toDict()
    const symbols = symbolsOf(dict.numbers)
    const result = ljHarmonic(
      { positions: dict.positions, cell: dict.cell },
      symbols,
      {
        fmax: params.fmax,
        maxSteps: params.max_steps,
        displacementAngstrom: params.displacement_angstrom,
        zeroModeTol: params.zero_mode_tol,
      },
    )
    return { jobId, engine: this.name, calculator: 'lj-js', ...result, wall_seconds: (Date.now() - t0) / 1000 }
  }

  /**
   * 元素参考态每原子能量（热力学第一档）：本引擎自洽的 LJ fcc 平衡态。
   * 如实标注来源——非实验值，也不冒充其他引擎的零点；跨引擎比较须先对指纹。
   */
  async referenceEnergy(symbol, _params = {}) {
    if (this._refCache.has(symbol)) return this._refCache.get(symbol)
    const result = ljReferenceEnergy(symbol)
    this._refCache.set(symbol, result)
    return result
  }
}
