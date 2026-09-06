// 活性上下文接真实工作流（§8.2）：势函数热替换 → 筛选候选失效传播
// 端到端链路：saturday 核心插件（当前数据面引擎：EMT / lj-js 回退档）+ derivation + screening 三插件同 Context。
// 1. screening 完成即登记两层推导（候选能量 ← [材料, 任务, 引擎]；排序 ← [基体, 各候选]）
// 2. activate 第二引擎 → saturday/potential/activated → bridge wiring 沿 engine:<旧引擎>
//    传播失效：候选与排序全链置 invalid（三级传播链）
// 3. 惰性重算拓扑序：先候选能量后排序

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/saturday.plugin.mjs'
import screeningPlugin from '@toki0413/plugin-screening'
import derivationPlugin from '@toki0413/plugin-derivation'

const TRAJECTORY = fileURLToPath(new URL('../data/trajectory-live-context.jsonl', import.meta.url))

let ctx, fiber, derivationFiber, screenFiber
let handles, screenRt, derivation
let screenResult

before(async () => {
  await rm(TRAJECTORY, { force: true })
  ctx = new Context()
  fiber = await ctx.registry.plugin({
    name: 'saturday',
    apply: (ctx) => plugin.apply(ctx, { trajectoryPath: TRAJECTORY }),
  })
  handles = fiber.store.saturday
  derivationFiber = await ctx.registry.plugin({
    name: 'saturday-derivation',
    apply: (ctx) => derivationPlugin.apply(ctx, {}),
  })
  derivation = ctx.reflect.get('derivation')
  screenFiber = await ctx.registry.plugin({
    name: 'saturday-screening',
    apply: (ctx) => screeningPlugin.apply(ctx, {}),
  })
  screenRt = screenFiber.store.saturdayScreening.rt

  // 真实筛选（Cu 基体 + EMT 范围内掺杂）：完成即登记推导
  const material = await ctx.reflect.get('material').load('Cu')
  screenResult = await screenRt.tools.call('workflow.screen', {
    materialId: material.id, dopants: ['Ni', 'Ag'], batchId: 'live-demo-1',
  })
})

after(async () => {
  await screenFiber.dispose()
  await derivationFiber.dispose()
  await fiber.dispose()
})

test('1. 筛选完成即登记两层推导：引擎是推导输入，初始全 valid', () => {
  // 数据面自适应：推导输入里的引擎名如实反映当前数据面（emt-mock / lj-js 回退档）
  const dataPlane = handles.dataPlane
  assert.equal(screenResult.failed.length, 0)
  const rec = screenResult.derivation
  assert.ok(rec, '注入 derivation 服务后结果必须携带登记凭证')
  assert.equal(rec.batchId, 'live-demo-1')
  assert.equal(rec.energyRefs.length, 3, '3 个变体 3 条候选能量推导')
  // 候选层：材料 + 任务 + 引擎 三输入
  const energyDrv = derivation.list().find(d => d.output === rec.energyRefs[0])
  assert.equal(energyDrv.inputs.length, 3)
  assert.ok(energyDrv.inputs.some(r => r.startsWith('material:')))
  assert.ok(energyDrv.inputs.some(r => r.startsWith('job:')))
  assert.ok(energyDrv.inputs.includes(`engine:${dataPlane}`), '引擎必须入推导输入（排序 = f(基体, 引擎)）')
  // 排序层：基体 + 各候选能量
  const rankDrv = derivation.list().find(d => d.output === rec.rankRef)
  assert.ok(rankDrv.inputs.some(r => r.startsWith('material:')))
  assert.ok(rec.energyRefs.every(ref => rankDrv.inputs.includes(ref)))
  // 初始全 valid
  assert.equal(derivation.status(rec.rankRef).status, 'valid')
  assert.ok(rec.energyRefs.every(ref => derivation.status(ref).status === 'valid'))
})

test('2. 势函数热替换：沿 engine:<旧引擎> 全链失效（候选 + 排序）', async () => {
  const rec = screenResult.derivation
  const dataPlane = handles.dataPlane
  // 注册第二引擎（stub：manifest 合法即可，不真跑）并热切换
  handles.potential.register({
    name: 'stub-dft',
    manifest: {
      capabilities: [{ type: 'relax', accuracy: 0.9, speed: 0.2, cost: 0.5, maxAtoms: 200 }],
      constraints: {},
      eventGranularity: 'iteration',
      units: { energy: 'eV', length: 'Å', time: 'fs' },
      fingerprint: { software: 'stub-dft', method: 'DFT-mock' },
    },
    relax: async () => { throw new Error('live-context 测试不应真跑第二引擎') },
  })
  await handles.potential.activate('stub-dft')

  // 三级传播链：引擎失效 → 候选能量失效 → 排序失效
  for (const ref of rec.energyRefs) {
    const s = derivation.status(ref)
    assert.equal(s.status, 'invalid', `候选能量 ${ref} 必须失效`)
    assert.equal(s.invalidatedBy.source, `engine:${dataPlane}`)
    assert.match(s.invalidatedBy.reason, /势函数热替换/)
  }
  const rank = derivation.status(rec.rankRef)
  assert.equal(rank.status, 'invalid', '排序依赖候选能量，必须级联失效')
  assert.equal(rank.invalidatedBy.source, `engine:${dataPlane}`, '失效溯源到同一引擎')
})

test('3. 幂等：重复激活同一引擎不再传播', async () => {
  const rec = screenResult.derivation
  const before = derivation.status(rec.rankRef)
  await handles.potential.activate('stub-dft')   // 同名激活：activate 直接返回
  const afterStatus = derivation.status(rec.rankRef)
  assert.deepEqual(afterStatus.invalidatedBy, before.invalidatedBy, '不得追加/改写失效记录')
})

test('4. 惰性重算：拓扑序（先候选能量后排序）+ 预算受控', async () => {
  const rec = screenResult.derivation
  await assert.rejects(
    () => derivation.recompute({ recompute: async () => {}, budget: 1 }),
    err => err.code === 'BUDGET_EXCEEDED',
    '4 条待重算超出预算 1：显式拒绝，不静默部分执行',
  )
  const order = []
  const { recomputed } = await derivation.recompute({
    recompute: async d => order.push(d.output),
    budget: 4,
  })
  assert.deepEqual(recomputed.sort(), [...rec.energyRefs, rec.rankRef].sort())
  assert.equal(order[order.length - 1], rec.rankRef, '排序依赖候选能量，必须最后重算')
  assert.ok(derivation.status(rec.rankRef).recomputedAt, '重算时间戳追加（append-only）')
})
