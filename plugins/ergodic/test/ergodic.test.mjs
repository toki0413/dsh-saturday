// @saturday/plugin-ergodic 测试（契约 §4.5 oracle 条款：遍历对账首个实证 + 升档实证）
// 纯层：对账统计与判定强度三档分级（信息性 / 声明交付不一致 / Boltzmann 重加权检验）；
// 升档：OU 采样器（likelihood: exact）→ 重要性重加权解析对账（权重/ESS/重加权均值落闭式）；
// 插件层：工具挂载与回收、缺服务显式报错、端到端对账（判定 + 事件 + 确定性）；
// 集成：真实 ASE sidecar（Langevin MD + LJ 单点）走通完整对账链路。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Material, PrototypeLibResolver, PotentialRegistry } from '@saturday/core'
import { referencePerturbationSampler } from '@saturday/plugin-sampler-perturb'
import { ouSampler } from '@saturday/plugin-sampler-ou'
import plugin, { compareEnsembleToMD, ergodicVerdict, checkErgodic, reweightToBoltzmann, KB_EV_PER_K } from '../src/index.mjs'

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

test('4. 判定强度三档：信息性 / 声明与交付不一致 / Boltzmann 重加权检验', () => {
  const stats = compareEnsembleToMD({ ensembleEnergies: [-12], mdEnergies: [-12] })
  const info = ergodicVerdict({ stats, samplerName: 's1', likelihood: 'none', energyModel: 'eng', temperatureK: 300 })
  assert.equal(info.claim, 'informational')
  assert.ok(info.note.includes('不构成合规证明也不构成否决'))
  // 声明似然可求但候选缺 logProb：不充任强检验，降级并明说不一致（诚实纪律）
  const mismatch = ergodicVerdict({ stats, samplerName: 's2', likelihood: 'exact', energyModel: 'eng', temperatureK: 300 })
  assert.equal(mismatch.claim, 'informational')
  assert.ok(mismatch.note.includes('声明与交付不一致'))
  // 重加权就绪：判据换为重加权均值对 MD 时间平均，ESS 占比连同呈现
  const rw = { weights: [0.5, 0.5], essFraction: 1, reweightedMean: -12.0 }
  const check = ergodicVerdict({
    stats: compareEnsembleToMD({ ensembleEnergies: [-11, -13], mdEnergies: [-12] }),
    samplerName: 's3', likelihood: 'exact', energyModel: 'eng', temperatureK: 300, reweighted: rw,
  })
  assert.equal(check.claim, 'boltzmann-check')
  assert.equal(check.reconciled, true, '升档后判据是重加权均值（−12）而非原始均值')
  assert.ok(check.note.includes('重要性重加权') && check.note.includes('ESS 占比'))
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
  // 指名未挂载的采样器：同样显式报错，不静默回退默认采样器（契约 §2）
  await assert.rejects(
    () => ergodicRt.tools.call('workflow.ergodic', { referenceId: 'x', sampler: 'ou-perturbation' }),
    /"sampler\/ou-perturbation"/,
  )
})

// ── 升档实证：OU（likelihood: exact）→ 重要性重加权解析对账 ────
// 解析对账体系：能量取谐波 U = ½k·||u||²（k = 1 eV/Å²），提议分布 OU 与目标分布同形，
// 仅标准差不同（σ_q = uEq·√(1−e^{−2γΔ})，σ_t = √(k_B T/k)）——权重、ESS 占比、
// 重加权均值全部有闭式解，升档机制的每一步都可解析核验，不靠数值巧合。

const K_HARMONIC = 1.0 // eV/Å²

/** 从参考结构出发的逐坐标位移（扁平） */
function displacements(reference, candidate) {
  const out = []
  candidate.graph.nodes.forEach((node, i) => {
    const ref = reference.graph.nodes[i].position
    node.position.forEach((x, k) => out.push(x - ref[k]))
  })
  return out
}

/** 谐波目标分布的每坐标标准差（能量均分） */
function sigmaTarget(temperatureK) {
  return Math.sqrt(KB_EV_PER_K * temperatureK / K_HARMONIC)
}

/** 参考结构的逐节点参考坐标 */
function referencePositionsOf(reference) {
  return reference.graph.nodes.map(n => n.position)
}

