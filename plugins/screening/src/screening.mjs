// 批量掺杂筛选工作流 —— 第一个"像产品"的能力
// 流程：基体 + N 个掺杂变体 → 逐个弛豫 → 按 energyPerAtom 排序 → 每个变体落 Trajectory 事件。
//
// 物理诚实性说明：跨成分直接比较 energyPerAtom 并不严格（严格做法是相对凸包的形成焓），
// 这里排序值仅用于演示工作流编排与溯源能力；EMT 弛豫本身是真实物理。
//
// 活性上下文（§8.2）：排序 = f(基体, 引擎)。注入 derivation 时登记两层推导：
// 候选能量 result:energy-<jobId> ← [材料, 任务, 引擎]；排序 result:screen-<batchId> ←
// [基体, 各候选能量]。引擎是推导输入，势函数热替换即失效源（三级传播链）。
//
// 热力学第一档（§9 欠账）：注入 references（元素参考态每原子能量，显式计算所得）时，
// 排序从"近似形成焓"升级为严格形成焓 + 形成焓空间凸包判据；缺参考态诚实降级。

import { randomUUID } from 'node:crypto'
import {
  formationEnthalpy, convexHull, energyAboveHull,
  multiConvexHull, energyAboveHullMulti,
  compositionFromNumbers,
  Material,
  fingerprintEqual, assertSameUnits,
} from '@saturday/core'
import { combineEvidence, essFraction, evidenceError } from './evidence.mjs'
import { builtinEvidenceSources, resolveEvidenceSources } from './evidence-sources.mjs'

const KB_EV_PER_K = 8.617333262145e-5

/**
 * @param {Object}   opts
 * @param {Material} opts.material   基体材料
 * @param {string[]} opts.dopants    掺杂元素列表（各取代位点 0；fcc 原胞位点等价）
 * @param {PotentialRegistry} opts.potential
 * @param {number}  [opts.topK]      返回前 K 个结果，默认全部
 * @param {string}  [opts.engine]    引擎选择，默认 'auto'
 * @param {Function}[opts.emit]      事件发射器 (type, event) => Promise
 * @param {DerivationRegistry} [opts.derivation] 推导登记簿（注入则登记活性推导）
 * @param {string}  [opts.batchId]   筛选批次号（缺省自动生成）
 * @param {Object}  [opts.references] 元素参考态每原子能量（如 {Cu: -0.001}），注入则算严格形成焓+凸包；
 *        可选升级形态 {Cu: { energyPerAtom, fingerprint?, energyUnit? }}——声明了来源指纹/单位时，
 *        必须与候选引擎的归一声明一致（M3 门禁），不一致显式拒绝（不自动换算、不静默混源）
 * @param {string}  [opts.thermoUnavailable] 参考态不可得的原因（诚实记录，不静默降级）
 * @param {number}  [opts.maxDopedSites] 每掺杂的最大取代位数（浓度扫描：k=1..max 各一个变体，默认 1）
 * @param {Array<{elements: string[], sites?: number[]}>} [opts.codopants]
 *        共掺变体：多个不同元素占据不同位点（混合共掺；落在稳定相连线上的物理内点）
 * @param {{candidates: Array<{material?: Material, graph?: Object, source?: string, logProb?: number}>, samplerName?: string, likelihood?: string}} [opts.sampled]
 *        采样候选（来自任意采样器，如 OU）：逐候选单点回算后与似然证据联合排序；
 *        候选可给 Material 或 §4.5 SampledStructure 形态（{graph, source}，谱系登记采样来源）；
 *        不弛豫（弛豫会抹掉待加权的涨落信息），不入凸包（成分点与基体重合）
 * @param {number} [opts.temperatureK] 联合排序的目标温度（K；提供 sampled 或 evidenceSources 时必填——焓证据 −βE 无温度即无标度）
 * @param {string[]} [opts.evidenceSources] 枚举候选联合排序的额外证据源（显式启用，默认只按能量排）；
 *        内置 ['hull']：凸包距离证据（需 references 已构包）——稳定性证据随候选呈现，
 *        检验组合律的可扩展性（证据源可增，独立性声明随源数变化如实更新）
 * @param {Object<string, Object>} [opts.evidenceSourceRegistry] 证据源注册表（默认内置）；
 *        第三方可注入自定义描述符（{ name, requires, logWeights, independenceNote }），
 *        新证据源接入不改筛选代码（注册表化实证）
 */
