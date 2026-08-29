// plugin-derivation 纯函数层 —— 谱系驱动的失效传播与惰性重算（契约 §8.2 首个实证）
//
// 语义（README"活的材料上下文"目标形态）：材料上下文 = 响应式谱系图——
// 每个导出量声明推导来源（record），上游失效沿推导图向下游传递传播（invalidate），
// 重算是惰性且预算受控的（recompute）。
// 诚实边界（与契约条款逐条对应）：
//  - 冻结结果（实验数据 / 已交付，§7 冻结标记）失效传播时只追加修正记录、
//    状态不改、永不进入重算集；传播越过冻结节点继续向下游走（不吞失效）；
//  - 登记簿 append-only：失效过的记录永不删除，重算成功后以状态迁移 +
//    时间戳追加表达，不改写历史；
//  - 失效源只有显式 invalidate（不可变 fork 不是失效源：§6 冻结原对象语义，
//    substitute 产生新对象，原结构及其推导不受影响）。

// engine ref（契约化扩展）：排序 = f(基体, 引擎)——引擎是推导输入，
// 势函数热替换即失效源（§8.2 活性上下文接真实工作流）。
const REF_KINDS = ['material', 'job', 'result', 'engine']

export function derivationError(code, message) {
  const e = new Error(`${message} (${code})`)
  e.code = code
  return e
}

function parseRef(ref, what = 'ref') {
  if (typeof ref !== 'string') {
    throw derivationError('INVALID_REF', `${what} 必须是 '<kind>:<id>' 形式的字符串`)
  }
  const i = ref.indexOf(':')
  const kind = i > 0 ? ref.slice(0, i) : ''
  const id = i > 0 ? ref.slice(i + 1) : ''
  if (!REF_KINDS.includes(kind) || id.length === 0) {
    throw derivationError('INVALID_REF', `${what} 形如 material:<id> / job:<id> / result:<id> / engine:<id>，收到 '${ref}'`)
  }
  return { kind, id }
}

/**
 * 创建推导登记簿（活性上下文的地基：推导图 + 失效传播 + 惰性重算）。
 * @param {Object}   [opts]
 * @param {Function} [opts.emit] (type, event) => Promise<void>，事件由调用方路由（可测试性）
 */
export function createDerivationRegistry({ emit } = {}) {
  const derivations = []          // append-only 登记簿
  const byInput = new Map()       // ref -> 以它为输入的推导集
  const byOutput = new Map()      // ref -> 以它为输出的推导（每个输出至多一条现行记录）
  let seq = 0

  function record({ inputs, output, producer, frozen = false }) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw derivationError('INVALID_REF', 'inputs 必须是非空引用数组')
    }
    inputs.forEach(r => parseRef(r, 'input'))
    parseRef(output, 'output')
    if (typeof producer !== 'string' || producer.length === 0) {
      throw derivationError('INVALID_REF', 'producer 必须声明（谁产出了这个导出量）')
    }
    const d = {
      id: `drv-${++seq}`,
      inputs: [...inputs],
      output,
      producer,
      frozen: Boolean(frozen),
      status: 'valid',            // valid | invalid（frozen 永不置 invalid）
      corrections: [],            // 冻结结果的修正追加记录（§7）
      invalidatedBy: null,
      recomputedAt: null,
      createdAt: Date.now(),
    }
    derivations.push(d)
    byOutput.set(output, d)
    for (const r of inputs) {
      if (!byInput.has(r)) byInput.set(r, new Set())
      byInput.get(r).add(d)
    }
    return d
  }

  function status(ref) {
    parseRef(ref, 'ref')
    const d = byOutput.get(ref)
    if (!d) {
      throw derivationError('DERIVATION_NOT_FOUND', `'${ref}' 从未登记为导出量`)
    }
    return {
      ref,
      status: d.status,
      frozen: d.frozen,
      producer: d.producer,
      corrections: [...d.corrections],
      invalidatedBy: d.invalidatedBy,
      recomputedAt: d.recomputedAt,
    }
  }

  /**
   * 失效传播（§8.2）：沿推导图向下游传递；冻结节点只追加修正记录不改状态，
   * 传播越过冻结节点继续；已失效节点不重复传播（幂等）。
   * @returns {Promise<{ source: string, reason: string, invalidated: string[], corrections: string[] }>}
   */
  async function invalidate(ref, reason) {
    parseRef(ref, 'ref')
    if (typeof reason !== 'string' || reason.length === 0) {
      throw derivationError('INVALID_REF', 'reason 必须是非空字符串（失效原因是谱系的一部分）')
    }
    const invalidated = []
    const corrections = []
    const queue = [ref]
    const seen = new Set([ref])
    while (queue.length > 0) {
      const cur = queue.shift()
      for (const d of byInput.get(cur) ?? []) {
        if (d.frozen) {
          // §7 冻结标记：只追加修正记录，不重算、不改状态；传播继续向下游
          d.corrections.push({ reason, source: ref, at: Date.now() })
          corrections.push(d.output)
        } else if (d.status !== 'invalid') {
          d.status = 'invalid'
          d.invalidatedBy = { source: ref, reason, at: Date.now() }
          invalidated.push(d.output)
        }
        if (!seen.has(d.output)) {
          seen.add(d.output)
          queue.push(d.output)
        }
      }
    }
    const summary = { source: ref, reason, invalidated, corrections }
    if (invalidated.length > 0 || corrections.length > 0) {
      // 事件薄载荷（§7.2）：只放引用与原因，不放推导记录本体
      await emit?.('saturday/derivation/invalidated', {
        type: 'saturday/derivation/invalidated',
        payload: summary,
      })
    }
    return summary
  }

  /**
   * 惰性重算（§8.2，预算受控）：只重算失效且未冻结的推导，按输入依赖拓扑推进；
   * 待重算数超过预算即显式抛 BUDGET_EXCEEDED，不静默部分执行（预算是资源承诺）。
   * @param {Object}   opts
   * @param {Function} opts.recompute (derivation) => Promise<void>，调用方注入的真实重算
   * @param {number}   [opts.budget=Infinity] 本轮最多重算条数
   * @returns {Promise<{ recomputed: string[] }>}
   */
  async function recompute({ recompute, budget = Number.POSITIVE_INFINITY }) {
    if (typeof recompute !== 'function') {
      throw derivationError('BUDGET_EXCEEDED', 'recompute 函数必须注入（登记簿不知道如何重算）')
    }
    const pending = derivations.filter(d => d.status === 'invalid' && !d.frozen)
    if (pending.length > budget) {
      throw derivationError(
        'BUDGET_EXCEEDED',
        `待重算 ${pending.length} 条，超出预算 ${budget}；请提高预算或分批（惰性语义：预算不足就不动）`,
      )
    }
    const recomputed = []
    // 多趟推进：本轮只重算"输入全部有效"的条目（拓扑序），直到无进展
    let progressed = true
    while (progressed) {
      progressed = false
      for (const d of derivations) {
        if (d.status !== 'invalid' || d.frozen) continue
        const inputsReady = d.inputs.every(r => {
          const up = byOutput.get(r)
          return !up || up.status === 'valid'
        })
        if (!inputsReady) continue
        await recompute(d)
        d.status = 'valid'
        d.recomputedAt = Date.now()
        recomputed.push(d.output)
        progressed = true
      }
    }
    return { recomputed }
  }

  return {
    record,
    status,
    invalidate,
    recompute,
    get size() { return derivations.length },
    list: () => derivations.map(d => ({ ...d, inputs: [...d.inputs], corrections: [...d.corrections] })),
  }
}
