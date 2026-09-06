// @toki0413/mcp-server 测试
// 全量插件挂载 → 30 工具无重名；InMemory client 端到端（listTools / callTool /
// 错误 isError 语义 / 参数 schema 转换门禁）；卸载回收。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createSaturdayMcpServer, jsonToZodShape, PLUGIN_MANIFEST } from '../src/index.mjs'

async function withServer(fn, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-mcp-'))
  const { mcp, boot } = await createSaturdayMcpServer({
    trajectoryPath: join(dir, 'trajectory.jsonl'),
    ...options,
  })
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)])
  try {
    return await fn(client)
  } finally {
    await client.close()
    await boot.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

test('1. 全量插件挂载：31 工具、无重名、seam 前缀齐全', async () => {
  assert.equal(PLUGIN_MANIFEST.length, 18, 'bridge + 17 插件')
  await withServer(async (client) => {
    const { tools } = await client.listTools()
    assert.equal(tools.length, 31)
    const names = tools.map(t => t.name)
    assert.equal(new Set(names).size, names.length, '工具名无冲突（冲突即污染）')
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 0, `${t.name} 缺 description`)
      assert.equal(t.inputSchema.type, 'object')
    }
    for (const expected of ['material.load', 'structure.fromSmiles', 'potential.relax', 'analysis.phonon', 'sampler.flow', 'workflow.screen', 'derivation.record']) {
      assert.ok(names.includes(expected), `旗舰工具 ${expected} 应在册`)
    }
  })
})

test('2. material.load 端到端：真实物理调用返回 materialId 与 formula', async () => {
  await withServer(async (client) => {
    const r = await client.callTool({ name: 'material.load', arguments: { query: 'Cu' } })
    assert.notEqual(r.isError, true)
    const out = JSON.parse(r.content[0].text)
    assert.ok(out.materialId)
    assert.equal(out.formula, 'Cu')
  })
})

test('3. 工具抛错 → MCP isError 语义：结构化错误码可达调用方（不静默）', async () => {
  await withServer(async (client) => {
    const r = await client.callTool({ name: 'material.load', arguments: { query: 'Xx999NoSuchElement' } })
    assert.equal(r.isError, true, '无效元素必须显式失败')
    const err = JSON.parse(r.content[0].text)
    assert.ok(err.error && typeof err.error === 'string')
  })
})

test('4. 调用未注册工具 → isError 响应（未注册即不可达，不静默）', async () => {
  await withServer(async (client) => {
    const r = await client.callTool({ name: 'no.such.tool', arguments: {} })
    assert.equal(r.isError, true)
  })
})

test('5. 参数 schema 转换门禁：未知类型显式报错而非放宽 schema', () => {
  assert.throws(() => jsonToZodShape({ x: { type: 'weird' } }),
    /unsupported type "weird"/)
  assert.throws(() => jsonToZodShape({ x: 'not-an-object' }),
    /definition must be an object/)
})

test('6. zod 转换覆盖全类型：string/number/integer/boolean/array/object + default', async () => {
  const shape = jsonToZodShape({
    s: { type: 'string', description: 'a string' },
    n: { type: 'number' },
    i: { type: 'integer', default: 8 },
    b: { type: 'boolean' },
    arr: { type: 'array', items: { type: 'number' } },
    obj: { type: 'object', properties: { k: { type: 'string' } } },
  })
  const parsed = shape.s // string
  assert.ok(parsed)
  // default 生效：i 缺省解析为 8；全部可选（无 default 加 optional）
  const zodObject = (await import('zod')).z.object(shape)
  const v = zodObject.parse({})
  assert.equal(v.i, 8)
  assert.equal(v.s, undefined)
  const v2 = zodObject.parse({ s: 'x', n: 1.5, b: true, arr: [1, 2], obj: { k: 'v' } })
  assert.deepEqual([v2.s, v2.n, v2.b, v2.arr, v2.obj.k], ['x', 1.5, true, [1, 2], 'v'])
})

test('7. Trajectory 谱系：MCP 工具调用路径的产出落 append-only 日志', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-mcp-'))
  const trajPath = join(dir, 'trajectory.jsonl')
  const { mcp, boot } = await createSaturdayMcpServer({ trajectoryPath: trajPath })
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(st), client.connect(ct)])
  try {
    const loaded = await client.callTool({ name: 'material.load', arguments: { query: 'Cu' } })
    const matId = JSON.parse(loaded.content[0].text).materialId
    const r = await client.callTool({ name: 'potential.relax', arguments: { materialId: matId, engine: 'lj-js' } })
    assert.notEqual(r.isError, true, 'relax 应成功（数据面自适应）')
    await new Promise(r => setTimeout(r, 80))
    const text = await readFile(trajPath, 'utf8')
    assert.ok(text.length > 0, '谱系日志非空')
  } finally {
    await client.close()
    await boot.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
