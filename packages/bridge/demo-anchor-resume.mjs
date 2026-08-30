// 跨会话恢复演示（㉗，数据燃料续供的编排层形态）：
//   会话一：真实弛豫（收敛 + 终态交付）→ ⑮ 自动入库 → `sampler.anchor.save`
//          落盘（路径调用方显式声明）→ 会话终结（全部回收，库随会话消失）
//   会话二：全新挂载（空库，不伪造库外数据）→ `sampler.anchor.load` 回填
//          （门禁与导入工具同款）→ 检索 → 混合提案 → 回算 + 联合排序
// 价值闭环：搬运原语（㉓）+ 文件端（㉔）就位后，"落盘由调用方负责"的诚实
// 边界在此由编排层兑现——锚点库跨会话续供，谱系不断。
// 诚实声明：两"会话"是同一进程内两次独立挂载（各自 Context、各自锚点库、
// 各自全部回收），跨会话的唯一通道是磁盘载荷——这正是被实证的边界。
// ㊽ 会话三：判据快照落盘（㊻）后全新挂载 → 快照回填续供——裁决依据跨会话可续供、
// 可复算（快照不进锚点库：证据载荷与结构数据燃料正交，诚实声明同 ㊷）。
// 诚实纪律：无 ASE 环境下数据面诚实报错，本演示如实终止不伪造证据。
// 运行：node demo-anchor-resume.mjs（依赖 Python sidecar 做真实弛豫/单点）

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import plugin from './src/saturday.plugin.mjs'
import screeningPlugin from '@saturday/plugin-screening'
import samplerOuPlugin, { trajectoryTriggerAssessment } from '@saturday/plugin-sampler-ou'

async function mountSession() {
  const ctx = new Context()
  const fiber = await ctx.registry.plugin({ name: 'saturday', apply: (ctx) => plugin.apply(ctx, {}) })
  const screenFiber = await ctx.registry.plugin({ name: 'saturday-screening', apply: (ctx) => screeningPlugin.apply(ctx, {}) })
  const samplerFiber = await ctx.registry.plugin({ name: 'saturday-sampler-ou', apply: (ctx) => samplerOuPlugin.apply(ctx, {}) })
  return {
    fiber, screenFiber, samplerFiber,
    handles: fiber.store.saturday,
    screenRt: screenFiber.store.saturdayScreening.rt,
    samplerRt: samplerFiber.store.saturdaySamplerOu.rt,
    anchorStore: samplerFiber.store.saturdaySamplerOu.anchorStore,
    dispose: async () => { await samplerFiber.dispose(); await screenFiber.dispose(); await fiber.dispose() },
  }
}

const dir = await mkdtemp(join(tmpdir(), 'saturday-demo-resume-'))
const anchorPath = join(dir, 'anchors.json')
const snapshotPath = join(dir, 'trigger-snapshot.json')

// ── 会话一：闭环积累 → 落盘 → 终结 ──
console.log('══ 会话一：弛豫 → 自动入库 → 落盘 → 会话终结 ══')
const s1 = await mountSession()
let savedSize
try {
  const cu = await s1.handles.materialService.load('Cu')
  const cu3ag = cu.substitute(0, 'Ag')
  s1.handles.materialService.store.set(cu3ag.id, cu3ag)
  for (const m of [cu, cu3ag]) {
    const r = await s1.handles.rt.tools.call('potential.relax', { materialId: m.id, simulatedSeconds: 0 })
    console.log(`弛豫 ${m.formula}: converged=${r.converged}，energy=${r.energy.toFixed(6)} eV`)
  }
  console.log(`锚点库（⑮ 自动积累）: ${s1.anchorStore.size()} 个`)
  const saved = await s1.samplerRt.tools.call('sampler.anchor.save', { path: anchorPath })
  savedSize = saved.size
  console.log(`落盘: ${saved.size} 个锚点 → ${anchorPath}（路径调用方显式声明）`)
} finally {
  await s1.dispose()   // 会话终结：库随会话回收，数据只剩磁盘载荷
}
console.log('会话一终结：运行时全部回收，锚点库不复存在。\n')

