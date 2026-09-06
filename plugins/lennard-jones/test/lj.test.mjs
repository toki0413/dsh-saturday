// @toki0413/plugin-lj 契约测试 + 闭式对账（契约 §4.2）
// 零依赖引擎：本包测试在任何环境全量真实执行（无 skip 路径）——
// 这正是"开箱即用"引擎应有的测试形态。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import plugin, { LjProvider } from '../src/index.mjs'
import {
  ljCalculate, ljMd, ljHarmonic, ljReferenceEnergy,
  KB_EV_PER_K,
} from '../src/lj-engine.mjs'
import { Material, PrototypeLibResolver, PotentialRegistry } from '@toki0413/core'
import { potentialProviderContract } from '@toki0413/contract-tests'

// ── 套件 1：契约 §4.2（potentialProviderContract，runnable 全真跑）──
potentialProviderContract({
  subject: 'lj-js',
  createProvider: () => new LjProvider(),
  runnable: true,          // 零依赖引擎：任何环境都能真实执行
  runFormula: 'Ar',
})

// ── 测试用结构：Cu fcc 原胞（实验晶格常数）与其畸变态 ──────────
const A_CU = 3.615
const cuCell = [[A_CU, 0, 0], [0, A_CU, 0], [0, 0, A_CU]]
const cuPositions = [[0, 0, 0], [0, A_CU / 2, A_CU / 2], [A_CU / 2, 0, A_CU / 2], [A_CU / 2, A_CU / 2, 0]]
const cuSymbols = ['Cu', 'Cu', 'Cu', 'Cu']
const cuDistorted = {
  cell: cuCell,
  positions: cuPositions.map((p, i) =>
    i === 1 ? [p[0] + 0.13, p[1] - 0.07, p[2] + 0.05] : [...p]),
}

// ── 套件 2：闭式对账（数值层自洽，不依赖任何外部参照）──────────
test('1. 力 = 能量负梯度：逐分量中心差分对账（畸变态）', () => {
  const { forces } = ljCalculate(cuDistorted, cuSymbols)
  const h = 1e-5
  for (let atom = 0; atom < 2; atom++) {
    for (let k = 0; k < 3; k++) {
      const pos = cuDistorted.positions.map(p => [...p])
      pos[atom][k] += h
      const ep = ljCalculate({ cell: cuCell, positions: pos }, cuSymbols).energy
      pos[atom][k] -= 2 * h
      const em = ljCalculate({ cell: cuCell, positions: pos }, cuSymbols).energy
      const numeric = -(ep - em) / (2 * h)
      assert.ok(
        Math.abs(forces[atom][k] - numeric) / Math.max(Math.abs(numeric), 1e-12) < 1e-5,
        `atom ${atom} axis ${k}: 解析 ${forces[atom][k]} vs 数值 ${numeric}`,
      )
    }
  }
})

test('2. 对称结构驻点：fcc 完美晶格受力为零（机器精度）', () => {
  const { forces } = ljCalculate({ cell: cuCell, positions: cuPositions }, cuSymbols)
  const maxF = Math.max(...forces.map(f => Math.hypot(f[0], f[1], f[2])))
  assert.ok(maxF < 1e-12, `完美晶格受力应为零（对称性），实测 ${maxF}`)
})

test('3. MD 能量均分对账：⟨K⟩ ≈ 3N·kT/2（Langevin 恒温闭式）', () => {
  const T = 300
  const result = ljMd({ cell: cuCell, positions: cuPositions }, cuSymbols, {
    temperatureK: T, steps: 6000, dtFs: 1, sampleEvery: 2, friction: 0.02, seed: 7,
  })
  const tail = result.kinetic.slice(result.kinetic.length / 2)
  const meanK = tail.reduce((s, k) => s + k, 0) / tail.length
  const expected = 1.5 * cuPositions.length * KB_EV_PER_K * T
  assert.ok(
    Math.abs(meanK - expected) / expected < 0.1,
    `均分对账：实测 ⟨K⟩=${meanK.toFixed(5)} eV vs 闭式 ${expected.toFixed(5)} eV`,
  )
})

