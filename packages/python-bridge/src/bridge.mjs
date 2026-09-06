// PythonBridge —— TS 控制面 ↔ Python 数据面
// 传输抽象：LocalTransport（本地子进程，缺省）或 SshTransport（远程 SSH，站点配置）。
// 协议不变：换行分隔 JSON（无第三方依赖）。传输层可替换——这正是桥接层存在的意义。

import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { platform } from 'node:os'
import { fileURLToPath } from 'node:url'
import { LocalTransport } from './transport.mjs'

export class PythonBridge {
  constructor(options = {}) {
    // 传输注入：options.transport 优先（SshTransport 等远程通道）；
    // 缺省本地子进程（Windows 通常只有 python，按平台选默认命令；bridge.python 覆盖）
    this.transport = options.transport ?? new LocalTransport({
      python: options.python ?? (platform() === 'win32' ? 'python' : 'python3'),
      sidecar: options.sidecar ?? fileURLToPath(new URL('../../python-bridge/sidecar.py', import.meta.url)),
    })
    this.proc = null
    this.pending = new Map()
  }

  async connect() {
    if (this.proc) return
    this.proc = this.transport.launch()
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
    // spawn 即时错误（如解释器不存在）：立即拒绝挂起调用，不悬挂到超时；
    // 调用方据此决定显式失败还是显式回退（诚实降级，绝不静默卡死）
    this.proc.on('error', err => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`Failed to launch Python sidecar: ${err.message}`))
      }
      this.pending.clear()
      this.proc = null
    })
    // stdin 流错误兜底（如 sidecar 秒崩时握手写入撞进程退出触发 EPIPE）：
    // exit/error 处理器已拒绝挂起调用，流错误不得成为未处理异常炸掉宿主进程（回退链路完整性的最后一环）
    this.proc.stdin.on('error', () => {})
    // 握手：确认 sidecar 就绪与版本
    const hello = await this.call('hello', {})
    this.sidecarInfo = hello
  }

  /** 长任务友好的异步调用：Promise 在 Python 完成时才 settle */
  call(method, params, { timeoutMs = 300_000 } = {}) {
    if (!this.proc) return Promise.reject(new Error('Bridge not connected'))
    // 进程已死（如 sidecar 秒崩）：立即拒绝，不写入死管道也不悬挂到超时（诚实降级同款纪律）
    if (this.proc.exitCode !== null || this.proc.stdin.destroyed) {
      return Promise.reject(new Error(`Python sidecar exited (code ${this.proc.exitCode ?? 'unknown'})`))
    }
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
