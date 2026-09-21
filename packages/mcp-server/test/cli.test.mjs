// 无头一次性 CLI 冒烟测：spawn `node cli.mjs --tools`（排除需 Python 的插件保快/确定），
// 断言 stdout 是工具 JSON、含核心工具；--relax 走完整 boot 太重，留给 stdio/http 契约测覆盖。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs')

function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...args], {
      env: { ...process.env, OPENBLAS_NUM_THREADS: '1', SATURDAY_DISABLE: 'plugin-mp,plugin-lammps,plugin-mace,plugin-ase' },
    }, (err, stdout) => resolve({ code: err ? 1 : 0, stdout }))
  })
}

test('1. --tools 打印当前环境工具 JSON（无 MP 键则 structure.resolve 不在列）', async () => {
  const { code, stdout } = await runCli(['--tools'])
  assert.equal(code, 0)
  const tools = JSON.parse(stdout)
  assert.ok(Array.isArray(tools) && tools.length >= 20, `工具数应 ≥20，实得 ${tools.length}`)
  const names = tools.map(t => t.name)
  assert.ok(names.includes('potential.relax') && names.includes('material.load'), '核心工具在列')
})

test('2. --call 无头一次调用 material.load 返回真结构 materialId', async () => {
  const { code, stdout } = await runCli(['--call', 'material.load', JSON.stringify({ query: 'Cu' })])
  assert.equal(code, 0)
  const r = JSON.parse(stdout)
  assert.ok(r.materialId ?? r.id, '返回 materialId')
})
