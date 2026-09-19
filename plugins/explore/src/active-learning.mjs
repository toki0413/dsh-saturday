// plugin-explore 主动学习闭环（basin-hopping）——契约 §4.3 工作流 + §4.5 oracle 条款的迭代版。
//
// 语义：把 explore 的"单轮 采样→回算"升级成"多轮 采样→回算→择优更新中心"的随机爬山。
//   每轮从"当前最优候选结构"（不是弛豫后几何——provider.relax 不保证回传弛豫位形，
//   故对最优候选的输入结构再微扰，引擎回算把它拉回其盆地）用 sampler 产候选 →
//   逐候选引擎 relax 回算 → 能量更低则更新全局最优与中心。贪心接受（无代理模型，
//   引擎是唯一 oracle，§4.5）；候选是采样分布点非唯一解，全程 'sampled-candidate'
//   谱系（含 round/method 溯源）+ 逐条 converged 事件落 Trajectory。
//
// 诚实边界（随交付 note 呈现）：这是随机 basin-hopping，不是贝叶斯优化——无 GP 代理、
//   不承诺"最少回算次数";能量为引擎回算，收敛轨迹是"当前最优单调不升"（贪心接受的下界
//   保证），非全局最优声明。缺 sampler/potential 服务由调用层显式报错，不静默降级。
// 分层纪律同 explore：纯函数不碰 cordis；sampler/potential 由调用方注入。

import { Material } from '@toki0413/core'

function alError(code, msg) { const e = new Error(`${msg} (${code})`); e.code = code; return e }

/**
 * @param {Object} opts
 * @param {Material} opts.reference           种子结构
 * @param {Object}   opts.sampler             提供 sample({reference},{n,seed,sigma}) → [{graph, source}]
 * @param {PotentialRegistry} opts.potential
 * @param {string}   [opts.engine='auto']
 * @param {number}   [opts.rounds=3]
 * @param {number}   [opts.candidatesPerRound=4]
 * @param {number}   [opts.sigma=0.05]
 * @param {number}   [opts.seed=1]            确定性：第 r 轮用 seed+r，复现同序列
 * @param {Function} [opts.emit]
 */
export async function runActiveLearning({
  reference, sampler, potential, engine,
  rounds = 3, candidatesPerRound = 4, sigma = 0.05, seed = 1, emit,
} = {}) {
  if (!reference || typeof reference !== 'object') throw alError('AL_BAD_INPUT', 'runActiveLearning requires a seed reference Material')
  if (!sampler || typeof sampler.sample !== 'function') throw alError('AL_SAMPLER_MISSING', 'runActiveLearning requires a sampler with .sample() (§4.5)')
  if (!potential || typeof potential.resolveProvider !== 'function') throw alError('AL_POTENTIAL_MISSING', 'runActiveLearning requires a PotentialRegistry (potential service)')
  if (!Number.isInteger(rounds) || rounds < 1) throw alError('AL_BAD_ROUNDS', `rounds must be a positive integer; got ${rounds}`)
  if (!Number.isInteger(candidatesPerRound) || candidatesPerRound < 1) throw alError('AL_BAD_CANDIDATES', `candidatesPerRound must be a positive integer; got ${candidatesPerRound}`)

  const provider = potential.resolveProvider(
    { engine }, { type: 'relax', nAtoms: reference.nAtoms, profile: 'validation' },
  )

  async function relax(material, source, round, index) {
    const r = await provider.relax(material, {})
    const energyPerAtom = r.energy / material.nAtoms
    await emit?.('saturday/simulation/converged', {
      type: 'saturday/simulation/converged',
      payload: {
        jobId: r.jobId, material: { id: material.id, formula: material.formula },
        result: { energy: r.energy, energyPerAtom },
        engine: r.calculator ?? r.engine ?? provider.name, source, workflow: 'active-learning', round,
      },
    })
    return { material, source, round, index, energy: r.energy, energyPerAtom, converged: r.converged ?? true, calculator: r.calculator ?? r.engine ?? provider.name }
  }

  // 种子回算作基线（中心与全局最优的初值）
  let best = await relax(reference, 'seed', 0, null)
  let center = reference
  let evaluations = 1
  const history = [{ round: 0, bestEnergyPerAtom: best.energyPerAtom, improved: true, evaluations }]

  for (let round = 1; round <= rounds; round++) {
    const candidates = await sampler.sample(
      { reference: center }, { n: candidatesPerRound, seed: seed + round, sigma },
    )
    if (!Array.isArray(candidates) || candidates.length === 0) continue
    let roundBest = null
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]
      const material = await Material.create({
        modalities: { graph: c.graph, formula: reference.formula },
        lineage: [{
          operation: 'sampled-candidate',
          detail: { source: c.source, referenceId: center.id, index: i, round, method: 'active-learning' },
          timestamp: Date.now(),
        }],
      })
      const ev = await relax(material, c.source, round, i)
      evaluations++
      if (!roundBest || ev.energyPerAtom < roundBest.energyPerAtom) roundBest = ev
    }
    const improved = !!roundBest && roundBest.energyPerAtom < best.energyPerAtom
    if (improved) { best = roundBest; center = roundBest.material }
    history.push({
      round, bestEnergyPerAtom: best.energyPerAtom, improved,
      roundBestEnergyPerAtom: roundBest ? roundBest.energyPerAtom : null, evaluations,
    })
  }

  return {
    reference: reference.formula,
    provider: provider.name,
    rounds, candidatesPerRound, seed, sigma,
    evaluations,
    best: {
      source: best.source, round: best.round,
      energyPerAtom: best.energyPerAtom, energy: best.energy,
      converged: best.converged, materialId: best.material?.id ?? null,
    },
    history,
    note: 'basin-hopping 主动学习：每轮从当前最优结构微扰产候选→引擎 relax 回算→更低则更新中心与最优。' +
      '引擎是唯一 oracle（无 GP 代理，非贝叶斯优化）；候选是采样分布点非唯一解；history 的最优能量按构造单调不升（贪心接受下界），不声明全局最优。',
  }
}
