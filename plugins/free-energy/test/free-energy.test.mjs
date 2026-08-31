// @saturday/plugin-free-energy 测试（热力学第二档：构型自由能热力学积分）
// 纯层：输入门禁（锚点纪律延续）+ 谐波解析对账（梯形积分对闭式 ΔF）；
// 插件层：工具挂载与回收、缺服务显式报错、端到端（事件 + 锚点回环）+ 真实 ASE 冒烟。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Material, PrototypeLibResolver, PotentialRegistry } from '@saturday/core'
import plugin, { freeEnergyByIntegration, harmonicVibrationalFreeEnergy, KB_EV_PER_K, H_EV_S } from '../src/index.mjs'

// ── 纯层：输入门禁（第一档纪律延续：零点不得静默假设）────────

const grid = [100, 200, 300]
const series = grid.map(t => Array.from({ length: 5 }, () => -12 + t / 1000))

test('1. 门禁：缺锚点抛 THERMO_REFERENCE_MISSING（自由能零点必须显式声明）', () => {
  assert.throws(
    () => freeEnergyByIntegration({ temperaturesK: grid, potentialEnergies: series }),
    err => err.code === 'THERMO_REFERENCE_MISSING' && /never assumed/.test(err.message),
  )
})

test('2. 门禁：网格/对齐/升序/锚点在网格上/非有限值，逐项显式报错', () => {
  const anchor = { temperatureK: 200, F0: -1 }
  assert.throws(() => freeEnergyByIntegration({ temperaturesK: [100], potentialEnergies: [[1]], anchor }),
    err => err.code === 'THERMO_INVALID_INPUT')
  assert.throws(() => freeEnergyByIntegration({ temperaturesK: grid, potentialEnergies: series.slice(0, 2), anchor }),
    err => err.code === 'THERMO_INVALID_INPUT')
  assert.throws(() => freeEnergyByIntegration({ temperaturesK: [300, 100], potentialEnergies: [[1], [1]], anchor: { temperatureK: 100, F0: 0 } }),
    err => err.code === 'THERMO_INVALID_INPUT')
  assert.throws(() => freeEnergyByIntegration({ temperaturesK: grid, potentialEnergies: series, anchor: { temperatureK: 150, F0: 0 } }),
    err => err.code === 'THERMO_INVALID_INPUT' && /must be one of the grid points/.test(err.message))
  assert.throws(() => freeEnergyByIntegration({ temperaturesK: grid, potentialEnergies: [[NaN], [1], [1]], anchor }),
    err => err.code === 'THERMO_INVALID_INPUT')
  assert.throws(() => freeEnergyByIntegration({ temperaturesK: grid, potentialEnergies: [[], [1], [1]], anchor }),
    err => err.code === 'THERMO_INVALID_INPUT')
})

// ── 纯层：解析对账（不靠数值巧合）──────────────────────
// 解析体系：⟨U⟩(β) 取 β 的线性函数 g(β) = E₀ + c·β（对应 ⟨U⟩(T) = E₀ + c/(k_B T)）——
// 梯形法对线性核**精确**（截断误差恒为零），因此积分结果对闭式：
//   Δ(βF) = E₀(β−β₀) + c·(β²−β₀²)/2，ΔF = Δ(βF)/β
// 任何实现误差（插值/分段/符号）都会直接暴露，不靠容差掩盖。
// 谐波体系（⟨U⟩ = E₀ + d·k_B T/2 → g 含 1/β 对数项）作为第二套独立核验，
// 梯形截断误差随网格加密收敛，用密网格压进容差。

