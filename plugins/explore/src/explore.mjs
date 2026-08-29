// plugin-explore 纯函数层 —— 采样 → 回算闭环编排（契约 §4.5 oracle 条款 + §4.3 工作流规则）
//
// 语义：候选是参考结构邻域微扰分布的采样点（§4.5 采样语义，非唯一解）。
// "回算"即把每个候选构造成 Material 独立送入引擎弛豫——候选不自证，
// 引擎是唯一 oracle（§4.5：核对失败是工作流级错误，不得静默）。
// 谱系：候选 Material 带 'sampled-candidate' 谱系标记（source / referenceId / index），
// 事件薄载荷携带 source 引用，全程可从 Trajectory 批量溯源。

import { Material } from '@saturday/core'

/**
 * @param {Object}   opts
 * @param {Material} opts.reference   参考结构（回算基线，自身也入 Trajectory）
 * @param {Array}    opts.candidates  sampler 输出 [{ graph, source }]（§4.5 SampledStructure）
 * @param {PotentialRegistry} opts.potential
 * @param {string}  [opts.engine]     引擎选择，默认 'auto'（validation 画像）
 * @param {number}  [opts.topK]       只返回能量最低的前 K 个
 * @param {Function}[opts.emit]       事件发射器 (type, event) => Promise
 */
export async function exploreCandidates({ reference, candidates, potential, engine, topK, emit }) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    const err = new Error('explore requires non-empty candidates from a sampler (§4.5 generative seam)')
    err.code = 'SAMPLE_NOT_FOUND'
    throw err
  }

  // 参考结构同样回算：提供 dE 基线，自身逐条可溯源
  const jobs = [
    ...candidates.map((c, i) => ({ kind: 'candidate', index: i, source: c.source, graph: c.graph })),
    { kind: 'reference', index: null, source: 'reference', graph: null },
  ]

  const provider = potential.resolveProvider(
    { engine },
    { type: 'relax', nAtoms: reference.nAtoms, profile: 'validation' },
  )

  let referenceEnergy = null
  const results = []
  for (const job of jobs) {
    const label = job.kind === 'reference'
      ? `${reference.formula} (reference)`
      : `${reference.formula} candidate #${job.index + 1}`
    const material = job.kind === 'reference'
      ? reference
      // 微扰不改组分：化学式沿用参考结构；graph 模态构造，谱系登记采样来源
      : await Material.create({
          modalities: { graph: job.graph, formula: reference.formula },
          lineage: [{
            operation: 'sampled-candidate',
            detail: { source: job.source, referenceId: reference.id, index: job.index },
            timestamp: Date.now(),
          }],
        })
    try {
      const r = await provider.relax(material, {})
      const energyPerAtom = r.energy / material.nAtoms
      const entry = {
        label,
        kind: job.kind,
        source: job.source,
        formula: material.formula,
        status: 'ok',
        energy: r.energy,
        energyPerAtom,
        converged: r.converged ?? true,
        nSteps: r.n_steps,
        calculator: r.calculator ?? r.engine,
        jobId: r.jobId,
        materialId: material.id,
      }
      results.push(entry)
      if (job.kind === 'reference') referenceEnergy = r.energy
      // 每个变体一条事件 → Trajectory（薄载荷：标量 + 引用，含谱系 source）
      await emit?.('saturday/simulation/converged', {
        type: 'saturday/simulation/converged',
        payload: {
          jobId: r.jobId,
          material: { id: material.id, formula: material.formula },
          result: { energy: r.energy, energyPerAtom, nSteps: r.n_steps },
          engine: r.engine,
          source: job.source,
          workflow: 'explore',
        },
      })
    } catch (err) {
      results.push({ label, kind: job.kind, source: job.source, status: 'failed', error: err.message })
    }
  }

  // 二遍填充相对能量：基线缺失时诚实置 null，不得伪造
  for (const e of results) {
    if (e.status === 'ok') {
      e.dE = referenceEnergy === null ? null : e.energy - referenceEnergy
    }
  }

  const ranked = results
    .filter(r => r.status === 'ok')
    .sort((a, b) => a.energyPerAtom - b.energyPerAtom)

  return {
    reference: reference.formula,
    referenceEnergy,
    provider: provider.name,
    ranked: topK ? ranked.slice(0, topK) : ranked,
    failed: results.filter(r => r.status === 'failed'),
    note: '候选是参考结构邻域微扰分布的采样点（§4.5），能量为引擎回算结果而非采样器自证；' +
          (referenceEnergy === null ? '参考回算失败，dE 基线缺失（已置 null）；' : 'dE 为相对参考结构回算能量；') +
          '同组分内相对比较，不构成稳定性排序（严格判定需相对凸包形成焓）',
  }
}
