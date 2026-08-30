// ⑩ 锚点引导混合提案的工具层（Agent 面）：
//   sampler.anchor.add —— 闭环产出的参考结构入会话锚点库（谱系必填门禁在工具层生效）
//   sampler.mixture    —— 会话库检索 / 内联锚点 → OU 混合提案（似然 exact，候选不自证声明随交付）
// 纪律实证：无谱系不入库、空库不伪造锚点（ANCHOR_EMPTY）、权重不静默补全、
// 拓扑门禁先于采样、两条路径共用同一条纯层目标构造（门禁不另开旁路）。
// 泄漏防护：断言入 try，finally 保证 dispose（测试进程不得挂起掩盖失败）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/index.mjs'

// 轻量材料服务桩：只提供 sampler.anchor.add 材料入库路径所需的 get（不拉真引擎）
const graphCu4 = {
  nodes: [
    { number: 29, position: [0, 0, 0] },
    { number: 29, position: [1.8, 0, 0] },
    { number: 29, position: [0, 1.8, 0] },
    { number: 29, position: [1.8, 1.8, 0] },
  ],
  edges: [],
}
const graphCu3Ag = {
  nodes: [
    { number: 29, position: [0, 0, 0] },
    { number: 29, position: [1.8, 0, 0] },
    { number: 29, position: [0, 1.8, 0] },
    { number: 47, position: [1.8, 1.8, 0] },
  ],
  edges: [],
}
const materials = {
  cu4: { id: 'cu4', formula: 'Cu4', graph: graphCu4 },
  cu3ag: { id: 'cu3ag', formula: 'Cu3Ag', graph: graphCu3Ag },
}

async function mountSampler() {
  const ctx = new Context()
  ctx.provide('material', { get: async (id) => {
    if (!materials[id]) throw new Error(`MATERIAL_NOT_FOUND: ${id}`)
    return materials[id]
  } })
  const fiber = await ctx.registry.plugin({ name: 'saturday-sampler-ou', apply: (c) => plugin.apply(c, {}) })
  return { ctx, fiber, handles: fiber.store.saturdaySamplerOu }
}

test('1. sampler.anchor.add：谱系必填门禁在工具层生效（材料入库缺省声明 / 直交付无谱系即拒）', async () => {
  const { fiber, handles } = await mountSampler()
  try {
    // 材料入库：来源声明缺省 = 材料身份（出处可追溯），组分从原子序机械提取
    const added = await handles.rt.tools.call('sampler.anchor.add', { materialId: 'cu4' })
    assert.equal(added.added, true)
    assert.equal(added.size, 1)
    assert.equal(added.entry.source, 'material:cu4')
    assert.deepEqual(added.entry.composition, { Cu: 4 }, '组分从结构节点原子序机械提取')
    assert.equal(added.entry.graph, undefined, '锚点本体不外泄（检索与采样在库内消费）')
    // 直交付无谱系：拒绝入库（无来源声明的数据不入库）
    await assert.rejects(
      handles.rt.tools.call('sampler.anchor.add', { graph: graphCu4 }),
      /source|谱系/,
    )
    assert.equal(handles.anchorStore.size(), 1, '被拒锚点不得入库')
  } finally {
    await fiber.dispose()
  }
})

test('2. sampler.mixture（内联锚点）：单次调用即用，配额/似然/谱系诚实交付', async () => {
  const { fiber, handles } = await mountSampler()
  try {
    const result = await handles.rt.tools.call('sampler.mixture', {
      anchors: [
        { graph: graphCu4, source: 'inline:cu4', composition: { Cu: 1 } },
        { graph: graphCu3Ag, source: 'inline:cu3ag', composition: { Cu: 3, Ag: 1 } },
      ],
      weights: [0.4, 0.6],
      composition: { Cu: 3, Ag: 1 },
      n: 10, seed: 3,
    })
    assert.equal(result.anchorOrigin, 'inline')
    assert.equal(result.likelihood, 'exact')
    assert.equal(result.n, 10)
    // 配额正比于混合权重（最大余数法）：0.4/0.6 → 4/6
    const per = [0, 0]
    for (const c of result.candidates) per[c.anchorIndex] += 1
    assert.deepEqual(per, [4, 6], '配额正比于混合权重')
    for (const c of result.candidates) {
      assert.ok(Number.isFinite(c.logProb), '逐候选附可独立重算的混合似然')
      assert.match(c.source, /#mixture#seed=3#anchor=/, '候选谱系记录所属锚点（谱系不断）')
    }
    assert.match(result.note, /候选不自证/, '候选不自证声明随交付呈现')
    // 内联路径不入会话库（单次调用即用）
    assert.equal(handles.anchorStore.size(), 0)
    // 权重长度与锚点数不一致：不静默补全
    await assert.rejects(
      handles.rt.tools.call('sampler.mixture', {
        anchors: [{ graph: graphCu4, source: 'inline:cu4' }],
        weights: [0.5, 0.5],
        n: 2, seed: 1,
      }),
      /weights/,
    )
  } finally {
    await fiber.dispose()
  }
})

test('3. sampler.mixture（会话库）：拓扑门禁前置 + 空库拒伪造 + 检索排序随交付呈现 + 确定性', async () => {
  const { fiber, handles } = await mountSampler()
  try {
    // 会话库路径缺 nAtoms：拓扑门禁前置拒绝
    await assert.rejects(
      handles.rt.tools.call('sampler.mixture', { n: 2, seed: 1 }),
      /nAtoms/,
    )
    // 空库检索：不得构造混合目标（不伪造锚点）
    await assert.rejects(
      handles.rt.tools.call('sampler.mixture', { nAtoms: 4, n: 2, seed: 1 }),
      /ANCHOR_EMPTY|锚点/,
    )
    // 闭环积累：两个已注册材料入库（来源声明 = 材料身份）
    await handles.rt.tools.call('sampler.anchor.add', { materialId: 'cu4' })
    await handles.rt.tools.call('sampler.anchor.add', { materialId: 'cu3ag' })
    const result = await handles.rt.tools.call('sampler.mixture', {
      nAtoms: 4, composition: { Cu: 3, Ag: 1 }, n: 6, seed: 7,
    })
    assert.equal(result.anchorOrigin, 'session-store')
    assert.equal(result.anchors.length, 2)
    assert.equal(result.anchors[0].source, 'material:cu3ag', '组分最近锚点排首（L1 距离升序）')
    assert.equal(result.anchors[0].distance, 0, '入库组分从原子序机械提取，与查询组分一致 → 距离 0')
    assert.equal(result.anchors[1].distance, 0.5, 'cu4 锚点与查询组分的 L1 距离如实呈现（|0−0.25|×2 = 0.5）')
    assert.equal(result.n, 6)
    // 确定性：同参数二次调用逐候选一致（种子纪律延伸到工具层）
    const again = await handles.rt.tools.call('sampler.mixture', {
      nAtoms: 4, composition: { Cu: 3, Ag: 1 }, n: 6, seed: 7,
    })
    assert.deepEqual(again.candidates.map(c => c.logProb), result.candidates.map(c => c.logProb))
    // 跨拓扑检索：不同节点数无匹配 → 依旧拒伪造（拓扑硬门禁先于采样）
    await assert.rejects(
      handles.rt.tools.call('sampler.mixture', { nAtoms: 3, n: 2, seed: 1 }),
      /ANCHOR_EMPTY|锚点/,
    )
  } finally {
    await fiber.dispose()
  }
})
