// @saturday/plugin-screening 契约测试（契约 §4.3）
// 不依赖 Python sidecar：material/potential 服务由 stub 插件提供，
// 验证的是"工作流插件形态"本身：服务依赖显式解析、逐变体事件、不吞错。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import plugin, { screenDopants } from '../src/index.mjs'
import { builtinEvidenceSources, resolveEvidenceSources, hullEvidenceSource, mixingEntropyEvidenceSource } from '../src/evidence-sources.mjs'
import { Material, PrototypeLibResolver, PotentialRegistry } from '@saturday/core'
import { workflowContract } from '@saturday/contract-tests'

// ── stub 核心插件：只提供 material / potential 两个服务 ──────────
// 注：before() 钩子晚于模块体执行，relaxImpl 必须延迟捕获，不能直接闭包模块级变量
function stubCorePlugin(getRelaxImpl) {
  return {
    name: 'stub-core',
    async apply(ctx) {
      const relaxImpl = getRelaxImpl()
      const resolver = new PrototypeLibResolver()
      const store = new Map()
      const materialService = {
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
      }
      const rt = { on() {}, emit() {} }
      const potential = new PotentialRegistry(rt)
      potential.register({
        name: 'stub-engine',
        manifest: {
          capabilities: [{ type: 'relax', accuracy: 0.5, speed: 0.99, cost: 0.01, maxAtoms: 200 }],
          constraints: {},
          eventGranularity: 'job',
          units: { energy: 'eV', length: 'Å', time: 'fs' },
          fingerprint: { software: 'stub-engine', method: 'stub' },
        },
        relax: relaxImpl,
      })
      await potential.activate('stub-engine')
      // 事件收集必须在 fiber 作用域内（根上下文裸监听会让 emit 报错）
      const events = []
      ctx.events.on('saturday/simulation/converged', e => events.push(e))
      ctx.reflect.provide('material', materialService)
      ctx.reflect.provide('potential', potential)
      ctx.fiber.store.stub = { materialService, potential, events }
    },
  }
}

let ctx, screenFiber, screenRt

before(async () => {
  ctx = new Context()
  screenFiber = await ctx.registry.plugin({
    name: 'saturday-screening',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  screenRt = screenFiber.store.saturdayScreening.rt
})

after(async () => {
  await screenFiber.dispose()
})

test('1. 工作流插件独立挂载：工具注册且归属本插件', () => {
  assert.deepEqual(screenRt.tools.list().map(t => t.name), ['workflow.screen'])
})

test('2. 缺核心服务必须显式报错，不得静默降级（契约 §2）', async () => {
  await assert.rejects(
    () => screenRt.tools.call('workflow.screen', { materialId: 'x', dopants: ['Ag'] }),
    /requires services "material" and "potential"/,
  )
})

test('3. 与核心服务组合：逐变体事件 + 排序正确（契约 §4.3）', async () => {
  // 确定性能量：掺杂越靠后能量越低，验证排序而非透传
  const energies = { Cu: -12.0, Cu3Ag: -12.4, Cu3Ni: -12.2 }

  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => ({
    jobId: `job-${material.formula}`, engine: 'stub-engine',
    converged: true, energy: energies[material.formula], n_steps: 5,
  })))
  const { materialService, events } = coreFiber.store.stub
  const cu = await materialService.load('Cu')

  const result = await screenRt.tools.call('workflow.screen', {
    materialId: cu.id, dopants: ['Ag', 'Ni'],
  })
  assert.equal(result.failed.length, 0)
  assert.deepEqual(result.ranked.map(r => r.formula), ['Cu3Ag', 'Cu3Ni', 'Cu'])
  // 逐变体事件：3 个变体 3 条事件，全部含 jobId 引用（薄载荷）
  assert.equal(events.length, 3)
  assert.ok(events.every(e => e.payload.jobId && e.payload.material.id))
  await coreFiber.dispose()
})

test('4. 单变体失败计入 failed，不中断整体（不吞错）', async () => {
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => {
    if (material.formula === 'Cu3Ni') throw new Error('stub: Ni 变体故意失败')
    return {
      jobId: `job-${material.formula}`, engine: 'stub-engine',
      converged: true, energy: -12.0, n_steps: 5,
    }
  }))
  const { materialService } = coreFiber.store.stub
  const cu = await materialService.load('Cu')

  const result = await screenRt.tools.call('workflow.screen', {
    materialId: cu.id, dopants: ['Ag', 'Ni'],
  })
  assert.equal(result.ranked.length, 2, '成功变体照常排序返回')
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].dopant, 'Ni')
  assert.match(result.failed[0].error, /故意失败/)
  await coreFiber.dispose()
})

// ── 多组分凸包接线（第 1.5 档）：注入 references 后元素数 ≥ 3 升级为统一成分空间凸包 ──
// 能量模型：refCu/refAg/refNi 均 -3.0 → ΔH_f(Cu3Ag) = −0.05（稳定，低于包络），
// ΔH_f(Cu3Ni) = +0.05（不稳定）；端点全零 → 包络即 z=0 超平面，判据闭式可写。
test('5. 多组分凸包：三元系升级（mode=multi-component，闭式判据对账）', async () => {
  const energies = { Cu: -12.0, Cu3Ag: -12.2, Cu3Ni: -11.8 } // 4 原子：每原子 −3.0 / −3.05 / −2.95
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => ({
    jobId: `job-${material.formula}`, engine: 'stub-engine',
    converged: true, energy: energies[material.formula], n_steps: 5,
  })))
  const { materialService } = coreFiber.store.stub
  const cu = await materialService.load('Cu')

  const result = await screenDopants({
    material: cu, dopants: ['Ag', 'Ni'],
    potential: coreFiber.store.stub.potential,
    references: { Cu: -3.0, Ag: -3.0, Ni: -3.0 },
  })
  assert.equal(result.thermo.mode, 'multi-component', '三元系必须走多组分凸包')
  assert.equal(result.thermo.hullDimension, 2, '3 元素 → d=2 成分空间')
  assert.equal(result.thermo.level, 'stub-engine')
  const byFormula = Object.fromEntries(result.ranked.map(r => [r.formula, r]))
  // 端点全零 → 包络 = z=0 超平面：energyAboveHull = max(0, ΔH_f) 闭式
  assert.ok(Math.abs(byFormula.Cu3Ni.energyAboveHull - 0.05) < 1e-12, '不稳定候选：距离恰为 ΔH_f')
  assert.equal(byFormula.Cu3Ag.energyAboveHull, 0, '稳定候选（ΔH_f<0）：低于包络，钳到 0')
  assert.equal(byFormula.Cu.energyAboveHull, 0, '基体端点在包上')
  await coreFiber.dispose()
})

