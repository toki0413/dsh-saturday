// @saturday/plugin-derivation 测试（契约 §8.2 首个实证：活性上下文地基）
// 纯层：登记/状态、传递失效与幂等、冻结语义、显式错、预算与拓扑重算；
// 插件层：挂载/卸载回收、工具端到端（失效事件薄载荷）、
//         不可变 fork 非失效源的语义固化；
// 套件：derivationContract 接入。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Material, PrototypeLibResolver } from '@saturday/core'
import { derivationContract } from '@saturday/contract-tests'
import plugin, { createDerivationRegistry } from '../src/index.mjs'

// ── 纯层：登记簿语义 ────────────────────────────────────────

test('1. 登记与状态：导出量声明推导来源，初始 valid', () => {
  const reg = createDerivationRegistry()
  reg.record({ inputs: ['material:cu'], output: 'result:e0', producer: 'workflow.screening' })
  const s = reg.status('result:e0')
  assert.equal(s.status, 'valid')
  assert.equal(s.frozen, false)
  assert.equal(s.producer, 'workflow.screening')
  assert.equal(reg.size, 1)
})

test('2. 传递失效：三级链下游全失效、上游无关分支不受影响、重复失效幂等', async () => {
  const reg = createDerivationRegistry()
  reg.record({ inputs: ['material:cu'], output: 'result:e1', producer: 'relax' })
  reg.record({ inputs: ['result:e1'], output: 'result:hull', producer: 'analysis.convex-hull' })
  reg.record({ inputs: ['material:ag'], output: 'result:e-ag', producer: 'relax' })  // 无关分支

  const r = await reg.invalidate('material:cu', '结构源撤回：原型库条目勘误')
  assert.deepEqual(r.invalidated.sort(), ['result:e1', 'result:hull'])
  assert.equal(reg.status('result:hull').status, 'invalid')
  assert.equal(reg.status('result:hull').invalidatedBy.reason, '结构源撤回：原型库条目勘误')
  assert.equal(reg.status('result:e-ag').status, 'valid', '无关分支不受传播影响')

  const again = await reg.invalidate('material:cu', '重复声明')
  assert.equal(again.invalidated.length, 0, '已失效不重复传播')
})

test('3. 冻结语义：只追加修正不改状态，传播越过冻结节点继续', async () => {
  const reg = createDerivationRegistry()
  reg.record({ inputs: ['material:cu'], output: 'result:xrd', producer: 'experiment', frozen: true })
  reg.record({ inputs: ['result:xrd'], output: 'result:phase', producer: 'analysis.index' })

  const r = await reg.invalidate('material:cu', '样品批次勘误')
  const sx = reg.status('result:xrd')
  assert.equal(sx.status, 'valid', '冻结（实验数据）不得置 invalid')
  assert.equal(sx.corrections.length, 1)
  assert.equal(sx.corrections[0].reason, '样品批次勘误')
  assert.deepEqual(r.corrections, ['result:xrd'])
  assert.equal(reg.status('result:phase').status, 'invalid', '传播越过冻结节点继续（不吞失效）')

  // 冻结节点永不进入重算集
  const { recomputed } = await reg.recompute({ recompute: async () => {}, budget: 10 })
  assert.deepEqual(recomputed, ['result:phase'], '冻结结果不在重算集（§7）')
})

test('4. 显式失败：未登记查状态与非法引用形', () => {
  const reg = createDerivationRegistry()
  assert.throws(() => reg.status('result:ghost'), err => err.code === 'DERIVATION_NOT_FOUND')
  assert.throws(() => reg.status('not-a-ref'), err => err.code === 'INVALID_REF')
  assert.throws(
    () => reg.record({ inputs: ['material:cu'], output: 'result:e0', producer: '' }),
    err => err.code === 'INVALID_REF',
    'producer 缺失必须显式错',
  )
})

test('5. 惰性重算：预算受控（超预算显式错）+ 拓扑序 + append-only 登记簿不缩水', async () => {
  const reg = createDerivationRegistry()
  reg.record({ inputs: ['material:cu'], output: 'result:e1', producer: 'relax' })
  reg.record({ inputs: ['result:e1'], output: 'result:e2', producer: 'analysis' })
  await reg.invalidate('material:cu', '参数勘误')

  await assert.rejects(
    () => reg.recompute({ recompute: async () => {}, budget: 1 }),
    err => err.code === 'BUDGET_EXCEEDED',
    '预算是资源承诺：超预算显式错，不静默部分执行',
  )

  const order = []
  const { recomputed } = await reg.recompute({ recompute: async d => order.push(d.output), budget: 2 })
  assert.deepEqual(order, ['result:e1', 'result:e2'], '依赖在前：先重算上游再重算下游')
  assert.deepEqual(recomputed.sort(), ['result:e1', 'result:e2'])
  assert.equal(reg.status('result:e2').status, 'valid')
  assert.ok(reg.status('result:e2').recomputedAt)
  assert.equal(reg.size, 2, 'append-only：登记簿不因失效/重算缩水')
})

