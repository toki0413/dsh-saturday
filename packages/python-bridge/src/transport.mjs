// 传输抽象：sidecar 进程的启动通道。
// LocalTransport —— 本地子进程（现有行为，缺省）；
// SshTransport —— SSH 远程执行：本地 spawn ssh，stdin/stdout 透传到远程 sidecar
// （JSON-lines 协议与本地完全一致，桥层无感知）。
// 接口约定：launch() 返回 ChildProcess 形状的对象（stdin/stdout/on/exitCode/kill），
// PythonBridge 对传输无感知——死亡进程快速拒绝、EPIPE 兜底、握手校验全部照常生效。
// 站点配置：clusters.json（缺省 ~/.saturday/clusters.json）声明远程主机；
// sidecar.py 须已部署在远程工作目录——连接前的文件存在性校验属显式预检
// （缺失即报错，绝不静默本地回退：远程语义是算力选择，不是降级路径）。

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export class LocalTransport {
  constructor({ python, sidecar } = {}) {
    this.python = python
    this.sidecar = sidecar
  }

  launch() {
    return spawn(this.python, [this.sidecar], {
      stdio: ['pipe', 'pipe', 'inherit'],
    })
  }

  describe() {
    return { kind: 'local', python: this.python }
  }
}

export class SshTransport {
  /**
   * @param {object} o
   * @param {string} o.host 远程主机（必需）
   * @param {string} [o.user] SSH 用户（缺省走本机 ssh 配置）
   * @param {number} [o.port] SSH 端口（缺省 22）
   * @param {string} [o.python] 远程解释器命令（缺省 python3）
   * @param {string} [o.workDir] 远程工作目录（sidecar.py 所在目录；必需）
   * @param {string} [o.sidecarPath] 远程 sidecar 文件名（缺省 sidecar.py）
   * @param {string[]} [o.sshOptions] 附加 ssh 参数（如 -i 密钥、-J 跳板）
   * @param {Function} [o.spawnImpl] 注入点（测试替身；缺省 node child_process.spawn）
   */
  constructor({ host, user, port, python = 'python3', workDir, sidecarPath = 'sidecar.py', sshOptions = [], spawnImpl } = {}) {
    if (!host) throw new Error('SshTransport: host is required')
    if (!workDir) throw new Error('SshTransport: workDir is required')
    this.host = host
    this.user = user
    this.port = port
    this.python = python
    this.workDir = workDir
    this.sidecarPath = sidecarPath
    this.sshOptions = sshOptions
    this.spawnImpl = spawnImpl ?? spawn
  }

  /** ssh 目标参数（host 别名或 user@host） */
  target() {
    return this.user ? `${this.user}@${this.host}` : this.host
  }

  baseArgs() {
    const args = []
    if (this.port) args.push('-p', String(this.port))
    args.push(...this.sshOptions)
    // 非交互与非转发：stdio 只承载 JSON-lines 协议，远程 shell 横幅走 stderr（桥层忽略）
    args.push('-o', 'BatchMode=yes')
    args.push(this.target())
    return args
  }

  /** 远程命令：进入工作目录后启动 sidecar（JSON-lines 到 stdout） */
  remoteCommand() {
    return `cd ${this.workDir} && ${this.python} ${this.sidecarPath}`
  }

  launch() {
    return this.spawnImpl('ssh', [...this.baseArgs(), this.remoteCommand()], {
      stdio: ['pipe', 'pipe', 'inherit'],
    })
  }

  /** 显式预检：远程 sidecar 文件是否存在（部署前置的诚实校验，缺失即报错） */
  async verify() {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl('ssh', [...this.baseArgs(), `test -f ${this.workDir}/${this.sidecarPath}`], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let err = ''
      child.stderr?.on?.('data', d => { err += d })
      child.on('error', e => reject(new Error(`SSH unreachable (${this.target()}): ${e.message}`)))
      child.on('close', code => {
        if (code === 0) resolve({ ok: true, host: this.target() })
        else reject(new Error(
          `remote sidecar missing: ${this.workDir}/${this.sidecarPath} @ ${this.target()}` +
          `${err ? ` (${err.slice(0, 120)})` : ''}——部署 sidecar 后重试，不回退本地（远程语义是算力选择）`))
      })
    })
  }

  describe() {
    return { kind: 'ssh', host: this.target(), workDir: this.workDir, python: this.python }
  }
}

/** 站点配置：clusters.json → { name: SshTransport }。缺省路径 ~/.saturday/clusters.json */
export function loadClusters(path = join(homedir(), '.saturday', 'clusters.json')) {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const clusters = {}
  for (const c of raw.clusters ?? []) {
    if (!c.name || !c.host || !c.workDir) {
      throw new Error(`clusters config: each cluster needs name/host/workDir (${JSON.stringify(c?.name ?? c)})`)
    }
    clusters[c.name] = new SshTransport(c)
  }
  return clusters
}
