// MACE Provider —— PotentialProvider seam 的机器学习势实现（契约 §4.2）
// 与 LAMMPS 经典势对照的另一条路线：基于 mace-torch 的通用 ML 势（MACE-MP 等）。
//
// 双形态：
//  • 一次性子进程（缺省，历史形态）：每次调用 spawn python 跑推理脚本，仅实现 relax；
//  • 常驻 batch（resident: true）：复用 @toki0413/python-bridge 的 JSON-lines 协议，
//    模型只加载一次跨作业复用（一次性形态每次重载 torch+模型，GPU 在场时进程开销
//    远大于计算本身）；实现 relax/calculate/md 三作业，能力声明随模式动态生成——
//    实现什么声明什么，一次性形态绝不因常驻形态的存在而虚报 calculate/md
//    （#83 时代虚报 calculate 致 auto 选中后爆炸的实证教训）。
// 远程形态免费获得：transport 传 SshTransport 即经 SSH 在远程（如 GPU 集群）跑 sidecar。
// 可用性预检失败显式抛 ENGINE_UNAVAILABLE，绝不静默降级（契约 §4.2 路由契约）。
// 探测与执行器均可注入，测试无需安装 torch。

import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PythonBridge } from '@toki0413/python-bridge'

export class EngineUnavailableError extends Error {
  constructor(model, cause) {
    super(`MACE engine ("${model}") is unavailable: ${cause}. ` +
          'Install mace-torch (pip install mace-torch) or inject a transport; ' +
          'Saturday never silently substitutes another engine')
    this.code = 'ENGINE_UNAVAILABLE'
  }
}

export class MaceError extends Error {
  constructor(code, message) { super(`${message} (${code})`); this.code = code }
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

/** 能力声明随模式生成：一次性形态只声明它真实现的 relax */
const ONESHOT_CAPABILITIES = [
  { type: 'relax', accuracy: 0.88, speed: 0.8, cost: 0.25, maxAtoms: 100_000 },
]
/** 常驻形态额外实现并声明 calculate（能量+力）与 md（Langevin NVT）；
 *  不声明 stress 等未实现性质（assertCalculable 门禁按此显式拒绝） */
const RESIDENT_CAPABILITIES = [
  { type: 'relax', accuracy: 0.88, speed: 0.8, cost: 0.25, maxAtoms: 100_000 },
  { type: 'calculate', accuracy: 0.88, speed: 0.85, cost: 0.25, maxAtoms: 100_000, properties: ['stress'] },
  { type: 'md', accuracy: 0.88, speed: 0.75, cost: 0.25, maxAtoms: 100_000 },
]

export class MaceProvider {
  name = 'mace'
  version = '0.1.0'