export async function screenDopants({ material, dopants, potential, topK, engine, emit, derivation, batchId, references, thermoUnavailable, maxDopedSites, codopants, sampled, temperatureK, evidenceSources, evidenceSourceRegistry }) {
  const maxSites = maxDopedSites ?? 1
  if (!Number.isInteger(maxSites) || maxSites < 1) {
    throw new Error(`maxDopedSites 必须是正整数（收到 ${maxSites}）：浓度变体数不得静默纠正`)
  }
  if (maxSites > material.nAtoms - 1) {
    throw new Error(
      `maxDopedSites ${maxSites} 超出基体可取代位点数 ${material.nAtoms - 1}` +
      '（全取代 = 纯掺杂端点，属参考态而非候选）',
    )
  }
  // 变体集：基体 + 每掺杂的浓度系列（取代位点 0..k-1，k=1..maxSites）+ 共掺变体（可选）
  const variants = [{ kind: 'pristine', dopant: null, sites: 0, material }]
  for (const d of dopants) {
    for (let k = 1; k <= maxSites; k++) {
      let m = material
      for (let s = 0; s < k; s++) m = m.substitute(s, d)
      variants.push({ kind: 'doped', dopant: d, sites: k, material: m })
    }
  }
  for (const cd of codopants ?? []) {
    if (!Array.isArray(cd.elements) || cd.elements.length < 2) {
      throw new Error('codopants 每项须含 ≥2 个不同元素（单元素请用 dopants）')
    }
    if (new Set(cd.elements).size !== cd.elements.length) {
      throw new Error(`codopants 元素重复（${cd.elements.join(',')}）：同一元素多次取代无物理意义`)
    }
    const sites = cd.sites ?? cd.elements.map((_, i) => i)
    if (new Set(sites).size !== sites.length || sites.some(s => s < 0 || s >= material.nAtoms)) {
      throw new Error(`codopants 位点非法（${sites.join(',')}）：须互异且在基体位点范围内`)
    }
    let m = material
    cd.elements.forEach((el, i) => { m = m.substitute(sites[i], el) })
    variants.push({ kind: 'codoped', dopant: cd.elements.join('+'), sites: cd.elements.length, material: m })
  }

  const provider = potential.resolveProvider(
    { engine },
    { type: 'relax', nAtoms: material.nAtoms, profile: 'screening' },
  )

  const results = []
  for (const v of variants) {
    const label = v.kind === 'pristine'
      ? `${material.formula} (pristine)`
      : `${material.formula} → ${v.material.formula}`
    try {
      const r = await provider.relax(v.material, {})
      const entry = {
        label,
        kind: v.kind,
        dopant: v.dopant,
        sites: v.sites ?? (v.kind === 'doped' ? 1 : 0),
        formula: v.material.formula,
        materialId: v.material.id,
        composition: compositionFromNumbers(v.material.graph.nodes.map(n => n.number)),
        status: 'ok',
        energy: r.energy,
        energyPerAtom: r.energy / v.material.nAtoms,
        converged: r.converged ?? true,
        nSteps: r.n_steps,
        wallSeconds: r.wall_seconds,
        calculator: r.calculator ?? r.engine,
        jobId: r.jobId,
      }
      results.push(entry)
      // 每个变体一个事件 → Trajectory（批量任务的逐条溯源）
      await emit?.('saturday/simulation/converged', {
        type: 'saturday/simulation/converged',
        payload: {
          jobId: r.jobId,
          material: { id: v.material.id, formula: v.material.formula },
          result: { energy: r.energy, energyPerAtom: entry.energyPerAtom, nSteps: r.n_steps },
          engine: r.engine,
          calculator: entry.calculator,
          wallSeconds: r.wall_seconds,
          workflow: 'screen',
        },
      })
    } catch (err) {
      results.push({
        label, kind: v.kind, dopant: v.dopant, sites: v.sites ?? 0,
        formula: v.material.formula,
        status: 'failed', error: err.message,
      })
    }
  }

  const ranked = results
    .filter(r => r.status === 'ok')
    .sort((a, b) => a.energyPerAtom - b.energyPerAtom)

  // 热力学第一档：参考态显式注入 → 严格形成焓 + 凸包判据。
  // 元素数 ≤ 2（单掺杂二元系）：每个掺杂系用两端点 + 该掺杂的全部浓度候选构包；
  // 单内点时退化为 0-0 弦（energyAboveHull = max(0, ΔH_f)），多浓度内点时包络非退化。
  // 元素数 ≥ 3（多掺杂/三元及以上）：升为多组分凸包——每个元素参考态是成分空间
  // 端点（形成焓按定义 = 0，是定义事实而非外推），与全部候选在统一 d 维空间构包；
  // 端点全零时包络即 z=0 超平面，判据与二元弦数值一致（core 对账 1e-12）。
  // 缺参考态诚实降级：保留"近似"声明，不伪造严格量。
  let thermo
  if (references) {
    // M3（能量组合门禁）：参考态能量与候选能量进同一凸包/形成焓前必须同源可比。
    // 纯数值形态 = 调用方声明"与候选引擎同源"（工具层路径即由本引擎 referenceEnergy 产出，
    // 既有行为不变）；升级形态可携带来源指纹与能量单位——声明了就对账：
    // 指纹不同源或单位不一致都显式拒绝，绝不自动换算/静默混源（异构引擎生态第一风险源）。
    // 未声明者诚实降级（声明 ≠ 强制：无声明的旧路径不被新门禁追溯拦截）。
    const refValues = {}
    let fingerprintDeclared = true
    for (const [el, v] of Object.entries(references)) {
      if (typeof v === 'number') {
        refValues[el] = v
        fingerprintDeclared = false
        continue
      }
      if (!v || !Number.isFinite(v.energyPerAtom)) {
        throw evidenceError('EVIDENCE_INVALID_INPUT',
          `references.${el} 升级形态必须携带有限能量 energyPerAtom（收到 ${JSON.stringify(v)}）`)
      }
      refValues[el] = v.energyPerAtom
      if (v.fingerprint) {
        const cmp = fingerprintEqual(provider._fingerprint, v.fingerprint)
        if (!cmp.same) {
          throw evidenceError('EVIDENCE_INVALID_INPUT',
            `references.${el} 参考态能量与候选引擎不同源：${cmp.reason}——` +
            '凸包判据要求全部能量同源（跨引擎混入即得"看起来合法但物理无意义"的包络）')
        }
      } else {
        fingerprintDeclared = false
      }
      if (v.energyUnit) assertSameUnits(provider._units?.energy ?? 'eV', v.energyUnit, `references.${el} 参考态能量单位`)
    }
    for (const r of ranked) {
      r.formationEnthalpy = formationEnthalpy({
        energy: r.energy, composition: r.composition, references: refValues,
      })
    }
    const elements = Object.keys(refValues)
    if (elements.length >= 3) {
      // 多组分凸包：端点（每元素纯元素点）+ 候选点（归一成分，能量 = 形成焓）
      const normalize = (composition) => {
        const total = Object.values(composition).reduce((a, b) => a + b, 0)
        return Object.fromEntries(
          Object.entries(composition).map(([el, n]) => [el, n / total]),
        )
      }
      const points = [
        ...elements.map(el => ({ composition: { [el]: 1 }, energy: 0 })),
        ...ranked.map(r => ({ composition: normalize(r.composition), energy: r.formationEnthalpy })),
      ]
      const hull = multiConvexHull(points)
      for (const r of ranked) {
        r.energyAboveHull = energyAboveHullMulti(
          { composition: normalize(r.composition), energy: r.formationEnthalpy }, hull,
        )
      }
      thermo = {
        level: provider.name,
        mode: 'multi-component',
        hullDimension: hull.d,
        references: refValues,
        referenceProvenance: fingerprintDeclared ? 'declared' : 'undeclared',
        note: `多组分凸包判据（${elements.length} 元素，d=${hull.d} 单形下包络 + 重心插值）；` +
              '端点 = 各元素参考态（形成焓零点经本引擎显式弛豫计算）',
      }
    } else {
      // 二元分支：逐掺杂系构包（两端点 + 该掺杂的全部浓度候选），逐候选查询。
      // 单内点退化为 0-0 弦；多浓度内点时包络由最低内点撑起（非退化判据）。
      const toX = (r) => {
        const total = Object.values(r.composition).reduce((a, b) => a + b, 0)
        return r.composition[r.dopant] / total
      }
      for (const r of ranked) {
        if (r.kind === 'pristine') {
          r.energyAboveHull = 0
          continue
        }
        const cands = ranked.filter(x => x.kind === 'doped' && x.dopant === r.dopant)
        const pts = [
          { x: 0, y: 0 },
          ...cands.map(c => ({ x: toX(c), y: c.formationEnthalpy })),
          { x: 1, y: 0 },
        ]
        const hullResult = convexHull(pts)
        r.energyAboveHull = energyAboveHull({ x: toX(r), y: r.formationEnthalpy }, hullResult)
      }
      thermo = {
        level: provider.name,
        mode: 'binary',
        references: refValues,
        referenceProvenance: fingerprintDeclared ? 'declared' : 'undeclared',
        note: '形成焓能量零点 = 各元素参考态经本引擎显式弛豫计算；' +
              'energyAboveHull 为形成焓空间凸包判据（单内点时退化为 0-0 弦）',
      }
    }
  } else if (thermoUnavailable) {
    thermo = { level: 'unavailable', reason: thermoUnavailable }
  }

  // 枚举候选联合排序（可选）：默认只按能量排（既有行为不变）；显式启用证据源时，
  // 对全部回算成功的变体组合多源证据 → jointRanked。凸包距离是逐候选的稳定性证据：
  // energyAboveHull = 0（包上/包内）声明为稳定相候选，包内（负值）无额外区分证据——
  // 用 max(0,·) 掩码（不伪造“越稳越好”的证据）；独立性与退化事实如实声明。
  let joint
  const extraSources = evidenceSources ?? []
  if (extraSources.length > 0) {
    if (!Number.isFinite(temperatureK) || temperatureK <= 0) {
      throw evidenceError('EVIDENCE_INVALID_INPUT',
        'temperatureK is required when evidenceSources are enabled: ' +
        'Boltzmann evidence −βΔH_f has no scale without a declared temperature')
    }
    // 证据源注册表化：筛选层只做通用循环（解析 → 校验输入要求 → 取逐候选 log 权重），
    // 新证据源在 evidence-sources.mjs 注册描述符即可接入，不改筛选代码；
    // 未知源由 resolveEvidenceSources 显式拒绝，输入缺门由各描述符 requires 报错。
    const descriptors = resolveEvidenceSources(extraSources, evidenceSourceRegistry ?? builtinEvidenceSources)
    const betaE = 1 / (KB_EV_PER_K * temperatureK)
    const ctx = { ranked, thermo, betaEVInv: betaE }
    const jointSources = [
      { name: `boltzmann:${provider.name}`, logWeights: ranked.map(r => -betaE * r.formationEnthalpy) },
    ]
    for (const d of descriptors) {
      d.requires(ctx)
      jointSources.push({ name: `${d.name}:${thermo?.mode ?? 'builtin'}`, logWeights: d.logWeights(ctx) })
    }
    const combinedE = combineEvidence({
      sources: jointSources,
      independence: '焓证据 −βΔH_f 来自同一 provider 逐候选单点；'
                    + descriptors.map(d => d.independenceNote).join('；'),
    })
    const jointEntries = ranked.map((r, i) => ({
      label: r.label,
      formula: r.formula,
      materialId: r.materialId,
      energyPerAtom: r.energyPerAtom,
      formationEnthalpy: r.formationEnthalpy,
      energyAboveHull: r.energyAboveHull,
      weight: combinedE.weights[i],
      logJointWeight: combinedE.logJointWeights[i],
      coverage: combinedE.coverage[i],
    }))
    jointEntries.sort((a, b) => b.weight - a.weight)
    joint = {
      temperatureK,
      betaEVInv: betaE,
      entries: jointEntries,
      essFraction: essFraction(combinedE.weights),
      sourceNames: combinedE.sourceNames,
      independence: combinedE.independence,
      note: '枚举候选联合排序：凸包证据对包内点（energyAboveHull<0）按 max(0,·) 掩码——' +
            '“已稳定”不再提供额外区分证据（禁止零填充伪造稳定性梯度）；' +
            'energyAboveHull=0 为当前候选集内的稳定相候选',
    }
  }

  // 多证据源联合排序（Logits 组合律，纯层见 ./evidence.mjs）：
  // 采样候选 = 基体成分的热涨落快照，逐候选单点回算（候选不自证，§4.5）。
  // 能量证据 −βU × 提议似然 q → 重要性权重 log w = −βU − log q（与 ergodic 升档同形）；
  // 独立性声明与逐候选覆盖随交付呈现；缺 logProb 的候选按覆盖子集组合（不零填充）。
  let sampledJoint
  if (sampled) {
    if (!Number.isFinite(temperatureK) || temperatureK <= 0) {
      throw evidenceError('EVIDENCE_INVALID_INPUT',
        'temperatureK is required when sampled candidates are provided: ' +
        'Boltzmann evidence −βE has no scale without a declared temperature')
    }
    if (!Array.isArray(sampled.candidates) || sampled.candidates.length === 0) {
      throw evidenceError('EVIDENCE_INVALID_INPUT', 'sampled.candidates must be a non-empty array')
    }
    if (typeof provider.calculate !== 'function') {
      throw evidenceError('EVIDENCE_INVALID_INPUT',
        `engine ${provider.name} does not provide the calculate primitive: ` +
        'joint ranking requires oracle single-point energies (candidates do not self-attest)')
    }
    const beta = 1 / (KB_EV_PER_K * temperatureK)
    const okEntries = []
    const failedSampled = []
    for (let i = 0; i < sampled.candidates.length; i++) {
      const c = sampled.candidates[i]
      const label = `sampled[${i}]`
      let m = c?.material
      // §4.5 SampledStructure 形态（{graph, source}）：graph 模态构造 + 谱系登记采样来源；
      // 微扰不改组分，化学式沿用基体（与 explore 回算同款构造）
      if (!m?.graph && c?.graph) {
        m = await Material.create({
          modalities: { graph: c.graph, formula: material.formula },
          lineage: [{
            operation: 'sampled-candidate',
            detail: { source: c.source ?? `sampled:${i}`, referenceId: material.id, index: i },
            timestamp: Date.now(),
          }],
        })
      }
      if (!m?.graph) {
        failedSampled.push({ label, status: 'failed', error: 'candidate missing material/graph' })
        continue
      }
      try {
        const calc = await provider.calculate(m, {})
        okEntries.push({
          label,
          kind: 'sampled',
          formula: m.formula,
          materialId: m.id,
          energy: calc.energy,
          energyPerAtom: calc.energy / m.nAtoms,
          logProb: Number.isFinite(c.logProb) ? c.logProb : null,   // 缺失即缺失（掩码语义）
          jobId: calc.jobId,
          calculator: calc.calculator ?? calc.engine,
        })
      } catch (err) {
        failedSampled.push({ label, status: 'failed', error: err.message })
      }
    }
    if (okEntries.length === 0) {
      sampledJoint = {
        samplerName: sampled.samplerName ?? 'undeclared',
        nFailed: failedSampled.length,
        note: '全部单点回算失败：联合排序无数据（不伪造权重）',
        failed: failedSampled,
      }
    } else {
      const combined = combineEvidence({
        sources: [
          { name: `boltzmann:${provider.name}`, logWeights: okEntries.map(e => -beta * e.energy) },
          { name: `proposal:${sampled.samplerName ?? 'undeclared'}`, logWeights: okEntries.map(e => e.logProb) },
        ],
        independence: '能量证据取引擎单点能（玻尔兹曼因子 −βU），似然证据取采样器提议核密度 q；' +
                      '两者条件独立于候选给定坐标：U 是能量面属性，q 是采样协议属性。' +
                      '组合后为重要性权重（重加权到玻尔兹曼目标的修正因子），兼作联合排序判据',
      })
      okEntries.forEach((e, i) => {
        e.weight = combined.weights[i]
        e.logJointWeight = combined.logJointWeights[i]
        e.coverage = combined.coverage[i]
      })
      okEntries.sort((a, b) => b.weight - a.weight)
      sampledJoint = {
        samplerName: sampled.samplerName ?? 'undeclared',
        likelihood: sampled.likelihood ?? 'undeclared',
        temperatureK,
        betaEVInv: beta,
        entries: okEntries,
        essFraction: essFraction(combined.weights),
        sourceNames: combined.sourceNames,
        independence: combined.independence,
        // 温度联动诚实声明（⑳）：采样器若声明了自身温度且与目标温度不一致，
        // 如实呈现（提议核的涨落幅度与玻尔兹曼目标的标度不匹配是消费方该知道的事），
        // 不静默纠正（纠正 = 改变交付的证据语义，超出工作流权限）
        ...(Number.isFinite(sampled.samplerTemperatureK) && sampled.samplerTemperatureK !== temperatureK
          ? { temperatureMismatch: {
              samplerTemperatureK: sampled.samplerTemperatureK,
              targetTemperatureK: temperatureK,
              note: '提议核按采样温度涨落，玻尔兹曼证据按目标温度加权：' +
                    '重要性权重仍正确（修正因子已吸收温差），但两温度语义不同，如实声明',
            } }
          : {}),
        note: '采样候选是基体成分的热涨落快照：不入凸包（成分点与基体重合，判据以枚举候选为准）；' +
              '单点作业经 jobId 溯源；缺 logProb 的候选按覆盖子集组合并如实声明',
        ...(failedSampled.length > 0 ? { failed: failedSampled } : {}),
      }
    }
  }

  // 活性上下文（§8.2）：登记两层推导；引擎入输入，热替换即失效源。
  // 只对成功变体登记；未注入登记簿时行为不变（纯编排层零依赖）。
  let derivationRecord
  if (derivation) {
    const bid = batchId ?? randomUUID()
    const energyRefs = ranked.map(r => {
      const ref = `result:energy-${r.jobId}`
      derivation.record({
        inputs: [`material:${r.materialId}`, `job:${r.jobId}`, `engine:${provider.name}`],
        output: ref,
        producer: 'workflow.screen',
      })
      return ref
    })
    const rankRef = `result:screen-${bid}`
    derivation.record({
      inputs: [`material:${material.id}`, ...energyRefs],
      output: rankRef,
      producer: 'workflow.screen',
    })
    derivationRecord = { batchId: bid, rankRef, energyRefs }
  }

  return {
    base: material.formula,
    dopants,
    provider: provider.name,
    // 能量来源可追溯性随交付呈现（M1/M3 的消费入口：消费方可据此核对跨批次可比性）
    ...(provider._fingerprint ? { providerFingerprint: provider._fingerprint } : {}),
    ...(provider._units ? { providerUnits: provider._units } : {}),
    ranked: topK ? ranked.slice(0, topK) : ranked,
    failed: results.filter(r => r.status === 'failed'),
    ...(derivationRecord ? { derivation: derivationRecord } : {}),
    ...(thermo ? { thermo } : {}),
    ...(joint ? { joint } : {}),
    ...(sampledJoint ? { sampledJoint } : {}),
    note: references
      ? '严格形成焓排序（formationEnthalpy，能量零点显式计算）；' +
        'energyAboveHull=0 为当前候选集内的热力学稳定相候选'
      : 'ASE EMT 能量零点为各元素平衡 fcc 晶体，故 energyPerAtom 近似形成焓排序' +
        '（Cu3Pt/Cu3Au 负值=有序化倾向，Cu-Ni/Cu-Ag 正值=相分离倾向，与实验冶金学一致）；' +
        '严格筛选需相对凸包的形成焓',
  }
}