test('3. 解析对账：线性核梯形精确闭式 + 谐波密网格收敛 + 锚点精确归零', () => {
  // ─ 第一套：线性核（梯形精确）──
  // 完整闭式：ΔF(T) = [E₀(β−β₀) + c(β²−β₀²)/2]/β + F₀(β₀−β)/β，
  // 末项是锚点绝对自由能随 β 的传播（β₀F₀/β − F₀）——不得遗漏。
  const E0 = -12.0
  const c = 5e-4 // eV²，使 ⟨U⟩ 跨网格有可观差异（~47 meV）
  const beta = t => 1 / (KB_EV_PER_K * t)
  const temps = [100, 200, 300, 400, 500]
  const g = b => E0 + c * b
  const energies = temps.map(t => Array.from({ length: 4 }, () => g(beta(t))))
  const anchor = { temperatureK: 300, F0: -11.8 }

  const out = freeEnergyByIntegration({
    temperaturesK: temps, potentialEnergies: energies,
    anchor, anchorSource: 'linear-analytic',
  })

  assert.equal(out.method, 'thermodynamic-integration')
  assert.equal(out.quantity, 'configurational-free-energy')
  assert.equal(out.anchor.source, 'linear-analytic', '锚点来源声明必须随交付呈现')
  const anchorPoint = out.curve.find(p => p.temperatureK === 300)
  assert.ok(Math.abs(anchorPoint.dF) < 1e-12, '锚点处 ΔF 必须精确为零')
  assert.ok(Math.abs(anchorPoint.F - anchor.F0) < 1e-12, '锚点处 F 必须等于显式声明的 F₀')
  for (const t of [100, 200, 400, 500]) {
    const point = out.curve.find(p => p.temperatureK === t)
    const integral = E0 * (beta(t) - beta(300)) + c * (beta(t) ** 2 - beta(300) ** 2) / 2
    const expected = integral / beta(t) + anchor.F0 * (beta(300) - beta(t)) / beta(t)
    assert.ok(Math.abs(point.dF - expected) < 1e-9,
      `线性核：ΔF(${t} K) 必须精确落闭式（期望 ${expected}，实测 ${point.dF}）`)
  }
  // 统计诚实：常量序列 → sem 为 0（不夸大不确定性也不伪造）
  assert.ok(out.curve.every(p => p.sem === 0))
  assert.ok(out.note.includes('不含动量部分'), '诚实边界必须写进交付')
})

test('4. 解析对账（第二套）：谐波核密网格梯形收敛到闭式（截断误差有界）', () => {
  const E0 = -12.0
  const d = 12
  const F0 = -11.8
  const beta = t => 1 / (KB_EV_PER_K * t)
  const harmonicMeanU = (t) => E0 + d * KB_EV_PER_K * t / 2
  // 完整闭式：积分项/β + 锚点传播项（同测试 3，不得遗漏）
  const expectedDF = (t) => {
    const integral = E0 * (beta(t) - beta(300)) + (d / 2) * Math.log(beta(t) / beta(300))
    return integral / beta(t) + F0 * (beta(300) - beta(t)) / beta(t)
  }

  const temps = Array.from({ length: 21 }, (_, i) => 100 + i * 20) // 100..500 K 密网格
  const energies = temps.map(t => Array.from({ length: 4 }, () => harmonicMeanU(t)))
  const out = freeEnergyByIntegration({
    temperaturesK: temps, potentialEnergies: energies,
    anchor: { temperatureK: 300, F0 }, anchorSource: 'harmonic-analytic',
  })
  for (const t of [100, 500]) {
    const point = out.curve.find(p => p.temperatureK === t)
    const expected = expectedDF(t)
    assert.ok(Math.abs(point.dF - expected) < 5e-4,
      `谐波核：ΔF(${t} K) 应落密网格截断容差内（期望 ${expected}，实测 ${point.dF}）`)
  }
})

test('5. 统计诚实：带噪声轨迹 → sem 为正有限数且随样本量缩小', () => {
  const temps = [100, 200]
  const noisy = (n) => [Array.from({ length: n }, (_, i) => -12 + 0.01 * Math.sin(i)),
                         Array.from({ length: n }, (_, i) => -11.9 + 0.01 * Math.cos(i))]
  const small = freeEnergyByIntegration({ temperaturesK: temps, potentialEnergies: noisy(4), anchor: { temperatureK: 100, F0: 0 } })
  const large = freeEnergyByIntegration({ temperaturesK: temps, potentialEnergies: noisy(64), anchor: { temperatureK: 100, F0: 0 } })
  for (const p of small.curve) assert.ok(Number.isFinite(p.sem) && p.sem > 0)
  assert.ok(large.curve[0].sem < small.curve[0].sem, 'sem 必须随样本量缩小（标准误语义）')
})

// ── 插件层 ──────────────────────────────────────────────────

