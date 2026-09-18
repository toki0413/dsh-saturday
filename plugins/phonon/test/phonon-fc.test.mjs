// 实空间力常数提取 runForceConstants 的端到端集成测试 —— 合成一维单原子链（简谐、周期）。
// 证明「超胞力响应 → Φ_{ij}(R) 提取 → Born–von Kármán ω(q)」整链正确，且 ASR/牛顿残余受控。
// 不碰引擎：力场闭式已知，提取失败/折叠约定错都会让对账崩。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runForceConstants, SQRT_EV_A2_AMU_TO_THZ, MASS_AMU } from '../src/phonon.mjs'
import { phononFrequenciesAtQ } from '../src/phonon-bz.mjs'

const K = 1.0
// 一维单原子链：原胞 1 原子，x 向格矢 a=1，y/z 大格解耦。力场 F_x[k]=−K(2u_k−u_{k−1}−u_{k+1})（环）。
function chainProvider(g) {
  const N = g.nodes.length
  const u = g.nodes.map((n, k) => n.position[0] - k) // 理想 x=k（a=1）
  const forces = u.map((_, k) => {
    const fx = -K * (2 * u[k] - u[(k - 1 + N) % N] - u[(k + 1) % N])
    return [fx, 0, 0]
  })
  return Promise.resolve({ forces, calculator: 'synthetic-chain' })
}
const chainPrimitive = () => ({
  cell: [[1, 0, 0], [0, 10, 0], [0, 0, 10]],
  nodes: [{ number: 29, position: [0, 0, 0] }], // Cu，mass=MASS_AMU[29]
})
const blockAt = (fc, R) => fc.blocks.find(b => b.R.join(',') === R.join(','))?.phi

test('1. 一维链 Φ_xx(R) 提取对闭式：self=2K、±1=−K，ASR/牛顿残余≈0', async () => {
  const { fc, diagnostics } = await runForceConstants(chainPrimitive(), chainProvider, { displacement: 0.02, supercellRep: [4, 1, 1] })
  close(blockAt(fc, [0, 0, 0])[0][0], 2 * K, 1e-6, 'Φ_xx(0)=2K')
  close(blockAt(fc, [1, 0, 0])[0][0], -K, 1e-6, 'Φ_xx(+1)=−K')
  close(blockAt(fc, [-1, 0, 0])[0][0], -K, 1e-6, 'Φ_xx(−1)=−K')
  assert.ok(diagnostics.asrResidualAfter < 1e-9, `ASR 修正后行和应≈0，得 ${diagnostics.asrResidualAfter}`)
  assert.ok(diagnostics.newtonResidual < 1e-9, `牛顿第三应满足，得 ${diagnostics.newtonResidual}`)
  assert.ok(diagnostics.equilibriumForceMax < 1e-9, '平衡力应为零')
  assert.equal(diagnostics.supercell.rangeMax, 1, '力程只到最近邻 → 折回后 |R|≤1')
  assert.equal(diagnostics.calculator, 'synthetic-chain')
})

test('2. 提取的 Φ(R) 喂 Born–von Kármán → ω(q)=2√(K/m)|sin(πq)|', async () => {
  const { fc } = await runForceConstants(chainPrimitive(), chainProvider, { displacement: 0.02, supercellRep: [4, 1, 1] })
  const m = MASS_AMU[29]
  for (const qf of [0.25, 0.5]) {
    const { frequenciesTHz } = phononFrequenciesAtQ(fc, [qf, 0, 0])
    const expected = 2 * Math.sqrt(K / m) * Math.abs(Math.sin(Math.PI * qf)) * SQRT_EV_A2_AMU_TO_THZ
    close(frequenciesTHz[frequenciesTHz.length - 1], expected, 1e-3)
  }
  // Γ 点：ASR 满足 → 全零模
  const g = phononFrequenciesAtQ(fc, [0, 0, 0]).frequenciesTHz
  assert.ok(g.every(f => Math.abs(f) < 1e-6), `Γ 应全零，得 ${g}`)
})

test('3. [1,1,1] 无 R 分辨 → 显式拒绝（不静默退化成 Γ-only）', async () => {
  await assert.rejects(
    () => runForceConstants(chainPrimitive(), chainProvider, { supercellRep: [1, 1, 1] }),
    e => e.code === 'PHONON_BAD_SUPERCELL')
})

function close(a, b, eps, msg = '') {
  assert.ok(Number.isFinite(a) && Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps}) ${msg}`)
}
