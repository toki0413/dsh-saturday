// plugin-ergodic 纯函数层 —— 遍历对账统计（契约 §4.5 oracle 条款）
//
// 语义：给定同一能量函数下的两组能量观测——采样器候选的系综侧单点能量、
// MD 的时间平均侧轨迹能量——比较两侧均值并给出带容差的判定。
// 诚实边界（写入 note，消费方必须连同呈现）：
//  - 对账只对"声称按 ρ ∝ exp(−βU) 采样"的采样器构成强约束；
//    likelihood:'none' 的采样器（如微扰采样）得到的判定是**信息性**的；
//  - 判定强度三档（升档实证）：none → 信息性；exact/approximate 且候选附 logProb
//    → Boltzmann 直接检验——提议似然可求时做重要性重加权（log w = −βU − log q），
//    重加权均值对 MD 时间平均才是对 Boltzmann 声明的实质检验；
//    声明非 none 但候选缺 logProb → 声明与交付不一致，降级信息性并明说；
//  - 重加权受提议/目标重叠度限制：ESS 占比低时方差大，须连同 essFraction 呈现；
//  - 有限样本的均值带标准误，判定用 |Δ均值| ≤ tolerance 的朴素判据，
//    不夸大统计功效。

// 编排层需 Material（候选 graph → 可回算对象）
import { Material } from '@saturday/core'

/** 玻尔兹曼常数（eV/K） */
export const KB_EV_PER_K = 8.617333262145e-5

export function ergodicError(code, message) {
  const e = new Error(`${message} (${code})`)
  e.code = code
  return e
}

function finiteSeries(name, xs) {
  if (!Array.isArray(xs) || xs.length === 0) {
    throw ergodicError('SAMPLER_UNAVAILABLE', `${name} energy series is empty or missing`)
  }
  for (const x of xs) {
    if (!Number.isFinite(x)) {
      throw ergodicError('SAMPLER_UNAVAILABLE', `${name} energy series contains non-finite value: ${x}`)
    }
  }
  return xs
}

function stats(xs) {
  const n = xs.length
  const mean = xs.reduce((s, x) => s + x, 0) / n
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(n - 1, 1)
  return { n, mean, sem: Math.sqrt(variance / n) }
}

/**
 * 重要性重加权（升档的核心机制）：提议似然 q 可求时，把候选系综重加权到
 * 目标 Boltzmann 分布 ρ ∝ exp(−βU)：log w_i = −β·U_i − log q(x_i)，
 * log-sum-exp 归一。返回权重、重加权均值与 ESS 占比（重叠度诊断，诚实呈现）。
 * @param {Object}   opts
 * @param {number[]} opts.logProbs     逐候选提议对数似然（有限）
 * @param {number[]} opts.energies     逐候选同一能量函数下的单点能量（eV）
 * @param {number}   opts.temperatureK 目标温度（K，正有限）
 */
export function reweightToBoltzmann({ logProbs, energies, temperatureK }) {
  if (!Array.isArray(logProbs) || !Array.isArray(energies) || logProbs.length !== energies.length || logProbs.length === 0) {
    throw ergodicError('SAMPLER_UNAVAILABLE', 'logProbs and energies must be non-empty arrays of equal length')
  }
  for (const lp of logProbs) {
    if (!Number.isFinite(lp)) {
      throw ergodicError('SAMPLER_UNAVAILABLE', `logProb must be finite; got ${lp}`)
    }
  }
  if (!Number.isFinite(temperatureK) || temperatureK <= 0) {
    throw ergodicError('SAMPLER_UNAVAILABLE', `temperatureK must be a positive finite number; got ${temperatureK}`)
  }
  const beta = 1 / (KB_EV_PER_K * temperatureK)
  const logW = energies.map((u, i) => -beta * u - logProbs[i])
  const maxLogW = Math.max(...logW)
  const ws = logW.map(l => Math.exp(l - maxLogW))
  const sum = ws.reduce((a, b) => a + b, 0)
  const weights = ws.map(w => w / sum)
  const essFraction = 1 / (weights.length * weights.reduce((a, w) => a + w * w, 0))
  const reweightedMean = weights.reduce((a, w, i) => a + w * energies[i], 0)
  return { weights, essFraction, reweightedMean }
}