// ── 插件层：挂载与工具 ──────────────────────────────────────

test('6. 注册即 effect：服务与工具随挂载出现、随卸载回收', async () => {
  const ctx = new Context()
  const fiber = await ctx.registry.plugin(plugin)
  const { rt, registry } = fiber.store.saturdayDerivation
  try {
    assert.ok(rt.getService('derivation') === registry, '服务注册即 effect')
    assert.ok(rt.tools.list().some(t => t.name === 'derivation.invalidate'))
    assert.ok(rt.tools.list().some(t => t.name === 'derivation.record'))
    assert.ok(rt.tools.list().some(t => t.name === 'derivation.status'))
  } finally {
    // fiber.store 随 dispose 回收：先取引用再做回收断言（既有教训）
    await fiber.dispose()
    assert.equal(rt.getService('derivation'), undefined, '服务随卸载消失')
    assert.ok(!rt.tools.list().some(t => t.name === 'derivation.invalidate'), '工具随卸载回收')
  }
})

test('7. 工具端到端：record → invalidate → status，失效事件薄载荷', async () => {
  const ctx = new Context()
  const events = []
  ctx.events.on('saturday/derivation/invalidated', e => events.push(e))
  const fiber = await ctx.registry.plugin(plugin)
  try {
    const tools = fiber.store.saturdayDerivation.rt.tools
    await tools.call('derivation.record', {
      inputs: ['material:cu-1'], output: 'result:e-cu', producer: 'workflow.screening',
    })
    await tools.call('derivation.record', {
      inputs: ['result:e-cu'], output: 'result:rank', producer: 'workflow.screening',
    })
    const inv = await tools.call('derivation.invalidate', {
      ref: 'material:cu-1', reason: '结构源撤回',
    })
    assert.deepEqual(inv.invalidated.sort(), ['result:e-cu', 'result:rank'])

    const st = await tools.call('derivation.status', { ref: 'result:rank' })
    assert.equal(st.status, 'invalid')

    assert.equal(events.length, 1, '一次传播一条事件')
    const p = events[0].payload
    assert.equal(p.source, 'material:cu-1')
    assert.ok(Array.isArray(p.invalidated), '薄载荷：引用清单而非记录本体')
    assert.equal(p.reason, '结构源撤回')
  } finally {
    await fiber.dispose()
  }
})

test('8. 语义固化：substitute fork 不是失效源（不可变冻结原对象，§6）', async () => {
  const reg = createDerivationRegistry()
  const cu = await Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())
  reg.record({ inputs: [`material:${cu.id}`], output: 'result:e-cu', producer: 'relax' })

  // fork 产生新对象：原结构及其推导不受影响，失效源只有显式 invalidate
  const doped = cu.substitute(0, 'Ag')
  assert.notEqual(doped.id, cu.id)
  assert.equal(reg.status('result:e-cu').status, 'valid', 'fork 不触发父结构推导失效')

  // 新结构要进入活性上下文，必须自行登记新推导（谱系独立）
  reg.record({ inputs: [`material:${doped.id}`], output: 'result:e-doped', producer: 'relax' })
  await reg.invalidate(`material:${doped.id}`, '掺杂候选撤回')
  assert.equal(reg.status('result:e-doped').status, 'invalid')
  assert.equal(reg.status('result:e-cu').status, 'valid', 'fork 链失效不回灌父链')
})

// ── 套件接入：derivationContract（第五套件第二个接入者）──────

test('9. derivationContract：本插件登记簿通过全部契约断言', async () => {
  // 套件在模块加载期注册自身测试；此处以函数形态直接复用断言逻辑验证插件实现
  const events = []
  const reg = createDerivationRegistry({ emit: async (type, event) => events.push(event) })

  reg.record({ inputs: ['material:m1'], output: 'result:e1', producer: 'contract-mock' })
  assert.equal(reg.status('result:e1').status, 'valid')

  reg.record({ inputs: ['result:e1'], output: 'result:e2', producer: 'contract-mock' })
  const r = await reg.invalidate('material:m1', 'contract: 结构源撤回')
  assert.deepEqual(r.invalidated.sort(), ['result:e1', 'result:e2'])
  assert.equal(events.length, 1, '传播发事件（薄载荷）')

  const frozenReg = createDerivationRegistry()
  frozenReg.record({ inputs: ['material:m1'], output: 'result:f', producer: 'experiment', frozen: true })
  await frozenReg.invalidate('material:m1', 'contract: 勘误')
  assert.equal(frozenReg.status('result:f').status, 'valid')
  assert.equal(frozenReg.status('result:f').corrections.length, 1)

  assert.throws(() => reg.status('result:ghost'), err => err.code === 'DERIVATION_NOT_FOUND')

  await reg.recompute({ recompute: async () => {}, budget: 2 })
  assert.equal(reg.status('result:e2').status, 'valid')
})

derivationContract({
  subject: 'derivation',
  createRegistry: () => createDerivationRegistry(),
})
