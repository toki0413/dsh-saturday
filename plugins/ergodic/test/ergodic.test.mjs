// @saturday/plugin-ergodic 测试（契约 §4.5 oracle 条款：遍历对账首个实证）
// 纯层：对账统计与判定强度分级（信息性 / Boltzmann 检验）；
// 插件层：工具挂载与回收、缺服务显式报错、端到端对账（判定 + 事件 + 确定性）；
// 集成：真实 ASE sidecar（Langevin MD + LJ 单点）走通完整对账链路。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Material, PrototypeLibResolver, PotentialRegistry } from '@saturday/core'
import { referencePerturbationSampler } from '@saturday/plugin-sampler-perturb'
import plugin, { compareEnsembleToMD, ergodicVerdict, checkErgodic } from '../src/index.mjs'

// ── 纯层：对账统计 ──────────────────────────────────────────

test('1. 统计：两侧一致 → 对账通过，判定量与标准误齐备', () => {
  const stats = compareEnsembleToMD({
    ensembleEnergies: [-12.0, -12.1, -11.9, -12.0],
    mdEnergies: [-12.0, -12.05, -11.95, -12.0, -12.02],
  })
  assert.equal(stats.reconciled, true)
  assert.ok(stats.discrepancy < 0.05)
  assert.equal(stats.ensemble.n, 4)
  assert.equal(stats.md.n, 5)
  assert.ok(Number.isFinite(stats.ensemble.sem) && Number.isFinite(stats.md.sem))
})

test('2. 统计：均值差超容差 → 不对账；容差非法显式报错', () => {
  const stats = compareEnsembleToMD({
    ensembleEnergies: [-12.0], mdEnergies: [-13.0], tolerance: 0.5,
  })
  assert.equal(stats.reconciled, false)
  assert.ok(Math.abs(stats.discrepancy - 1.0) < 1e-12)
  assert.throws(
    () => compareEnsembleToMD({ ensembleEnergies: [-12], mdEnergies: [-12], tolerance: -1 }),
    err => err.code === 'SAMPLER_UNAVAILABLE',
  )
})

test('3. 统计：空序列 / 非有限值显式报错，不得静默通过', () => {
  assert.throws(() => compareEnsembleToMD({ ensembleEnergies: [], mdEnergies: [-12] }),
    err => err.code === 'SAMPLER_UNAVAILABLE')
  assert.throws(() => compareEnsembleToMD({ ensembleEnergies: [NaN], mdEnergies: [-12] }),
    err => err.code === 'SAMPLER_UNAVAILABLE')
})

test('4. 判定强度：似然声明决定对账是信息性还是对声明的直接检验', () => {
  const stats = compareEnsembleToMD({ ensembleEnergies: [-12], mdEnergies: [-12] })
  const info = ergodicVerdict({ stats, samplerName: 's1', likelihood: 'none', energyModel: 'eng', temperatureK: 300 })
  assert.equal(info.claim, 'informational')
  assert.ok(info.note.includes('不构成合规证明也不构成否决'))
  const check = ergodicVerdict({ stats, samplerName: 's2', likelihood: 'exact', energyModel: 'eng', temperatureK: 300 })
  assert.equal(check.claim, 'boltzmann-check')
  assert.ok(check.note.includes('直接检验'))
})

// ── 插件层 ──────────────────────────────────────────────────

