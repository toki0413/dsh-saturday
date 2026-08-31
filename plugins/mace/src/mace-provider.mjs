// MACE Provider —— PotentialProvider seam 的机器学习势实现（契约 §4.2）
// 与 LAMMPS 经典势对照的另一条路线：基于 mace-torch 的通用 ML 势（MACE-MP 等）。
//
// 形态：一次性 Python 子进程推理（无 sidecar 常驻），事件粒度 'job'。
// 可用性预检：relax 前先探测 `import mace`；不可用显式抛
// ENGINE_UNAVAILABLE，绝不静默降级（契约 §4.2 路由契约）。
// 探测与执行器均可注入，测试无需安装 torch。

import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { randomUUID } from 'node:crypto'

export class EngineUnavailableError extends Error {
  constructor(model, cause) {
    super(`MACE engine ("${model}") is unavailable: ${cause}. ` +
          'Install mace-torch (pip install mace-torch) or inject a transport; ' +
          'Saturday never silently substitutes another engine')
    this.code = 'ENGINE_UNAVAILABLE'
  }
}

/** 默认执行脚本：stdin 收结构 JSON，stdout 吐结果 JSON。
 *  CI 无 torch 环境，此路径不做集成断言——诚实标注为"待真实环境核验"。 */
const MACE_RELAX_SCRIPT = `
import json, sys
from ase import Atoms
from ase.optimize import BFGS
from mace.calculators import mace_mp
spec = json.load(sys.stdin)
graph = spec['graph']
atoms = Atoms(numbers=[n['number'] for n in graph['nodes']],
              positions=[n['position'] for n in graph['nodes']],
              cell=graph['cell'], pbc=graph['periodic'])
atoms.calc = mace_mp(model=spec.get('model', 'medium'), default_dtype='float64')
opt = BFGS(atoms)
converged = opt.run(fmax=spec['params'].get('fmax', 0.05),
                    steps=spec['params'].get('max_steps', 200))
print(json.dumps({'converged': bool(converged),
                  'energy': float(atoms.get_potential_energy()),
                  'n_steps': int(opt.nsteps)}))
`

export class MaceProvider {
  name = 'mace'
  version = '0.1.0'
  manifest = {
    capabilities: [
      // ML 通用势的典型定位：精度接近 DFT、速度远超 DFT；比经典势更通用（无需按体系配势）
      { type: 'relax', accuracy: 0.88, speed: 0.8, cost: 0.25, maxAtoms: 100_000 },
      { type: 'calculate', accuracy: 0.88, speed: 0.85, cost: 0.25, maxAtoms: 100_000 },
    ],
    constraints: { requiresLicense: false },
    eventGranularity: 'job',   // 一次性子进程推理：只有任务级事件
    // M1（单位与指纹）：MACE-MP 输出 eV/Å/fs；档位（small/medium/large）是配置项，
    // 运行时版本/档位未回读 → unknown（诚实降级，不冒充已知）
    units: { energy: 'eV', length: 'Å', time: 'fs' },
    fingerprint: { software: 'mace', method: 'ML-MACE', version: 'unknown' },
  }

  /**
   * @param {Object}   opts
   * @param {string}  [opts.model]      MACE-MP 档位（'small'|'medium'|'large'）
   * @param {string}  [opts.python]     Python 命令（Windows 默认 'python'）
   * @param {Function}[opts.spawnImpl]   子进程执行器注入（测试用伪进程）
   * @param {Function}[opts.checkImpl]  可用性探测注入：() => Promise<boolean>
   * @param {Function}[opts.runImpl]    执行器注入：(material, params) => Promise<result>
   */
  constructor({ model = 'medium', python, spawnImpl, checkImpl, runImpl } = {}) {
    this.model = model
    this.python = python ?? (platform() === 'win32' ? 'python' : 'python3')
    this.spawnImpl = spawnImpl ?? spawn
    this.checkImpl = checkImpl ?? (() => this.probeModule())
    this.runImpl = runImpl ?? ((material, params) => this.runOnce(material, params))
  }

  /** 默认探测：`python -c "import mace"`，退出码 0 即可用 */
  probeModule() {
    return new Promise(resolve => {
      const child = this.spawnImpl(this.python, ['-c', 'import mace'])
      child.on('error', () => resolve(false))
      child.on('close', code => resolve(code === 0))
    })
  }

  /**
   * 运行时版本回读（实测态）：`python -c "import mace; print(mace.__version__)"`。
   * 探测失败（模块缺失/退出异常/无输出）返回 null——诚实降级保持 'unknown'，不冒充。
   */
  probeVersion() {
    return new Promise(resolve => {
      let out = ''
      let child
      try {
        child = this.spawnImpl(this.python, ['-c', 'import mace; print(mace.__version__)'])
      } catch {
        return resolve(null)
      }
      child.stdout.on('data', d => out += d)
      child.on('error', () => resolve(null))
      child.on('close', code => resolve(code === 0 && out.trim() ? out.trim() : null))
    })
  }

  /** 默认真实执行：结构 JSON 走 stdin，结果 JSON 走 stdout */
  runOnce(material, params = {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.python, ['-c', MACE_RELAX_SCRIPT])
      let out = '', err = ''
      child.stdout.on('data', d => out += d)
      child.stderr.on('data', d => err += d)
      child.on('error', e => reject(new EngineUnavailableError(this.model, e.message)))
      child.on('close', code => {
        if (code !== 0) return reject(new EngineUnavailableError(this.model, err.slice(0, 200) || `exit ${code}`))
        try { resolve(JSON.parse(out)) }
        catch { reject(new Error(`MACE runner returned unparseable output: ${out.slice(0, 120)}`)) }
      })
      child.stdin.write(JSON.stringify({ graph: material.graph, model: this.model, params }))
      child.stdin.end()
    })
  }

  async relax(material, params = {}) {
    // 预检即门禁：每次放松前探测（结果不缓存——环境可能在运行中变化）
    const available = await this.checkImpl()
    if (!available) {
      throw new EngineUnavailableError(this.model, 'python module "mace" is not importable')
    }
    const jobId = randomUUID()
    const t0 = Date.now()
    const result = await this.runImpl(material, params)
    return {
      jobId,
      engine: this.name,
      converged: result.converged,
      energy: result.energy,
      n_steps: result.n_steps ?? 0,
      calculator: `mace:${this.model}`,
      wall_seconds: (Date.now() - t0) / 1000,
    }
  }
}
