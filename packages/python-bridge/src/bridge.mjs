// PythonBridge —— TS 控制面 ↔ Python 数据面
// MVP 传输：子进程 stdio + 换行分隔 JSON（无第三方依赖）。
// 生产路径可换 ZeroMQ 等传输；接口不变，传输层可替换——这正是桥接层存在的意义。

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { platform } from 'node:os'
import { fileURLToPath } from 'node:url'

export class PythonBridge {
  constructor(options = {}) {
    // Windows 通常只有 python（无 python3），按平台选默认命令；可用 bridge.python 覆盖
    this.python = options.python ?? (platform() === 'win32' ? 'python' : 'python3')
    this.sidecar = options.sidecar ?? fileURLToPath(new URL('../../python-bridge/sidecar.py', import.meta.url))
    this.proc = null
    this.pending = new Map()
  }

  async connect() {
    if (this.proc) return
    this.proc = spawn(this.python, [this.sidecar], {
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    const rl = createInterface({ input: this.proc.stdout })
    rl.on('line', line => {
      let msg
      try { msg = JSON.parse(line) } catch { return }
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(`${msg.error.code ?? 'PY_ERROR'}: ${msg.error.message}`))
      else entry.resolve(msg.result)
    })
    this.proc.on('exit', code => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`Python sidecar exited (code ${code})`))
      }
      this.pending.clear()
      this.proc = null
    })
    // 握手：确认 sidecar 就绪与版本
    const hello = await this.call('hello', {})
    this.sidecarInfo = hello
  }

  /** 长任务友好的异步调用：Promise 在 Python 完成时才 settle */
  call(method, params, { timeoutMs = 300_000 } = {}) {
    if (!this.proc) return Promise.reject(new Error('Bridge not connected'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Bridge call "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v) },
        reject: e => { clearTimeout(timer); reject(e) },
      })
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  async disconnect() {
    if (!this.proc) return
    try { await this.call('shutdown', {}, { timeoutMs: 5000 }) } catch { /* 容忍 */ }
    this.proc.kill()
    this.proc = null
  }
}
