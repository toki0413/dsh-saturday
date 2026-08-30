// ㉔ 持久化落盘侧：库间搬运原语的文件端（导出载荷 ↔ 磁盘）——
// save 落盘（无损 JSON，路径调用方显式声明）→ 新会话 load 回填（门禁与导入工具同款）；
// 错误路径如实：文件缺失/损坏/非载荷形态显式报错（不静默返回空库冒充成功）。
// 泄漏防护（纪律）：挂载即拉起 Python sidecar，前置断言入 try，finally 保证 dispose + 临时目录清理。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import plugin, { trajectoryTriggerAssessment } from '../src/index.mjs'

const graph4 = {
  nodes: Array.from({ length: 4 }, (_, i) => ({ number: 29, position: [i * 1.8, 0, 0] })),
  edges: [],
  periodic: true,
  cell: [[8, 0, 0], [0, 8, 0], [0, 0, 8]],
}

async function mount() {
  const ctx = new Context()
  ctx.provide('material', { get: async () => { throw new Error('stub: material not needed') } })
  const fiber = await ctx.registry.plugin({ name: 'saturday-sampler-ou', apply: (ctx) => plugin.apply(ctx, {}) })
  return { fiber, handles: fiber.store.saturdaySamplerOu }
}

test('1. 落盘→跨会话回填：新库 load 后逐字段一致且即刻可提案', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-anchor-save-'))
  const src = await mount()
  const dst = await mount()
  try {
    src.handles.anchorStore.add({ graph: graph4, source: 'material:cu-a', composition: { Cu: 4 } })
    src.handles.anchorStore.add({ graph: graph4, source: 'job:j-9#engine=emt-mock', composition: { Cu: 3, Ag: 1 }, energy: -0.75 })
    const path = join(dir, 'anchors.json')
    const saved = await src.handles.rt.tools.call('sampler.anchor.save', { path })
    assert.equal(saved.saved, true)
    assert.equal(saved.size, 2)

    const loaded = await dst.handles.rt.tools.call('sampler.anchor.load', { path })
    assert.equal(loaded.loaded, true)
    assert.equal(loaded.added, 2)
    const restored = dst.handles.anchorStore.entries()
    assert.equal(restored[0].source, 'material:cu-a')
    assert.equal(restored[1].energy, -0.75, '能量随落盘载荷回填不丢')
    assert.equal(restored[1].graph.nodes.length, 4, 'graph 本体随落盘载荷回填不丢')
    // 回填锚点即刻可提案（跨会话数据燃料续供的价值闭环）
    const mixture = await dst.handles.rt.tools.call('sampler.mixture', {
      nAtoms: 4, composition: { Cu: 4 }, n: 2, seed: 1,
    })
    assert.equal(mixture.anchors.length, 2)
  } finally {
    await src.fiber.dispose()
    await dst.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('2. 错误路径如实：文件缺失/损坏/非载荷形态显式报错（不静默冒充成功）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-anchor-load-'))
  const env = await mount()
  try {
    // 文件缺失：显式错（不静默返回空库冒充成功）
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.load', { path: join(dir, 'missing.json') }),
      err => err.code === 'ANCHOR_PERSIST' && /不可读/.test(err.message),
    )
    // 损坏 JSON：显式错
    const corrupt = join(dir, 'corrupt.json')
    await writeFile(corrupt, '{not-json')
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.load', { path: corrupt }),
      err => err.code === 'ANCHOR_PERSIST' && /合法 JSON/.test(err.message),
    )
    // 合法 JSON 但非载荷形态（缺 entries）：显式错（不猜测冒充）
    const alien = join(dir, 'alien.json')
    await writeFile(alien, JSON.stringify({ hello: 'world' }))
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.load', { path: alien }),
      err => err.code === 'ANCHOR_PERSIST' && /entries/.test(err.message),
    )
    assert.equal(env.handles.anchorStore.size(), 0, '三条错误路径都不得污染库')
  } finally {
    await env.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('3. 会话内重载幂等 + 路径显式声明门禁', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-anchor-idem-'))
  const env = await mount()
  try {
    env.handles.anchorStore.add({ graph: graph4, source: 'material:cu-a', composition: { Cu: 4 } })
    const path = join(dir, 'anchors.json')
    await env.handles.rt.tools.call('sampler.anchor.save', { path })
    const again = await env.handles.rt.tools.call('sampler.anchor.load', { path })
    assert.equal(again.added, 0)
    assert.equal(again.skipped, 1, '同库重载：同谱系幂等跳过（重放安全）')
    assert.equal(env.handles.anchorStore.size(), 1)
    // 路径缺省：显式错（库不自作主张读写文件系统）
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.save', {}),
      err => err.code === 'ANCHOR_PERSIST',
    )
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.load', {}),
      err => err.code === 'ANCHOR_PERSIST',
    )
  } finally {
    await env.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('4. ㉜ 完整性校验：版本门禁 + size 声明对账（声明 ≠ 实质即拒，不静默接受）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-anchor-integrity-'))
  const env = await mount()
  try {
    // 版本门禁：未知版本形态不静默接受（不猜测兼容）
    const alien = join(dir, 'alien-version.json')
    await writeFile(alien, JSON.stringify({ version: 'saturday-anchor-store/9', size: 1,
      entries: [{ graph: graph4, source: 'material:cu-a', composition: { Cu: 4 } }] }))
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.load', { path: alien }),
      err => err.code === 'ANCHOR_PERSIST' && /版本不受支持/.test(err.message),
    )
    // 无版本声明同样拒（缺失不冒充合法形态）
    const noversion = join(dir, 'no-version.json')
    await writeFile(noversion, JSON.stringify({ size: 1,
      entries: [{ graph: graph4, source: 'material:cu-a', composition: { Cu: 4 } }] }))
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.load', { path: noversion }),
      err => err.code === 'ANCHOR_PERSIST' && /版本不受支持/.test(err.message),
    )
    // size 声明对账：声明 ≠ 实质即拒（不猜测补齐）
    const mismatch = join(dir, 'size-mismatch.json')
    await writeFile(mismatch, JSON.stringify({ version: 'saturday-anchor-store/2', size: 5,
      entries: [{ entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'material:cu-a', composition: { Cu: 4 } }] }))
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.load', { path: mismatch }),
      err => err.code === 'ANCHOR_PERSIST' && /完整性声明与实质不符/.test(err.message),
    )
    assert.equal(env.handles.anchorStore.size(), 0, '三条完整性门禁都不得污染库')
  } finally {
    await env.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('5. ㉜ 单条损坏不连坐：坏条目逐条拒绝，合法条目照常入库（完整性门禁不开旁路）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-anchor-partial-'))
  const env = await mount()
  try {
    const partial = join(dir, 'partial.json')
    await writeFile(partial, JSON.stringify({ version: 'saturday-anchor-store/2', size: 3, entries: [
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'material:cu-good', composition: { Cu: 4 } },
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4 },   // 坏条目：无谱系（由共享导入循环逐条拒绝，不连坐）
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'job:j-1#engine=emt-mock', composition: { Cu: 3, Ag: 1 } },
    ] }))
    const loaded = await env.handles.rt.tools.call('sampler.anchor.load', { path: partial })
    assert.equal(loaded.added, 2, '合法条目不因坏条目连坐')
    assert.equal(loaded.rejected.length, 1, '坏条目逐条如实拒绝')
    assert.equal(env.handles.anchorStore.size(), 2)
  } finally {
    await env.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('6. ㉝ 条目级版本戳：损坏定位到条目（含载荷原位索引），不连坐合法条目', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-anchor-stamp-'))
  const env = await mount()
  try {
    const stamped = join(dir, 'stamped.json')
    await writeFile(stamped, JSON.stringify({ version: 'saturday-anchor-store/2', size: 3, entries: [
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'material:cu-ok', composition: { Cu: 4 } },
      { graph: graph4, source: 'material:cu-nostamp', composition: { Cu: 4 } },   // 缺版本戳：条目级损坏，定位到索引 1
      { entryVersion: 'saturday-anchor-entry/9', graph: graph4, source: 'job:j-9', composition: { Cu: 4 } },   // 未知版本戳：定位到索引 2
    ] }))
    const loaded = await env.handles.rt.tools.call('sampler.anchor.load', { path: stamped })
    assert.equal(loaded.added, 1, '合法条目照常入库（不连坐）')
    assert.deepEqual(loaded.rejected.map(r => r.index).sort(), [1, 2], '损坏定位到载荷原位索引（过滤后不丢定位能力）')
    assert.ok(loaded.rejected.every(r => /条目版本戳/.test(r.reason)), '拒绝原因如实声明条目级损坏')
    assert.equal(env.handles.anchorStore.size(), 1)
  } finally {
    await env.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('7. ㉞ 多载荷合并回填：同谱系幂等兜底跨载荷重复 + 门禁先行（任一文件不过 → 整批拒绝、库零污染）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-anchor-multi-'))
  const env = await mount()
  try {
    const p1 = join(dir, 'p1.json')
    const p2 = join(dir, 'p2.json')
    const bad = join(dir, 'bad.json')
    await writeFile(p1, JSON.stringify({ version: 'saturday-anchor-store/2', size: 2, entries: [
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'material:cu-m', composition: { Cu: 4 } },
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'job:j-m#engine=emt-mock', composition: { Cu: 3, Ag: 1 } },
    ] }))
    await writeFile(p2, JSON.stringify({ version: 'saturday-anchor-store/2', size: 2, entries: [
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'material:cu-m', composition: { Cu: 4 } },   // 与 p1 同谱系：幂等跳过
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'material:ag-m', composition: { Ag: 4 } },
    ] }))
    // 合并回填：同谱系幂等门禁天然兜底跨载荷重复；逐文件明细随交付呈现
    const merged = await env.handles.rt.tools.call('sampler.anchor.load', { paths: [p1, p2] })
    assert.equal(merged.added, 3, '跨载荷合并去重后入库三条')
    assert.equal(merged.skipped, 1, '同谱系跨载荷重复幂等跳过')
    assert.equal(merged.files.length, 2, '逐文件明细随交付')
    assert.equal(merged.files[1].skipped, 1, '重复定位在第二份载荷')
    assert.deepEqual(merged.lineageRefs.sort(), ['job:j-m', 'material:ag-m', 'material:cu-m'], 'lineageRefs 跨载荷合并去重')
    assert.equal(env.handles.anchorStore.size(), 3)
    // 门禁先行：批次内含损坏文件 → 整批拒绝，已入库条目不受影响（库零污染）
    await writeFile(bad, 'not-json')
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.load', { paths: [p2, bad] }),
      err => err.code === 'ANCHOR_PERSIST' && /门禁先行/.test(err.message),
    )
    assert.equal(env.handles.anchorStore.size(), 3, '门禁先行：出错时未写入任何条目')
    // path 与 paths 二选一门禁（不静默猜测调用方意图）
    await assert.rejects(
      () => env.handles.rt.tools.call('sampler.anchor.load', { path: p1, paths: [p2] }),
      /必须且只能提供/,
    )
  } finally {
    await env.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('8. ㉟ 血缘审计（只读）：三态统计如实 + 审计不回填不污染库 + 异常文件如实入报告', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-anchor-audit-'))
  const env = await mount()
  try {
    const mixed = join(dir, 'mixed.json')
    const broken = join(dir, 'broken.json')
    await writeFile(mixed, JSON.stringify({ version: 'saturday-anchor-store/2', size: 4, entries: [
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'material:cu-t', composition: { Cu: 4 } },   // 可追溯
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'job:j-t#engine=emt-mock', composition: { Cu: 4 } },   // 可追溯（含引擎后缀）
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'inline:adhoc', composition: { Cu: 4 } },   // 不可追溯（有来源非可追溯形态）
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4 },   // 损坏（来源缺失，回填必拒）
    ] }))
    await writeFile(broken, 'not-json')
    const report = await env.handles.rt.tools.call('sampler.anchor.audit', { paths: [mixed, broken] })
    assert.equal(report.files[0].ok, true)
    assert.deepEqual(
      { t: report.files[0].traceable, u: report.files[0].untracked, c: report.files[0].corrupt },
      { t: 2, u: 1, c: 1 },
      '三态统计如实：可追溯/不可追溯/损坏',
    )
    // ㊶ 修复建议通道：非可追溯条目随报告附可操作的修复声明（指明出路，不代改）
    assert.deepEqual(
      report.files[0].repairHints.map(h => [h.index, h.state]),
      [[2, 'untracked'], [3, 'corrupt']],
      '修复建议定位到条目（载荷原位索引 + 三态），可追溯条目不附建议',
    )
    assert.ok(report.files[0].repairHints.every(h => typeof h.hint === 'string' && h.hint.length > 0),
      '修复声明可操作（缺什么、回填时会怎样）')
    assert.ok(report.files[0].repairHints[1].hint.includes('必拒'), '损坏条目的建议如实声明回填必拒')
    assert.ok(report.files[0].repairHints[0].hint.includes('可回填但不可追溯'), '不可追溯条目的建议区分于损坏（可回填但建议声明可追溯起源）')
    assert.equal(report.files[1].ok, false, '异常文件如实入报告（不连坐其余文件，不冒充可审计）')
    assert.equal(env.handles.anchorStore.size(), 0, '审计为只读观测：不回填、库零污染')
  } finally {
    await env.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('9. ㊳ 库容量观测（只读）：谱系形态分布如实 + 观测不变更库（与 ㉟ 载荷审计构成双观测面）', async () => {
  const env = await mount()
  try {
    env.handles.anchorStore.add({ graph: graph4, source: 'material:cu-s', composition: { Cu: 4 } })
    env.handles.anchorStore.add({ graph: graph4, source: 'job:j-s#engine=emt-mock', composition: { Cu: 3, Ag: 1 } })
    env.handles.anchorStore.add({ graph: graph4, source: 'inline:adhoc-s' })   // 其他形态 + 无组分声明（库层允许即如实观测）
    const stats = await env.handles.rt.tools.call('sampler.anchor.stats', {})
    assert.equal(stats.size, 3)
    assert.deepEqual(stats.lineage, { material: 1, job: 1, other: 1 }, '谱系形态分布如实（归一化取 # 前段）')
    assert.equal(stats.withComposition, 2, '组分声明覆盖如实')
    assert.equal(env.handles.anchorStore.size(), 3, '观测不变更库')
  } finally {
    await env.fiber.dispose()
  }
})

test('10. ㊵ 触发判据接容量观测：stats 读数直接喂判据（声明式对账，不是门禁）', async () => {
  const env = await mount()
  try {
    env.handles.anchorStore.add({ graph: graph4, source: 'material:cu-tr', composition: { Cu: 4 } })
    env.handles.anchorStore.add({ graph: graph4, source: 'job:j-tr#engine=emt-mock', composition: { Cu: 4 } })
    env.handles.anchorStore.add({ graph: graph4, source: 'inline:adhoc-tr' })   // 无组分声明 → 拉低覆盖率
    const stats = await env.handles.rt.tools.call('sampler.anchor.stats', {})
    // 宽松阈值 → 达标；严格阈值 → 缺口如实（判据随读数变化，不硬编码结论）
    const loose = trajectoryTriggerAssessment(stats, { minSize: 2, minCompositionCoverage: 0.5 })
    assert.equal(loose.met, true, '读数满足宽松阈值 → 达标')
    const strict = trajectoryTriggerAssessment(stats, { minSize: 10, minCompositionCoverage: 0.9 })
    assert.equal(strict.met, false)
    assert.equal(strict.reasons.length, 2, '两项缺口各自独立呈报')
    assert.equal(strict.readings.size, 3, '判据回呈的读数与观测一致（读数 → 判据不断链）')
  } finally {
    await env.fiber.dispose()
  }
})

test('11. ㊸ 修复原语：只修复不可追溯条目 + 写新载荷不碰原件（审计是修复的验收面）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-anchor-repair-'))
  const env = await mount()
  try {
    const src = join(dir, 'src.json')
    const out = join(dir, 'out.json')
    await writeFile(src, JSON.stringify({ version: 'saturday-anchor-store/2', size: 3, entries: [
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'material:cu-r0', composition: { Cu: 4 } },
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'inline:adhoc-r1', composition: { Cu: 4 } },
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'inline:adhoc-r2', composition: { Cu: 4 } },
    ] }))
    const before = await readFile(src, 'utf8')
    const result = await env.handles.rt.tools.call('sampler.anchor.repair', {
      path: src, out,
      repairs: [
        { index: 1, source: 'material:cu-r1' },
        { index: 2, source: 'job:j-r2#engine=emt-mock' },
      ],
    })
    assert.equal(result.applied.length, 2, '两条不可追溯条目逐条修复（调用方显式授权）')
    assert.equal(result.refused.length, 0)
    assert.deepEqual(result.applied.map(a => [a.index, a.from, a.to]),
      [[1, 'inline:adhoc-r1', 'material:cu-r1'], [2, 'inline:adhoc-r2', 'job:j-r2#engine=emt-mock']],
      '修复声明如实回呈（原位索引 + 前后来源）')
    // 审计是修复的验收面：新载荷全可追溯；原件一字不动（留作证据）
    const verdict = await env.handles.rt.tools.call('sampler.anchor.audit', { path: out })
    assert.deepEqual(
      { t: verdict.files[0].traceable, u: verdict.files[0].untracked, c: verdict.files[0].corrupt },
      { t: 3, u: 0, c: 0 }, '修复后载荷重新审计：全可追溯')
    assert.equal(await readFile(src, 'utf8'), before, '修复写新载荷不碰原件（原件留作证据）')
    assert.equal(env.handles.anchorStore.size(), 0, '修复不回填：库零污染（观测/修复权责分离）')
  } finally {
    await env.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('12. ㊸ 修复门禁：损坏/已可追溯/越界/非可追溯来源如实拒绝 + 覆盖原件拒绝（修复不是伪造）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-anchor-repair-gate-'))
  const env = await mount()
  try {
    const src = join(dir, 'src.json')
    const out = join(dir, 'out.json')
    await writeFile(src, JSON.stringify({ version: 'saturday-anchor-store/2', size: 3, entries: [
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'material:cu-g0', composition: { Cu: 4 } },
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4, source: 'inline:adhoc-g1', composition: { Cu: 4 } },
      { entryVersion: 'saturday-anchor-entry/1', graph: graph4 },   // 损坏（来源缺失）
    ] }))
    const result = await env.handles.rt.tools.call('sampler.anchor.repair', {
      path: src, out,
      repairs: [
        { index: 2, source: 'material:fake' },     // 损坏条目 → 修复即伪造，必拒
        { index: 0, source: 'material:already' },  // 已可追溯 → 不替调用方做决定，拒
        { index: 9, source: 'material:oor' },      // 越界，拒
        { index: 1, source: 'inline:still-bad' },  // 修复来源非可追溯形态，拒
        { index: 1, source: 'material:cu-g1' },    // 唯一合法 → 应用
      ],
    })
    assert.equal(result.applied.length, 1, '仅逐条授权的合法修复应用')
    assert.equal(result.refused.length, 4, '四类非法修复各自如实拒绝')
    assert.ok(result.refused[0].reason.includes('伪造'), '损坏条目的拒绝理由指向伪造')
    assert.ok(result.refused[1].reason.includes('已可追溯'), '已可追溯条目的拒绝理由不冒充需修复')
    // 声明层门禁：覆盖原件拒绝 + 空修复声明拒绝（不静默猜测）
    await assert.rejects(
      env.handles.rt.tools.call('sampler.anchor.repair', { path: src, out: src, repairs: [{ index: 1, source: 'material:x' }] }),
      /不得与 path 相同/, 'out 与 path 相同 → 拒绝覆盖原件')
    await assert.rejects(
      env.handles.rt.tools.call('sampler.anchor.repair', { path: src, out, repairs: [] }),
      /逐条显式/, '空修复声明 → 拒绝（修复不是越权代改）')
    assert.equal(env.handles.anchorStore.size(), 0, '修复全程不回填：库零污染')
  } finally {
    await env.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
