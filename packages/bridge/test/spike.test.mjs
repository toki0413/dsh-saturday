// Phase 0 Spike 验收测试（node:test，零额外依赖）
// 运行：node --test test/

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/saturday.plugin.mjs'
import screeningPlugin from '@saturday/plugin-screening'
import { PotentialRegistry, Material, PrototypeLibResolver } from '@saturday/core'
import { VASP_LIKE_MANIFEST } from '../src/compute/emt-provider.mjs'

const TRAJECTORY = fileURLToPath(new URL('../data/trajectory.jsonl', import.meta.url))

let ctx, fiber, handles, screenFiber, screenRt, HAS_ASE = false, DATA_PLANE = 'emt-mock'

before(async () => {
  await rm(TRAJECTORY, { force: true })
  ctx = new Context()
  fiber = await ctx.registry.plugin({
    name: 'saturday',
    apply: (ctx) => plugin.apply(ctx, { trajectoryPath: TRAJECTORY }),
  })
  handles = fiber.store.saturday
  // 工作流插件独立挂载（契约 §4.3）：与核心插件同一 Context 组合
  screenFiber = await ctx.registry.plugin({
    name: 'saturday-screening',
    apply: (ctx) => screeningPlugin.apply(ctx, { trajectoryPath: TRAJECTORY }),
  })
  screenRt = screenFiber.store.saturdayScreening.rt
  // 环境自适应（与演示同款纪律）：零依赖数据面下 emt-mock 不注册（回退 lj-js），
  // 探针改走 store.dataPlane；HAS_ASE 仅在 emt-mock 在场时有意义（决定测试 9/11 断言强度）
  DATA_PLANE = handles.dataPlane
  if (handles.potential.providers.has('emt-mock')) {
    const provider = handles.potential.get('emt-mock')
    HAS_ASE = provider.bridge.sidecarInfo?.calculators?.['ase-emt'] === true
  }
})

after(async () => {
  await screenFiber.dispose()
  await fiber.dispose()
})

test('1. Bundle 加载：material / potential 服务可用', () => {
  assert.ok(ctx.reflect.get('material'), 'material service should be provided')
  assert.ok(ctx.reflect.get('potential'), 'potential service should be provided')
})

test('2. material.load：Si 解析为金刚石，谱系记录结构来源', async () => {
  const material = ctx.reflect.get('material')
  const si = await material.load('Si')
  assert.equal(si.nAtoms, 8)
  const resolved = si.lineage.find(l => l.operation === 'structure-resolved')
  assert.equal(resolved.detail.resolver, 'prototype-lib')
  assert.equal(resolved.detail.source, 'prototype:A4-diamond')
})

test('3. 多晶型：TiO2 默认金红石，rank 1 得锐钛矿', async () => {
  const resolver = new PrototypeLibResolver()
  const rutile = await Material.create({ modalities: { formula: 'TiO2' } }, resolver)
  const anatase = await Material.create({ modalities: { formula: 'TiO2' } }, resolver, { polymorphRank: 1 })
  assert.ok(rutile.graph.cell[2][2] < 4)     // 金红石 c ≈ 2.96
  assert.ok(anatase.graph.cell[2][2] > 9)    // 锐钛矿 c ≈ 9.51
})

test('4. formula-only 无 resolver 必须报错（修订 #8）', async () => {
  await assert.rejects(
    () => Material.create({ modalities: { formula: 'Si' } }),
    /requires a StructureResolver/,
  )
})

