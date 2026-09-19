// streamable-http 入口端到端测试：进程内起 HTTP server，用 SDK 的 StreamableHTTPClientTransport
// 经真 HTTP 完成 initialize + tools/list + tools/call；再验健康端点；断言按能力（含 analysis.xrd）
// 不绑死绝对工具数（无 MP_API_KEY 时 structure.resolve 收缩，双档一致通过）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startHttp } from '../src/index.mjs'

test('1. startHttp：真 streamable-http 握手列工具 + 调用 + 健康端点 + 优雅卸载', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-http-'))
  const http = await startHttp({ port: 0, trajectoryPath: join(dir, 'trajectory.jsonl') })
  const client = new Client({ name: 'http-test', version: '0.0.1' })
  const transport = new StreamableHTTPClientTransport(new URL(http.url))
  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    assert.ok(names.includes('analysis.xrd'), 'HTTP 面应含 analysis.xrd')
    assert.ok(names.includes('material.load'), 'HTTP 面应含 material.load')
    assert.ok(names.length >= 30, `工具数下限 30，got ${names.length}`)
    // 一次真实调用
    const r = await client.callTool({ name: 'material.load', arguments: { query: 'Cu' } })
    assert.notEqual(r.isError, true)
    const out = JSON.parse(r.content[0].text)
    assert.equal(out.formula, 'Cu')
    await client.close()
  } finally {
    // 健康端点（独立于 MCP 会话）
    const health = await (await fetch(`http://127.0.0.1:${http.port}/health`)).json()
    assert.equal(health.ok, true)
    assert.equal(health.transport, 'streamable-http')
    await http.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
  // 卸载后端口令应已关（连不上）
  await assert.rejects(() => fetch(`http://127.0.0.1:${http.port}/health`))
})