// 线性核解析引擎：md 返回 ⟨U⟩(T) = E₀ + c·β 的常量序列（确定性）
function linearMdEngine(c) {
  const betaOf = t => 1 / (KB_EV_PER_K * t)
  return {
    name: 'linear-analytic',
    manifest: {
      capabilities: [
        { type: 'md', accuracy: 0.9, speed: 0.99, cost: 0.01, maxAtoms: 200 },
      ],
      constraints: {},
      eventGranularity: 'job',
      units: { energy: 'eV', length: 'Å', time: 'fs' },
      fingerprint: { software: 'linear-analytic', method: 'analytic' },
    },
    async md(material, params = {}) {
      const t = params.temperature_K ?? 300
      const meanU = -12.0 + c * betaOf(t)
      return {
        jobId: `md-T${t}`, engine: 'linear-analytic',
        energies: Array.from({ length: 10 }, () => meanU),
        n_steps: params.steps ?? 10,
      }
    },
  }
}

const C_LINEAR = 5e-4 // 与测试 3 同一线性核系数

function stubCorePlugin(engine) {
  return {
    name: 'stub-core-fe',
    async apply(ctx) {
      const resolver = new PrototypeLibResolver()
      const store = new Map()
      ctx.reflect.provide('material', {
        async load(formula) {
          const m = await Material.create({ modalities: { formula } }, resolver)
          store.set(m.id, m)
          return m
        },
        async get(id) {
          const m = store.get(id)
          if (!m) throw new Error(`Unknown material id: ${id}`)
          return m
        },
      })
      const potential = new PotentialRegistry({ on() {}, emit() {} })
      potential.register(engine)
      await potential.activate(engine.name)
      ctx.reflect.provide('potential', potential)
      const events = []
      ctx.events.on('saturday/analysis/complete', e => events.push(e))
      ctx.fiber.store.stub = { events }
    },
  }
}

