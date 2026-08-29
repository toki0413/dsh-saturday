// @saturday/contract-tests —— 契约测试套件（契约 §8.3）
// 兼容性由测试而非文档承诺：新插件进入生态，必须在自己的测试文件里
// 调用对应套件。套件用 node:test 注册用例，调用方只需提供工厂函数与夹具。
//
// 用法示例：
//   import { structureResolverContract } from '@saturday/contract-tests'
//   structureResolverContract({
//     subject: 'materials-project',
//     createResolver: () => new MaterialsProjectResolver({ apiKey, fetchImpl: stub }),
//     knownFormula: 'TiO2',
//   })

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Material, PrototypeLibResolver, PotentialRegistry } from '@saturday/core'

const dummyRt = { on() {}, emit() {} }

// ────────────────────────────────────────────────────────────
// 套件 1：structure-resolver（契约 §4.1）
// ────────────────────────────────────────────────────────────

/**
 * @param {Object}   opts
 * @param {string}   opts.subject         被测 resolver 标识（测试名前缀）
 * @param {Function} opts.createResolver  () => StructureResolver（可 async）
 * @param {string}   opts.knownFormula    被测源必须能解析的化学式
 * @param {string}  [opts.missFormula]    被测源必须查无的化学式（默认用一个怪式）
 */
export function structureResolverContract({ subject, createResolver, knownFormula, missFormula = 'Xx99Qq77' }) {
  test(`[contract:${subject}] §4.1 name 与候选形状`, async () => {
    const resolver = await createResolver()
    assert.equal(typeof resolver.name, 'string')
    assert.ok(resolver.name.length > 0)

    const candidates = await resolver.resolve(knownFormula)
    assert.ok(Array.isArray(candidates) && candidates.length >= 1, 'resolve must return non-empty candidates')
    for (const c of candidates) {
      assert.ok(Array.isArray(c.graph.nodes) && c.graph.nodes.length >= 1)
      for (const n of c.graph.nodes) {
        assert.equal(typeof n.id, 'number')
        assert.equal(typeof n.number, 'number')
        assert.equal(n.position.length, 3, 'position must be [x, y, z]')
      }
      assert.ok(Array.isArray(c.graph.edges), 'edges reserved field required (v0: empty)')
      assert.equal(typeof c.graph.periodic, 'boolean')
      assert.equal(c.graph.cell.length, 3, 'cell must be 3 row vectors')
      assert.equal(typeof c.source, 'string', 'source is written to lineage verbatim')
      assert.equal(typeof c.polymorphRank, 'number')
    }
  })

  test(`[contract:${subject}] §4.1 polymorphRank 从 0 起升序`, async () => {
    const resolver = await createResolver()
    const candidates = await resolver.resolve(knownFormula)
    assert.deepEqual(candidates.map(c => c.polymorphRank), candidates.map((_, i) => i))
  })

  test(`[contract:${subject}] §4.1 查无必须抛 STRUCTURE_NOT_FOUND（附可用范围提示）`, async () => {
    const resolver = await createResolver()
    await assert.rejects(
      () => resolver.resolve(missFormula),
      err => err.code === 'STRUCTURE_NOT_FOUND',
    )
  })

  test(`[contract:${subject}] §4.1 幂等：同输入同输出`, async () => {
    const resolver = await createResolver()
    const a = await resolver.resolve(knownFormula)
    const b = await resolver.resolve(knownFormula)
    assert.deepEqual(b.map(c => c.source), a.map(c => c.source))
    assert.deepEqual(b.map(c => c.graph.nodes.length), a.map(c => c.graph.nodes.length))
  })
}

// ────────────────────────────────────────────────────────────
// 套件 2：potential-provider（契约 §4.2 + §5.2）
// ────────────────────────────────────────────────────────────