test('5. autoRoute 评分修正：screening 选快引擎（修订 #7）', () => {
  const rt = { on() {}, emit() {} }
  const reg = new PotentialRegistry(rt)
  reg.register({ name: 'emt-mock', manifest: {
    capabilities: [{ type: 'calculate', accuracy: 0.5, speed: 0.99, cost: 0.05, maxAtoms: 200 }],
    constraints: {},
    units: { energy: 'eV', length: 'Å', time: 'fs' },
    fingerprint: { software: 'emt-mock', method: 'LJ-mock' },
  } })
  reg.register({ name: 'vasp', manifest: {
    capabilities: [{ type: 'calculate', accuracy: 0.95, speed: 0.3, cost: 0.9, maxAtoms: 500 }],
    constraints: { requiresLicense: true },
    units: { energy: 'eV', length: 'Å', time: 'fs' },
    fingerprint: { software: 'vasp', method: 'DFT-PBE' },
  } })
  assert.equal(reg.autoRoute({ type: 'calculate', nAtoms: 8, profile: 'screening' }).name, 'emt-mock')
  assert.equal(reg.autoRoute({ type: 'calculate', nAtoms: 8, profile: 'validation' }).name, 'vasp')
})

test('6. potential.relax：经当前数据面引擎完成弛豫，结果合理', async () => {
  const material = ctx.reflect.get('material')
  const ar = await material.load('Ar')   // LJ 势对 Ar 是定性合理的玩具
  const potential = ctx.reflect.get('potential')
  const provider = potential.resolveProvider({ engine: 'auto' }, { type: 'relax', nAtoms: ar.nAtoms })
  const result = await provider.relax(ar, { simulated_seconds: 0.1 })
  assert.equal(result.converged, true)
  assert.ok(Number.isFinite(result.energy))
  // scale 是 sidecar 引擎的统一缩放字段；lj-js（坐标+晶胞弛豫）不声明该字段，在场才验（如实）
  if (result.scale !== undefined) {
    assert.ok(result.scale > 0.9 && result.scale < 1.1)
  }
  // 步数只验形态（有限非负整数）：Ar 原型结构与 LJ 势本就自洽，lj-js 可 0 步收敛（不假设步数下限）
  assert.ok(Number.isInteger(result.n_steps) && result.n_steps >= 0)
})

test('7. 事件 → Trajectory：工具调用后溯源日志落盘', async () => {
  const { rt, materialService } = handles
  const loaded = await rt.tools.call('material.load', { query: 'Ar' })
  assert.ok(loaded.materialId)
  const result = await rt.tools.call('potential.relax', {
    materialId: loaded.materialId, simulatedSeconds: 0.1,
  })
  assert.ok(result.energy)

  // 等待事件异步落盘
  await new Promise(r => setTimeout(r, 100))
  const lines = (await readFile(TRAJECTORY, 'utf8')).trim().split('\n').map(JSON.parse)
  const entry = lines.find(l => l.type === 'material_calculation_complete')
  assert.ok(entry, 'trajectory should contain the calculation entry')
  assert.equal(entry.material.formula, 'Ar')
  assert.equal(entry.engine, DATA_PLANE, '轨迹引擎字段如实反映当前数据面')
  assert.ok(materialService)
})

test('8. 卸载回退：dispose 后服务与工具全部回收（effect 语义）', async () => {
  const ctx2 = new Context()
  const f2 = await ctx2.registry.plugin({
    name: 'saturday',
    apply: (ctx) => plugin.apply(ctx, { trajectoryPath: TRAJECTORY }),
  })
  const h2 = f2.store.saturday
  // 泄漏防护（纪律）：挂载即拉起 Python sidecar，dispose 前的断言若失败而跳过回收，
  // 子进程会挂住事件循环 → 测试进程永久挂起，掩盖真实失败。故前置断言入 try，
  // finally 保证 dispose；回收断言依赖 dispose 已发生，在 finally 之后照常执行。
  try {
    assert.ok(ctx2.reflect.get('material'))
    assert.equal(h2.rt.tools.list().length, 3, '核心插件三工具基线：material.load / potential.relax / engine.availability（workflow.screen 已迁出为独立插件）')
  } finally {
    await f2.dispose()
  }
  assert.equal(ctx2.reflect.get('material'), undefined, 'service should be withdrawn on dispose')
  assert.equal(h2.rt.tools.list().length, 0, 'tools should be withdrawn on dispose')
})