test('6. 二元路径保持：单掺杂时 mode=binary，判据不变', async () => {
  const energies = { Cu: -12.0, Cu3Ag: -12.2 }
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => ({
    jobId: `job-${material.formula}`, engine: 'stub-engine',
    converged: true, energy: energies[material.formula], n_steps: 5,
  })))
  const { materialService } = coreFiber.store.stub
  const cu = await materialService.load('Cu')

  const result = await screenDopants({
    material: cu, dopants: ['Ag'],
    potential: coreFiber.store.stub.potential,
    references: { Cu: -3.0, Ag: -3.0 },
  })
  assert.equal(result.thermo.mode, 'binary')
  const ag = result.ranked.find(r => r.formula === 'Cu3Ag')
  assert.ok(Math.abs(ag.energyAboveHull - Math.max(0, ag.formationEnthalpy)) < 1e-12)
  await coreFiber.dispose()
})

// ── 多浓度扫描（⑮）：同掺杂多内点 → 包络非退化，判据闭式可写 ──
// 能量模型：Cu2Ni2 的 ΔH_f=−0.05 撑起包络；Cu3Ni（x=0.25）在 (0,0)-(0.5,−0.05) 弦上方，
// 插值 −0.025 → 距离闭式 = 0.05 − (−0.025) = 0.075（非退化判据的最小实证）。
test('7. 多浓度扫描：二元多内点非退化判据（闭式 0.075 对账）', async () => {
  // 4 原子胞：Cu=-12.0（-3.0/atom）、Cu3Ni=-11.8（+0.05）、Cu2Ni2=-12.2（-0.05）
  const energies = { Cu: -12.0, Cu3Ni: -11.8, Cu2Ni2: -12.2 }
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => ({
    jobId: `job-${material.formula}`, engine: 'stub-engine',
    converged: true, energy: energies[material.formula], n_steps: 5,
  })))
  const { materialService } = coreFiber.store.stub
  const cu = await materialService.load('Cu')

  const result = await screenDopants({
    material: cu, dopants: ['Ni'], maxDopedSites: 2,
    potential: coreFiber.store.stub.potential,
    references: { Cu: -3.0, Ni: -3.0 },
  })
  assert.equal(result.thermo.mode, 'binary')
  assert.deepEqual(result.ranked.map(r => r.formula), ['Cu2Ni2', 'Cu', 'Cu3Ni'], '浓度系列全量入选')
  assert.deepEqual(result.ranked.map(r => r.sites), [2, 0, 1], 'sites 字段随候选携带')
  const byFormula = Object.fromEntries(result.ranked.map(r => [r.formula, r]))
  assert.ok(Math.abs(byFormula.Cu2Ni2.energyAboveHull) < 1e-12, '最低内点在包上')
  assert.ok(Math.abs(byFormula.Cu3Ni.energyAboveHull - 0.075) < 1e-12,
    '高浓度候选的判据由弦插值撑起（闭式 0.075，非退化）')
  await coreFiber.dispose()
})

test('8. maxDopedSites 越界显式报错：全取代 = 纯掺杂端点，属参考态而非候选', async () => {
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => ({
    jobId: `job-${material.formula}`, engine: 'stub-engine',
    converged: true, energy: -12.0, n_steps: 5,
  })))
  const { materialService } = coreFiber.store.stub
  const cu = await materialService.load('Cu')
  await assert.rejects(
    () => screenDopants({ material: cu, dopants: ['Ni'], maxDopedSites: 4, potential: coreFiber.store.stub.potential }),
    /超出基体可取代位点数 3/,
  )
  await assert.rejects(
    () => screenDopants({ material: cu, dopants: ['Ni'], maxDopedSites: 0, potential: coreFiber.store.stub.potential }),
    /必须是正整数/,
  )
  await coreFiber.dispose()
})

