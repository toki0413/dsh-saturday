// 会话分支账本（Session Ledger）—— 把"模拟是可回退的搜索/组合空间"落成一条受约束的原语。
//
// 语义（刻意钉死，与可逆性边界对齐）：
//   - 分支是"决策线"不是"可变状态副本"：fork 记一条支的父与分叉点序号；此后各支独立追加结果。
//   - 结果不可变：账本只增不改不删（add-only）；同 (支,subject,key) 多条 → valueFor 取最高 seq（最新一次记录）。
//   - 可见性沿祖先链：某记录对分支 b 可见 ⟺ 它记在 b 或 b 的祖先支上。故 fork 前的历史共享、
//     fork 后的分叉彼此隔离（兄弟支互不可见）——这是 git 式历史，但只用于"读侧对照"，不是合并。
//   - 无破坏式合并：compare 只读并列各支的可见值与差；markTrunk 只把一个决策线标为主干（指针 + 审计），
//     绝不删别的支或它们的记录。选主干是决策，不是回退。
// 纯函数层：不碰 cordis、不碰 attach/detach 与 Trajectory 落盘路径（那些是本仓红过的高危路径）。
// 接线（工具/服务）在 index.mjs；此处只给可确定性复现、可闭式测的账本逻辑。

function ledgerError(code, msg) { const e = new Error(`${msg} (${code})`); e.code = code; return e }
const sameVal = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b)

/**
 * @param {{rootId?:string}} [opts]
 */
export function createSessionLedger({ rootId = 'main' } = {}) {
  const branches = new Map([[rootId, { id: rootId, parent: null, forkedAtSeq: 0 }]])
  const records = []            // 只增：{seq, branchId, subject, key, value, meta}
  let seq = 0
  let branchCounter = 0
  let trunk = rootId

  function requireBranch(id) {
    if (!branches.has(id)) throw ledgerError('BRANCH_UNKNOWN', `unknown branch "${id}"`)
    return branches.get(id)
  }
  function lineageOf(id) {      // [root, .., id] 祖先链（含自身）
    const chain = []
    let cur = requireBranch(id)
    while (cur) { chain.push(cur.id); cur = cur.parent ? branches.get(cur.parent) : null }
    return chain.reverse()
  }
  function valueForImpl(branch, subject, key) {   // 沿祖先链取 seq 最大的一条可见值
    const visible = new Set(lineageOf(branch))
    let best = null
    for (const r of records) {
      if (!visible.has(r.branchId) || r.subject !== subject || r.key !== key) continue
      if (!best || r.seq > best.seq) best = r
    }
    return best ? { found: true, ...best } : { found: false, subject, key }
  }

  return {
    rootId,

    /** 分叉：从 from（缺省当前主干）起一条新决策线；add-only，不复制/改动任何已有状态。 */
    fork({ from = trunk, id } = {}) {
      requireBranch(from)
      const branchId = id ?? `branch-${++branchCounter}`
      if (branches.has(branchId)) throw ledgerError('BRANCH_EXISTS', `branch "${branchId}" already exists`)
      if (id != null && (typeof id !== 'string' || id.length === 0)) throw ledgerError('BRANCH_BAD_ID', 'explicit branch id must be a non-empty string')
      const b = { id: branchId, parent: from, forkedAtSeq: seq }
      branches.set(branchId, b)
      return { id: branchId, parent: from, forkedAtSeq: seq }
    },

    /** 记一条计算结果到某支（只增；同键多条则最新一条对该支及其后代生效）。 */
    record({ branch = trunk, subject, key, value, meta = null } = {}) {
      requireBranch(branch)
      if (typeof subject !== 'string' || subject.length === 0) throw ledgerError('SUBJECT_REQUIRED', 'record requires subject')
      if (typeof key !== 'string' || key.length === 0) throw ledgerError('KEY_REQUIRED', 'record requires key')
      const rec = { seq: ++seq, branchId: branch, subject, key, value, meta }
      records.push(rec)
      return { ...rec }
    },

    /** 某支对 (subject,key) 的可见值：沿祖先链取 seq 最大的一条；不 found 则 found=false。 */
    valueFor({ branch = trunk, subject, key } = {}) {
      return valueForImpl(branch, subject, key)
    },

    /** 只读对照：并列各支（缺省全部）对同一 (subject,key) 的可见值与差；不改任何状态。 */
    compare({ subject, key, branches: only } = {}) {
      const ids = only ?? [...branches.keys()]
      const byBranch = ids.map(id => { const v = valueForImpl(id, subject, key); return { branchId: id, ...v } })
      const found = byBranch.filter(b => b.found)
      const numeric = found.every(b => typeof b.value === 'number') && found.length > 0
      let spread = null, maxPairwiseDelta = null
      if (numeric) {
        const vs = found.map(b => b.value)
        spread = Math.max(...vs) - Math.min(...vs)
        maxPairwiseDelta = spread
      }
      const distinct = [...new Set(found.map(b => JSON.stringify(b.value)))]
      return {
        subject, key, trunk, byBranch, nFound: found.length,
        trunkValue: found.some(b => b.branchId === trunk) ? (found.find(b => b.branchId === trunk).value) : null,
        hasDisagreement: distinct.length > 1, distinctValues: distinct.length,
        spread, maxPairwiseDelta,
        note: '只读对照：各支可见值沿祖先链取最新；主干是决策标记，不合并、不删他支。',
      }
    },

    /** 标主干：仅移动指针（决策线选择），其余支与其记录原样在场、仍可对照。 */
    markTrunk({ branch } = {}) {
      requireBranch(branch)
      trunk = branch
      return { trunk, note: '主干=选定的决策线；非破坏，其余分支与其结果保留可溯源。' }
    },

    /** 某支可见的历史（沿祖先链过滤、按 seq 升序）。 */
    history({ branch = trunk } = {}) {
      const visible = new Set(lineageOf(branch))
      return records.filter(r => visible.has(r.branchId)).map(r => ({ ...r }))
    },

    status() {
      return {
        rootId, trunk, nRecords: seq, nBranches: branches.size,
        branches: [...branches.values()].map(b => ({ ...b, isTrunk: b.id === trunk, lineage: lineageOf(b.id) })),
      }
    },
    sameVal,
  }
}
