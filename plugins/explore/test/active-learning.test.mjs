// 主动学习闭环（basin-hopping）纯函数测试：合成 sampler（mulberry32 微扰）+ 合成 oracle
// （谐振 E=Σ|pos|²）。验证编排不变量——贪心最优单调不升、评估数对账、同种子确定性复现、
// 缺依赖显式报错。不依赖真引擎（行为闭式可控）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Material } from '@toki0413/core'
import { runActiveLearning } from '../src/active-learning.mjs'

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const seedGraph = () => ({
  cell: [[4, 0, 0], [0, 4, 0], [0, 0, 4]],
  nodes: [
    { number: 29, position: [0.3, 0.4, 0.5] },
    { number: 29, position: [2.3, 2.4, 2.5] },
  ],
})
// 合成 sampler：对 reference.graph 逐原子高斯微扰（固定种子）
const fakeSampler = {
  async sample({ reference }, { n, seed, sigma }) {
    const rng = mulberry32(seed >>> 0)
    const out = []
    for (let i = 0; i < n; i++) {
      const g = structuredClone(reference.graph)
      for (const nd of g.nodes) for (let a = 0; a < 3; a++) nd.position[a] += (rng() * 2 - 1) * sigma
      out.push({ graph: g, source: `generative:fake#${seed}-${i}` })
    }
    return out
  },
}
// 合成 oracle：E = Σ|pos|²（无实际弛豫，能量随偏离原点增大）
function fakePotential() {
  return {
    resolveProvider: () => ({
      name: 'fake-relax',
      async relax(material) {
        const E = material.graph.nodes.reduce((s, nd) => s + nd.position[0] ** 2 + nd.position[1] ** 2 + nd.position[2] ** 2, 0)
        return { energy: E, converged: true, jobId: `job-${Math.random()}`, engine: 'fake-relax' }
      },
    }),
  }
}
const makeRef = () => Material.create({ modalities: { graph: seedGraph(), formula: 'Cu2' } })

test('1. basin-hopping：贪心最优单调不升 + 评估数对账 + 交付形态', async () => {
  const reference = await makeRef()
  const events = []
  const out = await runActiveLearning({
    reference, sampler: fakeSampler, potential: fakePotential(),
    rounds: 4, candidatesPerRound: 5, seed: 42, sigma: 0.2,
    emit: (type, ev) => { events.push(ev.payload); return Promise.resolve() },
  })
  assert.equal(out.provider, 'fake-relax')
  assert.equal(out.evaluations, 1 + 4 * 5, '1 次种子回算 + rounds×candidates')
  assert.equal(out.history.length, 5, 'round0 基线 + 4 轮')
  // 单调不升（贪心接受）
  for (let i = 1; i < out.history.length; i++) {
    assert.ok(out.history[i].bestEnergyPerAtom <= out.history[i - 1].bestEnergyPerAtom + 1e-12,
      `最优应单调不升：${out.history[i - 1].bestEnergyPerAtom} → ${out.history[i].bestEnergyPerAtom}`)
  }
  assert.equal(out.best.converged, true)
  assert.ok(out.note.includes('basin-hopping') && out.note.includes('无 GP'), '诚实声明方法边界')
  // 每次回算一条 converged 事件，含 workflow:active-learning
  assert.equal(events.length, out.evaluations)
  assert.ok(events.every(e => e.workflow === 'active-learning'))
})

test('2. 同种子确定性复现（同序列 → 同最优能量与来源轮次）', async () => {
  const a = await runActiveLearning({ reference: await makeRef(), sampler: fakeSampler, potential: fakePotential(), rounds: 3, candidatesPerRound: 6, seed: 7 })
  const b = await runActiveLearning({ reference: await makeRef(), sampler: fakeSampler, potential: fakePotential(), rounds: 3, candidatesPerRound: 6, seed: 7 })
  assert.equal(a.best.energyPerAtom, b.best.energyPerAtom)
  assert.equal(a.best.source, b.best.source)
  assert.deepEqual(a.history.map(h => h.bestEnergyPerAtom), b.history.map(h => h.bestEnergyPerAtom))
})

test('3. 能量确有下降（相对种子基线）且历史可溯源', async () => {
  const reference = await makeRef()
  const out = await runActiveLearning({ reference, sampler: fakeSampler, potential: fakePotential(), rounds: 8, candidatesPerRound: 8, seed: 123, sigma: 0.3 })
  assert.ok(out.best.energyPerAtom < out.history[0].bestEnergyPerAtom, '多轮应把最优能量降到种子基线以下')
  assert.ok(out.history.some(h => h.round > 0 && h.improved), '至少一轮改进')
})

test('4. 缺依赖/非法参数显式报错，不静默', async () => {
  const reference = await makeRef()
  const p = fakePotential()
  await assert.rejects(() => runActiveLearning({ reference, potential: p, rounds: 1 }), e => e.code === 'AL_SAMPLER_MISSING')
  await assert.rejects(() => runActiveLearning({ reference, sampler: fakeSampler, rounds: 1 }), e => e.code === 'AL_POTENTIAL_MISSING')
  await assert.rejects(() => runActiveLearning({ reference, sampler: fakeSampler, potential: p, rounds: 0 }), e => e.code === 'AL_BAD_ROUNDS')
})