test('6. 插件挂载：工具注册，卸载回收', async () => {
  const ctx = new Context()
  const fiber = await ctx.registry.plugin({
    name: 'saturday-free-energy',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdayFreeEnergy
    assert.ok(rt.tools.list().some(t => t.name === 'workflow.freeEnergy'))
  } finally {
    const { rt } = fiber.store.saturdayFreeEnergy
    await fiber.dispose()
    assert.ok(!rt.tools.list().some(t => t.name === 'workflow.freeEnergy'), '工具随卸载回收')
  }
})

test('7. 缺核心服务必须显式报错，不得静默降级（契约 §2）', async () => {
  const ctx = new Context()
  const fiber = await ctx.registry.plugin({
    name: 'saturday-free-energy',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdayFreeEnergy
    await assert.rejects(
      () => rt.tools.call('workflow.freeEnergy', { referenceId: 'x' }),
      err => err.code === 'THERMO_INVALID_INPUT' && /requires services/.test(err.message),
    )
  } finally {
    await fiber.dispose()
  }
})

test('8. 端到端：解析引擎 → 曲线 + 锚点回环 + 事件薄载荷', async () => {
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(linearMdEngine(C_LINEAR)))
  const fiber = await ctx.registry.plugin({
    name: 'saturday-free-energy',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdayFreeEnergy
    const { events } = coreFiber.store.stub
    const loaded = await rt.getService('material').load('Cu')

    const temps = [100, 200, 300, 400, 500]
    const F0 = -11.5
    const out = await rt.tools.call('workflow.freeEnergy', {
      referenceId: loaded.id, temperatures: temps,
      anchorTemperatureK: 300, anchorF0: F0, anchorSource: 'linear-analytic',
      mdSteps: 10,
    })

    assert.equal(out.reference, 'Cu')
    assert.equal(out.engine, 'linear-analytic')
    assert.equal(out.curve.length, temps.length)
    assert.equal(out.mdJobIds.length, temps.length, '逐网格点必须有独立 MD 作业（可溯源）')
    assert.ok(out.anchor.source === 'linear-analytic')
    // 解析对账：线性核梯形精确 → ΔF 精确落完整闭式（积分项 + 锚点传播项）
    const beta = t => 1 / (KB_EV_PER_K * t)
    for (const t of [100, 500]) {
      const point = out.curve.find(p => p.temperatureK === t)
      const integral = -12.0 * (beta(t) - beta(300)) + C_LINEAR * (beta(t) ** 2 - beta(300) ** 2) / 2
      const expected = integral / beta(t) + F0 * (beta(300) - beta(t)) / beta(t)
      assert.ok(Math.abs(point.dF - expected) < 1e-9,
        `端到端 ΔF(${t} K) 必须精确落闭式（期望 ${expected}，实测 ${point.dF}）`)
    }
    // 事件薄载荷：引用 + 标量锚点/端点 ΔF
    assert.equal(events.length, 1)
    const p = events[0].payload
    assert.equal(p.analysis, 'free-energy')
    assert.ok(p.material.id && p.material.formula === 'Cu')
    assert.ok(Number.isFinite(p.endpointDF))
  } finally {
    await fiber.dispose()
    await coreFiber.dispose()
  }
})

test('9. 集成（真实 ASE sidecar）：LJ 两点网格冒烟——曲线形状与有限量齐备', async t => {
  const { default: asePlugin } = await import('@saturday/plugin-ase')
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin({
    name: 'stub-core-fe-ase',
    async apply(ctx) {
      const resolver = new PrototypeLibResolver()
      const store = new Map()
      ctx.reflect.provide('material', {
        async load(formula) {
          const m = await Material.create({ modalities: { formula } }, resolver)
          store.set(m.id, m)
          return m
        },
        async get(id) { return store.get(id) },
      })
      ctx.reflect.provide('potential', new PotentialRegistry({ on() {}, emit() {} }))
    },
  })
  let aseFiber
  try {
    aseFiber = await ctx.registry.plugin({
      name: 'saturday-ase',
      apply: (ctx) => asePlugin.apply(ctx, { calculator: 'lj' }),
    })
  } catch {
    await coreFiber.dispose()
    return t.skip('python unavailable in this environment')
  }
  const fiber = await ctx.registry.plugin({
    name: 'saturday-free-energy',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdayFreeEnergy
    const loaded = await rt.getService('material').load('Cu')
    const out = await rt.tools.call('workflow.freeEnergy', {
      referenceId: loaded.id, temperatures: [200, 300],
      anchorTemperatureK: 200, anchorF0: 0, anchorSource: 'smoke-anchor',
      mdSteps: 20, dtFs: 1,
    })
    assert.equal(out.engine, 'ase')
    assert.equal(out.curve.length, 2)
    assert.ok(out.curve.every(p => Number.isFinite(p.F) && Number.isFinite(p.meanU)))
    assert.ok(Math.abs(out.curve[0].dF) < 1e-12, '锚点处 ΔF 归零')
    assert.ok(Number.isFinite(out.curve[1].dF))
  } finally {
    await fiber.dispose()
    await aseFiber.dispose()
    await coreFiber.dispose()
  }
})

// ── 谐波锚点：量子谐振子纯层闭式 + 接线纪律 ──────────────
// 闭式：F_i(T) = ℏω/2 + kT·ln(1−e^{−ℏω/kT})；低温极限 → 零点能，
// 高温极限 → kT·ln(ℏω/kT)（经典极限）；模间线性叠加。

test('10. 谐波纯层闭式：低温→零点能，高温→经典极限，线性叠加，虚频拒收', () => {
  const f = 10 // THz
  const quanta = H_EV_S * f * 1e12 // ℏω (eV)
  const lowT = harmonicVibrationalFreeEnergy({ frequenciesTHz: [f], temperatureK: 1 })
  assert.ok(Math.abs(lowT.vibrationalFreeEnergyEV - 0.5 * quanta) < 1e-9,
    '低温极限：F → 零点能 ℏω/2（热激发项指数压低）')
  assert.ok(Math.abs(lowT.zeroPointEnergyEV - 0.5 * quanta) < 1e-12)

  const highT = harmonicVibrationalFreeEnergy({ frequenciesTHz: [f], temperatureK: 1e6 })
  const kT = KB_EV_PER_K * 1e6
  const classic = kT * Math.log(quanta / kT) // ln(1−e^{−x}) ≈ ln x（x≪1）
  assert.ok(Math.abs(highT.vibrationalFreeEnergyEV - classic) / Math.abs(classic) < 1e-4,
    '高温极限：F → kT·ln(ℏω/kT)（经典谐振子）')

  const doubled = harmonicVibrationalFreeEnergy({ frequenciesTHz: [f, f], temperatureK: 300 })
  const single = harmonicVibrationalFreeEnergy({ frequenciesTHz: [f], temperatureK: 300 })
  assert.ok(Math.abs(doubled.vibrationalFreeEnergyEV - 2 * single.vibrationalFreeEnergyEV) < 1e-12,
    '模间独立：自由能线性叠加')

  assert.throws(() => harmonicVibrationalFreeEnergy({ frequenciesTHz: [-1], temperatureK: 300 }),
    err => err.code === 'THERMO_INVALID_INPUT' && /imaginary/.test(err.message),
    '虚频拒收：谐波锚点对鞍点无物理意义，必须声明而非静默修正')
  assert.throws(() => harmonicVibrationalFreeEnergy({ frequenciesTHz: [f], temperatureK: -1 }),
    err => err.code === 'THERMO_INVALID_INPUT')
})

test('11. 锚点接线纪律：引擎无 harmonic 原语/显式模式缺 F₀ 均显式报错', async () => {
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(linearMdEngine(C_LINEAR)))
  const fiber = await ctx.registry.plugin({
    name: 'saturday-free-energy',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdayFreeEnergy
    const loaded = await rt.getService('material').load('Cu')
    await assert.rejects(
      () => rt.tools.call('workflow.freeEnergy', {
        referenceId: loaded.id, temperatures: [200, 300],
        anchorTemperatureK: 200, anchorMode: 'harmonic',
      }),
      err => err.code === 'THERMO_INVALID_INPUT' && /harmonic.*primitive/.test(err.message),
      '引擎未声明 harmonic 原语：不得静默退化为零锚点',
    )
    await assert.rejects(
      () => rt.tools.call('workflow.freeEnergy', {
        referenceId: loaded.id, temperatures: [200, 300], anchorTemperatureK: 200,
      }),
      err => err.code === 'THERMO_REFERENCE_MISSING',
      '显式模式缺 anchorF0：零点必须声明',
    )
  } finally {
    await fiber.dispose()
    await coreFiber.dispose()
  }
})

test('12. 端到端谐波锚点：stub 引擎定频 → 锚点 = u0 + 闭式振动自由能', async () => {
  // stub 引擎：harmonic 返回定频 8 THz ×2 模 + u0；md 同线性核。
  // 对账：交付的 anchor.F0 必须精确等于 u0 + 纯层闭式重算值（同一闭式来源）。
  const U0 = -13.2
  const FREQS = [8, 8]
  const engine = {
    ...linearMdEngine(C_LINEAR),
    name: 'harmonic-analytic',
    async harmonic() {
      return { jobId: 'harm-1', engine: 'harmonic-analytic', u0_eV: U0, frequencies_thz: FREQS, imaginary_modes: 0 }
    },
  }
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(engine))
  const fiber = await ctx.registry.plugin({
    name: 'saturday-free-energy',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  try {
    const { rt } = fiber.store.saturdayFreeEnergy
    const { events } = coreFiber.store.stub
    const loaded = await rt.getService('material').load('Cu')
    const out = await rt.tools.call('workflow.freeEnergy', {
      referenceId: loaded.id, temperatures: [200, 300],
      anchorTemperatureK: 200, anchorMode: 'harmonic', mdSteps: 5,
    })
    const vib = harmonicVibrationalFreeEnergy({ frequenciesTHz: FREQS, temperatureK: 200 })
    assert.ok(Math.abs(out.anchor.F0 - (U0 + vib.vibrationalFreeEnergyEV)) < 1e-12,
      '锚点 = u0 + 量子谐振子闭式（纯层重算对账）')
    assert.match(out.anchor.source, /谐波近似/, '锚点来源声明必须物理化且随交付呈现')
    assert.equal(out.harmonicDetail.nModes, 2)
    assert.equal(events[0].payload.anchorMode, 'harmonic', '事件载荷声明锚点模式')
    assert.ok(Math.abs(out.curve[0].dF) < 1e-12, '锚点处 ΔF 归零')
  } finally {
    await fiber.dispose()
    await coreFiber.dispose()
  }
})
