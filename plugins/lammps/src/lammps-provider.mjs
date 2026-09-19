// LAMMPS Provider —— PotentialProvider seam 的批处理引擎实现（契约 §4.2）
// 形态：批处理二进制（非 sidecar 常驻进程），事件粒度只能是 'job'——
// 细粒度监听请求必须被显式拒绝（契约 §5.2），这正是本插件要压测的契约点。
//
// 本文件是 SDK"声明式引擎描述符 + 共享 codec"的第一次 dogfood：
//   provider 不再是手写命令/解析，而是由 @toki0413/core/descriptor-provider 读一份描述符装配，
//   结构序列化复用 @toki0413/core/codecs 的 lammps-data codec（质量走 core 共享表）。
//   外部计算组接一个读已支持格式的引擎，照此写描述符即可，不必手写 provider。
// 可测试性：二进制名与执行器可注入；无 LAMMPS 环境下 relax 显式报
// ENGINE_UNAVAILABLE，绝不静默降级到别的引擎（契约 §4.2 路由契约）。

import { spawn } from 'node:child_process'
import { writeLammpsData } from '@toki0413/core/codecs'
import { makeDescriptorProvider } from '@toki0413/core/descriptor-provider'

export class EngineUnavailableError extends Error {
  constructor(binary, cause) {
    super(`LAMMPS binary "${binary}" is unavailable: ${cause}. ` +
          'Install LAMMPS or set config.binary; Saturday never silently substitutes another engine')
    this.code = 'ENGINE_UNAVAILABLE'
  }
}

/** AtomGraph → LAMMPS data file（委托共享 codec；保留此导出兼容既有引用） */
export function toLammpsData(graph) {
  return writeLammpsData(graph)
}

/** 最小弛豫输入脚本（委托渲染；保留导出兼容）。势文件由调用方提供。 */
export function buildInputScript({ potentialFile }) {
  return DESCRIPTOR.run.template.replace(/\{\{dataFile\}\}/g, DESCRIPTOR.run.dataFile)
    .replace(/\{\{potentialFile\}\}/g, potentialFile)
}

/** 解析日志中的终态能量（脚本末行 print "SATURDAY_ENERGY ..."）；保留导出兼容。 */
export function parseFinalEnergy(log) {
  const m = [...log.matchAll(/SATURDAY_ENERGY\s+(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/g)].pop()
  if (!m) throw new Error('LAMMPS log missing SATURDAY_ENERGY marker')
  return parseFloat(m[1])
}

/**
 * LAMMPS 引擎描述符（数据）：命令/版本探测/可用性前置/输入格式/脚本模板/输出解析/能力指纹。
 * 手写 provider 的六项职责里，除结构序列化（交给共享 codec）外全部落到这里。
 */
export const DESCRIPTOR = {
  name: 'lammps',
  version: '0.1.0',
  displayName: 'LAMMPS',
  binaryDefault: 'lmp',
  manifest: {
    capabilities: [
      // 经典势典型定位：快、便宜、百万原子级；精度低于 DFT（对比值见契约 §4.2）
      { type: 'relax', accuracy: 0.7, speed: 0.85, cost: 0.15, maxAtoms: 1_000_000 },
    ],
    constraints: { requiresLicense: false },
    eventGranularity: 'job',   // 批处理二进制：只有任务级事件，无逐迭代回调
    units: { energy: 'eV', length: 'Å', time: 'fs' },   // metal 单位制
    fingerprint: { software: 'lammps', method: 'metal-EAM', version: 'unknown' },
  },
  versionProbe: { args: ['-h'], regex: String.raw`LAMMPS\s*\(([^)]+)\)` },
  availability: { requireConfig: [{ key: 'potentialFile', label: 'potential file' }] },
  structure: { inputFormat: 'lammps-data' },
  run: {
    dataFile: 'data.lammps',
    inputFile: 'input.lammps',
    args: ['-in', 'input.lammps'],
    template: [
      'units metal',
      'atom_style atomic',
      'boundary p p p',
      'read_data {{dataFile}}',
      'pair_style eam/alloy',
      'pair_coeff * * {{potentialFile}}',
      'fix 1 all box/relax iso 0.0',
      'minimize 1.0e-8 1.0e-8 1000 10000',
      'variable pe equal pe',
      'print "SATURDAY_ENERGY ${pe}"',
    ].join('\n') + '\n',
  },
  output: { energy: { name: 'SATURDAY_ENERGY', regex: String.raw`SATURDAY_ENERGY\s+(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)` } },
  result: { converged: true, nSteps: 0 },   // job 粒度：批处理不回传步数
}

export class LammpsProvider {
  constructor({ binary, potentialFile, spawnImpl } = {}) {
    this._p = makeDescriptorProvider(DESCRIPTOR, {
      binary, potentialFile, spawnImpl: spawnImpl ?? spawn,
      EngineUnavailableError: (b, cause) => new EngineUnavailableError(b, cause),
    })
  }
  get name() { return this._p.name }
  get version() { return this._p.version }
  get manifest() { return this._p.manifest }
  probeVersion() { return this._p.probeVersion() }
  probeAvailability() { return this._p.probeAvailability() }
  available() { return this._p.available() }
  relax(material, params) { return this._p.relax(material, params) }
}
