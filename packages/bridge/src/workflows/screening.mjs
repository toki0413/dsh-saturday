// 批量掺杂筛选工作流 —— 第一个"像产品"的能力
// 流程：基体 + N 个掺杂变体 → 逐个弛豫 → 按 energyPerAtom 排序 → 每个变体落 Trajectory 事件。
//
// 物理诚实性说明：跨成分直接比较 energyPerAtom 并不严格（严格做法是相对凸包的形成焓），
// 这里排序值仅用于演示工作流编排与溯源能力；EMT 弛豫本身是真实物理。

/**
 * @param {Object}   opts
 * @param {Material} opts.material   基体材料
 * @param {string[]} opts.dopants    掺杂元素列表（各取代位点 0；fcc 原胞位点等价）
 * @param {PotentialRegistry} opts.potential
 * @param {number}  [opts.topK]      返回前 K 个结果，默认全部
 * @param {string}  [opts.engine]    引擎选择，默认 'auto'
 * @param {Function}[opts.emit]      事件发射器 (type, event) => Promise
 */
export async function screenDopants({ material, dopants, potential, topK, engine, emit }) {
  const variants = [
    { kind: 'pristine', dopant: null, material },
    ...dopants.map(d => ({ kind: 'doped', dopant: d, material: material.substitute(0, d) })),
  ]

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
        formula: v.material.formula,
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
        label, kind: v.kind, dopant: v.dopant, formula: v.material.formula,
        status: 'failed', error: err.message,
      })
    }
  }

  const ranked = results
    .filter(r => r.status === 'ok')
    .sort((a, b) => a.energyPerAtom - b.energyPerAtom)

  return {
    base: material.formula,
    dopants,
    provider: provider.name,
    ranked: topK ? ranked.slice(0, topK) : ranked,
    failed: results.filter(r => r.status === 'failed'),
    note: 'ASE EMT 能量零点为各元素平衡 fcc 晶体，故 energyPerAtom 近似形成焓排序' +
          '（Cu3Pt/Cu3Au 负值=有序化倾向，Cu-Ni/Cu-Ag 正值=相分离倾向，与实验冶金学一致）；' +
          '严格筛选需相对凸包的形成焓',
  }
}