/**
 * @param {Object}  opts
 * @param {string}  opts.subject          被测 provider 标识（测试名前缀）
 * @param {Function} opts.createProvider  () => PotentialProvider（可用形态，可 async）
 * @param {boolean} [opts.runnable]       本环境能否真实跑通 relax（决定走形状断言还是显式失败断言）
 * @param {string}  [opts.runFormula]     runnable 时使用的化学式（默认 'Ar'，原型库内置）
 * @param {Object}  [opts.unavailable]    显式失败路径：{ createProvider, code }，
 *                                        relax 必须抛带该 code 的错误，不得静默降级
 * @param {boolean} [opts.skipIdempotency] 结果含随机因素时关闭幂等断言（默认开）
 */
export function potentialProviderContract({
  subject, createProvider,
  runnable = false, runFormula = 'Ar',
  unavailable = null, skipIdempotency = false,
}) {
  test(`[contract:${subject}] §4.2 manifest 形状`, async () => {
    const provider = await createProvider()
    assert.equal(typeof provider.name, 'string')
    assert.equal(typeof provider.version, 'string')
    const m = provider.manifest
    assert.ok(Array.isArray(m.capabilities) && m.capabilities.length >= 1)
    for (const c of m.capabilities) {
      assert.ok(['relax', 'calculate'].includes(c.type), `capability type must be relax|calculate, got ${c.type}`)
      for (const k of ['accuracy', 'speed', 'cost']) {
        assert.equal(typeof c[k], 'number')
        assert.ok(c[k] >= 0 && c[k] <= 1, `${k} must be in [0,1] (修订 #7：统一"越大越好")`)
      }
    }
    assert.equal(typeof m.constraints, 'object')
    // §5.2：粒度必须显式声明（未声明者按 iteration 对待是兼容宽容，新插件应显式）
    assert.ok(['iteration', 'job'].includes(m.eventGranularity), 'eventGranularity must be declared')
  })

  test(`[contract:${subject}] §5.2 事件粒度门禁`, async () => {
    const provider = await createProvider()
    const reg = new PotentialRegistry(dummyRt)
    reg.register(provider)
    if (provider.manifest.eventGranularity === 'job') {
      assert.throws(
        () => reg.assertCanMonitor(provider, 'iteration'),
        err => err.code === 'GRANULARITY_UNAVAILABLE',
        'job 级引擎必须显式拒绝细粒度监听',
      )
    } else {
      reg.assertCanMonitor(provider, 'iteration')
    }
    reg.assertCanMonitor(provider, 'job')   // 任务级监听对任何引擎都合法（粒度是上限）
  })

  if (runnable) {
    test(`[contract:${subject}] §4.2 relax 结果形状（真实执行）`, async () => {
      const provider = await createProvider()
      const material = await Material.create({ modalities: { formula: runFormula } }, new PrototypeLibResolver())
      const result = await provider.relax(material, {})
      assert.equal(typeof result.jobId, 'string')
      assert.equal(result.engine, provider.name, 'engine must be provider.name')
      assert.equal(typeof result.converged, 'boolean')
      assert.ok(Number.isFinite(result.energy), 'energy must be a finite number (eV)')
      assert.equal(typeof result.n_steps, 'number')
      assert.ok(result.n_steps >= 0)
    })

    if (!skipIdempotency) {
      test(`[contract:${subject}] §4.2 幂等：相同输入相同结果（允许经缓存）`, async () => {
        const provider = await createProvider()
        const material = await Material.create({ modalities: { formula: runFormula } }, new PrototypeLibResolver())
        const a = await provider.relax(material, {})
        const b = await provider.relax(material, {})
        assert.ok(Math.abs(a.energy - b.energy) < 1e-8, 'identical input must yield identical energy')
      })
    }
  }

  if (unavailable) {
    test(`[contract:${subject}] 显式失败：不可用时抛 ${unavailable.code}，绝不静默降级`, async () => {
      const provider = await unavailable.createProvider()
      const material = await Material.create({ modalities: { formula: runFormula } }, new PrototypeLibResolver())
      await assert.rejects(
        () => provider.relax(material, {}),
        err => err.code === unavailable.code,
      )
    })
  }
}

// ────────────────────────────────────────────────────────────
// 套件 3：workflow（契约 §4.3）
// 契约冻结的是纯编排层：事件由调用方路由（注入 emit），
// 故套件不触碰 cordis，调用方把 relaxImpl 接进自己依赖的引擎即可。
// ────────────────────────────────────────────────────────────