// ── 会话二：全新挂载 → 回填 → 即刻参与闭环 ──
console.log('══ 会话二：全新挂载 → 回填 → 检索 → 提案 → 回算 → 联合排序 ══')
const s2 = await mountSession()
let assessmentRef   // ㊽：判据结论提出到会话作用域，供会话三续供对账（只读引用，不改判）
try {
  console.log(`新会话锚点库初始: ${s2.anchorStore.size()} 个（不伪造库外数据）`)
  const loaded = await s2.samplerRt.tools.call('sampler.anchor.load', { path: anchorPath })
  console.log(`回填: added=${loaded.added} skipped=${loaded.skipped}（门禁与导入工具同款）`)

  const cu = await s2.handles.materialService.load('Cu')
  const mixture = await s2.samplerRt.tools.call('sampler.mixture', {
    nAtoms: 4, composition: { Cu: 3, Ag: 1 },
    weights: [0.6, 0.4],
    n: 8, seed: 7, uEq: 0.05, gammaDt: 1.0, temperatureK: 300,
  })
  console.log(`锚点来源层: ${mixture.anchorOrigin}（回填锚点即刻是数据燃料）`)
  for (const [i, a] of mixture.anchors.entries()) {
    console.log(`  检索[${i}]: ${a.source.split('#')[0]}…，组分 L1 距离 = ${a.distance}（谱系跨会话保留）`)
  }

  const hasAse = s2.handles.potential.get('emt-mock').bridge.sidecarInfo?.calculators?.['ase-emt'] === true
  if (!hasAse) {
    console.log('ASE 不可用：数据面诚实报错，本演示如实终止（不伪造回算证据）。')
  } else {
    const result = await s2.screenRt.tools.call('workflow.screen', {
      materialId: cu.id, dopants: ['Ag'],
      sampled: mixture.candidates.map(c => ({ graph: c.graph, source: c.source, logProb: c.logProb })),
      sampledSource: 'sampler.mixture',
      temperatureK: 300,
    })
    const joint = result.sampledJoint
    const sum = joint.entries.reduce((a, e) => a + e.weight, 0)
    console.log(`联合排序: ${joint.entries.length} 候选全部回算成功；Σw = ${sum.toFixed(12)}；ESS = ${joint.essFraction.toFixed(3)}`)
    console.log(`跨会话恢复完成：落盘 ${savedSize} 个 → 回填 ${loaded.added} 个 → 提案 → 回算 → 排序，谱系不断。`)
  }

  // ㊷ 收尾判据快照：“足够轨迹”读数 → 判据对账（机器可读的裁决依据，可追溯可复算）：
  // 裁决从“人工对照触发条件”升级为机器可读的判据快照——阈值由调用方显式声明（此处为演示声明的
  // 原型阈值，非内置常量），结论如实呈报不是门禁（㊵/㉘：先见数据再谈机制）。
  const stats = await s2.samplerRt.tools.call('sampler.anchor.stats', {})
  const thresholds = { minSize: 100, minCompositionCoverage: 0.8 }
  const assessment = trajectoryTriggerAssessment(stats, thresholds)
  assessmentRef = assessment
  console.log(`判据快照（㊷）: met=${assessment.met}，读数=${JSON.stringify(assessment.readings)}，缺口=${JSON.stringify(assessment.reasons)}`)
  console.log('裁决依据机器可读：读数 → 阈值 → 结论可复算（“足够轨迹”未达标 → 维持不引入自监督，同 ㉘ 裁决）。')

  // ㊽ 判据快照落盘：会话内日志升级为磁盘证据（结论整体原样，落盘不改判）——
  // 裁决依据自此跨会话可续供（会话三回填验证实证）。
  const snapshotSaved = await s2.samplerRt.tools.call('sampler.trigger.snapshot.save', {
    path: snapshotPath, assessment, batchId: 'resume-b1',
  })
  console.log(`判据快照落盘（㊽）: ${snapshotSaved.path}（版本戳 ${snapshotSaved.version}，落盘不改判：met=${snapshotSaved.met}）`)
} finally {
  await s2.dispose()
}
console.log('会话二终结：锚点库回收，判据快照留在磁盘。\n')

// ── 会话三：全新挂载 → 判据快照回填续供（裁决依据跨会话可复算） ──
console.log('══ 会话三：判据快照回填续供（证据载荷与结构数据燃料正交） ══')
const s3 = await mountSession()
try {
  console.log(`新会话锚点库初始: ${s3.anchorStore.size()} 个（快照不是锚点条目，回填不进库）`)
  const restored = await s3.samplerRt.tools.call('sampler.trigger.snapshot.load', { path: snapshotPath })
  console.log(`判据快照回填（㊽）: met=${restored.met}，读数=${JSON.stringify(restored.readings)}，阈值=${JSON.stringify(restored.thresholds)}`)
  // 续供对账：回填的结论与会话二落盘前逐字段一致（裁决依据可复算，不重新估算）
  if (restored.met !== assessmentRef.met
      || JSON.stringify(restored.readings) !== JSON.stringify(assessmentRef.readings)
      || JSON.stringify(restored.thresholds) !== JSON.stringify(assessmentRef.thresholds)) {
    throw new Error('判据快照跨会话续供不一致：读数/阈值/结论必须与会话二原样一致')
  }
  console.log(`跨会话续供一致（会话三库内仍 ${s3.anchorStore.size()} 个：快照不进数据燃料）——裁决依据可续供、可复算。`)
} finally {
  await s3.dispose()
  await rm(dir, { recursive: true, force: true })
}
