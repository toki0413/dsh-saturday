// SDK 端到端实证：一个"读/吐 CIF 的引擎"，纯用 makeDescriptorProvider 装配（inputFormat 'cif' →
// writeCif 写出），伪引擎真读回该 CIF 并用 readCif 解析（产物非合法 CIF 即失败），据原子数回能量。
// 过 conformanceReport + 同一份 potentialProviderContract。与 #117 POSCAR 成对，把 CIF codec 推到端到端可回算。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeDescriptorProvider } from '@toki0413/core/descriptor-provider'
import { conformanceReport } from '@toki0413/core/conformance'
import { readCif } from '@toki0413/core/codecs'
import { Material, PrototypeLibResolver } from '@toki0413/core'
import { potentialProviderContract } from '@toki0413/contract-tests'

const CIFCLI = {
  name: 'cifcli', version: '0.0.1', displayName: 'CIFCLI', binaryDefault: 'cif-like',
  manifest: {
    capabilities: [{ type: 'relax', accuracy: 0.6, speed: 0.5, cost: 0.4, maxAtoms: 500 }],
    constraints: {}, eventGranularity: 'job',
    units: { energy: 'eV', length: 'Å', time: 'fs' },
    fingerprint: { software: 'cifcli', method: 'demo-cif-engine', version: 'unknown' },
  },
  versionProbe: { args: ['--version'], regex: 'v(\\d+\\.\\d+)' },
  availability: { requireConfig: [] },
  structure: { inputFormat: 'cif' },
  run: { dataFile: 'entry.cif', inputFile: 'cmd', args: ['-c', 'entry.cif'], template: 'relax\n' },
  output: { energy: { name: 'E_CIF', regex: 'E_CIF\\s+(-?\\d+(?:\\.\\d+)?)' } },
  result: { converged: true, nSteps: 0 },
}
// 伪 CIF 引擎：读回 provider 用 writeCif 写出的 CIF，readCif 解析（不合法即失败），按原子数回总能量。
function cifSpawn(perAtom) {
  return (binary, args, opts = {}) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    setImmediate(() => {
      try {
        const g = readCif(readFileSync(join(opts.cwd, CIFCLI.run.dataFile), 'utf8'))
        child.stdout.emit('data', Buffer.from(`E_CIF ${(perAtom * g.nodes.length).toFixed(6)}  natoms=${g.nodes.length}\n`))
        child.emit('close', 0)
      } catch (e) {
        child.stderr.emit('data', Buffer.from('CIF parse failed: ' + e.message))
        child.emit('close', 1)
      }
    })
    return child
  }
}
const okProvider = () => makeDescriptorProvider(CIFCLI, { spawnImpl: cifSpawn(-3.7) })

test('1. cif 描述符过 conformance 门禁（静态）', () => {
  const rep = conformanceReport({ provider: okProvider() })
  assert.equal(rep.passed, true, rep.checks.filter(c => !c.ok).map(c => `${c.id}:${c.detail}`).join(' | '))
  assert.equal(rep.subject, 'cifcli')
})

test('2. relax 端到端：伪引擎读回合法 CIF 并按原子数回能量', async () => {
  const cu = await Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())
  const r = await okProvider().relax(cu)
  assert.equal(r.engine, 'cifcli')
  assert.ok(Math.abs(r.energy - (-3.7 * cu.graph.nodes.length)) < 1e-6,
    `能量 = −3.7×原子数（伪引擎真解析了 writeCif 产物）；got ${r.energy}`)
})

potentialProviderContract({
  subject: 'cifcli（descriptor 装配 cif codec，零 provider 代码）',
  createProvider: () => okProvider(),
  runnable: true, runFormula: 'Cu',
  unavailable: {
    createProvider: () => makeDescriptorProvider(CIFCLI, {
      spawnImpl: () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); setImmediate(() => c.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))); return c },
    }),
    code: 'ENGINE_UNAVAILABLE',
  },
})