// ── 共掺变体（⑮）：落在稳定相连线以外的成分空间内部 → 非退化判据闭式可写 ──
// 几何：Cu2PtNi=(0.5,0.25,0.25) 由单形 (Cu3Pt,Pt,Ni) 包含：
// λ = (2/3, 1/12, 1/4)；包络插值 = (2/3)·(−0.08) = −4/75 → 距离 = 0.04+4/75 = 7/75。
test('9. 共掺候选：稳定相顶点拉低包络 → 非退化判据（闭式 7/75 对账）', async () => {
  // 4 原子胞：pristine 公式 Cu（省略数字 1）=-12.0、Cu3Pt=-12.32（ΔH_f=-0.08）、Cu2PtNi=-11.84（ΔH_f=+0.04）
  // 注：共掺产物的 formula 元素顺序不保证，用元素-计数签名归一后查能量表（键按元素名排序）
  const sig = (formula) => Object.fromEntries(
    [...formula.matchAll(/([A-Z][a-z]*)(\d*)/g)].map(([, el, n]) => [el, Number(n || 1)]),
  )
  const bySig = new Map([
    [JSON.stringify({ Cu: 1 }), -12.0],
    [JSON.stringify({ Cu: 3, Pt: 1 }), -12.32],
    [JSON.stringify({ Cu: 2, Ni: 1, Pt: 1 }), -11.84],
  ])
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => {
    const entries = Object.entries(sig(material.formula)).sort(([a], [b]) => a.localeCompare(b))
    return {
      jobId: `job-${material.formula}`, engine: 'stub-engine',
      converged: true, energy: bySig.get(JSON.stringify(Object.fromEntries(entries))), n_steps: 5,
    }
  }))
  const cu = await coreFiber.store.stub.materialService.load('Cu')
  const r2 = await screenDopants({
    material: cu, dopants: ['Pt'], maxDopedSites: 1,
    codopants: [{ elements: ['Pt', 'Ni'], sites: [0, 1] }],
    potential: coreFiber.store.stub.potential,
    references: { Cu: -3.0, Pt: -3.0, Ni: -3.0 },
  })
  assert.equal(r2.thermo.mode, 'multi-component')
  const byFormula = Object.fromEntries(r2.ranked.map(r => [r.formula, r]))
  const co = r2.ranked.find(r => r.kind === 'codoped')
  assert.ok(co, '共掺变体入选')
  assert.match(co.formula, /^Cu2(NiPt|PtNi)$/, '成分推导正确（元素顺序不保证）')
  assert.equal(co.dopant, 'Pt+Ni')
  assert.ok(Math.abs(byFormula.Cu3Pt.energyAboveHull) < 1e-12, '稳定相顶点在包络上')
  assert.ok(Math.abs(co.energyAboveHull - 7 / 75) < 1e-9,
    `非退化判据：距离 = ΔH_f − 包络插值 = 0.04 + 4/75 = 7/75（实际 ${co.energyAboveHull}）`)
  await coreFiber.dispose()
})

test('10. codopants 参数校验：元素重复/位点冲突/单元素均显式报错', async () => {
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => ({
    jobId: `job-${material.formula}`, engine: 'stub-engine',
    converged: true, energy: -12.0, n_steps: 5,
  })))
  const cu = await coreFiber.store.stub.materialService.load('Cu')
  const base = { material: cu, dopants: [], potential: coreFiber.store.stub.potential }
  await assert.rejects(() => screenDopants({ ...base, codopants: [{ elements: ['Pt', 'Pt'] }] }), /元素重复/)
  await assert.rejects(() => screenDopants({ ...base, codopants: [{ elements: ['Pt'] }] }), /≥2 个不同元素/)
  await assert.rejects(() => screenDopants({ ...base, codopants: [{ elements: ['Pt', 'Ni'], sites: [0, 0] }] }), /位点非法/)
  await coreFiber.dispose()
})

// ── 采样候选联合排序（⑯⑰，Logits 组合律）：单点回算能量证据 × 提议似然证据 ──
// 确定性对账：两采样候选单点能 E₀=−12.0 / E₁=−11.99（总能量，非每原子），
// logProb = 0 / −ln2，T = 1/(100·kB) K → β = 100 eV⁻¹。
// 联合 log 权重差：βΔE + ΔlogProb = 1 + ln2 → 权重比 w₀/w₁ = 2e，归一良态闭式可写。
function stubCorePluginWithCalc(getRelaxImpl, getCalcImpl) {
  const base = stubCorePlugin(getRelaxImpl)
  return {
    name: base.name,
    async apply(ctx) {
      await base.apply(ctx)
      const calcImpl = getCalcImpl()
      const { potential } = ctx.fiber.store.stub
      // 登记簿条目是活引用：直接把单点实现挂到已注册引擎上（能力声明不动，测试专用）
      potential.get('stub-engine').calculate = calcImpl
    },
  }
}

test('11. 采样候选联合排序：重要性权重闭式对账（能量证据 × 似然证据）', async () => {
  const calcEnergies = [-12.0, -11.99]
  let calcCount = 0
  const coreFiber = await ctx.registry.plugin(stubCorePluginWithCalc(
    () => async (material) => ({
      jobId: `job-${material.formula}`, engine: 'stub-engine',
      converged: true, energy: -12.0, n_steps: 5,
    }),
    () => async () => ({ jobId: `calc-${calcCount}`, engine: 'stub-engine', energy: calcEnergies[calcCount++] }),
  ))
  try {
    const { materialService } = coreFiber.store.stub
    const cu = await materialService.load('Cu')
    // 两个采样候选：同成分快照（公式同为 Cu，靠 materialId 区分）
    const s0 = await materialService.load('Cu')
    const s1 = await materialService.load('Cu')

    const result = await screenDopants({
      material: cu, dopants: [],
      potential: coreFiber.store.stub.potential,
      sampled: { candidates: [{ material: s0, logProb: 0 }, { material: s1, logProb: -Math.log(2) }], samplerName: 'stub-sampler', likelihood: 'exact' },
      temperatureK: 1 / (100 * 8.617333262145e-5),   // β = 100 eV⁻¹
    })
    const joint = result.sampledJoint
    assert.ok(joint, 'sampledJoint 段随交付呈现')
    assert.equal(joint.entries.length, 2)
    assert.ok(Math.abs(joint.betaEVInv - 100) < 1e-9, 'β = 100 eV⁻¹（温度显式选定）')
    // 闭式：w₀/w₁ = exp(1 + ln2) = 2e → w₀ = r/(1+r), r = 2e
    const r = 2 * Math.E
    assert.ok(Math.abs(joint.entries[0].weight - r / (1 + r)) < 1e-12, '高权重候选排前（闭式）')
    assert.ok(Math.abs(joint.entries[1].weight - 1 / (1 + r)) < 1e-12)
    // log 联合权重只有差值不变（归一减 max）：Δ = βΔE + ΔlogProb = 1 + ln2
    const dLog = joint.entries[0].logJointWeight - joint.entries[1].logJointWeight
    assert.ok(Math.abs(dLog - (1 + Math.log(2))) < 1e-9, 'log 权重差 = βΔE + ΔlogProb（闭式）')
    assert.deepEqual(joint.entries[0].coverage, ['boltzmann:stub-engine', 'proposal:stub-sampler'])
    assert.deepEqual(joint.sourceNames, ['boltzmann:stub-engine', 'proposal:stub-sampler'])
    assert.match(joint.independence, /条件独立/, '独立性声明随交付呈现')
    assert.equal(joint.likelihood, 'exact')
    assert.ok(joint.essFraction > 0 && joint.essFraction <= 1)
    // 枚举排序不受影响（无掺杂 → 只有基体）
    assert.equal(result.ranked.length, 1)
  } finally {
    await coreFiber.dispose()   // 断言失败也必须清理，否则服务残留连锁后续测试
  }
})

