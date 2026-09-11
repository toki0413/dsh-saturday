// @toki0413/plugin-elasticity 测试（analysis seam 第三实证：弹性张量 6×6）
// 纯层：应变几何（对角缩放/剪切保体积）、各向同性解析对账（C11=λ+2μ、C44=μ、A=1、
// K=λ+2μ/3）、Jacobi 特征值不变量、端到端 elasticStiffness（fake 应力源从形变恢复应变）；
// 工具层：应力源能力门禁（声明 stress → 可用；未声明 → ELASTICITY_STRESS_MISSING 显式拒绝）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Material, PrototypeLibResolver, PotentialRegistry } from '@toki0413/core'
import plugin, {
  strainedGraph, assembleStiffness, deriveModuli, jacobiEigenvalues, elasticStiffness,
} from '../src/index.mjs'

const LAME = { lambda: 1.0, mu: 0.4 } // eV/Å³
const CELL = [[3.6, 0, 0], [0, 3.6, 0], [0, 0, 3.6]]
const refGraph = () => ({
  nodes: [{ id: 0, number: 29, position: [0, 0, 0] }],
  edges: [], periodic: true, cell: structuredClone(CELL),
})

// ── 纯层 ─────────────────────────────────────────────────────

test('1. 应变几何：对角应变线性缩放晶胞；剪切应变保体积（det F = 1）', () => {
  const g = strainedGraph(refGraph(), 0, 0.01)
  assert.ok(Math.abs(g.cell[0][0] - 3.6 * 1.01) < 1e-12)
  assert.ok(Math.abs(g.cell[1][1] - 3.6) < 1e-12)
  const s = strainedGraph(refGraph(), 3, 0.01) // yz 工程剪切
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  // 对称应变张量含 O(ε²) 体积项（det(I+E)=1−ε²/4 量级）；线性响应由 ±差分消去——
  // 断言放在 2ε² 容差内，不假装对称剪切严格保体积
  assert.ok(Math.abs(det(s.cell) / det(CELL) - 1) < 2 * 0.01 * 0.01 + 1e-12, '剪切体积不变到 O(ε²)', )
})

/** 各向同性本构的合成 ±ε 应力样本（约定与云端 MACE 真机对账一致：引擎应力与拉正同号） */
function isotropicSamples(lambda, mu, eps) {
  const plus = [], minus = []
  for (let k = 0; k < 6; k++) {
    for (const sign of [1, -1]) {
      const e = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
      const voigt = [[0, 0], [1, 1], [2, 2], [1, 2], [0, 2], [0, 1]][k]
      const [i, j] = voigt
      if (i === j) e[i][i] = sign * eps
      else { e[i][j] = sign * eps / 2; e[j][i] = sign * eps / 2 }
      const tr = e[0][0] + e[1][1] + e[2][2]
      const st = e.map((row, i2) => row.map((v, j2) => lambda * tr * (i2 === j2 ? 1 : 0) + 2 * mu * v))
      const eng = [st[0][0], st[1][1], st[2][2], st[1][2], st[0][2], st[0][1]]
      ;(sign > 0 ? plus : minus).push(eng)
    }
  }
  return { plus, minus }
}

test('2. 各向同性解析对账：C11=λ+2μ、C44=μ、A=1、K=λ+2μ/3、G=μ、Born 稳定', () => {
  const eps = 0.005
  const { plus, minus } = isotropicSamples(LAME.lambda, LAME.mu, eps)
  const C = assembleStiffness(plus, minus, eps)
  const c11 = C[0][0], c12 = C[0][1], c44 = C[3][3]
  assert.ok(Math.abs(c11 - (LAME.lambda + 2 * LAME.mu)) < 1e-9, `C11=${c11}`)
  assert.ok(Math.abs(c12 - LAME.lambda) < 1e-9)
  assert.ok(Math.abs(c44 - LAME.mu) < 1e-9, `C44=${c44}`)
  const d = deriveModuli(C)
  assert.ok(Math.abs(d.K_EVperA3 - (LAME.lambda + 2 * LAME.mu / 3)) < 1e-9)
  assert.ok(Math.abs(d.G_EVperA3 - LAME.mu) < 1e-9)
  assert.ok(Math.abs(d.anisotropyFactor - 1) < 1e-9, '各向同性 A=1')
  assert.equal(d.bornStable, true)
  assert.ok(d.minEigenvalueEVperA3 > 0)
})

