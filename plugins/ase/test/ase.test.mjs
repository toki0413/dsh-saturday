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

test('6. 真实 sidecar：harmonic 算子（弛豫+Hessian→简正模；缺环境跳过）', async t => {
  const bridge = new PythonBridge({ sidecar: SIDECAR })
  try {
    await bridge.connect()
  } catch {
    t.skip('python unavailable in this environment')
    return
  }
  try {
    if (!bridge.sidecarInfo.calculators.includes('lj')) {
      t.skip('ASE not installed: no constructable calculator')
      return
    }
    assert.equal(bridge.sidecarInfo.operations.harmonic, true, 'hello 声明必须含 harmonic')

    // LJ 参数匹配晶格（最近邻 3.72 Å ≈ 2^{1/6}σ → σ≈3.31）：起点即平衡点。
    // rc=5 截断在次近邻（5.26 Å）以外 → 最近邻中心力模型；ASE 平滑截断使有效势偏离
    // 裸 LJ 极小，引入张力 → 立方对称下纵/横模弹性常数比给出 ν_L/ν_T ≈ √2。
    const provider = new AseProvider({
      bridge, calculator: 'lj', calculatorParams: { sigma: 3.31, epsilon: 0.02, rc: 5 },
    })
    const material = await Material.create({ modalities: { formula: 'Ar' } }, new PrototypeLibResolver())
    const result = await provider.harmonic(material, {})
    assert.equal(result.calculator, 'ase:lj')
    assert.equal(typeof result.converged, 'boolean')
    assert.ok(Number.isFinite(result.u0_eV) && result.u0_eV < 0, '锚点能量有限且为束缚态')
    assert.equal(result.n_modes, 3 * material.nAtoms, '模式数 = 3N')
    assert.equal(result.imaginary_modes, 0, 'fcc LJ 平衡点不得有真虚频（否则暴露而非掩盖）')
    assert.equal(result.zero_modes, 3, '周期晶胞平动零模恰 3 个')
    assert.equal(result.frequencies_thz.length, 9, '实模 = 3N − 3 平动')
    const freqs = result.frequencies_thz
    for (let i = 1; i < freqs.length; i++) {
      assert.ok(freqs[i] >= freqs[i - 1], '频率升序')
    }
    // 谱形对账：横模 6 重简并 + 纵模 3 重简并（fcc 立方对称，有限差分下 1e-3 内），
    // ν_L/ν_T 对 √2（实测 ~0.1% 偏差，来自 σ 舍入与平滑截断细节；容差 0.5%）
    const nuT = freqs[0]
    const nuL = freqs[8]
    assert.ok(freqs.slice(0, 6).every(f => Math.abs(f - nuT) / nuT < 1e-3), '横模 6 重简并')
    assert.ok(freqs.slice(6).every(f => Math.abs(f - nuL) / nuL < 1e-3), '纵模 3 重简并')
    assert.ok(Math.abs(nuL / nuT - Math.SQRT2) / Math.SQRT2 < 5e-3,
      `中心力+张力立方对称比 ν_L/ν_T ≈ √2（实测 ${(nuL / nuT).toFixed(4)}）`)
  } finally {
    await bridge.disconnect()
  }
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

test('7. 实测态回读（①）：probeVersion 取 sidecar 握手 ASE 版本；探测失败诚实返回 null', async () => {
  // 握手携带实测版本 → 回读成功（调用方据此经 stampFingerprint 升级指纹）
  const helloBridge = {
    async call(method) { return method === 'hello' ? { aseVersion: '3.23.0' } : {} },
  }
  assert.equal(await new AseProvider({ bridge: helloBridge }).probeVersion(), '3.23.0')
  // 无 ASE（aseVersion 为 null/空）→ null（保持 'unknown' 声明态，不冒充已知）
  const noAse = { async call() { return { aseVersion: null } } }
  assert.equal(await new AseProvider({ bridge: noAse }).probeVersion(), null)
  // sidecar 异常 → null（探测失败不抛错，留给调用方诚实降级）
  const broken = { async call() { throw new Error('sidecar gone') } }
  assert.equal(await new AseProvider({ bridge: broken }).probeVersion(), null)
})
