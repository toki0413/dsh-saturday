// 会话分支账本不变量测试：钉死"共享历史→分叉隔离、add-only、只读对照、非破坏主干、错误门"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSessionLedger } from '../src/branch-ledger.mjs'

test('1. 共享历史 + 分叉后各走各的（可见性沿祖先链）', () => {
  const L = createSessionLedger()
  L.record({ branch: 'main', subject: 'Cu', key: 'a', value: 3.615 })   // fork 前的共享历史
  const A = L.fork({ from: 'main' })
  const B = L.fork({ from: 'main' })
  L.record({ branch: A.id, subject: 'Cu', key: 'energy', value: -3.1 })
  L.record({ branch: B.id, subject: 'Cu', key: 'energy', value: -3.6 })
  // fork 前记在 main 的 a，两子支都继承可见
  assert.equal(L.valueFor({ branch: A.id, subject: 'Cu', key: 'a' }).value, 3.615)
  assert.equal(L.valueFor({ branch: B.id, subject: 'Cu', key: 'a' }).value, 3.615)
  // 分叉后各自 energy 独立
  assert.equal(L.valueFor({ branch: A.id, subject: 'Cu', key: 'energy' }).value, -3.1)
  assert.equal(L.valueFor({ branch: B.id, subject: 'Cu', key: 'energy' }).value, -3.6)
  assert.equal(L.valueFor({ branch: 'main', subject: 'Cu', key: 'energy' }).found, false, 'main 看不到子支的记录')
})

test('2. 兄弟支彼此隔离', () => {
  const L = createSessionLedger()
  const A = L.fork({ from: 'main' })
  const B = L.fork({ from: 'main' })
  L.record({ branch: A.id, subject: 'X', key: 'k', value: 1 })
  assert.equal(L.valueFor({ branch: B.id, subject: 'X', key: 'k' }).found, false, 'B 不应看见 A 的记录')
})

test('3. add-only + 同键最新生效（结果不可变，不覆盖）', () => {
  const L = createSessionLedger()
  L.record({ branch: 'main', subject: 'Cu', key: 'energy', value: -3.0 })
  L.record({ branch: 'main', subject: 'Cu', key: 'energy', value: -3.2 })   // 再来一条，不覆盖
  const v = L.valueFor({ branch: 'main', subject: 'Cu', key: 'energy' })
  assert.equal(v.value, -3.2, '取最新 seq')
  assert.equal(L.history({ branch: 'main' }).length, 2, '两条都在账本里（未删旧）')
  assert.equal(L.status().nRecords, 2)
})

test('4. compare 只读并列各支 + 报分歧与数值跨度', () => {
  const L = createSessionLedger()
  const A = L.fork({ from: 'main' })
  const B = L.fork({ from: 'main' })
  L.record({ branch: A.id, subject: 'Cu', key: 'energy', value: -3.1 })
  L.record({ branch: B.id, subject: 'Cu', key: 'energy', value: -3.6 })
  const before = L.status().nRecords
  const c = L.compare({ subject: 'Cu', key: 'energy' })
  assert.equal(c.hasDisagreement, true)
  assert.equal(c.distinctValues, 2)
  assert.ok(Math.abs(c.spread - 0.5) < 1e-9, `spread=${c.spread}`)
  assert.equal(c.nFound, 2, 'main 无该键 → 只两支 found')
  assert.equal(L.status().nRecords, before, 'compare 是只读，不增记录')
})

test('5. markTrunk 非破坏：换主干不删他支、记录仍全在场可对照', () => {
  const L = createSessionLedger()
  const A = L.fork({ from: 'main' })
  const B = L.fork({ from: 'main' })
  L.record({ branch: A.id, subject: 'Cu', key: 'energy', value: -3.1 })
  L.record({ branch: B.id, subject: 'Cu', key: 'energy', value: -3.6 })
  const before = L.status()
  L.markTrunk({ branch: B.id })
  const after = L.status()
  assert.equal(after.trunk, B.id)
  assert.equal(after.nRecords, before.nRecords, '标主干不删记录')
  assert.equal(after.nBranches, before.nBranches, '标主干不删分支')
  assert.ok(after.branches.find(b => b.id === A.id && !b.isTrunk), 'A 支仍在、非主干')
  assert.equal(L.compare({ subject: 'Cu', key: 'energy' }).trunkValue, -3.6)
})

test('6. 错误门：未知支/重复 id/非法入参显式抛错，不静默', () => {
  const L = createSessionLedger()
  assert.throws(() => L.fork({ from: 'ghost' }), e => e.code === 'BRANCH_UNKNOWN')
  assert.throws(() => L.record({ branch: 'ghost', subject: 'x', key: 'k', value: 1 }), e => e.code === 'BRANCH_UNKNOWN')
  L.fork({ id: 'dup' })
  assert.throws(() => L.fork({ id: 'dup' }), e => e.code === 'BRANCH_EXISTS')
  assert.throws(() => L.fork({ id: 123 }), e => e.code === 'BRANCH_BAD_ID')
  assert.throws(() => L.record({ branch: 'main', key: 'k', value: 1 }), e => e.code === 'SUBJECT_REQUIRED')
  assert.throws(() => L.record({ branch: 'main', subject: 's', value: 1 }), e => e.code === 'KEY_REQUIRED')
  assert.throws(() => L.markTrunk({ branch: 'nope' }), e => e.code === 'BRANCH_UNKNOWN')
})

test('7. 确定性：同操作序列 → 同 status/同可见值（可复现规划树）', () => {
  const build = () => {
    const L = createSessionLedger()
    const A = L.fork({ from: 'main' }); L.fork({ from: 'main' })
    L.record({ branch: A.id, subject: 'Cu', key: 'energy', value: -3.1 })
    L.record({ subject: 'Cu', key: 'a', value: 3.6 })
    return L
  }
  assert.deepEqual(build().status(), build().status())
})