/**
 * 系综侧 vs 时间平均侧的对账判定（纯统计，不触碰引擎与采样器）。
 * @param {Object}   opts
 * @param {number[]} opts.ensembleEnergies 采样候选在同一能量函数下的单点能量
 * @param {number[]} opts.mdEnergies       MD 轨迹逐采样步势能
 * @param {number}  [opts.tolerance]       均值差容差（eV，默认 0.05）
 */
export function compareEnsembleToMD({ ensembleEnergies, mdEnergies, tolerance = 0.05 } = {}) {
  const es = finiteSeries('ensemble', ensembleEnergies)
  const ms = finiteSeries('md', mdEnergies)
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw ergodicError('SAMPLER_UNAVAILABLE', `tolerance must be a non-negative finite number; got ${tolerance}`)
  }
  const ensemble = stats(es)
  const md = stats(ms)
  const discrepancy = Math.abs(ensemble.mean - md.mean)
  return {
    ensemble,
    md,
    discrepancy,
    tolerance,
    reconciled: discrepancy <= tolerance,
  }
}

/**
 * 完整对账报告：把统计判定与采样器的似然声明合并成诚实结论（三档分级）。
 *  - likelihood 'none' → informational（原始均值对比，信息性）；
 *  - exact/approximate 且候选附 logProb → boltzmann-check：重要性重加权均值对
 *    MD 时间平均（重加权才是对 Boltzmann 声明的实质检验）；
 *  - 声明非 none 但候选缺 logProb → 声明与交付不一致，降级信息性并明说。
 * @param {Object} opts
 * @param {Object}   opts.stats        compareEnsembleToMD 的输出
 * @param {string}   opts.samplerName  采样器名（谱系）
 * @param {string}   opts.likelihood   采样器 manifest.likelihood（'exact'|'approximate'|'none'）
 * @param {string}   opts.energyModel  能量函数（引擎名）
 * @param {number}   opts.temperatureK MD 温度（K）
 * @param {Object}  [opts.reweighted]  reweightToBoltzmann 输出（无则原始均值判定）
 */
export function ergodicVerdict({ stats, samplerName, likelihood, energyModel, temperatureK, reweighted }) {
  let claim, note, reconciled = stats.reconciled
  if (reweighted) {
    claim = 'boltzmann-check'
    reconciled = Math.abs(reweighted.reweightedMean - stats.md.mean) <= stats.tolerance
    note = `采样器 ${samplerName} 声明似然可求（${likelihood}）且候选附提议似然：` +
      `对账用重要性重加权（log w = −βU − log q）把候选系综重加权到 ${energyModel} 在 ` +
      `${temperatureK} K 的 Boltzmann 分布，重加权均值对 MD 时间平均构成对采样声明的直接检验；` +
      `ESS 占比 ${reweighted.essFraction.toFixed(3)}（低则重加权受提议/目标重叠度限制，方差增大，须连同呈现）；` +
      '未通过即声明失实，必须修正采样器或撤回声明'
  } else if (likelihood !== 'none') {
    claim = 'informational'
    note = `采样器 ${samplerName} 声明似然可求（${likelihood}）但候选未附 logProb——声明与交付不一致，` +
      '本对账降级为信息性（无法重加权）；请修正采样器交付或撤回似然声明'
  } else {
    claim = 'informational'
    note = `采样器 ${samplerName} 声明 likelihood: none，不声称按 ρ ∝ exp(−βU) 采样；` +
      `本对账仅量化其诱导测度与 ${energyModel} 在 ${temperatureK} K 下 MD 不变分布的距离（信息性），` +
      '不构成合规证明也不构成否决'
  }
  return {
    sampler: samplerName,
    energyModel,
    temperatureK,
    claim,
    ...stats,
    reconciled,
    ...(reweighted ? { reweighted } : {}),
    note,
  }
}

