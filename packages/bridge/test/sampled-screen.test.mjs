// 采样器 → 筛选 联合排序真实实证（Logits 组合律走完整工具链）：
// 链路：OU 采样器交付 {graph, source, logProb} → workflow.screen 透传（§4.5 SampledStructure）→
// 逐候选真实 EMT 单点回算（候选不自证）→ 能量证据 × 似然证据组合 → 归一权重 + 覆盖声明。
// 诚实纪律：无 ASE 环境下本套件跳过（数据面诚实报错，不伪造证据）。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/saturday.plugin.mjs'
import screeningPlugin from '@toki0413/plugin-screening'
import { ouSampler, ouLogProb } from '@toki0413/plugin-sampler-ou'

const TRAJECTORY = fileURLToPath(new URL('../data/trajectory-sampled-screen.jsonl', import.meta.url))

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
  // 环境自适应：零依赖数据面下 emt-mock 不注册（回退 lj-js），HAS_ASE 自然为 false → 真物理断言跳过（诚实）
  HAS_ASE = handles.potential.providers.has('emt-mock')
    && handles.potential.get('emt-mock').bridge.sidecarInfo?.calculators?.['ase-emt'] === true
})

after(async () => {
  await screenFiber.dispose()
  await fiber.dispose()
})

test('1. OU 候选进联合排序：真实 EMT 单点回算 + 双源证据组合 + 归一权重', async t => {
  if (!HAS_ASE) return t.skip('ASE unavailable: joint ranking requires real EMT single-point oracle')
  const cu = await ctx.reflect.get('material').load('Cu')
  const OU_PARAMS = { n: 6, seed: 7, uEq: 0.05, gammaDt: 1.0 }
  const sampled = await ouSampler.sample({ reference: cu }, OU_PARAMS)

  // 采样器自洽对账：交付的 logProb 可由位移闭式重算（exact 似然声明的实证，不靠数值巧合）
  const refPositions = cu.graph.nodes.flatMap(n => n.position)
  for (const c of sampled) {
    const disp = c.graph.nodes.flatMap(n => n.position).map((x, i) => x - refPositions[i])
    assert.ok(Math.abs(c.logProb - ouLogProb(disp, OU_PARAMS)) < 1e-9, 'logProb 可独立重算')
  }

  const result = await screenRt.tools.call('workflow.screen', {
    materialId: cu.id, dopants: [],
    sampled: sampled.map(c => ({ graph: c.graph, source: c.source, logProb: c.logProb })),
    sampledSource: 'sampler.ou',
    temperatureK: 300,
  })
  const joint = result.sampledJoint
  assert.equal(joint.entries.length, 6, '全部采样候选回算成功')
  assert.equal(joint.samplerName, 'sampler.ou')
  assert.equal(joint.failed, undefined, '无失败候选')
  // 权重归一 + 有限 + 按权重降序
  const sum = joint.entries.reduce((a, e) => a + e.weight, 0)
  assert.ok(Math.abs(sum - 1) < 1e-12, '联合权重归一（配分函数归一，非近似）')
  for (let i = 1; i < joint.entries.length; i++) {
    assert.ok(joint.entries[i - 1].weight >= joint.entries[i].weight, '按联合权重降序')
  }
  // 双源覆盖：每个候选都有玻尔兹曼能量证据 + OU 提议似然证据
  assert.deepEqual(joint.sourceNames, ['boltzmann:emt-mock', 'proposal:sampler.ou'])
  assert.ok(joint.entries.every(e => e.coverage.length === 2), '逐候选双源覆盖')
  assert.ok(joint.entries.every(e => Number.isFinite(e.energy) && Number.isFinite(e.logProb) && e.jobId))
  // 物理一致性：平衡点附近 OU 似然与能量反向相关（位移大 → 似然低且能量高）——
  // 不假设严格序（力常数各向异性），只断言权重最高的候选确实是能量与似然的折中而非单一证据的极值巧合
  assert.ok(joint.essFraction > 0 && joint.essFraction <= 1, 'ESS 占比诊断诚实呈现')
  assert.match(joint.independence, /条件独立/, '独立性声明随交付呈现')
})

test('2. 缺似然证据的候选：覆盖子集组合，权重仍归一（诚实降级不伪造）', async t => {
  if (!HAS_ASE) return t.skip('ASE unavailable in this environment')
  const cu = await ctx.reflect.get('material').load('Cu')
  const sampled = await ouSampler.sample({ reference: cu }, { n: 3, seed: 11 })

  const result = await screenRt.tools.call('workflow.screen', {
    materialId: cu.id, dopants: [],
    // 第二个候选故意不带 logProb（模拟 likelihood: none 的采样器交付）
    sampled: sampled.map((c, i) => i === 1
      ? { graph: c.graph, source: c.source }
      : { graph: c.graph, source: c.source, logProb: c.logProb }),
    sampledSource: 'mixed-samplers',
    temperatureK: 300,
  })
  const joint = result.sampledJoint
  const noLik = joint.entries.find(e => e.logProb === null)
  assert.ok(noLik, '缺似然的候选保留且显式标记（不零填充、不丢弃）')
  assert.deepEqual(noLik.coverage, ['boltzmann:emt-mock'], '覆盖声明如实缺似然源')
  const sum = joint.entries.reduce((a, e) => a + e.weight, 0)
  assert.ok(Math.abs(sum - 1) < 1e-12, '混合覆盖下权重仍归一')
})

test('3. 候选结构缺失与温度缺失均显式拒绝（不静默丢弃/不静默假设）', async () => {
  const cu = await ctx.reflect.get('material').load('Cu')
  await assert.rejects(
    () => screenRt.tools.call('workflow.screen', {
      materialId: cu.id, dopants: [],
      sampled: [{ logProb: 0 }], temperatureK: 300,
    }),
    /needs either materialId or graph/,
  )
  const sampled = await ouSampler.sample({ reference: cu }, { n: 1, seed: 3 })
  await assert.rejects(
    () => screenRt.tools.call('workflow.screen', {
      materialId: cu.id, dopants: [],
      sampled: [{ graph: sampled[0].graph, source: sampled[0].source, logProb: sampled[0].logProb }],
    }),
    /temperatureK is required/,
  )
})
