// 旗舰端到端：生成式提议器（RSS 随机结构搜索 + 仿射耦合流）喂进 workflow.explore 的
// 可插拔 sampler（#115 解锁）→ 候选不自证、逐候选引擎回算弛豫 → 能量排序 → 谱系可溯。
// 一份 sampler seam、两种生成器（rss 成分约束随机 / affine-flow 参考邻域双射输运），同一回算闭环。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import bridgePlugin from '../src/saturday.plugin.mjs'
import rssPlugin from '@toki0413/plugin-rss'
import flowPlugin from '@toki0413/plugin-sampler-flow'
import explorePlugin from '@toki0413/plugin-explore'

async function boot() {
  const ctx = new Context()
  const core = await ctx.registry.plugin({ name: 'saturday', apply: (c) => bridgePlugin.apply(c, { quiet: true }) })
  await ctx.registry.plugin({ name: 'saturday-sampler-rss', apply: (c) => rssPlugin.apply(c, {}) })
  await ctx.registry.plugin({ name: 'saturday-sampler-flow', apply: (c) => flowPlugin.apply(c, {}) })
  const explore = await ctx.registry.plugin({ name: 'saturday-explore', apply: (c) => explorePlugin.apply(c, {}) })
  const { rt } = core.store.saturday
  const eRt = explore.store.saturdayExplore.rt
  return { ctx, core, rt, eRt, async close() { await explore.dispose(); await core.dispose() } }
}

for (const sampler of ['rss', 'affine-flow']) {
  test(`生成式提议器 ${sampler} → workflow.explore 端到端回算闭环`, async () => {
    const h = await boot()
    try {
      const cu = await h.rt.tools.call('material.load', { query: 'Cu' })
      const out = await h.eRt.tools.call('workflow.explore', { referenceId: cu.materialId ?? cu.id, sampler, n: 6, seed: 7 })
      assert.ok(Array.isArray(out.ranked) && out.ranked.length >= 1, '回算排序非空')
      assert.ok(out.ranked.every(r => Number.isFinite(r.energyPerAtom)), '候选能量均为引擎回算有限值')
      assert.ok(out.ranked.some(r => String(r.source).startsWith('generative:')), '候选带 generative 谱系')
      assert.ok(out.ranked.some(r => r.kind === 'reference'), '参考结构自证在环内（dE 基线，按能量参与排序、位次不固定）')
      assert.equal(out.failed.length, 0, '生成→回算无吞错')
      // 排序非透传：按 energyPerAtom 单调不升序
      for (let i = 1; i < out.ranked.length; i++) {
        assert.ok(out.ranked[i].energyPerAtom >= out.ranked[i - 1].energyPerAtom - 1e-12, '按能量升序（小在前）')
      }
    } finally { await h.close() }
  })
}
