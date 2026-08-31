// 桥层优雅回退测试：Python 数据面不可用时显式回退到零依赖纯 JS 引擎 lj-js
// （开箱即用纪律：横幅如实报告，非静默降级；回退路径全链路可用）

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/saturday.plugin.mjs'
import { PythonBridge } from '@saturday/python-bridge'

const TRAJECTORY = fileURLToPath(new URL('../data/fallback-trajectory.jsonl', import.meta.url))
// 指向不存在的解释器：模拟纯 Node 环境（无 Python）
const NO_PYTHON = { python: 'saturday-nonexistent-python-binary' }

let ctx, fiber

before(async () => {
  await rm(TRAJECTORY, { force: true })
})

after(async () => {
  if (fiber) await fiber.dispose()
})

test('1. Python 缺失 → 显式回退 lj-js：数据面形态如实声明', async () => {
  ctx = new Context()
  fiber = await ctx.registry.plugin({
    name: 'saturday',
    apply: (ctx) => plugin.apply(ctx, { bridge: NO_PYTHON, quiet: true, trajectoryPath: TRAJECTORY }),
  })
  const handles = fiber.store.saturday
  assert.equal(handles.dataPlane, 'lj-js', 'store.dataPlane 必须如实声明回退形态')
  assert.ok(handles.potential.providers.has('lj-js'), '回退引擎必须显式注册（非隐式替换）')
  assert.ok(!handles.potential.providers.has('emt-mock'), 'Python 缺失时 emt-mock 不得注册')
  assert.equal(handles.potential.activeProvider, 'lj-js')
  assert.equal(
    handles.potential.get('lj-js').manifest.fingerprint.software, 'lj-js',
    '回退引擎指纹独立声明（跨引擎组合门禁照常生效）',
  )
})

test('2. 回退路径全链路可用：material.load + potential.relax 真实计算', async () => {
  const handles = fiber.store.saturday
  const loaded = await handles.rt.tools.call('material.load', { query: 'Ar' })
  assert.ok(loaded.materialId)
  const result = await handles.rt.tools.call('potential.relax', {
    materialId: loaded.materialId, simulatedSeconds: 0,
  })
  assert.equal(result.engine, 'lj-js', '弛豫必须如实标明回退引擎')
  assert.ok(Number.isFinite(result.energy))
  assert.equal(typeof result.converged, 'boolean')
})

test('3. 横幅如实报告（非静默降级）：回退信息含引擎名与解锁路径', async () => {
  await fiber.dispose()
  fiber = null
  const lines = []
  const original = console.log
  console.log = (...args) => lines.push(args.join(' '))
  try {
    const ctx2 = new Context()
    const fiber2 = await ctx2.registry.plugin({
      name: 'saturday',
      apply: (ctx) => plugin.apply(ctx, { bridge: NO_PYTHON, trajectoryPath: TRAJECTORY }),
    })
    await fiber2.dispose()
  } finally {
    console.log = original
  }
  const banner = lines.join('\n')
  assert.match(banner, /Python 数据面不可用/, '横幅必须如实报告数据面缺失')
  assert.match(banner, /lj-js/, '横幅必须标明回退引擎身份')
  assert.match(banner, /ASE/, '横幅必须给出精度解锁路径')
})

test('4. Python 可用时行为不变：数据面保持 emt-mock（回归无漂移）', async t => {
  // 环境探测：默认解释器不可用时跳过（与 ase.test 的 skip 纪律同款）
  const probe = new PythonBridge({})
  try {
    await probe.connect()
  } catch {
    t.skip('python unavailable in this environment')
    return
  }
  await probe.disconnect()

  const ctx3 = new Context()
  const fiber3 = await ctx3.registry.plugin({
    name: 'saturday',
    apply: (ctx) => plugin.apply(ctx, { quiet: true, trajectoryPath: TRAJECTORY }),
  })
  try {
    assert.equal(fiber3.store.saturday.dataPlane, 'emt-mock', '有 Python 时数据面不得漂移')
    assert.ok(fiber3.store.saturday.potential.providers.has('emt-mock'))
  } finally {
    await fiber3.dispose()
  }
})
