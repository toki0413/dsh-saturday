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
} from '@saturday/core'

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
 * @param {Object}  [opts.references] 元素参考态每原子能量（如 {Cu: -0.001}），注入则算严格形成焓+凸包
 * @param {string}  [opts.thermoUnavailable] 参考态不可得的原因（诚实记录，不静默降级）
 */
export async function screenDopants({ material, dopants, potential, topK, engine, emit, derivation, batchId, references, thermoUnavailable }) {
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
        label, kind: v.kind, dopant: v.dopant, formula: v.material.formula,
        status: 'failed', error: err.message,
      })
    }
  }

  const ranked = results
    .filter(r => r.status === 'ok')
    .sort((a, b) => a.energyPerAtom - b.energyPerAtom)

  // 热力学第一档：参考态显式注入 → 严格形成焓 + 凸包判据。
  // 元素数 ≤ 2（单掺杂二元系）：凸包退化为两端点 0-0 弦，
  // energyAboveHull = max(0, ΔH_f)。
  // 元素数 ≥ 3（多掺杂/三元及以上）：升为多组分凸包——每个元素参考态是成分空间
  // 端点（形成焓按定义 = 0，是定义事实而非外推），与全部候选在统一 d 维空间构包；
  // 端点全零时包络即 z=0 超平面，判据与二元弦数值一致（core 对账 1e-12）。
  // 缺参考态诚实降级：保留"近似"声明，不伪造严格量。
  let thermo
  if (references) {
    for (const r of ranked) {
      r.formationEnthalpy = formationEnthalpy({
        energy: r.energy, composition: r.composition, references,
      })
    }
    const elements = Object.keys(references)
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
        references,
        note: `多组分凸包判据（${elements.length} 元素，d=${hull.d} 单形下包络 + 重心插值）；` +
              '端点 = 各元素参考态（形成焓零点经本引擎显式弛豫计算）',
      }
    } else {
      for (const r of ranked) {
        if (r.kind === 'pristine') {
          r.energyAboveHull = 0
        } else {
          const total = Object.values(r.composition).reduce((a, b) => a + b, 0)
          const point = { x: r.composition[r.dopant] / total, y: r.formationEnthalpy }
          const hullResult = convexHull([{ x: 0, y: 0 }, point, { x: 1, y: 0 }])
          r.energyAboveHull = energyAboveHull(point, hullResult)
        }
      }
      thermo = {
        level: provider.name,
        mode: 'binary',
        references,
        note: '形成焓能量零点 = 各元素参考态经本引擎显式弛豫计算；' +
              'energyAboveHull 为形成焓空间凸包判据（单内点时退化为 0-0 弦）',
      }
    }
  } else if (thermoUnavailable) {
    thermo = { level: 'unavailable', reason: thermoUnavailable }
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
    ranked: topK ? ranked.slice(0, topK) : ranked,
    failed: results.filter(r => r.status === 'failed'),
    ...(derivationRecord ? { derivation: derivationRecord } : {}),
    ...(thermo ? { thermo } : {}),
    note: references
      ? '严格形成焓排序（formationEnthalpy，能量零点显式计算）；' +
        'energyAboveHull=0 为当前候选集内的热力学稳定相候选'
      : 'ASE EMT 能量零点为各元素平衡 fcc 晶体，故 energyPerAtom 近似形成焓排序' +
        '（Cu3Pt/Cu3Au 负值=有序化倾向，Cu-Ni/Cu-Ag 正值=相分离倾向，与实验冶金学一致）；' +
        '严格筛选需相对凸包的形成焓',
  }
}
