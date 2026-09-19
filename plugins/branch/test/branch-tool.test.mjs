// session.* 工具级集成测试：挂 plugin-branch，经工具出口跑一遍分叉-记录-对照-主干-快照 + 卸载回收。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/index.mjs'

test('1. 五工具在册 + 端到端分叉对照 + 主干非破坏 + 卸载回收', async () => {
  const ctx = new Context()
  const fiber = await ctx.registry.plugin({ name: 'saturday-branch', apply: (c) => plugin.apply(c, {}) })
  const rt = fiber.store.saturdayBranch.rt
  const call = (name, args) => rt.tools.call(name, args)
  assert.deepEqual(rt.tools.list().map(t => t.name).sort(),
    ['session.compare', 'session.fork', 'session.record', 'session.status', 'session.trunk'])
  try {
    await call('session.record', { branch: 'main', subject: 'Cu', key: 'a', value: 3.6 })
    const A = await call('session.fork', { from: 'main' })
    const B = await call('session.fork', { from: 'main' })
    await call('session.record', { branch: A.id, subject: 'Cu', key: 'energy', value: -3.1, meta: 'emt' })
    await call('session.record', { branch: B.id, subject: 'Cu', key: 'energy', value: -3.6, meta: 'lj' })

    // 共享历史：两子支都看见 main 的 a
    const cmpA = await call('session.compare', { subject: 'Cu', key: 'a' })
    assert.ok(cmpA.nFound >= 1)
    // 分歧对照：两支 energy 不同
    const cmp = await call('session.compare', { subject: 'Cu', key: 'energy' })
    assert.equal(cmp.hasDisagreement, true)
    assert.ok(Math.abs(cmp.spread - 0.5) < 1e-9)

    // 主干非破坏：选 B 为主干后 A 仍在、记录数不变
    const before = await call('session.status', {})
    await call('session.trunk', { branch: B.id })
    const after = await call('session.status', {})
    assert.equal(after.trunk, B.id)
    assert.equal(after.nRecords, before.nRecords)
    assert.equal(after.nBranches, before.nBranches)
  } finally {
    await fiber.dispose()
    assert.equal(rt.tools.list().length, 0, '工具随卸载回收')
  }
})

test('2. record 非法入参经工具出口显式失败（缺 subject）', async () => {
  const ctx = new Context()
  const fiber = await ctx.registry.plugin({ name: 'saturday-branch', apply: (c) => plugin.apply(c, {}) })
  const rt = fiber.store.saturdayBranch.rt
  try {
    await assert.rejects(() => rt.tools.call('session.record', { key: 'k', value: 1 }), e => /SUBJECT_REQUIRED/.test(String(e?.message)))
  } finally {
    await fiber.dispose()
  }
})