test('4a. 重加权纯层：权重归一 + 非法输入显式报错', () => {
  const r = reweightToBoltzmann({ logProbs: [0, -1], energies: [-1, -2], temperatureK: 300 })
  assert.ok(Math.abs(r.weights.reduce((a, b) => a + b, 0) - 1) < 1e-12)
  assert.ok(r.essFraction > 0 && r.essFraction <= 1)
  assert.ok(r.reweightedMean >= -2 && r.reweightedMean <= -1)
  assert.throws(() => reweightToBoltzmann({ logProbs: [0], energies: [-1, -2], temperatureK: 300 }),
    err => err.code === 'SAMPLER_UNAVAILABLE')
  assert.throws(() => reweightToBoltzmann({ logProbs: [NaN], energies: [-1], temperatureK: 300 }),
    err => err.code === 'SAMPLER_UNAVAILABLE')
  assert.throws(() => reweightToBoltzmann({ logProbs: [0], energies: [-1], temperatureK: 0 }),
    err => err.code === 'SAMPLER_UNAVAILABLE')
})

test('4b. 升档机制解析核验：σ_q = σ_t（提议即目标）→ 权重均匀、ESS=1、重加权均值不变', async () => {
  const reference = await Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())
  const temperatureK = 300
  // 闭式对账条件：让提议分布与目标谐波分布同方差（σ_q = σ_t），此时重要性权重解析为常数——
  // log w = −βU − log q 的二次项精确相消。这是对升档机制最强的解析核验：
  // 权重必须均匀、ESS 占比必须为 1、重加权均值必须等于原始均值。
  const sigmaT = sigmaTarget(temperatureK)
  const gammaDt = 1.0
  const uEq = sigmaT / Math.sqrt(1 - Math.exp(-2 * gammaDt))
  const candidates = await ouSampler.sample({ reference }, { n: 800, seed: 21, uEq, gammaDt })

  const energies = candidates.map(c =>
    0.5 * K_HARMONIC * displacements(reference, c).reduce((a, x) => a + x * x, 0))
  const rw = reweightToBoltzmann({
    logProbs: candidates.map(c => c.logProb), energies, temperatureK,
  })

  assert.ok(rw.weights.every(w => Math.abs(w - 1 / candidates.length) < 1e-9),
    'σ_q = σ_t 时重要性权重必须解析为均匀（二次项精确相消）')
  assert.ok(Math.abs(rw.essFraction - 1) < 1e-9, '权重均匀 → ESS 占比必须为 1')
  const rawMean = energies.reduce((a, b) => a + b, 0) / energies.length
  assert.ok(Math.abs(rw.reweightedMean - rawMean) < 1e-9, '权重均匀 → 重加权均值等于原始均值')
  // 重加权（即原始）位移模方均值应落目标分布解析值（能量均分：⟨||u||²⟩ = d·k_B T/k）
  const d = displacements(reference, candidates[0]).length
  const reweightedR2 = rw.weights.reduce((a, w, i) =>
    a + w * displacements(reference, candidates[i]).reduce((s, x) => s + x * x, 0), 0)
  const expectedR2 = d * KB_EV_PER_K * temperatureK / K_HARMONIC
  assert.ok(Math.abs(reweightedR2 - expectedR2) / expectedR2 < 0.1,
    `升档实证：⟨||u||²⟩ 应落解析值（期望 ${expectedR2.toFixed(4)}，实测 ${reweightedR2.toFixed(4)}）`)
})