/**
 * @param {Object}   opts
 * @param {string}   opts.subject    被测工作流标识（测试名前缀）
 * @param {Function} opts.runTest    ({ relaxImpl, dopants, emit }) => Promise<结果>；
 *                                   调用方负责构造基体、把 relaxImpl 接进引擎、
 *                                   并把 emit 透传给编排函数（纯函数形态）
 * @param {string}   opts.formula    基体化学式（原型库可解析）
 * @param {string[]} opts.dopants    掺杂元素列表（至少 1 个）
 * @param {Function} [opts.missingDeps] 工具层可选断言：缺核心服务时的调用，
 *                                   必须 reject（不得静默降级，契约 §2）
 */
export function workflowContract({ subject, runTest, formula, dopants, missingDeps }) {
  const stubRelax = (energies) => async (material) => ({
    jobId: `job-${material.formula}`, engine: 'contract-stub', converged: true,
    energy: energies[material.formula], n_steps: 3,
  })

  if (missingDeps) {
    test(`[contract:${subject}] §4.3 缺依赖必须显式报错，不得静默降级（契约 §2）`, async () => {
      await assert.rejects(
        () => missingDeps(),
        /requires|must be mounted|services/i,
      )
    })
  }

  test(`[contract:${subject}] §4.3 结果形状与排序：ranked 按 energyPerAtom 升序`, async () => {
    // 确定性能量：按 dopants 顺序递减，验证“排序”而非“透传”
    const energies = { [formula]: -12.0 }
    dopants.forEach((d, i) => { energies[`${formula}3${d}`] = -12.4 - i * 0.2 })
    const result = await runTest({ relaxImpl: stubRelax(energies), dopants })

    assert.ok(Array.isArray(result.ranked), 'ranked must be an array')
    assert.ok(Array.isArray(result.failed), 'failed must be an array')
    assert.equal(typeof result.note, 'string', 'note 诚实声明物理口径')
    assert.equal(result.ranked.length, dopants.length + 1, '基体 + 全部掺杂变体')
    for (const r of result.ranked) {
      assert.equal(typeof r.label, 'string')
      assert.ok(Number.isFinite(r.energy), 'energy must be finite (eV)')
      assert.ok(Number.isFinite(r.energyPerAtom))
    }
    const e = result.ranked.map(r => r.energyPerAtom)
    assert.deepEqual(e, [...e].sort((a, b) => a - b), '必须按 energyPerAtom 升序')
    assert.equal(result.ranked.at(-1).formula, formula, '能量最高的基体排在最后（验证排序而非透传）')
  })

  test(`[contract:${subject}] §4.3 逐变体事件：每个成功变体独立一条，薄载荷含引用`, async () => {
    const events = []
    await runTest({
      relaxImpl: stubRelax({ [formula]: -12.0 }),
      dopants,
      emit: async (type, event) => { events.push(event) },
    })
    assert.equal(events.length, dopants.length + 1, '每个成功变体一条事件（可逐条溯源）')
    for (const e of events) {
      assert.ok(e.payload?.jobId, '薄载荷：事件带 jobId 引用')
      assert.ok(e.payload?.material?.id, '薄载荷：事件带材料引用')
    }
  })

  test(`[contract:${subject}] §4.3 单变体失败计入 failed，不中断整体（不吞错）`, async () => {
    const failFormula = `${formula}3${dopants[0]}`
    const relaxImpl = async (material) => {
      if (material.formula === failFormula) throw new Error('contract-stub: 故意失败')
      return {
        jobId: `job-${material.formula}`, engine: 'contract-stub',
        converged: true, energy: -12.0, n_steps: 3,
      }
    }
    const result = await runTest({ relaxImpl, dopants })
    assert.equal(result.ranked.length, dopants.length, '成功变体照常排序返回')
    assert.equal(result.failed.length, 1)
    assert.match(result.failed[0].error, /故意失败/, '失败原因必须保留，不得吞错')
  })
}