test('12. 缺 logProb 的采样候选：按覆盖子集组合，覆盖声明如实区分', async () => {
  let calcCount = 0
  const coreFiber = await ctx.registry.plugin(stubCorePluginWithCalc(
    () => async (material) => ({
      jobId: `job-${material.formula}`, engine: 'stub-engine',
      converged: true, energy: -12.0, n_steps: 5,
    }),
    () => async () => ({ jobId: `calc-${calcCount}`, engine: 'stub-engine', energy: -12.0 + 0.01 * calcCount++ }),
  ))
  try {
    const { materialService } = coreFiber.store.stub
    const cu = await materialService.load('Cu')
    const s0 = await materialService.load('Cu')
    const s1 = await materialService.load('Cu')

    const result = await screenDopants({
      material: cu, dopants: [],
      potential: coreFiber.store.stub.potential,
      sampled: { candidates: [{ material: s0, logProb: 0 }, { material: s1 }], samplerName: 'stub-sampler' },
      temperatureK: 1 / (100 * 8.617333262145e-5),
    })
    const noLik = result.sampledJoint.entries.find(e => e.logProb === null)
    assert.ok(noLik, '缺 logProb 的候选保留且标记 null（不零填充）')
    assert.deepEqual(noLik.coverage, ['boltzmann:stub-engine'], '覆盖声明如实缺似然源')
    // 良态性断言：能量差 0.01·β=1 时，双源候选与单源候选的权重都是良态可区分的非零值；
    // 若误把缺失零填充（或温度错到 β=1000 下溢），至少一项会失效。0.01·β=1 时，
    // 双源候选（能量 −12.0，似然 0）对单源候选（能量 −11.99）的联合差 = 1 → 比值 e
    const both = result.sampledJoint.entries.find(e => e.logProb === 0)
    assert.ok(Math.abs(both.weight / noLik.weight - Math.E) < 1e-9, '权重比 = e（闭式）')
  } finally {
    await coreFiber.dispose()
  }
})

test('13. 联合排序门禁：缺温度 / 引擎无 calculate 原语均显式拒绝', async () => {
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => ({
    jobId: `job-${material.formula}`, engine: 'stub-engine',
    converged: true, energy: -12.0, n_steps: 5,
  })))
  try {
    const { materialService } = coreFiber.store.stub
    const cu = await materialService.load('Cu')
    const s0 = await materialService.load('Cu')
    const base = {
      material: cu, dopants: [], potential: coreFiber.store.stub.potential,
      sampled: { candidates: [{ material: s0, logProb: 0 }], samplerName: 'stub-sampler' },
    }
    await assert.rejects(() => screenDopants(base), /temperatureK is required/)
    await assert.rejects(
      () => screenDopants({ ...base, temperatureK: 300 }),
      /does not provide the calculate primitive/,
    )
  } finally {
    await coreFiber.dispose()
  }
})

test('14. 工具层采样候选解析：materialId 逐个解析，未知 ID 显式报错', async () => {
  let calcCount = 0
  const coreFiber = await ctx.registry.plugin(stubCorePluginWithCalc(
    () => async (material) => ({
      jobId: `job-${material.formula}`, engine: 'stub-engine',
      converged: true, energy: -12.0, n_steps: 5,
    }),
    () => async () => ({ jobId: `calc-${calcCount++}`, engine: 'stub-engine', energy: -12.0 }),
  ))
  try {
    const { materialService } = coreFiber.store.stub
    const cu = await materialService.load('Cu')
    const s0 = await materialService.load('Cu')

    const result = await screenRt.tools.call('workflow.screen', {
      materialId: cu.id, dopants: [],
      sampled: [{ materialId: s0.id, logProb: -1.5 }],
      sampledSource: 'sampler.ou',
      temperatureK: 300,
    })
    assert.equal(result.sampledJoint.samplerName, 'sampler.ou')
    assert.equal(result.sampledJoint.entries[0].materialId, s0.id)

    await assert.rejects(
      () => screenRt.tools.call('workflow.screen', {
        materialId: cu.id, dopants: [],
        sampled: [{ materialId: 'nonexistent', logProb: 0 }], temperatureK: 300,
      }),
      /Unknown material id: nonexistent/,
    )
  } finally {
    await coreFiber.dispose()
  }
})