test('3. Jacobi 特征值：对角阵排序正确；迹不变量（旋转不变性）', () => {
  const diag = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => (i === j ? [2, 5, 3, 4, 5, 6][i] : 0)))
  const ev = jacobiEigenvalues(diag)
  assert.deepEqual(ev, [2, 3, 4, 5, 5, 6])
  const A = [[4, 1, 0, 0, 0, 0], [1, 3, 0, 0, 0, 0], [0, 0, 2, 0, 0, 0], [0, 0, 0, 1, 0, 0], [0, 0, 0, 0, 1, 0], [0, 0, 0, 0, 0, 1]]
  const tr = A.reduce((s, row, i) => s + row[i], 0)
  const evs = jacobiEigenvalues(A)
  assert.ok(Math.abs(evs.reduce((s, v) => s + v, 0) - tr) < 1e-9, '迹不变')
})

test('4. 端到端 elasticStiffness：fake 应力源从形变恢复应变，12 次调用、C 与解析一致', async () => {
  const inv3 = (m) => {
    const a = m.flat()
    const [a00, a01, a02, a10, a11, a12, a20, a21, a22] = a
    const d = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20)
    const i = [
      (a11 * a22 - a12 * a21) / d, (a02 * a21 - a01 * a22) / d, (a01 * a12 - a02 * a11) / d,
      (a12 * a20 - a10 * a22) / d, (a00 * a22 - a02 * a20) / d, (a02 * a10 - a00 * a12) / d,
      (a10 * a21 - a11 * a20) / d, (a01 * a20 - a00 * a21) / d, (a00 * a11 - a01 * a10) / d,
    ]
    return [[i[0], i[1], i[2]], [i[3], i[4], i[5]], [i[6], i[7], i[8]]]
  }
  let calls = 0
  const calculateStress = (g) => {
    calls++
    // F = R_new · R_ref^{-1}（行向量约定：R_new = F·R_ref）
    const Rinv = inv3(CELL)
    const F = g.cell.map(row => [0, 1, 2].map(c => row[0] * Rinv[c][0] + row[1] * Rinv[c][1] + row[2] * Rinv[c][2]))
    const e = F.map((row, i) => row.map((v, j) => 0.5 * (v + F[j][i]) - (i === j ? 1 : 0) * 0 + (i === j ? -0 : 0)))
    // e_sym = (F+Fᵀ)/2 − I
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) e[i][j] = 0.5 * (F[i][j] + F[j][i]) - (i === j ? 1 : 0)
    const tr = e[0][0] + e[1][1] + e[2][2]
    const st = e.map((row, i) => row.map((v, j) => LAME.lambda * tr * (i === j ? 1 : 0) + 2 * LAME.mu * v))
    return Promise.resolve([st[0][0], st[1][1], st[2][2], st[1][2], st[0][2], st[0][1]])
  }
  const out = await elasticStiffness({ graph: refGraph(), calculateStress, eps: 0.005 })
  assert.equal(calls, 12, '6 方向 × ±ε = 12 次引擎调用')
  assert.equal(out.nCalculations, 12)
  assert.ok(Math.abs(out.C[0][0] - 1.8) < 1e-9)
  assert.ok(Math.abs(out.C[3][3] - 0.4) < 1e-9)
  assert.equal(out.bornStable, true)
  await assert.rejects(
    () => elasticStiffness({ graph: refGraph(), calculateStress, eps: 0.5 }),
    err => err.code === 'ELASTICITY_BAD_INPUT', '线性响应域外 eps 显式拒绝')
})

// ── 工具层：应力源能力门禁 ───────────────────────────────────

