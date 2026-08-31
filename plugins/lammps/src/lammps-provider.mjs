// LAMMPS Provider —— PotentialProvider seam 的批处理引擎实现（契约 §4.2）
// 形态：批处理二进制（非 sidecar 常驻进程），事件粒度只能是 'job'——
// 细粒度监听请求必须被显式拒绝（契约 §5.2），这正是本插件要压测的契约点。
//
// 可测试性：二进制名与执行器可注入；无 LAMMPS 环境下 relax 显式报
// ENGINE_UNAVAILABLE，绝不静默降级到别的引擎（契约 §4.2 路由契约）。

import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SYMBOL } from '@saturday/core/elements'

export class EngineUnavailableError extends Error {
  constructor(binary, cause) {
    super(`LAMMPS binary "${binary}" is unavailable: ${cause}. ` +
          'Install LAMMPS or set config.binary; Saturday never silently substitutes another engine')
    this.code = 'ENGINE_UNAVAILABLE'
  }
}

/** v0 支持元素的原子量（g/mol）；未覆盖元素显式报错 */
const MASSES = {
  Al: 26.982, Cu: 63.546, Ag: 107.868, Au: 196.967,
  Ni: 58.693, Pd: 106.42, Pt: 195.084, Fe: 55.845, Si: 28.085,
}

/** AtomGraph → LAMMPS data file（atom_style atomic，v0 仅支持正交盒） */
export function toLammpsData(graph) {
  const cell = graph.cell
  const offDiag = [0, 1, 2].some(i => [0, 1, 2].some(j => i !== j && Math.abs(cell[i][j]) > 1e-9))
  if (offDiag) throw new Error('LAMMPS provider v0: only orthogonal cells supported')

  const numbers = graph.nodes.map(n => n.number)
  const species = [...new Set(numbers)].sort((a, b) => a - b)
  const typeOf = new Map(species.map((z, i) => [z, i + 1]))

  const lines = [
    '# Saturday → LAMMPS data file (atom_style atomic)',
    '',
    `${graph.nodes.length} atoms`,
    `${species.length} atom types`,
    '',
    `0.0 ${cell[0][0]} xlo xhi`,
    `0.0 ${cell[1][1]} ylo yhi`,
    `0.0 ${cell[2][2]} zlo zhi`,
    '',
    'Masses',
    '',
    ...species.map((z, i) => {
      const el = SYMBOL[z]
      if (!MASSES[el]) throw new Error(`No atomic mass registered for element "${el}" (add to MASSES)`)
      return `${i + 1} ${MASSES[el]}   # ${el}`
    }),
    '',
    'Atoms',
    '',
    ...graph.nodes.map((n, i) =>
      `${i + 1} ${typeOf.get(n.number)} ${n.position.map(x => x.toFixed(6)).join(' ')}`),
    '',
  ]
  return lines.join('\n')
}

/** 最小弛豫输入脚本（势文件由调用方提供） */
export function buildInputScript({ potentialFile }) {
  return [
    'units metal',
    'atom_style atomic',
    'boundary p p p',
    `read_data data.lammps`,
    `pair_style eam/alloy`,
    `pair_coeff * * ${potentialFile}`,
    'fix 1 all box/relax iso 0.0',
    'minimize 1.0e-8 1.0e-8 1000 10000',
    'variable pe equal pe',
    'print "SATURDAY_ENERGY ${pe}"',
  ].join('\n') + '\n'
}

export class LammpsProvider {
  name = 'lammps'
  version = '0.1.0'
  manifest = {
    capabilities: [
      // 经典势的典型定位：快、便宜、百万原子级；精度低于 DFT（对比值见契约 §4.2）
      { type: 'relax', accuracy: 0.7, speed: 0.85, cost: 0.15, maxAtoms: 1_000_000 },
    ],
    constraints: { requiresLicense: false },
    eventGranularity: 'job',   // 批处理二进制：只有任务级事件，无逐迭代回调
    // M1（单位与指纹）：输入脚本走 metal 单位制（eV/Å/fs）；势函数类型随配势
    // 变化（默认 EAM），运行时版本未探测 → unknown（诚实降级）
    units: { energy: 'eV', length: 'Å', time: 'fs' },
    fingerprint: { software: 'lammps', method: 'metal-EAM', version: 'unknown' },
  }

  /**
   * @param {Object}  opts
   * @param {string} [opts.binary]        LAMMPS 可执行文件名/路径（默认 'lmp'）
   * @param {string} [opts.potentialFile] EAM 势文件路径（relax 必需）
   * @param {Function}[opts.spawnImpl]    执行器注入（测试用伪二进制）
   */
  constructor({ binary = 'lmp', potentialFile, spawnImpl } = {}) {
    this.binary = binary
    this.potentialFile = potentialFile
    this.spawnImpl = spawnImpl ?? spawn
  }

  /**
   * 运行时版本回读（实测态）：`binary -h` 解析横幅行（LAMMPS (2 Aug 2023) …）。
   * 探测失败（无二进制/启动异常/无横幅）返回 null——诚实降级保持 'unknown'，
   * 绝不拿非实测值盖章（与 M1 诚实降级同款纪律）。
   */
  probeVersion() {
    return new Promise(resolve => {
      let out = ''
      let child
      try {
        child = this.spawnImpl(this.binary, ['-h'])
      } catch {
        return resolve(null)
      }
      child.stdout.on('data', d => out += d)
      child.on('error', () => resolve(null))
      child.on('close', code => {
        const m = out.match(/LAMMPS\s*\(([^)]+)\)/)
        resolve(code === 0 && m ? m[1].trim() : null)
      })
    })
  }

  async relax(material, params = {}) {
    if (!this.potentialFile) {
      throw new EngineUnavailableError(this.binary, 'no potential file configured (config.potentialFile)')
    }
    const jobId = randomUUID()
    const dir = await mkdtemp(join(tmpdir(), 'saturday-lammps-'))
    await writeFile(join(dir, 'data.lammps'), toLammpsData(material.graph))
    await writeFile(join(dir, 'input.lammps'), buildInputScript({ potentialFile: this.potentialFile }))

    const t0 = Date.now()
    const log = await this.run(dir)
    const energy = parseFinalEnergy(log)
    return {
      jobId,
      engine: this.name,
      converged: true,
      energy,
      n_steps: 0,               // v0：批处理形态不回传步数（事件粒度 'job' 的直接后果）
      calculator: 'lammps',
      wall_seconds: (Date.now() - t0) / 1000,
    }
  }

  run(dir) {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.binary, ['-in', 'input.lammps'], { cwd: dir })
      let out = '', err = ''
      child.stdout.on('data', d => out += d)
      child.stderr.on('data', d => err += d)
      child.on('error', e => reject(new EngineUnavailableError(this.binary, e.message)))
      child.on('close', code => code === 0
        ? resolve(out)
        : reject(new Error(`LAMMPS exited with code ${code}: ${err.slice(0, 200)}`)))
    })
  }
}

/** 解析日志中的终态能量（脚本末行 print "SATURDAY_ENERGY ..."） */
export function parseFinalEnergy(log) {
  const m = [...log.matchAll(/SATURDAY_ENERGY\s+(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/g)].pop()
  if (!m) throw new Error('LAMMPS log missing SATURDAY_ENERGY marker')
  return parseFloat(m[1])
}