// ── 枚举候选第三证据源（⑲，组合律可扩展性检验）：凸包距离证据 ──
// 能量模型（4 原子胞，ref 全 −3.0 → 端点全零，包络 = z=0 超平面）：
// Cu: ΔH_f=0（hull=0）、Cu3Ag: ΔH_f=−0.01（稳定，hull 掩码 0）、Cu3Ni: ΔH_f=+0.01（hull=0.01）。
// β = 100 eV⁻¹ → log 权重 [0, +1, −2]：凸包证据把包外候选的罚分翻倍（闭式可写）。
test('15. 第三证据源：凸包距离接联合排序（权重闭式对账 + 掩码语义）', async () => {
  const energies = { Cu: -12.0, Cu3Ag: -12.04, Cu3Ni: -11.96 }
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => ({
    jobId: `job-${material.formula}`, engine: 'stub-engine',
    converged: true, energy: energies[material.formula], n_steps: 5,
  })))
  try {
    const cu = await coreFiber.store.stub.materialService.load('Cu')
    const result = await screenDopants({
      material: cu, dopants: ['Ag', 'Ni'],
      potential: coreFiber.store.stub.potential,
      references: { Cu: -3.0, Ag: -3.0, Ni: -3.0 },
      evidenceSources: ['hull'],
      temperatureK: 1 / (100 * 8.617333262145e-5),   // β = 100 eV⁻¹
    })
    const joint = result.joint
    assert.ok(joint, 'joint 段随交付呈现（显式启用才出现，默认行为不变）')
    assert.deepEqual(joint.sourceNames, ['boltzmann:stub-engine', 'hull:multi-component'])
    assert.ok(Math.abs(joint.betaEVInv - 100) < 1e-9)
    // 闭式：log 权重 [0, +1, −2] → 归一 ∝ [1, e, e⁻²]；降序 = Cu3Ag > Cu > Cu3Ni
    assert.deepEqual(joint.entries.map(e => e.formula), ['Cu3Ag', 'Cu', 'Cu3Ni'])
    const Z = 1 + Math.E + Math.exp(-2)
    assert.ok(Math.abs(joint.entries[0].weight - Math.E / Z) < 1e-12, '稳定候选权重闭式')
    assert.ok(Math.abs(joint.entries[1].weight - 1 / Z) < 1e-12, '基体（端点）权重闭式')
    assert.ok(Math.abs(joint.entries[2].weight - Math.exp(-2) / Z) < 1e-12,
      '包外候选：焓罚分 βΔH=1 + 凸包罚分 β·hull=1，双源叠加（闭式 e⁻²）')
    // 掩码语义：稳定候选（ΔH_f<0）的凸包证据 = 0（包内无额外区分证据，不伪造梯度）
    const ag = joint.entries.find(e => e.formula === 'Cu3Ag')
    assert.ok(Math.abs(ag.logJointWeight - 1) < 1e-9, '稳定候选的凸包证据贡献恰为 0（只有焓证据 +1）')
    assert.ok(joint.entries.every(e => e.coverage.length === 2), '枚举候选双源全覆盖')
    assert.match(joint.independence, /条件独立/, '独立性声明随交付呈现')
    assert.match(joint.independence, /退化/, '退化关联事实如实声明（不冒充独立）')
    assert.ok(joint.essFraction > 0 && joint.essFraction <= 1)
    // 默认行为回归：不启用证据源时无 joint 段（既有消费方零影响）
    const baseline = await screenDopants({
      material: cu, dopants: ['Ag', 'Ni'],
      potential: coreFiber.store.stub.potential,
      references: { Cu: -3.0, Ag: -3.0, Ni: -3.0 },
    })
    assert.equal(baseline.joint, undefined, '缺省不启用：行为与既有完全一致')
  } finally {
    await coreFiber.dispose()
  }
})

test('16. 第三证据源门禁：缺温度 / 缺参考态（无凸包）/ 未知源均显式拒绝', async () => {
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => ({
    jobId: `job-${material.formula}`, engine: 'stub-engine',
    converged: true, energy: -12.0, n_steps: 5,
  })))
  try {
    const cu = await coreFiber.store.stub.materialService.load('Cu')
    const base = { material: cu, dopants: ['Ni'], potential: coreFiber.store.stub.potential, evidenceSources: ['hull'] }
    await assert.rejects(() => screenDopants(base),
      /temperatureK is required/, '无温度：焓证据无标度，拒绝组合')
    await assert.rejects(
      () => screenDopants({ ...base, temperatureK: 300 }),
      /hull evidence requires references/, '无参考态：无凸包即无稳定性证据，不静默近似')
    await assert.rejects(
      () => screenDopants({
        ...base, temperatureK: 300,
        references: { Cu: -3.0, Ni: -3.0 }, evidenceSources: ['phonon'],
      }),
      /unknown evidence source "phonon"/, '未知证据源：须显式实现，不静默近似')
  } finally {
    await coreFiber.dispose()
  }
})

test('17. 温差诚实声明（⑳）：采样器声明温度与目标不一致时随交付呈现，不纠正', async () => {
  let calcCount = 0
  const coreFiber = await ctx.registry.plugin(stubCorePluginWithCalc(
    () => async (material) => ({
      jobId: `job-${material.formula}`, engine: 'stub-engine',
      converged: true, energy: -12.0, n_steps: 5,
    }),
    () => async () => ({ jobId: `calc-${calcCount++}`, engine: 'stub-engine', energy: -12.0 }),
  ))
  try {
    const { materialService } = coreFiber.store.stub
    const cu = await materialService.load('Cu')
    const s0 = await materialService.load('Cu')
    const sampled = { candidates: [{ material: s0, logProb: 0 }], samplerName: 'stub-sampler' }
    // 声明采样温度 600 K，目标 300 K：温差段必须呈现（提议核涨落幅度与目标标度不匹配）
    const mismatched = await screenDopants({
      material: cu, dopants: [], potential: coreFiber.store.stub.potential,
      sampled: { ...sampled, samplerTemperatureK: 600 }, temperatureK: 300,
    })
    assert.ok(mismatched.sampledJoint.temperatureMismatch, '温差声明随交付呈现')
    assert.equal(mismatched.sampledJoint.temperatureMismatch.samplerTemperatureK, 600)
    assert.equal(mismatched.sampledJoint.temperatureMismatch.targetTemperatureK, 300)
    assert.ok(mismatched.sampledJoint.entries.length === 1, '温差不阻断联合排序（声明而非拒绝）')
    // 温度一致或未声明：不出现温差段（不制造噪声）
    const aligned = await screenDopants({
      material: cu, dopants: [], potential: coreFiber.store.stub.potential,
      sampled: { ...sampled, samplerTemperatureK: 300 }, temperatureK: 300,
    })
    assert.equal(aligned.sampledJoint.temperatureMismatch, undefined)
    const undeclared = await screenDopants({
      material: cu, dopants: [], potential: coreFiber.store.stub.potential,
      sampled, temperatureK: 300,
    })
    assert.equal(undeclared.sampledJoint.temperatureMismatch, undefined)
  } finally {
    await coreFiber.dispose()
  }
})

