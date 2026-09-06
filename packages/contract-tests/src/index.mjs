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
import { Material, PrototypeLibResolver, PotentialRegistry, validateEngineUnits, validateEngineFingerprint } from '@saturday/core'

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
      assert.ok(['relax', 'calculate', 'md'].includes(c.type), `capability type must be relax|calculate|md, got ${c.type}`)  // md：§4.5 遍历对账（时间平均侧）
      for (const k of ['accuracy', 'speed', 'cost']) {
        assert.equal(typeof c[k], 'number')
        assert.ok(c[k] >= 0 && c[k] <= 1, `${k} must be in [0,1] (修订 #7：统一"越大越好")`)
      }
    }
    assert.equal(typeof m.constraints, 'object')
    // §5.2：粒度必须显式声明（未声明者按 iteration 对待是兼容宽容，新插件应显式）
    assert.ok(['iteration', 'job'].includes(m.eventGranularity), 'eventGranularity must be declared')
    // M1（单位与指纹）：异构引擎生态的泛化地基——无单位声明的能量不得进入
    // 组合路径；指纹不可追溯即不可组合（注册门禁同款断言，这里双保险）
    const units = validateEngineUnits(m.units)
    assert.deepEqual(Object.keys(units).sort(), ['energy', 'length', 'time'], 'units 三元组必须齐全')
    const fp = validateEngineFingerprint(m.fingerprint)
    assert.ok(fp.software.length > 0 && fp.method.length > 0, 'fingerprint.software/method 必填')
    assert.ok(typeof fp.version === 'string', 'version 不可得时降级 unknown（诚实声明，不空缺）')
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
 * @param {Function} [opts.failWhen]  (material) => boolean，不吞错测试里指定故意失败的变体；
 *                                   默认“首个掺杂变体”（screening 语义）；同构变体工作流（如采样回算）
 *                                   由 subject 自行标记（如谱系标记）并传入断言 */
