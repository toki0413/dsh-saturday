// @saturday/plugin-replay 测试
// 纯函数层：解析容错 / 索引重建；插件层：工具回放真实轨迹文件；
// 集成层：跑真实筛选 → 回放 → 索引与计算对账（含防回灌验证）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import bridgePlugin from '@saturday/bridge'
import plugin, { parseTrajectory, rebuildIndex, indexToSummary } from '../src/index.mjs'

// ── 真实形状的轨迹记录（对齐 packages/bridge 的落盘格式）──
const rec = (id, formula, energy, extra = {}) => JSON.stringify({
  type: 'material_calculation_complete',
  jobId: `job-${id}`,
  material: { id, formula },
  result: { energy, nSteps: 5 },
  engine: 'emt-mock',
  ...extra,
})

test('1. 解析容错：坏行跳过计数，空行忽略，好行保留', () => {
  const text = [rec('m1', 'Cu', -0.01), 'not-json{{', '', rec('m2', 'Cu3Ag', 0.06)].join('\n')
  const { records, skipped } = parseTrajectory(text)
  assert.equal(records.length, 2)
  assert.equal(skipped, 1)
})

test('2. 索引重建：按材料聚合，引擎/工作流集合化，最优能量取自 result.energy', () => {
  const { records } = parseTrajectory([
    rec('m1', 'Cu', -0.02, { workflow: 'screen' }),
    rec('m1', 'Cu', -0.03),                       // 同一材料复算（更优）
    rec('m2', 'Cu3Ag', 0.06, { workflow: 'screen' }),
    JSON.stringify({ type: 'lifecycle', note: 'no material' }),   // 无 material：不进索引
  ].join('\n'))
  const index = rebuildIndex(records)
  assert.equal(index.size, 2)

  const summary = indexToSummary(index)
  const cu = summary.find(s => s.materialId === 'm1')
  assert.equal(cu.calculationCount, 2)
  assert.equal(cu.bestEnergy, -0.03)
  assert.deepEqual(cu.engines, ['emt-mock'])
  assert.deepEqual(cu.workflows, ['screen'])
})

test('3. 工具：缺路径显式报错；回放返回索引摘要', async () => {
  const ctx = new Context()
  const dir = await mkdtemp(join(tmpdir(), 'saturday-replay-'))
  const path = join(dir, 'trajectory.jsonl')
  await writeFile(path, [rec('m1', 'Cu', -0.02), rec('m2', 'Cu3Ag', 0.06)].join('\n'))

  const fiber = await ctx.registry.plugin({
    name: 'saturday-replay',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  const { rt } = fiber.store.saturdayReplay

  await assert.rejects(
    () => rt.tools.call('trajectory.replay', {}),
    /requires trajectoryPath/,
  )

  const out = await rt.tools.call('trajectory.replay', { trajectoryPath: path })
  assert.equal(out.replayed, 2)
  assert.equal(out.skipped, 0)
  assert.equal(out.materials.length, 2)
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('4. reemit：重放事件带防回灌前缀，监听者在 fiber 内照常收到', async () => {
  const ctx = new Context()
  const dir = await mkdtemp(join(tmpdir(), 'saturday-replay-'))
  const path = join(dir, 'trajectory.jsonl')
  await writeFile(path, rec('m1', 'Cu', -0.02), 'utf8')

  // 监听器必须在 fiber 作用域内（根上下文裸监听会让 emit 报错）
  const coreFiber = await ctx.registry.plugin({
    name: 'stub-listener',
    apply(ctx) {
      const seen = []
      ctx.events.on('saturday/replay/material_calculation_complete', r => seen.push(r))
      ctx.fiber.store.seen = seen
    },
  })
  const fiber = await ctx.registry.plugin({
    name: 'saturday-replay',
    apply: (ctx) => plugin.apply(ctx, { trajectoryPath: path }),
  })
  const { rt } = fiber.store.saturdayReplay

  await rt.tools.call('trajectory.replay', { reemit: true })
  const seen = coreFiber.store.seen
  assert.equal(seen.length, 1)
  assert.equal(seen[0].material.formula, 'Cu')

  await fiber.dispose()
  await coreFiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('5. 集成：真实筛选 → 回放 → 索引对账；回放不产生新轨迹记录（防回灌）', async () => {
  const ctx = new Context()
  const dir = await mkdtemp(join(tmpdir(), 'saturday-replay-'))
  const path = join(dir, 'trajectory.jsonl')

  const coreFiber = await ctx.registry.plugin({
    name: 'saturday',
    apply: (ctx) => bridgePlugin.apply(ctx, { trajectoryPath: path }),
  })
  const screenFiber = await ctx.registry.plugin({
    name: 'saturday-screening',
    apply: async (ctx) => {
      const { default: screeningPlugin } = await import('@saturday/plugin-screening')
      return screeningPlugin.apply(ctx, { trajectoryPath: path })
    },
  })
  const replayFiber = await ctx.registry.plugin({
    name: 'saturday-replay',
    apply: (ctx) => plugin.apply(ctx, { trajectoryPath: path }),
  })

  const coreRt = coreFiber.store.saturday.rt
  const screenRt = screenFiber.store.saturdayScreening.rt
  const replayRt = replayFiber.store.saturdayReplay.rt

  // 跑一次真实筛选（Cu + Ag/Ni 掺杂）
  const loaded = await coreRt.tools.call('material.load', { query: 'Cu' })
  await screenRt.tools.call('workflow.screen', { materialId: loaded.materialId, dopants: ['Ag', 'Ni'] })
  await new Promise(r => setTimeout(r, 100))   // 事件异步落盘
  const lineCountBefore = (await readFile(path, 'utf8')).trim().split('\n').length

  // 回放（开 reemit，验证防回灌：轨迹写入监听器不会把回放当新计算）
  const out = await replayRt.tools.call('trajectory.replay', { reemit: true })
  assert.equal(out.replayed, 3, '三个变体各一条记录')
  assert.equal(out.skipped, 0)

  const formulas = out.materials.map(m => m.formula).sort()
  assert.deepEqual(formulas, ['Cu', 'Cu3Ag', 'Cu3Ni'])
  // 数据面自适应：回放索引的引擎集合如实反映当前数据面（emt-mock / lj-js 回退档）
  const dataPlane = coreFiber.store.saturday.dataPlane
  for (const m of out.materials) {
    assert.deepEqual(m.engines, [dataPlane])
    assert.ok(Number.isFinite(m.bestEnergy))
  }
  const screenVariants = out.materials.filter(m => m.workflows.includes('screen'))
  assert.equal(screenVariants.length, 3, '筛选工作流标记可回放')

  await new Promise(r => setTimeout(r, 100))
  const lineCountAfter = (await readFile(path, 'utf8')).trim().split('\n').length
  assert.equal(lineCountAfter, lineCountBefore, '回放不产生新轨迹记录（防回灌）')

  await replayFiber.dispose()
  await screenFiber.dispose()
  await coreFiber.dispose()
  await rm(dir, { recursive: true, force: true })
})