// stub 引擎：同时提供 calculate（系综侧）与 md（时间平均侧）。
// 默认能量构造使两侧均值一致（对账通过）；确定性由种子驱动。
function stubEngine({ calculateShift = 0, mdBase = -12 } = {}) {
  return {
    name: 'stub-engine',
    manifest: {
      capabilities: [
        { type: 'calculate', accuracy: 0.5, speed: 0.99, cost: 0.01, maxAtoms: 200 },
        { type: 'md', accuracy: 0.5, speed: 0.99, cost: 0.01, maxAtoms: 200 },
      ],
      constraints: {},
      eventGranularity: 'job',
    },
    async calculate(material) {
      const cand = material.lineage.find(l => l.operation === 'sampled-candidate')
      return { jobId: `calc-${cand?.detail.index ?? 'x'}`, engine: 'stub-engine', energy: -12 + calculateShift }
    },
    async md(material, params = {}) {
      const seed = params.seed ?? 1
      const steps = params.steps ?? 10
      return {
        jobId: `md-${seed}`,
        engine: 'stub-engine',
        energies: Array.from({ length: steps + 1 }, (_, i) => mdBase + 0.01 * Math.sin(seed + i)),
        temperature_K: params.temperature_K,
        n_steps: steps,
      }
    },
  }
}

function stubCorePlugin(engine) {
  return {
    name: 'stub-core',
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
      ctx.reflect.provide('sampler/reference-perturbation', referencePerturbationSampler)
      const events = []
      ctx.events.on('saturday/simulation/converged', e => events.push(e))
      ctx.fiber.store.stub = { events }
    },
  }
}

let ctx, ergodicFiber, ergodicRt

before(async () => {
  ctx = new Context()
  ergodicFiber = await ctx.registry.plugin({
    name: 'saturday-ergodic',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  ergodicRt = ergodicFiber.store.saturdayErgodic.rt
})

after(async () => {
  await ergodicFiber.dispose()
})

test('5. 插件挂载：工具注册且归属本插件', () => {
  assert.deepEqual(ergodicRt.tools.list().map(t => t.name), ['workflow.ergodic'])
})

test('6. 缺核心服务必须显式报错，不得静默降级（契约 §2）', async () => {
  await assert.rejects(
    () => ergodicRt.tools.call('workflow.ergodic', { referenceId: 'x' }),
    /requires services "material", "potential" and "sampler\/reference-perturbation"/,
  )
})

test('7. 端到端：对账判定 + 事件 + 诚实声明（微扰采样器 → 信息性）', async () => {
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(stubEngine({})))
  try {
    const { events } = coreFiber.store.stub
    const materialService = ergodicRt.getService('material')
    const cu = await materialService.load('Cu')

    const out = await ergodicRt.tools.call('workflow.ergodic', {
      referenceId: cu.id, n: 4, seed: 42, mdSteps: 10, mdSeed: 7,
    })
    assert.equal(out.reconciled, true)
    assert.equal(out.claim, 'informational', 'likelihood: none 的采样器只得到信息性判定')
    assert.ok(out.note.includes('不构成合规证明也不构成否决'))
    assert.equal(out.ensemble.n, 4)
    assert.equal(out.ensemble.sources.length, 4)
    assert.ok(out.ensemble.sources.every(s => s.startsWith('generative:')))
    // 事件薄载荷：判定为标量，引用齐备
    assert.equal(events.length, 1)
    const p = events[0].payload
    assert.equal(p.workflow, 'ergodic')
    assert.ok(p.jobId && p.material.id && typeof p.result.reconciled === 'boolean')
  } finally {
    await coreFiber.dispose()
  }

  // 判定非透传：系综能量整体偏移 → 超过容差即不对账
  const shifted = await ctx.registry.plugin(stubCorePlugin(stubEngine({ calculateShift: 1.0 })))
  try {
    const materialService = ergodicRt.getService('material')
    const cu = await materialService.load('Cu')
    const out = await ergodicRt.tools.call('workflow.ergodic', {
      referenceId: cu.id, n: 4, seed: 42, mdSteps: 10, mdSeed: 7,
    })
    assert.equal(out.reconciled, false, '能量偏移超容差必须判为不对账')
    assert.ok(out.discrepancy > 0.9)
  } finally {
    await shifted.dispose()
  }
})

test('8. 确定性：同种子同判定量，异种子异时间平均', async () => {
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(stubEngine({})))
  try {
    const materialService = ergodicRt.getService('material')
    const cu = await materialService.load('Cu')
    const pick = out => ({ d: out.discrepancy, m: out.md.mean, e: out.ensemble.mean })
    const a = await ergodicRt.tools.call('workflow.ergodic', { referenceId: cu.id, n: 2, seed: 3, mdSteps: 6, mdSeed: 7 })
    const b = await ergodicRt.tools.call('workflow.ergodic', { referenceId: cu.id, n: 2, seed: 3, mdSteps: 6, mdSeed: 7 })
    assert.deepEqual(pick(b), pick(a))
    const c = await ergodicRt.tools.call('workflow.ergodic', { referenceId: cu.id, n: 2, seed: 3, mdSteps: 6, mdSeed: 8 })
    assert.notDeepEqual(pick(c).m, pick(a).m)
  } finally {
    await coreFiber.dispose()
  }
})