/**
 * 遍历对账编排（§4.5 oracle 条款 + §4.3 工作流规则）：
 * 采样候选 → 能量函数逐点单点（系综侧）；参考结构 → 同能量函数恒温 MD（时间平均侧）；
 * 两侧均值在容差内对账。引擎是唯一 oracle，对账工具在工作流层不进采样器本体。
 *
 * @param {Object}   opts
 * @param {Material} opts.reference        参考结构（MD 起点）
 * @param {Array}    opts.candidates       采样器输出 [{ graph, source }]
 * @param {Object}   opts.samplerManifest  采样器 manifest（取 likelihood 定判定强度）
 * @param {string}   opts.samplerName      采样器名（谱系）
 * @param {PotentialRegistry} opts.potential
 * @param {string}  [opts.engine]          能量函数（引擎名），默认 'auto'
 * @param {Object}  [opts.mdParams]        { temperatureK, steps, dtFs, sampleEvery, seed }
 * @param {number}  [opts.tolerance]       均值差容差（eV）
 * @param {Function}[opts.emit]             事件发射器 (type, event) => Promise
 */
export async function checkErgodic({
  reference, candidates, samplerManifest, samplerName, potential,
  engine, mdParams = {}, tolerance = 0.05, emit,
}) {
  const temperatureK = mdParams.temperatureK ?? 300

  // 能量函数由引擎提供：必须同时支持 calculate（系综侧）与 md（时间平均侧）
  const calcProvider = potential.resolveProvider(
    { engine },
    { type: 'calculate', nAtoms: reference.nAtoms, profile: 'validation' },
  )
  const mdProvider = potential.resolveProvider(
    { engine },
    { type: 'md', nAtoms: reference.nAtoms, profile: 'validation' },
  )

  // 系综侧：候选逐个单点（候选不自证，能量全部来自能量函数）；似然声明非 none 时收集提议似然供重加权
  const likelihood = samplerManifest?.likelihood ?? 'none'
  const ensembleEnergies = []
  const sources = []
  const logProbs = []
  for (const [i, c] of candidates.entries()) {
    const material = await Material.create({
      modalities: { graph: c.graph, formula: reference.formula },
      lineage: [{
        operation: 'sampled-candidate',
        detail: { source: c.source, referenceId: reference.id, index: i },
        timestamp: Date.now(),
      }],
    })
    const r = await calcProvider.calculate(material, {})
    ensembleEnergies.push(r.energy)
    sources.push(c.source)
    if (likelihood !== 'none') logProbs.push(c.logProb)
  }

  // 时间平均侧：同一能量函数、同一参考结构起点的恒温 MD（种子确定性）
  const mdResult = await mdProvider.md(reference, {
    temperature_K: temperatureK,
    steps: mdParams.steps ?? 200,
    dt_fs: mdParams.dtFs ?? 1,
    sample_every: mdParams.sampleEvery ?? 5,
    seed: mdParams.seed,
  })

  const stats = compareEnsembleToMD({ ensembleEnergies, mdEnergies: mdResult.energies, tolerance })
  // 升档机制：提议似然齐备才重加权；缺失由 ergodicVerdict 降级并明说不一致（不吞错不假死）
  const reweighted = likelihood !== 'none' && logProbs.every(Number.isFinite)
    ? reweightToBoltzmann({ logProbs, energies: ensembleEnergies, temperatureK })
    : null
  const verdict = ergodicVerdict({
    stats,
    samplerName,
    likelihood,
    energyModel: mdProvider.name,
    temperatureK,
    ...(reweighted ? { reweighted } : {}),
  })

  // 对账结果也是一条计算事件 → Trajectory（薄载荷：引用 + 标量判定）
  await emit?.('saturday/simulation/converged', {
    type: 'saturday/simulation/converged',
    payload: {
      jobId: mdResult.jobId,
      material: { id: reference.id, formula: reference.formula },
      result: {
        reconciled: verdict.reconciled,
        discrepancy: verdict.discrepancy,
        tolerance: verdict.tolerance,
        claim: verdict.claim,
        ...(verdict.reweighted ? { essFraction: verdict.reweighted.essFraction } : {}),
      },
      engine: mdProvider.name,
      workflow: 'ergodic',
    },
  })

  return {
    reference: reference.formula,
    ...verdict,
    ensemble: { ...verdict.ensemble, sources },
    md: { ...verdict.md, jobId: mdResult.jobId, nSteps: mdResult.n_steps, wallSeconds: mdResult.wall_seconds },
  }
}