// ── 证据源注册表化（②）：新证据源接入不改筛选代码 ──────────────
// 描述符形态 = { name, requires, logWeights, independenceNote }；筛选层只做通用循环。
test('18. 证据源注册表化：解析三态 + 描述符闭式 + 自定义源端到端注入', async () => {
  // 纯层：解析三态（内置命中 / 未知拒绝 / 自定义注册表）
  assert.deepEqual(resolveEvidenceSources(['hull']), [hullEvidenceSource])
  assert.throws(() => resolveEvidenceSources(['phonon']), /unknown evidence source "phonon"/)
  const bias = {
    name: 'bias',
    requires() {},
    logWeights({ ranked }) { return ranked.map(r => (r.formula === 'Cu3Ag' ? 0.5 : 0)) },
    independenceNote: '先验偏置证据为确定性常数，与能量证据条件独立（测试用自定义源）',
  }
  assert.deepEqual(resolveEvidenceSources(['bias'], { bias }), [bias])
  // 描述符闭式：包内点掩码 0，包外点 −β·hull（β=100）
  const descriptorCtx = {
    ranked: [{ energyAboveHull: -0.02 }, { energyAboveHull: 0.05 }],
    thermo: { level: 'ok', mode: 'multi-component' }, betaEVInv: 100,
  }
  const logW = hullEvidenceSource.logWeights(descriptorCtx)
  assert.ok(logW[0] === 0 && logW[1] === -5, '掩码 0（包内）与 −β·hull（包外）闭式；用 === 比较避开 −0 的 SameValue 陷阱')
  assert.throws(() => hullEvidenceSource.requires({ ...descriptorCtx, thermo: { level: 'unavailable' } }),
    /hull evidence requires references/)

  // 端到端：自定义注册表注入（复用测试 15 能量模型），新源不改筛选代码即参与组合律。
  // 未启用 hull 源：log 权重 = 焓 [0, +1, −1] + 偏置 [0, +0.5, 0] → [0, 1.5, −1]
  const energies = { Cu: -12.0, Cu3Ag: -12.04, Cu3Ni: -11.96 }
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => ({
    jobId: `job-${material.formula}`, engine: 'stub-engine',
    converged: true, energy: energies[material.formula], n_steps: 5,
  })))
  try {
    const cu = await coreFiber.store.stub.materialService.load('Cu')
    const result = await screenDopants({
      material: cu, dopants: ['Ag', 'Ni'],
      potential: coreFiber.store.stub.potential,
      references: { Cu: -3.0, Ag: -3.0, Ni: -3.0 },
      evidenceSources: ['bias'],
      evidenceSourceRegistry: { bias },
      temperatureK: 1 / (100 * 8.617333262145e-5),   // β = 100 eV⁻¹
    })
    const joint = result.joint
    assert.ok(joint.sourceNames.includes('bias:multi-component'), '自定义源名随交付呈现')
    // 未启用 hull：log 权重 = 焓 [0, +1, −1] + 偏置 [0, +0.5, 0] → [0, 1.5, −1]；
    // 降序 Cu3Ag(1.5) > Cu(0) > Cu3Ni(−1)：偏置证据足以把稳定候选推上首位（闭式）
    const Z = Math.exp(1.5) + 1 + Math.exp(-1)
    assert.deepEqual(joint.entries.map(e => e.formula), ['Cu3Ag', 'Cu', 'Cu3Ni'])
    const ag = joint.entries.find(e => e.formula === 'Cu3Ag')
    assert.ok(Math.abs(ag.logJointWeight - 1.5) < 1e-9, 'Cu3Ag：焓 +1 + 偏置 +0.5，双源 log 权重相加（组合律闭式）')
    assert.ok(Math.abs(ag.weight - Math.exp(1.5) / Z) < 1e-12, '偏置证据进归一权重（闭式）')
    assert.ok(Math.abs(joint.entries[1].weight - 1 / Z) < 1e-12, '基体（无偏置）权重闭式')
    assert.match(joint.independence, /先验偏置/, '自定义源的独立性声明随组合呈现（不丢失）')
    // 内置注册表对未知源依然拒绝（注入注册表不绕过门禁）
    await assert.rejects(
      () => screenDopants({
        material: cu, dopants: ['Ag'], potential: coreFiber.store.stub.potential,
        references: { Cu: -3.0, Ag: -3.0 }, evidenceSources: ['phonon'], temperatureK: 300,
      }),
      /unknown evidence source "phonon"/)
  } finally {
    await coreFiber.dispose()
  }
  // 内置注册表完整性：描述符三要素齐全（缺一即接入即坏）
  for (const d of Object.values(builtinEvidenceSources)) {
    assert.ok(typeof d.name === 'string' && typeof d.requires === 'function' &&
      typeof d.logWeights === 'function' && typeof d.independenceNote === 'string',
      `内置证据源 ${d?.name} 描述符必须三要素齐全`)
  }
})

