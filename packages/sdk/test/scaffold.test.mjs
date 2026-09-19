// @toki0413/plugin-sdk 测试：模板描述符 → 装配出的 provider 真过 potentialProviderContract + conformance
// （证明"填描述符即得合规引擎插件"这条主张），外加生成器结构、名称校验、落盘。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { engineDescriptorTemplate, enginePluginFiles } from '../src/scaffold.mjs'
import { writePluginScaffold } from '../src/cli.mjs'
import { makeDescriptorProvider } from '@toki0413/core/descriptor-provider'
import { conformanceReport } from '@toki0413/core/conformance'
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
// 起步模板补上可跑字段（作者实际会照自己引擎填），证明脚手架端到端可用
function workingDescriptor() {
  const d = engineDescriptorTemplate({ name: 'demoeng' })
  d.versionProbe = { args: ['--version'], regex: 'v(\\d+\\.\\d+)' }
  d.run = { dataFile: 'in.dat', inputFile: 'run.in', args: ['in.dat'], template: 'relax\n' }
  d.output = { energy: { name: 'E', regex: 'E\\s*=\\s*(-?\\d+(?:\\.\\d+)?)' } }
  return d
}
const okProvider = (d) => makeDescriptorProvider(d, { binary: 'demoeng', spawnImpl: () => fakeChild({ stdout: 'E = -4.21\n' }) })
const errProvider = (d) => makeDescriptorProvider(d, { binary: 'demoeng', spawnImpl: () => fakeChild({ spawnError: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }) })

test('1. 生成器产四文件且 package/descriptor 合法', () => {
  const files = enginePluginFiles({ name: 'demoeng', descriptor: workingDescriptor() })
  assert.deepEqual(Object.keys(files).sort(), ['package.json', 'src/descriptor.mjs', 'src/index.mjs', 'test/descriptor.test.mjs'])
  const pkg = JSON.parse(files['package.json'])
  assert.equal(pkg.name, '@toki0413/plugin-demoeng')
  assert.ok(pkg.dependencies['@toki0413/core'] && pkg.dependencies['@toki0413/kernel'])
  assert.ok(files['src/descriptor.mjs'].includes('export const ENGINE_DESCRIPTOR'))
  assert.ok(files['src/index.mjs'].includes('makeDescriptorProvider'))
})

test('2. 名称/描述符校验显式报错', () => {
  assert.throws(() => enginePluginFiles({ name: 'Bad_Name', descriptor: undefined }), e => e.code === 'SDK_BAD_NAME')
  assert.throws(() => enginePluginFiles({ name: 'x', descriptor: { name: 'y' } }), e => e.code === 'SDK_NAME_MISMATCH')
})

test('3. 模板描述符装配的 provider 过 conformance（静态门禁）', () => {
  const rep = conformanceReport({ provider: okProvider(workingDescriptor()) })
  assert.equal(rep.passed, true, rep.checks.filter(c => !c.ok).map(c => `${c.id}:${c.detail}`).join(' | '))
  assert.equal(rep.subject, 'demoeng')
})

// 4. 端到端：脚手架描述符 → provider 过运行时契约（与 ase/lammps/mace 同一套件）
potentialProviderContract({
  subject: 'scaffolded demoeng（plugin-sdk 模板）',
  createProvider: () => okProvider(workingDescriptor()),
  runnable: true, runFormula: 'Cu',
  unavailable: { createProvider: () => errProvider(workingDescriptor()), code: 'ENGINE_UNAVAILABLE' },
})

test('5. writePluginScaffold 落盘四文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sdk-scaffold-'))
  try {
    const written = await writePluginScaffold(dir, { name: 'onemore', descriptor: undefined })
    assert.equal(written.length, 4)
    const idx = await readFile(join(dir, 'src', 'index.mjs'), 'utf8')
    assert.ok(idx.includes('saturday-onemore') && idx.includes('makeDescriptorProvider'))
    const gen = await readFile(join(dir, 'test', 'descriptor.test.mjs'), 'utf8')
    assert.ok(gen.includes('conformanceReport'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