  /**
   * @param {Object}   opts
   * @param {string}  [opts.model]      MACE-MP 档位（'small'|'medium'|'large'）
   * @param {boolean} [opts.resident]   常驻 batch 模式（python-bridge 协议，模型加载一次）
   * @param {string}  [opts.python]     Python 命令（Windows 默认 'python'）
   * @param {string}  [opts.sidecarPath] 常驻 sidecar 路径（缺省随包 mace_sidecar.py）
   * @param {object}  [opts.transport]  注入传输（SshTransport → 远程/GPU 集群跑 sidecar）
   * @param {object}  [opts.bridge]      注入 PythonBridge 替身（测试用）
   * @param {Function}[opts.spawnImpl]   子进程执行器注入（一次性形态测试用）
   * @param {Function}[opts.checkImpl]   可用性探测注入：() => Promise<boolean>
   * @param {Function}[opts.runImpl]     一次性执行器注入：(material, params) => Promise<result>
   */
  constructor({
    model = 'medium', python, spawnImpl, checkImpl, runImpl,
    resident = false, bridge, sidecarPath, transport,
  } = {}) {
    this.model = model
    this.resident = resident === true
    this.python = python ?? (platform() === 'win32' ? 'python' : 'python3')
    this.spawnImpl = spawnImpl ?? spawn
    this.checkImpl = checkImpl ?? (() => this.probeModule())
    this.runImpl = runImpl ?? ((material, params) => this.runOnce(material, params))

    // 常驻模式：模型加载一次的 sidecar 通道（本地子进程或注入 transport）
    this.bridge = null
    if (this.resident) {
      this._hello = null
      this._connected = false
      this._bridgeOwned = bridge == null
      this.bridge = bridge ?? new PythonBridge(transport
        ? { transport }
        : { python: this.python, sidecar: sidecarPath ??
            fileURLToPath(new URL('../sidecar/mace_sidecar.py', import.meta.url)) })
    }

    this.manifest = {
      capabilities: this.resident ? RESIDENT_CAPABILITIES : ONESHOT_CAPABILITIES,
      constraints: { requiresLicense: false },
      eventGranularity: 'job',   // 两种形态都是任务级事件（无逐迭代回调）
      // M1（单位与指纹）：MACE-MP 输出 eV/Å/fs；档位（small/medium/large）是配置项，
      // 运行时版本/档位未回读 → unknown（诚实降级，不冒充已知）
      units: { energy: 'eV', length: 'Å', time: 'fs' },
      fingerprint: { software: 'mace', method: 'ML-MACE', version: 'unknown' },
    }
  }

  /** 默认探测：`python -c "import mace"`，退出码 0 即可用 */
  probeModule() {
    return new Promise(resolve => {
      const child = this.spawnImpl(this.python, ['-c', 'import mace'])
      child.on('error', () => resolve(false))
      child.on('close', code => resolve(code === 0))
    })
  }

