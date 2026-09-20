// SDK 端到端实证：一个"读/吐 POSCAR 的 VASP 系引擎"，纯用 makeDescriptorProvider 装配
// （新代码只有描述符 + 选 poscar codec，provider 装配逻辑复用不改），过同一份 potentialProviderContract
// 与 conformanceReport。伪 spawn 会真去读回 provider 用 writePoscar 写出的 POSCAR 并用 readPoscar 解析
// （证明 #110 写侧端到端产出可被 VASP 类引擎消费的合法结构文件，不是空 echo），据原子数回能量。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeDescriptorProvider } from '@toki0413/core/descriptor-provider'
import { conformanceReport } from '@toki0413/core/conformance'
import { readPoscar } from '@toki0413/core/codecs'
import { Material, PrototypeLibResolver } from '@toki0413/core'
import { potentialProviderContract } from '@toki0413/contract-tests'

// 读/吐 POSCAR 的引擎描述符：inputFormat 'poscar' → codec 用 writePoscar；CLI 一进一出，stdout 标记解析能量。
const POSCARCLI = {
  name: 'poscarcli', version: '0.0.1', displayName: 'POSCARCLI', binaryDefault: 'vasp-like',
  manifest: {
    capabilities: [{ type: 'relax', accuracy: 0.6, speed: 0.5, cost: 0.4, maxAtoms: 500 }],
    constraints: {}, eventGranularity: 'job',
    units: { energy: 'eV', length: 'Å', time: 'fs' },
    fingerprint: { software: 'poscarcli', method: 'demo-vasp-like', version: 'unknown' },
  },
  versionProbe: { args: ['--version'], regex: 'v(\\d+\\.\\d+)' },
  availability: { requireConfig: [] },
  structure: { inputFormat: 'poscar' },
  run: { dataFile: 'POSCAR', inputFile: 'INCAR', args: ['-IN', 'POSCAR'], template: 'ISIF=3\n' },
  output: { energy: { name: 'FINAL-E', regex: 'FINAL-E\\s+(-?\\d+(?:\\.\\d+)?)' } },
  result: { converged: true, nSteps: 0 },
}

// 伪 VASP 引擎：读回 provider 写出的 POSCAR，用 readPoscar 解析（不合法即失败），按原子数回总能量。
function poscarSpawn(perAtom) {
  return (binary, args, opts = {}) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    setImmediate(() => {
      try {
        const text = readFileSync(join(opts.cwd, POSCARCLI.run.dataFile), 'utf8')
        const g = readPoscar(text)             // 若 writePoscar 产物非合法 POSCAR，这里抛 → close 1
        child.stdout.emit('data', Buffer.from(`ITER 0\nFINAL-E ${(perAtom * g.nodes.length).toFixed(6)}  natoms=${g.nodes.length}\n`))
        child.emit('close', 0)
      } catch (e) {
        child.stderr.emit('data', Buffer.from('POSCAR parse failed: ' + e.message))
        child.emit('close', 1)
      }
    })
    return child
  }
}
const okProvider = () => makeDescriptorProvider(POSCARCLI, { spawnImpl: poscarSpawn(-3.7) })

test('1. poscar 描述符过 conformance 门禁（静态）', () => {
  const rep = conformanceReport({ provider: okProvider() })
  assert.equal(rep.passed, true, rep.checks.filter(c => !c.ok).map(c => `${c.id}:${c.detail}`).join(' | '))
  assert.equal(rep.subject, 'poscarcli'); assert.equal(rep.eventGranularity, 'job')
})

test('2. relax 端到端：伪引擎读回合法 POSCAR 并按原子数回能量', async () => {
  const cu = await Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())
  const r = await okProvider().relax(cu)
  assert.equal(r.engine, 'poscarcli')
  assert.equal(r.converged, true)
  assert.ok(Math.abs(r.energy - (-3.7 * cu.graph.nodes.length)) < 1e-6,
    `能量 = -3.7×原子数（伪引擎真解析了 writePoscar 产物）；got ${r.energy}`)
})

// 描述符装配的 poscar 引擎过同一份运行时契约（与 ase/lammps/mace/xyzcli 同一入口）；
// potentialProviderContract 内部注册子测试，须顶层调用，不包在 test() 内。
potentialProviderContract({
  subject: 'poscarcli（descriptor 装配 poscar codec，零 provider 代码）',
  createProvider: () => okProvider(),
  runnable: true, runFormula: 'Cu',
  unavailable: {
    createProvider: () => makeDescriptorProvider(POSCARCLI, {
      spawnImpl: () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); setImmediate(() => c.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))); return c },
    }),
    code: 'ENGINE_UNAVAILABLE',
  },
})
