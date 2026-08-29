// @saturday/plugin-ase 契约测试（契约 §4.2）
// 伪桥驱动契约套件（不启动子进程）；真实 sidecar 集成单独一项（LJ），
// 缺 python 或 ASE 环境自动跳过。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/index.mjs'
import { AseProvider } from '../src/ase-provider.mjs'
import { PythonBridge } from '@saturday/python-bridge'
import { Material, PrototypeLibResolver, PotentialRegistry } from '@saturday/core'
import { potentialProviderContract } from '@saturday/contract-tests'

const SIDECAR = fileURLToPath(new URL('../python-sidecar/ase_calc.py', import.meta.url))

/** 伪桥：记录调用、返回罐头结果或抛结构化错误 */
function makeFakeBridge({ result = { converged: true, energy: -0.00123, n_steps: 4 }, error } = {}) {
  const calls = []
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params })
      if (error) throw new Error(error)
      return result
    },
  }
}

test('1. 显式指定透传：relax 请求携带计算器名与参数', async () => {
  const bridge = makeFakeBridge()
  const provider = new AseProvider({ bridge, calculator: 'lj', calculatorParams: { epsilon: 0.02 } })
  const material = await Material.create({ modalities: { formula: 'Ar' } }, new PrototypeLibResolver())
  await provider.relax(material, { fmax: 0.01 })

  assert.equal(bridge.calls.length, 1)
  const { method, params } = bridge.calls[0]
  assert.equal(method, 'relax')
  assert.equal(params.calculator.name, 'lj')
  assert.deepEqual(params.calculator.params, { epsilon: 0.02 })
  assert.deepEqual(params.params, { fmax: 0.01 })
  assert.ok(Array.isArray(params.structure.numbers), 'structure 走 toDict() 形状')
})

test('2. 计算器缺失：结构化错误 → ENGINE_UNAVAILABLE，绝不隐式替换', async () => {
  const bridge = makeFakeBridge({ error: 'EngineUnavailableError: unknown calculator: gpaw' })
  const provider = new AseProvider({ bridge, calculator: 'gpaw' })
  const material = await Material.create({ modalities: { formula: 'Ar' } }, new PrototypeLibResolver())
  await assert.rejects(
    () => provider.relax(material),
    err => err.code === 'ENGINE_UNAVAILABLE' && /never silently substitutes/.test(err.message),
  )
})

test('3. 真实 sidecar：Ar + LJ 端到端（需 python + ASE；缺任一则跳过）', async t => {
  const bridge = new PythonBridge({ sidecar: SIDECAR })
  try {
    await bridge.connect()
  } catch {
    t.skip('python unavailable in this environment')
    return
  }
  try {
    const hello = bridge.sidecarInfo
    assert.equal(hello.sidecar, 'saturday-ase-calc')
    assert.equal(hello.eventGranularity, 'iteration')
    if (!hello.calculators.includes('lj')) {
      t.skip('ASE not installed: no constructable calculator')
      return
    }

    const provider = new AseProvider({ bridge, calculator: 'lj' })
    const material = await Material.create({ modalities: { formula: 'Ar' } }, new PrototypeLibResolver())
    const result = await provider.relax(material, {})
    assert.equal(result.engine, 'ase')
    assert.equal(result.calculator, 'ase:lj')
    assert.ok(Number.isFinite(result.energy))
    assert.equal(typeof result.converged, 'boolean')
  } finally {
    await bridge.disconnect()
  }
})

test('4. 注册即 effect：挂载进注册表，卸载自动注销', async () => {
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin({
    name: 'stub-core',
    apply(ctx) {
      const registry = new PotentialRegistry({ on() {}, emit() {} })
      ctx.reflect.provide('potential', registry)
      ctx.fiber.store.registry = registry
    },
  })
  const registry = coreFiber.store.registry
  const fiber = await ctx.registry.plugin({
    name: 'saturday-ase',
    apply: (ctx) => plugin.apply(ctx, { bridge: makeFakeBridge() }),
  })
  assert.ok(registry.providers.has('ase'), 'provider registered on mount')
  await fiber.dispose()
  assert.equal(registry.providers.has('ase'), false, 'provider withdrawn on unmount')
  await coreFiber.dispose()
})

test('5. 插件入口：缺 "potential" 服务即挂载失败（契约 §2）', async () => {
  const ctx = new Context()
  await assert.rejects(
    () => Promise.resolve().then(() => plugin.apply(ctx, { bridge: makeFakeBridge() })),
    /requires service "potential"/,
  )
})

// ── 标准契约套件（§4.2 + §5.2，伪桥驱动）────────────────────────
potentialProviderContract({
  subject: 'ase',
  createProvider: () => new AseProvider({ bridge: makeFakeBridge() }),
  runnable: true,
  runFormula: 'Ar',
  unavailable: {
    createProvider: () => new AseProvider({
      bridge: makeFakeBridge({ error: 'EngineUnavailableError: No module named ase' }),
    }),
    code: 'ENGINE_UNAVAILABLE',
  },
})
