// 跨会话恢复端到端（数据燃料续供实证）：
// 旧会话落盘（调用方显式声明路径）→ 全部回收（会话终结）→ 新挂载空库加载
// （门禁与导入工具同款）→ 回填锚点即刻参与混合提案：谱系可追溯、来源层
// `session-store`、行为级无损（同参数两次提案逐候选严格一致——落盘往返
// 不丢任何影响采样行为的信息）。
// 泄漏防护（纪律）：挂载即拉起 Python sidecar，前置断言入 try，finally 保证 dispose + 临时目录清理。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/saturday.plugin.mjs'
import samplerOuPlugin from '@toki0413/plugin-sampler-ou'

const TRAJECTORY = fileURLToPath(new URL('../data/trajectory-anchor-resume.jsonl', import.meta.url))

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
  return {
    fiber, samplerFiber,
    handles: fiber.store.saturday,
    sampler: samplerFiber.store.saturdaySamplerOu,
  }
}

async function dispose(env) {
  await env.samplerFiber.dispose()
  await env.fiber.dispose()
}

const MIXTURE_ARGS = { nAtoms: 4, composition: { Cu: 3, Ag: 1 }, weights: [0.6, 0.4], n: 6, seed: 5, uEq: 0.05, gammaDt: 1.0 }

test('1. 跨会话恢复：落盘→回收→新库加载→回填锚点即刻参与闭环（谱系不断）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-anchor-resume-'))
  const sessionA = await mount()
  const sessionB = await mount()
  try {
    // 旧会话：闭环产物入库（谱系 = 材料身份）→ 落盘 → 会话终结（全部回收）
    const cu = await sessionA.handles.materialService.load('Cu')
    const cu3ag = cu.substitute(0, 'Ag')
    sessionA.sampler.anchorStore.add({ graph: cu.graph, source: 'material:cu-anchor', composition: { Cu: 4 } })
    sessionA.sampler.anchorStore.add({ graph: cu3ag.graph, source: 'material:cu3ag-anchor', composition: { Cu: 3, Ag: 1 }, energy: -1.25 })
    const path = join(dir, 'session-a.json')
    const saved = await sessionA.sampler.rt.tools.call('sampler.anchor.save', { path })
    assert.equal(saved.saved, true)
    assert.equal(saved.size, 2)
    await dispose(sessionA)   // 会话 A 终结：库随会话回收，只剩磁盘载荷

    // 新会话：空库加载（门禁与导入工具同款）→ 即刻参与混合提案
    assert.equal(sessionB.sampler.anchorStore.size(), 0, '新会话库初始为空（不伪造库外数据）')
    const loaded = await sessionB.sampler.rt.tools.call('sampler.anchor.load', { path })
    assert.equal(loaded.added, 2)
    const mixture = await sessionB.sampler.rt.tools.call('sampler.mixture', MIXTURE_ARGS)
    assert.equal(mixture.anchorOrigin, 'session-store', '回填锚点经会话库路径参与提案')
    assert.equal(mixture.anchors.length, 2, '两枚回填锚点全部被检索命中')
    assert.deepEqual(mixture.anchors.map(a => a.source.split('#')[0]).sort(),
      ['material:cu-anchor', 'material:cu3ag-anchor'], '谱系跨会话保留（可追溯不断）')
    assert.equal(mixture.candidates.length, 6, '配额照常：回填锚点即刻是数据燃料')
  } finally {
    await dispose(sessionB)
    await rm(dir, { recursive: true, force: true })
  }
})

test('2. 行为级无损对账：落盘往返不影响采样行为（同参数逐候选严格一致）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-anchor-lossless-'))
  const sessionA = await mount()
  const sessionB = await mount()
  try {
    const cu = await sessionA.handles.materialService.load('Cu')
    const cu3ag = cu.substitute(0, 'Ag')
    sessionA.sampler.anchorStore.add({ graph: cu.graph, source: 'material:cu-anchor', composition: { Cu: 4 } })
    sessionA.sampler.anchorStore.add({ graph: cu3ag.graph, source: 'material:cu3ag-anchor', composition: { Cu: 3, Ag: 1 } })
    // 原库提案（基线）
    const before = await sessionA.sampler.rt.tools.call('sampler.mixture', MIXTURE_ARGS)
    // 落盘 → 新会话加载 → 同参数提案
    const path = join(dir, 'lossless.json')
    await sessionA.sampler.rt.tools.call('sampler.anchor.save', { path })
    await sessionB.sampler.rt.tools.call('sampler.anchor.load', { path })
    const after = await sessionB.sampler.rt.tools.call('sampler.mixture', MIXTURE_ARGS)
    // 行为级无损：逐候选结构/似然/锚点归属严格一致（无损不只是字段齐全，是不改变任何采样行为）
    assert.equal(after.candidates.length, before.candidates.length)
    for (let i = 0; i < before.candidates.length; i++) {
      assert.deepEqual(after.candidates[i].graph, before.candidates[i].graph, `候选[${i}] 结构逐坐标一致`)
      assert.equal(after.candidates[i].logProb, before.candidates[i].logProb, `候选[${i}] 似然一致`)
      assert.equal(after.candidates[i].anchorIndex, before.candidates[i].anchorIndex, `候选[${i}] 锚点归属一致`)
      assert.equal(after.candidates[i].source, before.candidates[i].source, `候选[${i}] 谱系一致`)
    }
  } finally {
    await dispose(sessionA)
    await dispose(sessionB)
    await rm(dir, { recursive: true, force: true })
  }
})