test('4. MD 确定性：同种子同轨迹（复现纪律）', () => {
  const opts = { temperatureK: 300, steps: 20, dtFs: 1, sampleEvery: 1, seed: 123 }
  const a = ljMd({ cell: cuCell, positions: cuPositions }, cuSymbols, opts)
  const b = ljMd({ cell: cuCell, positions: cuPositions }, cuSymbols, opts)
  assert.deepEqual(a.energies, b.energies)
  assert.deepEqual(a.kinetic, b.kinetic)
})

test('5. 谐波锚点：Cu 原胞 12 模 = 9 实模 + 3 平动零模，0 虚模', () => {
  const harm = ljHarmonic({ cell: cuCell, positions: cuPositions }, cuSymbols, {})
  assert.equal(harm.n_modes, 12)
  assert.equal(harm.zero_modes, 3, '周期晶胞 Γ 点平动零模如实计数')
  assert.equal(harm.frequencies_thz.length, 9)
  assert.equal(harm.imaginary_modes, 0, '平衡点不得有虚频（鞍点拒绝纪律的上游保证）')
  for (const f of harm.frequencies_thz) assert.ok(f > 0 && Number.isFinite(f))
})

test('6. 谐波锚点与弛豫同源：u0 = 弛豫能量（单一能量来源）', async () => {
  const cu = await Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())
  const provider = new LjProvider()
  const [relaxRes, harmRes] = await Promise.all([
    provider.relax(cu, {}),
    provider.harmonic(cu, {}),
  ])
  assert.ok(Math.abs(relaxRes.energy - harmRes.u0_eV) < 1e-8)
})

test('7. 元素参考态：自洽闭式（弛豫验证零点）+ 幂等 + 显式失败', () => {
  const cu = ljReferenceEnergy('Cu')
  assert.ok(cu.energy_per_atom < 0, 'LJ 平衡态能量必须为负（成键）')
  assert.equal(cu.converged, true)
  assert.equal(cu.source, 'lj-self-consistent', '如实标注自洽参考态，非实验值')
  // 不同元素参考态必须不同（凸包非退化前提）
  const ag = ljReferenceEnergy('Ag')
  assert.notEqual(cu.energy_per_atom.toFixed(5), ag.energy_per_atom.toFixed(5))
  // 不支持的元素显式报错，绝不编参数
  assert.throws(() => ljReferenceEnergy('Xx'), err => err.code === 'LJ_ELEMENT_UNSUPPORTED')
})

test('8. calculate 诚实门禁：基线量可算，电子结构性质显式拒绝', async () => {
  const cu = await Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())
  const provider = new LjProvider()
  const result = await provider.calculate(cu, {})
  assert.ok(Number.isFinite(result.energy))
  assert.equal(result.forces.length, cu.nAtoms)
  await assert.rejects(
    () => provider.calculate(cu, { properties: ['bandgap'] }),
    err => err.code === 'PROPERTY_UNSUPPORTED',
  )
})

test('9. 版本回读：进程内引擎恒可探测（无 unknown 态）', async () => {
  const provider = new LjProvider()
  assert.equal(await provider.probeVersion(), provider.version)
})

// ── 套件 3：插件形态（挂载/卸载全回收）────────────────────────
test('10. 注册即 effect：挂载进注册表，卸载自动注销', async () => {
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin({
    name: 'stub-core',
    apply(ctx) {
      const registry = new PotentialRegistry({ on() {}, emit() {} })
      ctx.reflect.provide('potential', registry)
      ctx.fiber.store.registry = registry
    },
  })
  const registry = coreFiber.store.registry
  const fiber = await ctx.registry.plugin({
    name: 'saturday-lj',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  assert.ok(registry.providers.has('lj-js'), '挂载应把 lj-js 注册进引擎注册表')
  assert.equal(fiber.store.saturdayLj.provider.manifest.fingerprint.software, 'lj-js')
  await fiber.dispose()
  assert.ok(!registry.providers.has('lj-js'), '卸载必须自动注销（全回收纪律）')
  await coreFiber.dispose()
})

test('11. 缺 potential 服务显式报错，不静默降级（契约 §2）', async () => {
  const ctx = new Context()
  await assert.rejects(
    () => Promise.resolve().then(() => plugin.apply(ctx, {})),
    /requires service "potential"/,
  )
})
