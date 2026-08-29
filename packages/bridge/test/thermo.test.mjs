// 热力学第一档端到端（§9 欠账清偿）：严格形成焓 + 凸包判据接入真实筛选工作流
// 链路：workflow.screen → 引擎显式计算元素参考态（reference_energy 数据面算子）→
// 纯层形成焓/凸包 → 结果附 formationEnthalpy / energyAboveHull / thermo.level。
// 诚实纪律：无 ASE 环境下参考态不可得 → 本套件跳过（数据面诚实报错，不伪造零点）。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/saturday.plugin.mjs'
import screeningPlugin from '@saturday/plugin-screening'

const TRAJECTORY = fileURLToPath(new URL('../data/trajectory-thermo.jsonl', import.meta.url))

let ctx, fiber, screenFiber, handles, screenRt, HAS_ASE = false

before(async () => {
  await rm(TRAJECTORY, { force: true })
  ctx = new Context()
  fiber = await ctx.registry.plugin({
    name: 'saturday',
    apply: (ctx) => plugin.apply(ctx, { trajectoryPath: TRAJECTORY }),
  })
  handles = fiber.store.saturday
  screenFiber = await ctx.registry.plugin({
    name: 'saturday-screening',
    apply: (ctx) => screeningPlugin.apply(ctx, {}),
  })
  screenRt = screenFiber.store.saturdayScreening.rt
  HAS_ASE = handles.potential.get('emt-mock').bridge.sidecarInfo?.calculators?.['ase-emt'] === true
})

after(async () => {
  await screenFiber.dispose()
  await fiber.dispose()
})

test('1. 参考态显式计算：thermo.level + 全元素零点（真实 EMT）', async t => {
  if (!HAS_ASE) t.skip('ASE unavailable: reference_energy data-plane primitive requires real EMT')
  const material = await ctx.reflect.get('material').load('Cu')
  const result = await screenRt.tools.call('workflow.screen', {
    materialId: material.id, dopants: ['Ni', 'Ag'],
  })
  assert.equal(result.failed.length, 0)
  assert.ok(result.thermo, '参考态可得时必须附热力学块')
  assert.equal(result.thermo.level, 'emt-mock', '凸包精度等级必须声明为实际引擎（不冒充更高精度）')
  for (const el of ['Cu', 'Ni', 'Ag']) {
    assert.ok(Number.isFinite(result.thermo.references[el]), `参考态 ${el} 必须是显式计算的有限数`)
  }
})

test('2. 严格形成焓：基体近零 + 掺杂变体物理方向正确（Cu-Ni/Cu-Ag 相分离）', async t => {
  if (!HAS_ASE) t.skip('ASE unavailable in this environment')
  const material = await ctx.reflect.get('material').load('Cu')
  const result = await screenRt.tools.call('workflow.screen', {
    materialId: material.id, dopants: ['Ni', 'Ag'],
  })
  const pristine = result.ranked.find(r => r.kind === 'pristine')
  const ni = result.ranked.find(r => r.dopant === 'Ni')
  const ag = result.ranked.find(r => r.dopant === 'Ag')
  assert.ok([pristine, ni, ag].every(r => Number.isFinite(r.formationEnthalpy)))
  // 基体 = 参考态同构：形成焓应 ≈ 0（弛豫容差内的数值噪声）
  assert.ok(Math.abs(pristine.formationEnthalpy) < 1e-3, '基体形成焓应近零（自参考）')
  // EMT 冶金学：Cu-Ni / Cu-Ag 正形成焓 = 相分离倾向（与既有演示实证一致）
  assert.ok(ni.formationEnthalpy > 0, 'Cu3Ni 形成焓应为正（相分离）')
  assert.ok(ag.formationEnthalpy > 0, 'Cu3Ag 形成焓应为正（相分离）')
})

test('3. 多组分凸包判据：3 元素统一成分空间，端点全零 → energyAboveHull = max(0, ΔH_f)', async t => {
  if (!HAS_ASE) t.skip('ASE unavailable in this environment')
  const material = await ctx.reflect.get('material').load('Cu')
  const result = await screenRt.tools.call('workflow.screen', {
    materialId: material.id, dopants: ['Ni', 'Ag'],
  })
  assert.equal(result.thermo.mode, 'multi-component', '3 元素体系必须走多组分凸包')
  assert.equal(result.thermo.hullDimension, 2, '3 元素 → d=2 成分空间')
  const pristine = result.ranked.find(r => r.kind === 'pristine')
  assert.ok(pristine.energyAboveHull < 1e-3, '基体端点在包上（弛豫噪声容差内）')
  // 容差 = 基体形成焓噪声（若基体候选轻微低于端点会进包，扰动包络量级 ≤ |ΔH_f(base)|）
  const tol = 1e-9 + Math.abs(pristine.formationEnthalpy)
  for (const r of result.ranked.filter(x => x.kind === 'doped')) {
    assert.ok(r.energyAboveHull >= 0)
    assert.ok(
      Math.abs(r.energyAboveHull - Math.max(0, r.formationEnthalpy)) < tol,
      '端点全零 → 包络 ≈ z=0 超平面，判据与形成焓同号同量',
    )
  }
  assert.match(result.note, /严格形成焓/, '有参考态时声明必须从"近似"升级为"严格"')
})

test('4. 诚实降级：引擎无参考态原语时记录原因，不伪造严格量', async () => {
  // 纯层直验：不注入 references 且给出不可得原因 → 结果保留"近似"声明 + unavailable 记录
  const { screenDopants } = await import('@saturday/plugin-screening/screening')
  const { Material, PrototypeLibResolver, PotentialRegistry } = await import('@saturday/core')
  const material = await Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())
  const potential = new PotentialRegistry({ on() {}, emit() {} })
  potential.register({
    name: 'no-ref-engine',
    manifest: {
      capabilities: [{ type: 'relax', accuracy: 0.5, speed: 0.99, cost: 0.01, maxAtoms: 200 }],
      constraints: {},
      eventGranularity: 'job',
    },
    relax: async (m) => ({ jobId: `job-${m.formula}`, engine: 'no-ref-engine', converged: true, energy: -12.0, n_steps: 3 }),
  })
  await potential.activate('no-ref-engine')
  const result = await screenDopants({
    material, dopants: ['Ni'], potential,
    thermoUnavailable: '引擎 no-ref-engine 未声明参考态计算原语（referenceEnergy）',
  })
  assert.equal(result.thermo.level, 'unavailable')
  assert.match(result.thermo.reason, /referenceEnergy/)
  assert.ok(result.ranked.every(r => r.formationEnthalpy === undefined), '无参考态不得伪造形成焓')
  assert.match(result.note, /近似形成焓/, '声明保持诚实的"近似"')
})
