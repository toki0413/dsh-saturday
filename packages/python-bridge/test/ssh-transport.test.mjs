// SshTransport / loadClusters 测试（契约 B 阶段：远程执行传输抽象）
// 注入式：spawnImpl 返回假 SSH 子进程（EventEmitter 形状 + stdin 捕获 + 协议应答），
// 覆盖 PythonBridge × SshTransport 全链路（connect/hello/call/disconnect）而不真连网络。
// 真实 SSH 属环境相关，不在此套件（远程主机属站点配置，见 ~/.saturday/clusters.json）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PythonBridge } from '../src/index.mjs'
import { SshTransport, loadClusters } from '../src/transport.mjs'

/** 假 SSH 子进程：桥层写入 stdin 协议行 → 按 sidecar 协议回 JSON-lines */
function fakeSshChild(spawnLog) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stdout.resume = () => {}   // readline 接口要求 Readable 形状
  child.stderr = new EventEmitter()
  child.stdin = {
    destroyed: false,
    write(chunk) {
      spawnLog.written.push(chunk)
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        let req
        try { req = JSON.parse(line) } catch { return }
        const result = req.method === 'hello'
          ? { sidecar: 'fake-ssh-sidecar', version: '0.3.4', calculators: { 'fake-ssh': true } }
          : { echoed: req.method, params: req.params }
        child.stdout.emit('data', JSON.stringify({ id: req.id, result }) + '\n')
      }
    },
    end() { child.stdin.destroyed = true },
    on() {},
  }
  child.exitCode = null
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0) }
  return child
}

test('1. SshTransport 命令构造：目标/端口/BatchMode/远程命令', () => {
  const t = new SshTransport({ host: 'hpc.example.edu', user: 'toki0413', port: 2222, workDir: '~/saturday', python: 'python3.11' })
  assert.deepEqual(t.baseArgs(), ['-p', '2222', '-o', 'BatchMode=yes', 'toki0413@hpc.example.edu'])
  assert.equal(t.remoteCommand(), 'cd ~/saturday && python3.11 sidecar.py')
  const t2 = new SshTransport({ host: 'lab', workDir: '/scratch/sat', sshOptions: ['-i', '/tmp/key'] })
  assert.equal(t2.target(), 'lab')
  assert.ok(t2.baseArgs().includes('-i') && t2.baseArgs().includes('/tmp/key'))
})

test('2. 构造门禁：缺 host / 缺 workDir 显式报错', () => {
  assert.throws(() => new SshTransport({ workDir: '/x' }), /host is required/)
  assert.throws(() => new SshTransport({ host: 'h' }), /workDir is required/)
})

test('3. PythonBridge × SshTransport 全链路：connect/hello/call/断连（注入式，不真连）', async () => {
  const spawnLog = { written: [] }
  const t = new SshTransport({
    host: 'hpc.example.edu', user: 'toki0413', workDir: '~/saturday',
    spawnImpl: (cmd, args) => {
      spawnLog.cmd = cmd
      spawnLog.args = args
      return fakeSshChild(spawnLog)
    },
  })
  const bridge = new PythonBridge({ transport: t })
  await bridge.connect()
  assert.equal(bridge.sidecarInfo.sidecar, 'fake-ssh-sidecar', '握手经 SSH 通道完成')
  const out = await bridge.call('calculate', { structure: { numbers: [29] } })
  assert.equal(out.echoed, 'calculate')
  assert.deepEqual(out.echoed && Object.keys(out.params), ['structure'])
  // 协议行确实写入了 SSH 通道（本地 ssh 进程的 stdin）
  assert.ok(spawnLog.written.some(c => c.includes('"hello"')))
  assert.equal(spawnLog.cmd, 'ssh')
  assert.ok(spawnLog.args.includes('cd ~/saturday && python3 sidecar.py'))
  await bridge.disconnect()
})

test('4. verify()：远程 sidecar 存在性预检（exit 0 ok / exit 1 显式报缺失）', async () => {
  const ok = new SshTransport({ host: 'h', workDir: '/w', spawnImpl: (cmd, args) => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.on('error', () => {})
    setImmediate(() => child.emit('close', 0))
    return child
  } })
  await assert.doesNotReject(() => ok.verify())
  const missing = new SshTransport({ host: 'h', workDir: '/w', spawnImpl: (cmd, args) => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.on('error', () => {})
    setImmediate(() => child.emit('close', 1))
    return child
  } })
  await assert.rejects(() => missing.verify(), /remote sidecar missing/)
})

test('5. loadClusters：站点配置读取 + 字段门禁 + 缺文件显式失败', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sat-clusters-'))
  const cfg = join(dir, 'clusters.json')
  await writeFile(cfg, JSON.stringify({ clusters: [
    { name: 'lab-hpc', host: 'hpc.example.edu', user: 'toki0413', workDir: '~/saturday' },
  ] }))
  const clusters = loadClusters(cfg)
  assert.ok(clusters['lab-hpc'] instanceof SshTransport)
  assert.equal(clusters['lab-hpc'].target(), 'toki0413@hpc.example.edu')
  await writeFile(cfg, JSON.stringify({ clusters: [{ name: 'bad', host: 'h' }] }))
  assert.throws(() => loadClusters(cfg), /workDir/)
  await rm(dir, { recursive: true, force: true })
  assert.throws(() => loadClusters(join(dir, 'gone.json')), /clusters config unreadable|ENOENT/)
})
