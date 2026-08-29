// AseProvider —— PotentialProvider seam 的通用 ASE 计算器实现（契约 §4.2）
// 常驻 sidecar 形态（与 emt-mock 相同），但计算器由调用方显式指定：
// 'lj'（任意元素）或 'emt'（ASE 内置 EMT 元素子集），侧车不可用或
// 计算器缺失时抛结构化错误（ENGINE_UNAVAILABLE），绝不隐式替换。

import { randomUUID } from 'node:crypto'

export class EngineUnavailableError extends Error {
  constructor(calculator, cause) {
    super(`ASE calculator "${calculator}" is unavailable: ${cause}. ` +
          'Saturday never silently substitutes another calculator')
    this.code = 'ENGINE_UNAVAILABLE'
  }
}

export class AseProvider {
  name = 'ase'
  version = '0.1.0'
  manifest = {
    capabilities: [
      // ASE 通用计算器：精度介于玩具势与 ML 势之间（LJ 低 / EMT 中），
      // 常驻进程 + 轻量优化，速度与成本都接近免费
      { type: 'relax', accuracy: 0.6, speed: 0.95, cost: 0.05, maxAtoms: 10_000 },
      { type: 'calculate', accuracy: 0.6, speed: 0.97, cost: 0.05, maxAtoms: 10_000 },
    ],
    constraints: { requiresLicense: false },
    eventGranularity: 'iteration',   // 常驻 sidecar：逐调用同步形态
  }

  /**
   * @param {Object}  opts
   * @param {Object}  opts.bridge           已连接的 PythonBridge（或其同协议替身）
   * @param {string} [opts.calculator]      ASE 计算器名（默认 'lj'；'emt' 限 EMT 元素）
   * @param {Object} [opts.calculatorParams] 透传给计算器构造函数的参数（如 LJ 的 epsilon）
   */
  constructor({ bridge, calculator = 'lj', calculatorParams = {} } = {}) {
    if (!bridge) throw new Error('AseProvider requires a connected bridge (inject PythonBridge)')
    this.bridge = bridge
    this.calculator = calculator
    this.calculatorParams = calculatorParams
  }

  async relax(material, params = {}) {
    const jobId = randomUUID()
    const t0 = Date.now()
    let result
    try {
      result = await this.bridge.call('relax', {
        structure: material.toDict(),
        calculator: { name: this.calculator, params: this.calculatorParams },
        params,
      })
    } catch (err) {
      // sidecar 结构化错误（EngineUnavailableError / ImportError）→ 显式失败
      if (/EngineUnavailableError|ImportError|ModuleNotFoundError/.test(err.message)) {
        throw new EngineUnavailableError(this.calculator, err.message)
      }
      throw err
    }
    return {
      jobId,
      engine: this.name,
      converged: result.converged,
      energy: result.energy,
      n_steps: result.n_steps ?? 0,
      calculator: `ase:${this.calculator}`,
      wall_seconds: (Date.now() - t0) / 1000,
    }
  }
}
