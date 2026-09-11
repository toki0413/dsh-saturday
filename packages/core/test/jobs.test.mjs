// JobLedger + 引擎源标识 + detach 语义（core 层：动态拆装与热替换的承载机制）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PotentialRegistry, engineSourceId, JobLedger, jobError } from '@toki0413/core'

const mkProvider = (name = 'eng', model) => ({
  name,
  ...(model ? { model } : {}),
  manifest: {
    capabilities: [{ type: 'relax', accuracy: 0.5, speed: 0.5, cost: 0.5 }],
    units: { energy: 'eV', length: 'Å', time: 'fs' },
    fingerprint: { software: 's', method: 'm', version: 'unknown' },
  },
})

test('1. JobLedger：提交即记账、销账即消失、重复 settle 幂等、按 provider 查询', () => {
  const l = new JobLedger()
  const j1 = l.submit({ provider: 'a', kind: 'relax' })
  const j2 = l.submit({ provider: 'b', kind: 'md' })
  assert.equal(l.activeOf('a').length, 1)
  assert.equal(l.activeOf().length, 2)
  assert.equal(l.settle(j1, 'ok'), true)
  assert.equal(l.settle(j1, 'ok'), false, '重复销账幂等（未知/已销 → false，不抛）')
  assert.equal(l.activeOf('a').length, 0)
  assert.equal(l.activeOf('b').length, 1)
  assert.throws(() => l.submit({}), e => e.code === 'JOB_BAD_INPUT')
})

test('2. awaitDrain：无作业立即可；有作业超时如实返回 pending（不静默等待成功）', async () => {
  const l = new JobLedger()
  assert.deepEqual(await l.awaitDrain('x', { timeoutMs: 10 }), { drained: true, pending: [] })
  l.submit({ provider: 'x' })
  const r = await l.awaitDrain('x', { timeoutMs: 30, pollMs: 10 })
  assert.equal(r.drained, false)
  assert.equal(r.pending.length, 1)
})

test('3. register 鸭子注入台账与源标识；unregister 收回注入', () => {
  const reg = new PotentialRegistry({ emit: async () => {} })
  const p = mkProvider()
  reg.register(p)
  assert.equal(p.jobs, reg.jobs, 'provider 拿到台账句柄（可选参与，不破坏既有 provider）')
  assert.match(p._sourceId, /^engine:eng@[0-9a-f]{8}$/)
  reg.unregister('eng')
  assert.equal(p.jobs, undefined, '注销收回句柄')
})

test('4. detach 三策略：refuse 有作业即拒；drain 等收尾后注销；cancel 无通道即 CANCEL_UNSUPPORTED', async () => {
  const reg = new PotentialRegistry({ emit: async () => {} })
  reg.register(mkProvider('e1'))
  reg.jobs.submit({ provider: 'e1' })
  await assert.rejects(() => reg.detach('e1'), e => e.code === 'ACTIVE_JOBS')
  await assert.rejects(() => reg.detach('e1', { onActive: 'cancel' }), e => e.code === 'CANCEL_UNSUPPORTED')
  await assert.rejects(
    () => reg.detach('e1', { onActive: 'drain', timeoutMs: 30 }),
    e => e.code === 'DRAIN_TIMEOUT')
  // 在途作业 drain 期间收尾：hadActiveJobs=true 且成功拆下
  const settleLater = setTimeout(() => {
    for (const rec of reg.jobs.activeOf('e1')) reg.jobs.settle(rec.jobId)
  }, 15)
  const r = await reg.detach('e1', { onActive: 'drain', timeoutMs: 1000 })
  clearTimeout(settleLater)
  assert.equal(r.detached, 'e1')
  assert.equal(r.hadActiveJobs, true, '拆时确有在途作业，drain 等到收尾')
  assert.equal(r.drained, true)
  assert.equal(reg.providers.has('e1'), false)
  // 无在途作业：refuse 也能直接拆
  reg.register(mkProvider('e2'))
  assert.deepEqual(await reg.detach('e2'), { detached: 'e2', hadActiveJobs: false, drained: true })
})

test('5. engineSourceId：档位/版本维变化必变哈希；盖章升级触发 refingerprinted 广播（同名重注册被碰撞防护拒绝）', async () => {
  const emitted = []
  const reg = new PotentialRegistry({ emit: async (type, ev) => emitted.push(ev.payload) })
  const a = mkProvider('mace', 'medium')
  reg.register(a)
  // 纯函数层面：同名不同档 → 源标识必异（不经过注册表，避开碰撞防护——防护本身由测试 6 验）
  assert.notEqual(engineSourceId(a), engineSourceId(mkProvider('mace', 'small')),
    '同名引擎换 checkpoint 档位 → 源标识变（失效有据）')
  // 盖章 unknown→实测：sourceId 变 → 广播事件（局部升级不再对下游隐身）
  const before = a._sourceId
  await reg.stampFingerprint('mace', { version: '0.3.16' })
  assert.notEqual(a._sourceId, before)
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].engine, 'mace')
  assert.equal(emitted[0].previousSourceId, before)
  // 盖同值（sourceId 不变）→ 不广播（幂等，不制造假失效）
  await reg.stampFingerprint('mace', { version: '0.3.16' })
  assert.equal(emitted.length, 1, '无实质变化不广播')
})

test('6. engineSourceId 纯函数可算；同名重注册被碰撞防护显式拒绝（attach 不静默替换）', () => {
  assert.match(engineSourceId(mkProvider('x')), /^engine:x@/)
  const reg = new PotentialRegistry({ emit: async () => {} })
  const p1 = mkProvider('dup')
  reg.register(p1)
  assert.throws(() => reg.register(mkProvider('dup')), e => e.code === 'PROVIDE_COLLISION')
  reg.register(p1)  // 同一对象重注册合法（幂等路径不拒）
})