// ── M3 能量组合门禁（参考态指纹/单位一致性）：进凸包前必须与候选引擎同源可比 ──
test('19. M3 参考态指纹/单位门禁：同源放行，异源/异单位显式拒绝（不静默换算、不静默混源）', async () => {
  const energies = { Cu: -12.0, Cu3Ag: -12.04 }
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => ({
    jobId: `job-${material.formula}`, engine: 'stub-engine',
    converged: true, energy: energies[material.formula], n_steps: 5,
  })))
  try {
    const cu = await coreFiber.store.stub.materialService.load('Cu')
    const sameSource = { software: 'stub-engine', method: 'stub' }
    // ① 同指纹（version 归一 unknown，两边缺视同）+ eV 单位 → 放行，provenance 声明态；
    //    能量来源可追溯性随交付呈现（消费方可据此核对跨批次可比性）
    const ok = await screenDopants({
      material: cu, dopants: ['Ag'],
      potential: coreFiber.store.stub.potential,
      references: {
        Cu: { energyPerAtom: -3.0, fingerprint: sameSource, energyUnit: 'eV' },
        Ag: { energyPerAtom: -3.0, fingerprint: { ...sameSource, version: 'unknown' }, energyUnit: 'eV' },
      },
    })
    assert.equal(ok.thermo.referenceProvenance, 'declared', '指纹全声明 → 来源声明态')
    assert.deepEqual(ok.providerFingerprint, { software: 'stub-engine', method: 'stub', version: 'unknown' })
    assert.deepEqual(ok.providerUnits, { energy: 'eV', length: 'Å', time: 'fs' })
    // ② 指纹不同源 → 显式拒绝（DFT 参考态混进 mock 引擎凸包 = 物理无意义的包络）
    await assert.rejects(() => screenDopants({
      material: cu, dopants: ['Ag'],
      potential: coreFiber.store.stub.potential,
      references: {
        Cu: { energyPerAtom: -3.0, fingerprint: sameSource },
        Ag: { energyPerAtom: -3.7, fingerprint: { software: 'vasp', method: 'DFT-PBE' } },
      },
    }), /不同源/, '异源能量混入凸包必须显式拒绝')
    // ③ 单位不一致 → UNIT_MISMATCH（不自动换算：是否可比推回调用方显式决策）
    await assert.rejects(() => screenDopants({
      material: cu, dopants: ['Ag'],
      potential: coreFiber.store.stub.potential,
      references: {
        Cu: { energyPerAtom: -3.0, fingerprint: sameSource },
        Ag: { energyPerAtom: -0.22, energyUnit: 'Ry' },
      },
    }), err => err.code === 'UNIT_MISMATCH')
    // ④ 纯数值形态（无声明）→ 诚实降级 provenance=undeclared，既有行为不变（门禁不追溯拦截）
    const legacy = await screenDopants({
      material: cu, dopants: ['Ag'],
      potential: coreFiber.store.stub.potential,
      references: { Cu: -3.0, Ag: -3.0 },
    })
    assert.equal(legacy.thermo.referenceProvenance, 'undeclared')
    // ⑤ 升级形态缺能量 → 显式拒绝（不得拿空壳声明冒充参考态）
    await assert.rejects(() => screenDopants({
      material: cu, dopants: ['Ag'],
      potential: coreFiber.store.stub.potential,
      references: { Cu: { fingerprint: sameSource }, Ag: -3.0 },
    }), /energyPerAtom/)
  } finally {
    await coreFiber.dispose()
  }
})

// ── ⑧ 换算审计通道：convertedFrom 声明"原值单位 + 已显式换算"，因子机械重算随交付呈现 ──
test('20. 换算审计：convertedFrom 因子闭式对账（声明 ≠ 替换，不绕过单位门禁）', async () => {
  const energies = { Cu: -12.0, Cu3Ag: -12.04 }
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => ({
    jobId: `job-${material.formula}`, engine: 'stub-engine',
    converged: true, energy: energies[material.formula], n_steps: 5,
  })))
  try {
    const cu = await coreFiber.store.stub.materialService.load('Cu')
    const sameSource = { software: 'stub-engine', method: 'stub' }
    // energyPerAtom 已是引擎单位（eV）；convertedFrom 声明原值来自 Ry 产出并已显式换算。
    // 审计因子 = 1 Ry → eV = 13.6056981335（白名单机械重算，独立手算对账）；结果与无声明路径闭式一致。
    const withAudit = await screenDopants({
      material: cu, dopants: ['Ag'],
      potential: coreFiber.store.stub.potential,
      references: {
        Cu: { energyPerAtom: -3.0, fingerprint: sameSource, convertedFrom: { unit: 'Ry' } },
        Ag: { energyPerAtom: -3.0, fingerprint: sameSource },
      },
    })
    assert.deepEqual(withAudit.thermo.referenceConversions,
      [{ element: 'Cu', from: 'Ry', to: 'eV', factor: 13.6056981335 }], '审计因子 = 白名单系数（机械可复现）')
    const ag = withAudit.ranked.find(r => r.formula === 'Cu3Ag')
    assert.ok(Math.abs(ag.formationEnthalpy - (-0.01)) < 1e-12, '声明不改消费：形成焓闭式与无声明路径一致')
    // 跨维度 convertedFrom（长度单位）→ 显式拒绝（白名单系数不存在）
    await assert.rejects(() => screenDopants({
      material: cu, dopants: ['Ag'],
      potential: coreFiber.store.stub.potential,
      references: { Cu: { energyPerAtom: -3.0, convertedFrom: { unit: 'Bohr' } }, Ag: -3.0 },
    }), err => err.code === 'UNIT_DIMENSION_MISMATCH')
    // 声明 ≠ 替换：energyUnit 与引擎不一致时，convertedFrom 不绕过门禁（换算必须发生在交付前）
    await assert.rejects(() => screenDopants({
      material: cu, dopants: ['Ag'],
      potential: coreFiber.store.stub.potential,
      references: {
        Cu: { energyPerAtom: -0.22, energyUnit: 'Ry', convertedFrom: { unit: 'Ry' } },
        Ag: -3.0,
      },
    }), err => err.code === 'UNIT_MISMATCH', '声明换算历史 ≠ 交付异单位能量')
  } finally {
    await coreFiber.dispose()
  }
})

