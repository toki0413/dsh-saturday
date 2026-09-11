// JobLedger —— 作业台账（动态拆装的承载机制，契约 §2.2"卸载不得中断在运行任务"的落地）
//
// 存在理由：jobId 此前散在各 provider 内部，注册表不知道"谁在跑什么"——
// 于是"卸载时活跃作业怎么办"只是承诺，没有机制。台账把作业登记为一等公民：
// 提交即记账、完成即销账、卸载路径先查账再动手。
//
// 语义边界（与可逆性三级作用域对齐）：
//  - 软件资源域：登记/销账本身全是内存态，随注册表生命周期回退；
//  - 计算任务域：drain（等待收尾）/ cancel（要求引擎幂等取消）/ refuse（显式拒绝卸载）
//    三种策略都是显式的——默认 refuse，绝不静默杀任务也绝不静默等待；
//  - cancel 依赖 provider.cancel 存在：没有就显式 CANCEL_UNSUPPORTED，不假装能停。

import { randomUUID } from 'node:crypto'

export function jobError(code, message) {
  const e = new Error(`${message} (${code})`)
  e.code = code
  return e
}

export class JobLedger {
  constructor() {
    this.records = new Map()   // jobId → { jobId, provider, materialId, kind, startedAt, outcome }
  }

  /** 提交作业即记账；provider 名必填——它是卸载路径查询的键 */
  submit({ provider, materialId = null, kind = 'job' } = {}) {
    if (typeof provider !== 'string' || provider.length === 0) {
      throw jobError('JOB_BAD_INPUT', 'submit requires provider name')
    }
    const jobId = randomUUID()
    this.records.set(jobId, {
      jobId, provider, materialId, kind, startedAt: Date.now(), outcome: null,
    })
    return jobId
  }

  /** 完成/失败/取消都要销账；未知 jobId 静默忽略（幂等 settle：重复回调安全） */
  settle(jobId, outcome = 'ok') {
    const rec = this.records.get(jobId)
    if (!rec) return false
    rec.outcome = outcome
    rec.settledAt = Date.now()
    this.records.delete(jobId)
    return true
  }

  /** 在运行作业清单：provider 省略则返回全部 */
  activeOf(provider) {
    return [...this.records.values()].filter(r => provider == null || r.provider === provider)
  }

  /**
   * 等待某 provider 的在途作业收尾（轮询式，无事件依赖——provider 不必知道台账存在）。
   * @returns {Promise<{ drained: boolean, pending: object[] }>}
   */
  async awaitDrain(provider, { timeoutMs = 60_000, pollMs = 25 } = {}) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const pending = this.activeOf(provider)
      if (pending.length === 0) return { drained: true, pending: [] }
      if (Date.now() >= deadline) return { drained: false, pending }
      await new Promise(r => setTimeout(r, pollMs))
    }
  }
}