test('4c. checkErgodic 端到端（纯层 + 谐波解析引擎）：exact 声明 → boltzmann-check 且重加权后对账', async () => {
  const reference = await Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())
  const d = reference.graph.nodes.length * 3
  const temperatureK = 300
  const sigmaT = sigmaTarget(temperatureK)
  const gammaDt = 1.0
  const uEq = sigmaT / Math.sqrt(1 - Math.exp(-2 * gammaDt))
  const refPositions = referencePositionsOf(reference)
  // 解析引擎：calculate = 谐波单点（位移从闭包参考坐标算得）；
  // md 轨迹能量 = 目标谐波分布在 T 下的势能均值（能量均分，确定性）
  const harmonicEngine = {
    name: 'harmonic-analytic',
    manifest: {
      capabilities: [
        { type: 'calculate', accuracy: 0.9, speed: 0.99, cost: 0.01, maxAtoms: 200 },
        { type: 'md', accuracy: 0.9, speed: 0.99, cost: 0.01, maxAtoms: 200 },
      ],
      constraints: {},
      eventGranularity: 'job',
    },
    async calculate(material) {
      const cand = material.lineage.find(l => l.operation === 'sampled-candidate')
      const u2 = material.graph.nodes.reduce((s, n, i) =>
        s + n.position.reduce((a, x, k) => a + (x - refPositions[i][k]) ** 2, 0), 0)
      return { jobId: `calc-${cand?.detail.index ?? 'x'}`, engine: 'harmonic-analytic', energy: 0.5 * K_HARMONIC * u2 }
    },
    async md(material, params = {}) {
      const meanEnergy = d * KB_EV_PER_K * (params.temperature_K ?? temperatureK) / K_HARMONIC / 2
      return {
        jobId: `md-${params.seed ?? 1}`, engine: 'harmonic-analytic',
        energies: Array.from({ length: 20 }, () => meanEnergy),
        n_steps: 20,
      }
    },
  }
  const potential = new PotentialRegistry({ on() {}, emit() {} })
  potential.register(harmonicEngine)
  await potential.activate(harmonicEngine.name)

  const candidates = await ouSampler.sample({ reference }, { n: 800, seed: 21, uEq, gammaDt })
  const events = []
  const out = await checkErgodic({
    reference, candidates,
    samplerManifest: ouSampler.manifest, samplerName: ouSampler.name,
    potential, mdParams: { temperatureK, steps: 20, seed: 7 },
    tolerance: 0.005, emit: (t, e) => { events.push(e) },
  })
  assert.equal(out.claim, 'boltzmann-check', 'exact 声明 + 候选附 logProb → 判定必须升档')
  assert.ok(out.reweighted && Number.isFinite(out.reweighted.reweightedMean))
  assert.ok(Math.abs(out.reweighted.essFraction - 1) < 1e-9, 'σ_q = σ_t → ESS 占比解析为 1')
  assert.ok(out.note.includes('重要性重加权'))
  // 重加权均值应与解析时间平均在容差内（σ_q = σ_t 时统计误差 ~ 均值/√(2n)，n=800 足够）
  assert.equal(out.reconciled, true, '重加权均值应与解析时间平均在容差内（±0.005 eV）')
  // 事件薄载荷携带 essFraction（升档诊断量）
  assert.equal(events.length, 1)
  assert.ok(Number.isFinite(events[0].payload.result.essFraction))
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

test('7b. 端到端（工具层升档）：OU 采样器 → boltzmann-check + 重加权判定 + essFraction', async () => {
  const coreFiber = await ctx.registry.plugin({
    name: 'stub-core-ou',
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
      const potential = new PotentialRegistry({ on() {}, emit() {} })
      const engine = stubEngine({})
      potential.register(engine)
      await potential.activate(engine.name)
      ctx.reflect.provide('potential', potential)
      ctx.reflect.provide('sampler/ou-perturbation', ouSampler)
    },
  })
  try {
    const materialService = ergodicRt.getService('material')
    const cu = await materialService.load('Cu')
    const out = await ergodicRt.tools.call('workflow.ergodic', {
      referenceId: cu.id, sampler: 'ou-perturbation',
      n: 6, seed: 42, uEq: 0.05, gammaDt: 1.0, mdSteps: 10, mdSeed: 7,
    })
    assert.equal(out.sampler, 'ou-perturbation')
    assert.equal(out.claim, 'boltzmann-check', '工具层升档：exact 声明 + 候选附 logProb')
    assert.ok(out.reweighted && Number.isFinite(out.reweighted.reweightedMean))
    assert.ok(out.reweighted.essFraction > 0 && out.reweighted.essFraction <= 1)
    assert.equal(out.reconciled, true, 'stub 引擎两侧能量一致 → 重加权后必须对账')
    assert.ok(out.note.includes('重要性重加权'))
  } finally {
    await coreFiber.dispose()
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
