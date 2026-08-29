// Phase 0 Spike 验收测试（node:test，零额外依赖）
// 运行：node --test test/

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/saturday.plugin.mjs'
import { PotentialRegistry } from '../src/core/potential.mjs'
import { Material } from '../src/core/material.mjs'
import { PrototypeLibResolver } from '../src/core/structure-resolver.mjs'

const TRAJECTORY = fileURLToPath(new URL('../data/trajectory.jsonl', import.meta.url))

let ctx, fiber, handles, HAS_ASE = false

before(async () => {
  await rm(TRAJECTORY, { force: true })
  ctx = new Context()
  fiber = await ctx.registry.plugin({
    name: 'saturday',
    apply: (ctx) => plugin.apply(ctx, { trajectoryPath: TRAJECTORY }),
  })
  handles = fiber.store.saturday
  // sidecar 握手信息：ASE 是否可用（决定测试 9/11 断言强度）
  const provider = handles.potential.get('emt-mock')
  HAS_ASE = provider.bridge.sidecarInfo?.calculators?.['ase-emt'] === true
})

after(async () => {
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
  } })
  reg.register({ name: 'vasp', manifest: {
    capabilities: [{ type: 'calculate', accuracy: 0.95, speed: 0.3, cost: 0.9, maxAtoms: 500 }],
    constraints: { requiresLicense: true },
  } })
  assert.equal(reg.autoRoute({ type: 'calculate', nAtoms: 8, profile: 'screening' }).name, 'emt-mock')
  assert.equal(reg.autoRoute({ type: 'calculate', nAtoms: 8, profile: 'validation' }).name, 'vasp')
})

test('6. potential.relax：经 Python sidecar 完成弛豫，结果合理', async () => {
  const material = ctx.reflect.get('material')
  const ar = await material.load('Ar')   // LJ 势对 Ar 是定性合理的玩具
  const potential = ctx.reflect.get('potential')
  const provider = potential.resolveProvider({ engine: 'auto' }, { type: 'relax', nAtoms: ar.nAtoms })
  const result = await provider.relax(ar, { simulated_seconds: 0.1 })
  assert.equal(result.converged, true)
  assert.ok(Number.isFinite(result.energy))
  assert.ok(result.scale > 0.9 && result.scale < 1.1)
  assert.ok(result.n_steps > 3)
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
  assert.equal(entry.engine, 'emt-mock')
  assert.ok(materialService)
})

test('8. 卸载回退：dispose 后服务与工具全部回收（effect 语义）', async () => {
  const ctx2 = new Context()
  const f2 = await ctx2.registry.plugin({
    name: 'saturday',
    apply: (ctx) => plugin.apply(ctx, { trajectoryPath: TRAJECTORY }),
  })
  const h2 = f2.store.saturday
  assert.ok(ctx2.reflect.get('material'))
  assert.equal(h2.rt.tools.list().length, 3)
  await f2.dispose()
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

test('11. workflow.screen：批量掺杂筛选，排序正确且逐变体溯源', async (t) => {
  const { rt } = handles
  const loaded = await rt.tools.call('material.load', { query: 'Cu' })
  const before = (await readFile(TRAJECTORY, 'utf8')).trim().split('\n').length

  const result = await rt.tools.call('workflow.screen', {
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
