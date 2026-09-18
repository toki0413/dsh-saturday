// 全 BZ 声子热力学纯层测试 —— 全部用闭式解析对账，不碰引擎（数值可信度门）。
// 覆盖：Hermitian 特征值嵌入、1D 单原子链 ω(q)=2√(K/m)|sin(πq)|、声学零模(ASR)、
// Einstein 热容闭式 + 高温→k_B + 低温→0 + 零点能 + 热三律(S→0)、Debye T³ 与 Dulong-Petit。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SQRT_EV_A2_AMU_TO_THZ, THZ_TO_MEV } from '../src/phonon.mjs'
import {
  hermitianEigenvalues, phononFrequenciesAtQ, thermoFromFrequenciesTHz,
  debyeCv3D, debyeTemperatureFromMax, KB_MEV_PER_K, R_J_PER_MOL_K,
} from '../src/phonon-bz.mjs'

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps})`)

test('1. Hermitian 特征值嵌入：已知复 Herm 矩阵 [1,4]', () => {
  // H=[[2,1+i],[1-i,3]] → C=[[2,1],[1,3]], S=[[0,1],[-1,0]]；解析 λ=(5±3)/2={1,4}
  const C = [[2, 1], [1, 3]]
  const S = [[0, 1], [-1, 0]]
  const ev = hermitianEigenvalues(C, S)
  close(ev[0], 1); close(ev[1], 4)
})

test('2. 1D 单原子链 Born–von Kármán：ω(q)=2√(K/m)|sin(πq)| + Γ 点声学零模', () => {
  const K = 1.0, m = 1.0
  const fc = {
    nAtoms: 1, masses: [m], cell: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    blocks: [
      { i: 0, j: 0, R: [0, 0, 0], phi: [[2 * K, 0, 0], [0, 0, 0], [0, 0, 0]] },
      { i: 0, j: 0, R: [1, 0, 0], phi: [[-K, 0, 0], [0, 0, 0], [0, 0, 0]] },
      { i: 0, j: 0, R: [-1, 0, 0], phi: [[-K, 0, 0], [0, 0, 0], [0, 0, 0]] },
    ],
  }
  for (const qf of [0.25, 0.5, 0.75]) {
    const { frequenciesTHz } = phononFrequenciesAtQ(fc, [qf, 0, 0])
    const expected = 2 * Math.sqrt(K / m) * Math.abs(Math.sin(Math.PI * qf)) * SQRT_EV_A2_AMU_TO_THZ
    close(frequenciesTHz[2], expected, 1e-4) // 最大支 = 声学纵向
  }
  // q=0：ASR 满足 → 全零（含 y/z 两支恒零）
  const g = phononFrequenciesAtQ(fc, [0, 0, 0]).frequenciesTHz
  assert.ok(g.every((f) => Math.abs(f) < 1e-9), `Γ 点应全零模，得 ${g}`)
})

test('3. Einstein 单模热容闭式 + 极限 + 零点能 + 热三律', () => {
  const fE = 5.0 // THz
  const E = fE * THZ_TO_MEV
  const T = 100
  const x = E / (KB_MEV_PER_K * T)
  const t = thermoFromFrequenciesTHz([fE], T)
  close(t.cvKb, (x / (2 * Math.sinh(x / 2))) ** 2, 1e-9)
  close(t.zpeMeV, 0.5 * E, 1e-9)
  close(t.cvJmolK, t.cvKb * R_J_PER_MOL_K, 1e-9)
  // 高温经典极限：单模 C_v/k_B → 1
  close(thermoFromFrequenciesTHz([fE], 1e6).cvKb, 1, 1e-3)
  // 低温：C_v → 0 且 S → 0（热三律）
  const low = thermoFromFrequenciesTHz([fE], 1)
  assert.ok(low.cvKb < 1e-6, `低温 C_v 应→0，得 ${low.cvKb}`)
  assert.ok(Math.abs(low.sJmolK) < 1e-4, `低温 S 应→0，得 ${low.sJmolK}`)
})

test('4. Debye 模型：高温 Dulong–Petit 3N·R，低温 ∝ T³', () => {
  close(debyeCv3D(300, 30000, { atoms: 1 }), 3 * R_J_PER_MOL_K, 0.05) // 高温 → 24.94 J/mol/K
  const cv3 = debyeCv3D(300, 3, { atoms: 1 })
  const cv6 = debyeCv3D(300, 6, { atoms: 1 })
  close(cv6 / cv3, 8, 0.5) // (6/3)³=8（低温 T³ 标度）
  // Debye 温度：θ_D = ħω_max/k_B
  close(debyeTemperatureFromMax(10), (10 * THZ_TO_MEV) / KB_MEV_PER_K, 1e-6)
})

test('5. 三模集热容按模数叠加（Einstein 频率可加）', () => {
  const f = 3.0, T = 50
  const single = thermoFromFrequenciesTHz([f], T).cvKb
  const triple = thermoFromFrequenciesTHz([f, f, f], T).cvKb
  close(triple, 3 * single, 1e-9)
})