  /** 运行时版本回读（实测态）：一次性形态 `python -c "import mace; print(mace.__version__)"`；
   *  常驻形态握手 hello 携带实测版本。探测失败诚实返回 null——保持 'unknown' 不冒充。 */
  probeVersion() {
    if (this.resident) {
      return this.connect().then(h => h?.version ?? null).catch(() => null)
    }
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
        catch {
          // 宿主库可能向 stdout 打印警告（如 cuequivariance 提示）——提取最后一个 JSON 对象子串重试
          const start = out.lastIndexOf('\n{')
          if (start >= 0) {
            try { return resolve(JSON.parse(out.slice(start + 1))) } catch { /* fallthrough */ }
          }
          reject(new Error(`MACE runner returned unparseable output: ${out.slice(0, 120)}`))
        }
      })
      child.stdin.write(JSON.stringify({ graph: material.graph, model: this.model, params }))
      child.stdin.end()
    })
  }

  // ── 常驻 batch 模式：模型加载一次，跨作业复用 ──────────────────

  /** 连接即就绪验证：hello 握手会加载模型（失败在此暴露，不留到首个作业） */
  async connect() {
    if (!this.resident) {
      throw new MaceError('MODE_UNSUPPORTED', 'connect() 属常驻模式（resident: true）；一次性形态无需连接')
    }
    if (!this._connected) {
      await this.bridge.connect()
      this._hello = this.bridge.sidecarInfo ?? null
      this._connected = true
    }
    return this._hello
  }

  async disconnect() {
    if (this.resident && this._connected) {
      this._connected = false
      this._hello = null
      await this.bridge.disconnect().catch(() => {})
    }
  }

  /** 常驻调用统一入口：连接级失败 → ENGINE_UNAVAILABLE（绝不静默换引擎）；
   *  异步作业过作业台账记账（register 时由 PotentialRegistry 鸭子注入 this.jobs），
   *  卸载路径据此 drain/refuse/cancel，不静默杀任务也不留孤儿 */
  async _call(method, params) {
    const jobId = this.jobs?.submit({ provider: this.name, kind: method })
    try {
      await this.connect()
      const result = await this.bridge.call(method, params)
      if (jobId != null) this.jobs.settle(jobId, 'ok')
      return result
    } catch (err) {
      if (jobId != null) this.jobs.settle(jobId, 'failed')
      if (err instanceof MaceError) throw err
      throw new EngineUnavailableError(this.model, err.message)
    }
  }

  /** 单点能量+力（eV、eV/Å）——仅常驻形态实现并声明（一次性形态调用即显式拒绝） */
  async calculate(material, params = {}) {
    if (!this.resident) {
      throw new MaceError('CAPABILITY_NOT_IMPLEMENTED',
        '一次性子进程形态未实现 calculate（manifest 亦未声明）；请启用 resident 模式')
    }
    const result = await this._call('calculate', { graph: material.graph, params })
    return { engine: this.name, calculator: result.calculator ?? `mace:${this.model}`, ...result }
  }

  /** Langevin NVT 系综 MD（仅常驻形态）；参数名对齐 md 原语约定（temperature_K 主名、
   *  temperatureK 别名；free-energy 工作流即此约定）；交付含 energies 采样轨迹 */
  async md(material, params = {}) {
    if (!this.resident) {
      throw new MaceError('CAPABILITY_NOT_IMPLEMENTED',
        '一次性子进程形态未实现 md（manifest 亦未声明）；请启用 resident 模式')
    }
    const temperature = params.temperature_K ?? params.temperatureK
    const steps = params.steps ?? 100
    const dt = params.dt_fs ?? params.dtFs ?? 1.0
    if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature <= 0) {
      throw new MaceError('MD_PARAMS_INVALID', `md requires temperature_K > 0 (K); got ${temperature}`)
    }
    if (!Number.isInteger(steps) || steps < 1) {
      throw new MaceError('MD_PARAMS_INVALID', `md requires integer steps >= 1; got ${steps}`)
    }
    if (typeof dt !== 'number' || !(dt > 0)) {
      throw new MaceError('MD_PARAMS_INVALID', `md requires dt_fs > 0 (fs); got ${dt}`)
    }
    const result = await this._call('md', {
      graph: material.graph,
      params: { ...params, temperature_K: temperature, dt_fs: dt, steps },
    })
    if (!Array.isArray(result?.energies)) {
      throw new EngineUnavailableError(this.model, 'md returned no energies series (sidecar 协议漂移)')
    }
    return { engine: this.name, calculator: result.calculator ?? `mace:${this.model}`, ...result }
  }

  /** 一次性形态的异步执行也记账（卸载同样需知道在途作业） */
  async relax(material, params = {}) {
    const jobId = randomUUID()
    const t0 = Date.now()
    if (this.resident) {
      // 常驻模式：连接即门禁（hello 已验证就绪），不再每作业 spawn 探测
      const result = await this._call('relax', { graph: material.graph, params })
      return {
        jobId,
        engine: this.name,
        converged: result.converged,
        energy: result.energy,
        n_steps: result.n_steps ?? 0,
        positions: result.positions,
        calculator: result.calculator ?? `mace:${this.model}`,
        wall_seconds: (Date.now() - t0) / 1000,
      }
    }
    // 一次性模式预检即门禁：每次放松前探测（结果不缓存——环境可能在运行中变化）
    const ledgerId = this.jobs?.submit({ provider: this.name, materialId: material?.id ?? null, kind: 'relax' })
    let available
    try {
      available = await this.checkImpl()
    } finally {
      if (ledgerId != null) this.jobs.settle(ledgerId, available ? 'ok' : 'failed')
    }
    if (!available) {
      throw new EngineUnavailableError(this.model, 'python module "mace" is not importable')
    }
    const runId = this.jobs?.submit({ provider: this.name, materialId: material?.id ?? null, kind: 'relax' })
    let result
    try {
      result = await this.runImpl(material, params)
      if (runId != null) this.jobs.settle(runId, 'ok')
    } catch (e) {
      if (runId != null) this.jobs.settle(runId, 'failed')
      throw e
    }
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

  /** 取消能力声明：一次性形态无 cancel 通道——台账据此显式 CANCEL_UNSUPPORTED 而非假装能停 */
}