test('9. 真物理：Cu 经 ASE EMT 弛豫，晶格常数落在实验值 ±1%', async (t) => {
  if (!HAS_ASE) return t.skip('ASE 不可用（lj-mock 兜底模式），跳过真物理断言')
  const material = ctx.reflect.get('material')
  const cu = await material.load('Cu')
  const potential = ctx.reflect.get('potential')
  const provider = potential.resolveProvider({ engine: 'auto' }, { type: 'relax', nAtoms: cu.nAtoms })
  const result = await provider.relax(cu, {})
  assert.equal(result.calculator, 'ase-emt')
  assert.equal(result.converged, true)
  // 弛豫后晶胞仍为立方：a = cell[0][0]，EMT 平衡值 ≈ 3.59 Å（实验 3.615 Å）
  const a = result.cell[0][0]
  assert.ok(a > 3.55 && a < 3.65, `Cu lattice ${a} Å out of expected range`)
  assert.ok(result.energy < 0, 'fcc Cu cohesive energy should be negative')
})

test('10. Material.substitute：Cu 掺 Ag 得 Cu3Ag，谱系可追溯且原对象不变', async () => {
  const material = ctx.reflect.get('material')
  const cu = await material.load('Cu')
  const doped = cu.substitute(0, 'Ag')
  assert.equal(doped.formula, 'Cu3Ag')
  assert.equal(doped.nAtoms, 4)
  assert.equal(cu.formula, 'Cu', 'immutability: base material unchanged')
  const sub = doped.lineage.find(l => l.operation === 'substitute')
  assert.ok(sub, 'lineage should record the substitute event')
  assert.equal(sub.detail.element, 'Ag')
  assert.equal(sub.detail.parent, cu.id)
  // 未知元素必须报错
  assert.throws(() => cu.substitute(0, 'Xx'), /Unknown element/)
})

test('11. workflow.screen：批量掺杂筛选，排序正确且逐变体溯源（独立插件）', async (t) => {
  const { rt } = handles
  const loaded = await rt.tools.call('material.load', { query: 'Cu' })
  const before = (await readFile(TRAJECTORY, 'utf8')).trim().split('\n').length

  const result = await screenRt.tools.call('workflow.screen', {
    materialId: loaded.materialId, dopants: ['Ag', 'Ni'],
  })
  // pristine + 2 掺杂 = 3 个变体全部成功
  assert.equal(result.ranked.length, 3)
  assert.equal(result.failed.length, 0)
  assert.ok(result.ranked.every(r => r.status === 'ok'))
  // 按 energyPerAtom 升序
  for (let i = 1; i < result.ranked.length; i++) {
    assert.ok(result.ranked[i].energyPerAtom >= result.ranked[i - 1].energyPerAtom)
  }
  assert.deepEqual(
    result.ranked.map(r => r.formula).sort(),
    ['Cu', 'Cu3Ag', 'Cu3Ni'].sort(),
  )
  if (HAS_ASE) {
    assert.ok(result.ranked.every(r => r.calculator === 'ase-emt'))
  } else {
    t.diagnostic('ASE 不可用，跳过 calculator 断言')
  }

  // 每个变体一条 Trajectory 记录（含 workflow 标记）
  await new Promise(r => setTimeout(r, 100))
  const lines = (await readFile(TRAJECTORY, 'utf8')).trim().split('\n').map(JSON.parse)
  const screenEntries = lines.filter(l => l.workflow === 'screen')
  assert.equal(screenEntries.length, 3, 'each variant should have its own trajectory entry')
  assert.ok(lines.length >= before + 3)
})

// ── 契约测试（附录 A 待补项）──────────────────────────────