function fakeStressProvider({ withStress, refA = 3.6 }) {
  return {
    name: withStress ? 'fake-stress' : 'fake-nostress',
    manifest: {
      capabilities: [{ type: 'calculate', accuracy: 0.9, speed: 0.9, cost: 0.1,
        ...(withStress ? { properties: ['stress'] } : {}) }],
      units: { energy: 'eV', length: 'Å', time: 'fs' },
      fingerprint: { software: 'fake', method: 'test', version: '0.0.0' },
    },
    async calculate(material, params = {}) {
      if (!withStress) return { energy: 0, forces: material.graph.nodes.map(() => [0, 0, 0]) }
      // 线弹性各向同性响应（λ=1.0, μ=0.4 eV/Å³）：从形变后 cell 恢复应变，
      // 使工具层拿到的 C 非奇异且与解析值一致（数值对账在纯层测试 2/4）
      const g = material.graph.cell
      const e0 = g[0][0] / refA - 1, e1 = g[1][1] / refA - 1, e2 = g[2][2] / refA - 1
      const g3 = (g[1][2] + g[2][1]) / refA, g4 = (g[0][2] + g[2][0]) / refA, g5 = (g[0][1] + g[1][0]) / refA
      const tr = e0 + e1 + e2
      const st = [LAME.lambda * tr + 2 * LAME.mu * e0, LAME.lambda * tr + 2 * LAME.mu * e1,
        LAME.lambda * tr + 2 * LAME.mu * e2, LAME.mu * g3, LAME.mu * g4, LAME.mu * g5]
      return { energy: 0, forces: material.graph.nodes.map(() => [0, 0, 0]), stress: st }
    },
  }
}

async function mountWithProvider(withStress, refA = 3.6) {
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin({
    name: 'stub-core',
    async apply(ctx) {
      const potential = new PotentialRegistry({ on() {}, emit() {} })
      potential.register(fakeStressProvider({ withStress, refA }))
      const resolver = new PrototypeLibResolver()
      const store = new Map()
      ctx.reflect.provide('potential', potential)
      ctx.reflect.provide('material', {
        async load(formula) { const m = await Material.create({ modalities: { formula } }, resolver); store.set(m.id, m); return m },
        async get(id) { return store.get(id) },
      })
      ctx.fiber.store.core = { potential }
    },
  })
  const { potential } = coreFiber.store.core
  const mat = await ctx.reflect.get('material').load('Cu')
  const fiber = await ctx.registry.plugin({ name: 'saturday-elasticity', apply: (c) => plugin.apply(c, {}) })
  return { fiber, mat, potential, coreFiber }
}

test('5. 工具门禁：引擎声明 calculate+stress → 12 次调用出 C；未声明 → ELASTICITY_STRESS_MISSING（绝不近似替代）', async () => {
  const ok = await mountWithProvider(true, 3.615)  // Cu 原型格常数（fake 应变恢复基准须与之一致）
  try {
    const out = await ok.fiber.store.saturdayElasticity.rt.tools.call('analysis.elasticity',
      { materialId: ok.mat.id, engine: 'fake-stress' })
    assert.equal(out.engine, 'fake-stress')
    assert.equal(out.nCalculations, 12)
    assert.equal(out.C.length, 6)
    assert.ok(Math.abs(out.C[0][0] - 1.8) < 1e-6, '工具层与解析对账：C11=λ+2μ')
    assert.equal(out.bornStable, true)
    assert.ok(out.units.gpaConversion.includes('160.2176634'), 'GPa 换算显式声明')
  } finally {
    await ok.fiber.dispose(); await ok.coreFiber.dispose()
  }
  const bad = await mountWithProvider(false, 3.615)
  try {
    await assert.rejects(
      () => bad.fiber.store.saturdayElasticity.rt.tools.call('analysis.elasticity',
        { materialId: bad.mat.id, engine: 'fake-nostress' }),
      err => err.code === 'ELASTICITY_STRESS_MISSING')
  } finally {
    await bad.fiber.dispose(); await bad.coreFiber.dispose()
  }
})
