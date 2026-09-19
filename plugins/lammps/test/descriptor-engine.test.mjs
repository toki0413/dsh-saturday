// SDK 泛化验证：一个"非 lammps、读不同格式(XYZ)"的第二个引擎，纯用 makeDescriptorProvider 装配
// （新代码只有描述符 + 一个 codec，provider 装配逻辑复用不改），过同一份 potentialProviderContract
// 与 conformanceReport。证明"接新引擎 = 描述符 + 选 codec、零 provider 代码"不是只对 lammps 成立。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { makeDescriptorProvider } from '@toki0413/core/descriptor-provider'
import { conformanceReport } from '@toki0413/core/conformance'
import { writeXyz } from '@toki0413/core/codecs'
import { Material, PrototypeLibResolver } from '@toki0413/core'
import { potentialProviderContract } from '@toki0413/contract-tests'

function fakeChild({ stdout = '', exitCode = 0, spawnError = null } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  setImmediate(() => {
    if (spawnError) return child.emit('error', spawnError)
    if (stdout) child.stdout.emit('data', Buffer.from(stdout))
    child.emit('close', exitCode)
  })
  return child
}

// 第二个引擎描述符：读 xyz、CLI 一进一出、输出标记解析能量。与 lammps 不同名、不同格式、不同脚本。
const XYZCLI = {
  name: 'xyzcli', version: '0.0.1', displayName: 'XYZCLI', binaryDefault: 'xcmd',
  manifest: {
    capabilities: [{ type: 'relax', accuracy: 0.6, speed: 0.6, cost: 0.3, maxAtoms: 500 }],
    constraints: {}, eventGranularity: 'job',
    units: { energy: 'eV', length: 'Å', time: 'fs' },
    fingerprint: { software: 'xyzcli', method: 'demo-ff', version: 'unknown' },
  },
  versionProbe: { args: ['--version'], regex: 'v(\\d+\\.\\d+)' },
  availability: { requireConfig: [] },
  structure: { inputFormat: 'xyz' },
  run: { dataFile: 'in.xyz', inputFile: 'run.cmd', args: ['in.xyz'], template: 'relax run\n' },
  output: { energy: { name: 'TOTAL', regex: 'TOTAL\\s*=\\s*(-?\\d+(?:\\.\\d+)?)' } },
  result: { converged: true, nSteps: 0 },
}
const okProvider = () => makeDescriptorProvider(XYZCLI, {
  spawnImpl: () => fakeChild({ stdout: 'running...\nTOTAL = -7.5123\n' }),
})

test('1. xyz codec 忠实格式（第二格式，独立于 lammps-data）', async () => {
  const cu = await Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())
  const xyz = writeXyz(cu.graph)
  const lines = xyz.trim().split('\n')
  assert.equal(lines[0], String(cu.graph.nodes.length))
  assert.match(lines[2], /^Cu\s+-?\d+\.\d{6}\s+-?\d+\.\d{6}\s+-?\d+\.\d{6}$/)
})

// 第二个描述符引擎过同一份运行时契约（与 ase/lammps/mace 同一入口）——potentialProviderContract
// 内部注册子测试，须在模块顶层调用（嵌进 test() 回调会被取消），故不包在 test() 内。
potentialProviderContract({
  subject: 'xyzcli（descriptor 装配，零 provider 代码）',
  createProvider: () => okProvider(),
  runnable: true, runFormula: 'Cu',
  unavailable: {
    createProvider: () => makeDescriptorProvider(XYZCLI, {
      spawnImpl: () => fakeChild({ spawnError: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }),
    }),
    code: 'ENGINE_UNAVAILABLE',
  },
})

test('3. 第二个引擎过 conformance 门禁 + relax 解析能量', async () => {
  const rep = conformanceReport({ provider: okProvider() })
  assert.equal(rep.passed, true, rep.checks.filter(c => !c.ok).map(c => `${c.id}:${c.detail}`).join(' | '))
  assert.equal(rep.subject, 'xyzcli'); assert.equal(rep.eventGranularity, 'job')
  const cu = await Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())
  const r = await okProvider().relax(cu)
  assert.equal(r.engine, 'xyzcli')
  assert.ok(Math.abs(r.energy - (-7.5123)) < 1e-9)
})