// ── ⑦ 工具层消费指纹：自产参考态升级声明形态，指纹/单位随交付投影给 Agent ──
test('21. 工具层：自产参考态同源声明（provenance 声明态）+ 指纹随交付投影', async () => {
  const energies = { Cu: -12.0, Cu3Ag: -12.04 }
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => ({
    jobId: `job-${material.formula}`, engine: 'ref-engine',
    converged: true, energy: energies[material.formula], n_steps: 5,
  })))
  try {
    // 带 referenceEnergy 原语的引擎：自产参考态按定义同源，工具层应升级为声明形态
    coreFiber.store.stub.potential.register({
      name: 'ref-engine',
      manifest: {
        capabilities: [{ type: 'relax', accuracy: 0.5, speed: 0.99, cost: 0.01, maxAtoms: 200 }],
        constraints: {},
        eventGranularity: 'job',
        units: { energy: 'eV', length: 'Å', time: 'fs' },
        fingerprint: { software: 'ref-engine', method: 'stub-ref' },
      },
      relax: async (material) => ({
        jobId: `job-${material.formula}`, engine: 'ref-engine',
        converged: true, energy: energies[material.formula], n_steps: 5,
      }),
      referenceEnergy: async () => ({ energy_per_atom: -3.0 }),
    })
    const cu = await coreFiber.store.stub.materialService.load('Cu')
    const result = await screenRt.tools.call('workflow.screen', {
      materialId: cu.id, dopants: ['Ag'], engine: 'ref-engine',
    })
    assert.equal(result.thermo.referenceProvenance, 'declared', '工具层自产参考态 → 来源声明态（同源按定义成立）')
    assert.equal(result.thermo.references.Cu, -3.0, '归一后仍是纯能量数值（消费方无感）')
    // 指纹/单位随交付投影（render 全量序列化，宿主侧可核对能量来源可比性）
    assert.deepEqual(result.providerFingerprint, { software: 'ref-engine', method: 'stub-ref', version: 'unknown' })
    assert.deepEqual(result.providerUnits, { energy: 'eV', length: 'Å', time: 'fs' })
  } finally {
    await coreFiber.dispose()
  }
})

// ── ④ 证据源注册表第二内置源：理想混合熵（只消费组分，零能量信息共享）──
test('22. 混合熵证据源：每点位熵闭式 + 端到端联合排序（注册表化实证：第二源不改筛选代码）', async () => {
  // 纯层闭式（先手算再对账）：纯元素 = 0；Cu3Ag（x=0.75/0.25）= −(0.75 ln 0.75 + 0.25 ln 0.25)
  //   = 0.5623351446188083；组分是计数形态，源内归一（与凸包构造同源同形）
  const s = mixingEntropyEvidenceSource.logWeights({
    ranked: [{ composition: { Cu: 4 } }, { composition: { Cu: 3, Ag: 1 } }],
  })
  assert.ok(s[0] === 0, '纯元素无混合可言：按定义 0，不伪造梯度')
  assert.ok(Math.abs(s[1] - 0.5623351446188083) < 1e-12, '每点位理想混合熵闭式（手算对账）')
  assert.throws(() => mixingEntropyEvidenceSource.requires({ ranked: [{ composition: null }] }),
    /composition/, '缺组分即无证据（输入门禁与 hull 源同款诚实）')
  assert.deepEqual(resolveEvidenceSources(['mixing-entropy']), [mixingEntropyEvidenceSource], '内置注册表已含第二源')

  // 端到端（复用测试 18 能量模型）：未启用 hull，log 权重 = 焓 [0,+1,−1] + 混合熵 [0, S1, S1]
  const S1 = 0.5623351446188083
  const energies = { Cu: -12.0, Cu3Ag: -12.04, Cu3Ni: -11.96 }
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => ({
    jobId: `job-${material.formula}`, engine: 'stub-engine',
    converged: true, energy: energies[material.formula], n_steps: 5,
  })))
  try {
    const cu = await coreFiber.store.stub.materialService.load('Cu')
    const result = await screenDopants({
      material: cu, dopants: ['Ag', 'Ni'],
      potential: coreFiber.store.stub.potential,
      references: { Cu: -3.0, Ag: -3.0, Ni: -3.0 },
      evidenceSources: ['mixing-entropy'],
      temperatureK: 1 / (100 * 8.617333262145e-5),   // β = 100 eV⁻¹
    })
    const joint = result.joint
    assert.ok(joint.sourceNames.some(n => n.startsWith('mixing-entropy:')), '第二源名随交付呈现')
    // 降序：Cu3Ag(1+S1) > Cu(0) > Cu3Ni(−1+S1)——排序不变但权重位移（熵证据如实叠加）
    const Z = Math.exp(1 + S1) + 1 + Math.exp(-1 + S1)
    assert.deepEqual(joint.entries.map(e => e.formula), ['Cu3Ag', 'Cu', 'Cu3Ni'])
    const ag = joint.entries.find(e => e.formula === 'Cu3Ag')
    assert.ok(Math.abs(ag.logJointWeight - (1 + S1)) < 1e-9, 'Cu3Ag：焓 +1 + 混合熵 +S1（双源闭式相加）')
    assert.ok(Math.abs(ag.weight - Math.exp(1 + S1) / Z) < 1e-12, '混合熵进归一权重（闭式）')
    const ni = joint.entries.find(e => e.formula === 'Cu3Ni')
    assert.ok(Math.abs(ni.logJointWeight - (-1 + S1)) < 1e-9, 'Cu3Ni：焓 −1 被同形状混合熵部分抵消（熵不敌焓，如实呈现）')
    assert.match(joint.independence, /混合熵/, '第二源独立性声明随组合呈现（与凸包共享组分变量的退化关联如实声明）')
  } finally {
    await coreFiber.dispose()
  }
})

// ── 接入契约套件（§8.3：兼容性由测试承诺）：纯编排层走 screenDopants，
//    缺依赖断言走工具层（此时无核心服务挂载，最后执行）──
workflowContract({
  subject: 'screen',
  formula: 'Cu',
  dopants: ['Ag', 'Ni'],
  runTest: async ({ relaxImpl, dopants, emit }) => {
    const material = await Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())
    const potential = new PotentialRegistry({ on() {}, emit() {} })
    potential.register({
      name: 'contract-stub',
      manifest: {
        capabilities: [{ type: 'relax', accuracy: 0.5, speed: 0.99, cost: 0.01, maxAtoms: 200 }],
        constraints: {},
        eventGranularity: 'job',
        units: { energy: 'eV', length: 'Å', time: 'fs' },
        fingerprint: { software: 'contract-stub', method: 'stub' },
      },
      relax: relaxImpl,
    })
    await potential.activate('contract-stub')
    return screenDopants({ material, dopants, potential, emit })
  },
  missingDeps: () => screenRt.tools.call('workflow.screen', { materialId: 'x', dopants: ['Ag'] }),
})