// ── 集成：真实 ASE sidecar（Langevin MD + LJ 单点，对账链路全程真物理）──
// 微扰采样器与 LJ 不变分布并不一致——判定预期为不对账，正是 oracle 的价值：
// 对账工具如实报告诱导测度与不变分布的距离，而不是粉饰。

test('9. 集成（真实 sidecar）：微扰采样对 LJ 能量函数 → 信息性不对账', async () => {
  const { default: asePlugin } = await import('@saturday/plugin-ase')
  const coreFiber = await ctx.registry.plugin({
    name: 'stub-core-ase',
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
      ctx.reflect.provide('sampler/reference-perturbation', referencePerturbationSampler)
    },
  })
  const aseFiber = await ctx.registry.plugin({
    name: 'saturday-ase',
    apply: (ctx) => asePlugin.apply(ctx, { calculator: 'lj' }),
  })
  try {
    const materialService = ergodicRt.getService('material')
    const cu = await materialService.load('Cu')
    const out = await ergodicRt.tools.call('workflow.ergodic', {
      referenceId: cu.id, n: 4, seed: 42, sigma: 0.05,
      mdSteps: 40, dtFs: 1, temperatureK: 300, mdSeed: 7,
      tolerance: 0.001,
    })
    assert.equal(out.energyModel, 'ase')
    assert.equal(out.claim, 'informational')
    assert.equal(typeof out.reconciled, 'boolean')
    assert.ok(Number.isFinite(out.discrepancy))
    assert.equal(out.ensemble.n, 4)
    assert.ok(out.md.n > 10, 'MD 轨迹采样点必须真实产出')
    assert.ok(out.note.includes('信息性'), '诚实声明必须随结果返回')
  } finally {
    await aseFiber.dispose()
    await coreFiber.dispose()
  }
})

test('10. 集成（真实 sidecar）：MD 种子确定性——同种子同轨迹能量', async () => {
  const { default: asePlugin } = await import('@saturday/plugin-ase')
  const coreFiber = await ctx.registry.plugin({
    name: 'stub-core-ase2',
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
      ctx.reflect.provide('sampler/reference-perturbation', referencePerturbationSampler)
    },
  })
  const aseFiber = await ctx.registry.plugin({
    name: 'saturday-ase',
    apply: (ctx) => asePlugin.apply(ctx, { calculator: 'lj' }),
  })
  try {
    const materialService = ergodicRt.getService('material')
    const cu = await materialService.load('Cu')
    const a = await ergodicRt.tools.call('workflow.ergodic', {
      referenceId: cu.id, n: 2, seed: 1, mdSteps: 20, mdSeed: 7, tolerance: 1,
    })
    const b = await ergodicRt.tools.call('workflow.ergodic', {
      referenceId: cu.id, n: 2, seed: 1, mdSteps: 20, mdSeed: 7, tolerance: 1,
    })
    assert.equal(b.md.mean, a.md.mean, '同种子必须复现同一轨迹能量均值')
  } finally {
    await aseFiber.dispose()
    await coreFiber.dispose()
  }
})
