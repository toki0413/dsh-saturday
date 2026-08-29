// plugin-ergodic 纯函数层 —— 遍历对账统计（契约 §4.5 oracle 条款）
//
// 语义：给定同一能量函数下的两组能量观测——采样器候选的系综侧单点能量、
// MD 的时间平均侧轨迹能量——比较两侧均值并给出带容差的判定。
// 诚实边界（写入 note，消费方必须连同呈现）：
//  - 对账只对"声称按 ρ ∝ exp(−βU) 采样"的采样器构成强约束；
//    likelihood:'none' 的采样器（如微扰采样）得到的判定是**信息性**的
//    （量化其诱导测度与 MD 不变分布的距离），不构成合规证明也不构成否决；
//  - 有限样本的均值带标准误，判定用 |Δ均值| ≤ tolerance 的朴素判据，
//    不夸大统计功效。

// 编排层需 Material（候选 graph → 可回算对象）
import { Material } from '@saturday/core'

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
 * 完整对账报告：把统计判定与采样器的似然声明合并成诚实结论。
 * @param {Object} opts
 * @param {Object} opts.stats        compareEnsembleToMD 的输出
 * @param {string} opts.samplerName  采样器名（谱系）
 * @param {string} opts.likelihood   采样器 manifest.likelihood（'exact'|'approximate'|'none'）
 * @param {string} opts.energyModel  能量函数（引擎名）
 * @param {number} opts.temperatureK MD 温度（K）
 */
export function ergodicVerdict({ stats, samplerName, likelihood, energyModel, temperatureK }) {
  const claim = likelihood === 'none' ? 'informational' : 'boltzmann-check'
  const note = claim === 'informational'
    ? `采样器 ${samplerName} 声明 likelihood: none，不声称按 ρ ∝ exp(−βU) 采样；` +
      `本对账仅量化其诱导测度与 ${energyModel} 在 ${temperatureK} K 下 MD 不变分布的距离（信息性），` +
      '不构成合规证明也不构成否决'
    : `采样器 ${samplerName} 声明似然可求（${likelihood}），本对账是对"按 ${energyModel} ` +
      `在 ${temperatureK} K 的 Boltzmann 分布采样"声明的直接检验；` +
      '未通过即声明失实，必须修正采样器或撤回声明'
  return {
    sampler: samplerName,
    energyModel,
    temperatureK,
    claim,
    ...stats,
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

  // 系综侧：候选逐个单点（候选不自证，能量全部来自能量函数）
  const ensembleEnergies = []
  const sources = []
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
  const verdict = ergodicVerdict({
    stats,
    samplerName,
    likelihood: samplerManifest?.likelihood ?? 'none',
    energyModel: mdProvider.name,
    temperatureK,
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