export function workflowContract({ subject, runTest, formula, dopants, missingDeps, failWhen }) {
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
    const shouldFail = failWhen ?? (m => m.formula === failFormula)
    const relaxImpl = async (material) => {
      if (shouldFail(material)) throw new Error('contract-stub: 故意失败')
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

// ────────────────────────────────────────────────────────────
// 套件 4：sampler（契约 §4.5）
// 采样语义强制声明 / 似然与可逆性诚实声明 / 谱系前缀 /
// 确定性（种子）/ 生成失败显式错。
// ────────────────────────────────────────────────────────────

/**
 * §4.5 可逆性声明的执行原语：未声明 invertible 的采样器调用 encode 必须抛
 * INVERTIBILITY_UNDECLARED（声明是可执行条款，不是文档修辞）。
 * 消费方经此原语调 encode，不得绕过 manifest 直接探测 sampler.encode。
 */
export async function encodeLatent(sampler, structure) {
  if (sampler?.manifest?.invertible !== true) {
    const e = new Error(
      `${sampler?.name ?? 'sampler'} 未声明 invertible（manifest.invertible !== true）：` +
      '输运映射不可逆或未声明，encode 不可调用（声明即承诺，未声明即拒绝） (INVERTIBILITY_UNDECLARED)')
    e.code = 'INVERTIBILITY_UNDECLARED'
    throw e
  }
  return sampler.encode(structure)
}

/**
 * @param {Object}   opts
 * @param {string}   opts.subject         被测 sampler 标识（测试名前缀）
 * @param {Function} opts.createSampler   (reference?) => StructureSampler（可 async；reference 供可逆采样器绑定位移空间）
 * @param {Function} opts.createReference () => Material（supportedTargets 含 reference 时的参考结构）
 */
export function samplerContract({ subject, createSampler, createReference }) {
  const TARGET_KINDS = ['composition', 'properties', 'energyModel', 'reference']

  test(`[contract:${subject}] §4.5 manifest：采样语义强制声明 + 诚实声明自洽`, async () => {
    const sampler = await createSampler()
    assert.equal(typeof sampler.name, 'string')
    const m = sampler.manifest
    assert.equal(m.semantics, 'sampling', '采样语义是唯一语义（与 §4.1 查表式结构源的本质区别）')
    assert.ok(['exact', 'approximate', 'none'].includes(m.likelihood), '似然声明必须三选一')
    assert.equal(typeof m.invertible, 'boolean')
    assert.ok(Array.isArray(m.supportedTargets) && m.supportedTargets.length >= 1)
    for (const t of m.supportedTargets) assert.ok(TARGET_KINDS.includes(t))
    // 诚实声明可执行：invertible 与 encode 提供必须一致（不静默、不伪造）
    if (m.invertible) {
      assert.equal(typeof sampler.encode, 'function', 'invertible 声明必须提供 encode')
    } else {
      assert.equal(sampler.encode, undefined, 'invertible: false 不得提供 encode')
    }
  })

  test(`[contract:${subject}] §4.5 采样输出形状：generative: 谱系前缀 + 似然声明一致`, async () => {
    const sampler = await createSampler()
    const reference = await createReference()
    const samples = await sampler.sample({ reference }, { n: 3, seed: 42 })
    assert.equal(samples.length, 3, 'n 必须被尊重')
    for (const s of samples) {
      assert.ok(typeof s.source === 'string' && s.source.startsWith('generative:'),
        'source 必须以 generative:<name> 前缀写入谱系')
      // 候选可回算验证：graph 形状兼容 §4.1（可送入引擎）
      assert.ok(Array.isArray(s.graph.nodes) && s.graph.nodes.length >= 1)
      for (const node of s.graph.nodes) assert.equal(node.position.length, 3)
      assert.ok(Array.isArray(s.graph.edges))
      assert.equal(typeof s.graph.periodic, 'boolean')
      assert.equal(s.graph.cell.length, 3)
      // 似然诚实：声明 none 时不得伪造 logProb
      if (sampler.manifest.likelihood === 'none') {
        assert.equal(s.logProb, undefined, 'likelihood: none 禁止伪造伪似然')
      } else {
        assert.ok(Number.isFinite(s.logProb), '声明似然则必须可求值')
      }
    }
  })

  test(`[contract:${subject}] §4.5 确定性：同种子同样本，异种子异样本`, async () => {
    const sampler = await createSampler()
    const reference = await createReference()
    const a = await sampler.sample({ reference }, { n: 2, seed: 7 })
    const b = await sampler.sample({ reference }, { n: 2, seed: 7 })
    assert.deepEqual(b.map(s => s.graph.nodes), a.map(s => s.graph.nodes), '同种子必须确定性复现')
    const c = await sampler.sample({ reference }, { n: 2, seed: 8 })
    assert.notDeepEqual(c.map(s => s.graph.nodes), a.map(s => s.graph.nodes), '异种子不得退化为常量映射')
  })

  test(`[contract:${subject}] §4.5 生成失败显式错：缺目标 SAMPLER_UNAVAILABLE，产不出候选 SAMPLE_NOT_FOUND`, async () => {
    const sampler = await createSampler()
    await assert.rejects(
      () => sampler.sample({}, {}),
      err => err.code === 'SAMPLER_UNAVAILABLE',
      '缺目标/超覆盖范围必须显式报错，不得静默为空成功',
    )
    const reference = await createReference()
    await assert.rejects(
      () => sampler.sample({ reference }, { n: 0, seed: 1 }),
      err => err.code === 'SAMPLE_NOT_FOUND',
      '按判据产不出候选必须显式报错',
    )
  })

  test(`[contract:${subject}] §4.5 候选可回算：graph 可直接构造 Material（生成→弛豫→核对闭环入口）`, async () => {
    const sampler = await createSampler()
    const reference = await createReference()
    const [s] = await sampler.sample({ reference }, { n: 1, seed: 3 })
    const material = await Material.create({ modalities: { graph: s.graph } })
    assert.equal(material.nAtoms, s.graph.nodes.length)
  })

  test(`[contract:${subject}] §4.5 可逆性声明可执行：未声明即 encode 拒（INVERTIBILITY_UNDECLARED），声明者透传且确定性`, async () => {
    const sampler = await createSampler()
    const reference = await createReference()
    if (sampler.manifest.invertible !== true) {
      // 未声明可逆：执行原语必须显式拒绝（不静默返回 undefined，不探测私有 encode）
      await assert.rejects(
        () => encodeLatent(sampler, reference.graph),
        err => err.code === 'INVERTIBILITY_UNDECLARED',
        '未声明 invertible 的采样器调用 encode 必须抛 INVERTIBILITY_UNDECLARED',
      )
      return
    }
    // 声明可逆：用参考绑定的实例走执行原语（encode 的位移空间相对参考定义），
    // 交付必须确定性（同一结构两次编码逐坐标一致）
    const bound = await createSampler(reference)
    const [s] = await bound.sample({ reference }, { n: 1, seed: 9 })
    const a = await encodeLatent(bound, s.graph)
    const b = await encodeLatent(bound, s.graph)
    assert.deepEqual(b, a, 'encode 必须确定性（双射是逐点映射，不含随机源）')
  })
}

// ────────────────────────────────────────────────────────────
// 套件 5：derivation（契约 §8.2 首个实证：活性上下文地基）
// 登记即声明推导来源 / 失效沿推导图向下游传递传播 / 冻结只追加修正 /
// 查无显式错 / 惰性重算预算受控。
// ────────────────────────────────────────────────────────────

/**
 * @param {Object}   opts
 * @param {string}   opts.subject        被测登记簿标识（测试名前缀）
 * @param {Function} opts.createRegistry () => DerivationRegistry（可 async）
 */
export function derivationContract({ subject, createRegistry }) {
  test(`[contract:${subject}] §8.2 登记与状态：导出量声明推导来源，初始 valid`, async () => {
    const reg = await createRegistry()
    reg.record({ inputs: ['material:m1'], output: 'result:e1', producer: 'contract-mock' })
    const s = reg.status('result:e1')
    assert.equal(s.status, 'valid')
    assert.equal(s.frozen, false)
    assert.equal(s.producer, 'contract-mock', 'producer 必须保留（谁产出的导出量）')
  })

  test(`[contract:${subject}] §8.2 失效传播：沿推导图向下游传递，重复失效幂等`, async () => {
    const reg = await createRegistry()
    reg.record({ inputs: ['material:m1'], output: 'result:e1', producer: 'contract-mock' })
    reg.record({ inputs: ['result:e1'], output: 'result:e2', producer: 'contract-mock' })
    const r1 = await reg.invalidate('material:m1', 'contract: 结构源撤回')
    assert.deepEqual(r1.invalidated.sort(), ['result:e1', 'result:e2'], '下游全链失效')
    assert.equal(reg.status('result:e1').status, 'invalid')
    assert.equal(reg.status('result:e2').status, 'invalid')
    const r2 = await reg.invalidate('material:m1', 'contract: 重复失效')
    assert.equal(r2.invalidated.length, 0, '已失效不得重复传播（幂等）')
  })

  test(`[contract:${subject}] §8.2 冻结标记：只追加修正记录不改状态，传播越过冻结节点继续`, async () => {
    const reg = await createRegistry()
    reg.record({ inputs: ['material:m1'], output: 'result:e1', producer: 'contract-mock', frozen: true })
    reg.record({ inputs: ['result:e1'], output: 'result:e2', producer: 'contract-mock' })
    const r = await reg.invalidate('material:m1', 'contract: 参数勘误')
    const s1 = reg.status('result:e1')
    assert.equal(s1.status, 'valid', '冻结结果不得置 invalid（§7：不重算）')
    assert.equal(s1.corrections.length, 1, '只追加修正记录')
    assert.deepEqual(r.corrections, ['result:e1'])
    assert.equal(reg.status('result:e2').status, 'invalid', '传播越过冻结节点继续向下游（不吞失效）')
  })

  test(`[contract:${subject}] §8.2 查无显式错：未登记的导出量 DERIVATION_NOT_FOUND`, async () => {
    const reg = await createRegistry()
    assert.throws(
      () => reg.status('result:never-recorded'),
      err => err.code === 'DERIVATION_NOT_FOUND',
      '不得静默返回默认状态',
    )
  })

  test(`[contract:${subject}] §8.2 引擎引用：engine:<id> 是合法推导输入与失效源（热替换即失效）`, async () => {
    const reg = await createRegistry()
    reg.record({
      inputs: ['material:m1', 'job:j1', 'engine:e-old'],
      output: 'result:e1', producer: 'contract-mock',
    })
    assert.equal(reg.status('result:e1').status, 'valid')
    const r = await reg.invalidate('engine:e-old', 'contract: 势函数热替换，比较基准变更')
    assert.deepEqual(r.invalidated, ['result:e1'], '引擎失效必须传播到依赖它的导出量')
    assert.equal(reg.status('result:e1').invalidatedBy.source, 'engine:e-old')
  })

  test(`[contract:${subject}] §8.2 惰性重算：预算受控 + 拓扑序 + append-only`, async () => {
    const reg = await createRegistry()
    reg.record({ inputs: ['material:m1'], output: 'result:e1', producer: 'contract-mock' })
    reg.record({ inputs: ['result:e1'], output: 'result:e2', producer: 'contract-mock' })
    await reg.invalidate('material:m1', 'contract: 重算前失效')
    await assert.rejects(
      () => reg.recompute({ recompute: async () => {}, budget: 1 }),
      err => err.code === 'BUDGET_EXCEEDED',
      '超预算显式报错，不静默部分执行',
    )
    const order = []
    const { recomputed } = await reg.recompute({
      recompute: async d => order.push(d.output),
      budget: 2,
    })
    assert.deepEqual(recomputed.sort(), ['result:e1', 'result:e2'])
    assert.deepEqual(order, ['result:e1', 'result:e2'], '依赖在前：先重算输入再重算下游')
    assert.equal(reg.status('result:e1').status, 'valid')
    assert.ok(reg.status('result:e1').recomputedAt, '重算时间戳追加（历史可查）')
  })
}
