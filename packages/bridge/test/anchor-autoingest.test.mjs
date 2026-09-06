//  闭环轨迹自动入库：
// 弛豫收敛 + 引擎交付终态结构 → 弛豫后结构自动入锚点库（谱系自动声明，出处可追溯）。
// 三道门禁的否定路径同样实证：未收敛不入库、旧协议（无终态交付）不入库、幂等。
// 泄漏防护（纪律）：挂载即拉起 Python sidecar，前置断言入 try，finally 保证 dispose。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/saturday.plugin.mjs'
import samplerOuPlugin from '@toki0413/plugin-sampler-ou'

const TRAJECTORY = fileURLToPath(new URL('../data/trajectory-anchor-autoingest.jsonl', import.meta.url))

async function mount() {
  await rm(TRAJECTORY, { force: true })
  const ctx = new Context()
  const fiber = await ctx.registry.plugin({
    name: 'saturday',
    apply: (ctx) => plugin.apply(ctx, { trajectoryPath: TRAJECTORY }),
  })
  const samplerFiber = await ctx.registry.plugin({
    name: 'saturday-sampler-ou',
    apply: (ctx) => samplerOuPlugin.apply(ctx, {}),
  })
  return { ctx, fiber, samplerFiber, handles: fiber.store.saturday, sampler: samplerFiber.store.saturdaySamplerOu }
}

test('1. 收敛 + 终态交付 → 弛豫后结构自动入库（谱系自动声明 + 幂等）', async () => {
  const { fiber, samplerFiber, handles, sampler } = await mount()
  try {
    const cu = await handles.materialService.load('Cu')
    const r1 = await handles.rt.tools.call('potential.relax', { materialId: cu.id, simulatedSeconds: 0 })
    assert.equal(r1.converged, true, '数据面引擎弛豫收敛（前提）')
    assert.ok(Array.isArray(r1.positions), '引擎交付终态坐标（前提）')

    const entries = sampler.anchorStore.entries()
    assert.equal(sampler.anchorStore.size(), 1, '收敛弛豫自动入库一次')
    const e = entries[0]
    // 数据面自适应：谱系引擎名如实反映当前数据面（emt-mock / lj-js 回退档）
    const dataPlane = handles.dataPlane
    assert.match(e.source, new RegExp(`^job:.+#engine=${dataPlane}$`), '谱系自动声明：job:<id>#engine=<name>（出处可追溯）')
    assert.deepEqual(e.composition, { Cu: 4 }, '组分从终态原子序机械提取')
    assert.ok(typeof e.energy === 'number' && Number.isFinite(e.energy), '闭环能量随锚点记录')
    // 弛豫后结构 ≠ 输入结构（引擎统一缩放：坐标按 scale 变化）
    const scale = r1.scale ?? 1
    if (Math.abs(scale - 1) > 1e-9) {
      const pos0 = cu.graph.nodes[0].position
      assert.ok(e.graph.nodes[0].position.some((x, i) => Math.abs(x - pos0[i]) > 1e-12),
        '入库的是弛豫后终态（不是输入结构冒充）')
    }

    // 幂等：同 jobId 事件不重复累计（重放语义安全）
    const { rt } = handles
    await rt.emit('saturday/simulation/converged', {
      type: 'saturday/simulation/converged',
      payload: {
        jobId: r1.jobId,
        material: { id: cu.id, formula: cu.formula },
        result: { energy: r1.energy, nSteps: r1.n_steps, converged: true },
        engine: dataPlane,
        relaxedStructure: e.graph,
      },
    })
    assert.equal(sampler.anchorStore.size(), 1, '同来源重复事件幂等（不重复累计）')
  } finally {
    await samplerFiber.dispose()
    await fiber.dispose()
  }
})

test('2. 未收敛不入库（不收敛的结构不是盆地底，入库即伪造数据燃料）', async () => {
  const { fiber, samplerFiber, handles, sampler } = await mount()
  try {
    // 假引擎：收敛失败但交付终态（门禁  只看 converged，不被终态在场诱导）
    handles.potential.register({
      name: 'fake-unconverged',
      manifest: {
        capabilities: [{ type: 'relax', accuracy: 0.5, speed: 0.9, cost: 0.1, maxAtoms: 100 }],
        constraints: { requiresLicense: false },
        eventGranularity: 'job',
        units: { energy: 'eV', length: 'Å', time: 'fs' },
        fingerprint: { software: 'fake', method: 'mock', version: 'unknown' },
      },
      async relax(material) {
        return {
          jobId: 'job-unconverged', engine: 'fake-unconverged',
          converged: false, energy: 0.1, n_steps: 200,
          positions: material.graph.nodes.map(n => n.position),
          cell: material.graph.cell,
        }
      },
    })
    await handles.potential.activate('fake-unconverged')
    const cu = await handles.materialService.load('Cu')
    await handles.rt.tools.call('potential.relax', { materialId: cu.id, engine: 'fake-unconverged' })
    assert.equal(sampler.anchorStore.size(), 0, '未收敛：终态在场也不入库')
  } finally {
    await samplerFiber.dispose()
    await fiber.dispose()
  }
})

test('3. 旧协议（无终态交付）不入库（诚实缺省，不拿输入结构冒充弛豫产物）', async () => {
  const { fiber, samplerFiber, handles, sampler } = await mount()
  try {
    // 假引擎：收敛成功但不返回终态坐标（旧协议形态）
    handles.potential.register({
      name: 'fake-legacy',
      manifest: {
        capabilities: [{ type: 'relax', accuracy: 0.5, speed: 0.9, cost: 0.1, maxAtoms: 100 }],
        constraints: { requiresLicense: false },
        eventGranularity: 'job',
        units: { energy: 'eV', length: 'Å', time: 'fs' },
        fingerprint: { software: 'fake', method: 'mock', version: 'unknown' },
      },
      async relax() {
        return { jobId: 'job-legacy', engine: 'fake-legacy', converged: true, energy: -0.5, n_steps: 3 }
      },
    })
    await handles.potential.activate('fake-legacy')
    const cu = await handles.materialService.load('Cu')
    await handles.rt.tools.call('potential.relax', { materialId: cu.id, engine: 'fake-legacy' })
    assert.equal(sampler.anchorStore.size(), 0, '无终态交付：收敛也不入库（不拿输入结构冒充）')
  } finally {
    await samplerFiber.dispose()
    await fiber.dispose()
  }
})