test('12. 契约：license 是前置门禁（修订 #10）', async t => {
  if (!handles.potential.providers.has('emt-mock')) {
    t.skip('emt-mock 不在场（零依赖数据面）：免 license 引擎的在场断言由 fallback-lj 套件覆盖')
    return
  }
  const rt = { on() {}, emit() {} }
  const reg = new PotentialRegistry(rt)
  reg.register({ name: VASP_LIKE_MANIFEST.name, manifest: VASP_LIKE_MANIFEST.manifest })

  // license 不可用：激活被拒绝，且当前引擎不受影响（未激活成功不得污染状态）
  reg.licenseChecker = async () => false
  await assert.rejects(
    () => reg.activate('vasp'),
    err => err.code === 'LICENSE_UNAVAILABLE',
  )
  assert.equal(reg.activeProvider, null, 'failed preflight must not activate')

  // license 可用同一 Provider 放行（门禁是前置校验，不是一次性熔断）
  reg.licenseChecker = async () => true
  await reg.activate('vasp')
  assert.equal(reg.activeProvider, 'vasp')

  // 免 license 引擎（如 emt-mock）不受门禁影响
  const provider = handles.potential.get('emt-mock')
  await handles.potential.activate('emt-mock')
  assert.equal(handles.potential.activeProvider, 'emt-mock')
  assert.equal(provider.manifest.constraints.requiresLicense, false)
})

test('13. 契约：事件粒度声明——job 级引擎必须显式拒绝细粒度监听（§5.2）', () => {
  const rt = { on() {}, emit() {} }
  const reg = new PotentialRegistry(rt)
  // iteration 级引擎取当前数据面（emt-mock / lj-js 均声明 iteration，指纹独立但粒度同级）
  const emt = handles.potential.get(DATA_PLANE)

  // iteration 级引擎：允许细粒度监听，且粒度已在 manifest 声明（握手可见）
  assert.equal(emt.manifest.eventGranularity, 'iteration')
  reg.assertCanMonitor(emt, 'iteration')

  // job 级引擎：请求细粒度监听必须显式报错，不得静默降级为任务级
  const jobLevel = { name: VASP_LIKE_MANIFEST.name, manifest: VASP_LIKE_MANIFEST.manifest }
  assert.equal(jobLevel.manifest.eventGranularity, 'job')
  assert.throws(
    () => reg.assertCanMonitor(jobLevel, 'iteration'),
    err => err.code === 'GRANULARITY_UNAVAILABLE',
  )
  // 任务级监听对两类引擎都合法（粒度是上限，不是下限）
  reg.assertCanMonitor(jobLevel, 'job')
  reg.assertCanMonitor(emt, 'job')
})

test('14. 契约：事件薄、数据厚——工作流事件载荷只含引用不含结构（§7.2）', async () => {
  const { rt } = handles
  const loaded = await rt.tools.call('material.load', { query: 'Cu' })
  const before = (await readFile(TRAJECTORY, 'utf8')).trim().split('\n').length

  await screenRt.tools.call('workflow.screen', {
    materialId: loaded.materialId, dopants: ['Ag'],
  })
  await new Promise(r => setTimeout(r, 100))

  const lines = (await readFile(TRAJECTORY, 'utf8')).trim().split('\n').map(JSON.parse)
  const events = lines.slice(before).filter(l => l.workflow === 'screen')
  assert.ok(events.length >= 2, 'pristine + doped variants')
  for (const e of events) {
    // 必备引用字段：结构经 materialId 引用，计算经 jobId 引用
    assert.ok(e.material?.id, 'payload must reference material by id')
    assert.ok(e.jobId, 'payload must reference the computation by jobId')
    // 结构载荷不得内联：无原子数组、无坐标、无晶胞（GB 级对象走对象存储）
    assert.equal(e.nodes, undefined)
    assert.equal(e.structure, undefined)
    assert.equal(e.cell, undefined)
    assert.ok(!JSON.stringify(e).includes('"position"'), 'no inline positions in event payload')
  }
})
