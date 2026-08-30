// ⑥ 可用性预检暴露给 Agent 层：engine.availability 工具（①② 的 Agent 面）。
// 纪律实证：默认只报告不副作用（预检是查询不是变更）；stamp=true 才盖章；
// 探测失败保持声明态（不拿未知冒充已知）；注册表不因探测失败缩减。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/saturday.plugin.mjs'

const TRAJECTORY = fileURLToPath(new URL('../data/trajectory-availability.jsonl', import.meta.url))

let ctx, fiber, handles

const fakeManifest = (software) => ({
  capabilities: [{ type: 'relax', accuracy: 0.5, speed: 0.99, cost: 0.01, maxAtoms: 200 }],
  constraints: {},
  eventGranularity: 'job',
  units: { energy: 'eV', length: 'Å', time: 'fs' },
  fingerprint: { software, method: 'stub' },
})

before(async () => {
  await rm(TRAJECTORY, { force: true })
  ctx = new Context()
  fiber = await ctx.registry.plugin({
    name: 'saturday',
    apply: (ctx) => plugin.apply(ctx, { trajectoryPath: TRAJECTORY }),
  })
  handles = fiber.store.saturday
  // 两个伪探测引擎：一个探测成功（版本可得），一个探测失败（返回 null，诚实降级）
  handles.potential.register({
    name: 'fake-probe-ok', manifest: fakeManifest('fake-probe-ok'),
    probeVersion: async () => '9.9.9-fake',
    relax: async () => { throw new Error('测试桩不提供弛豫') },
  })
  handles.potential.register({
    name: 'fake-probe-miss', manifest: fakeManifest('fake-probe-miss'),
    probeVersion: async () => null,
    relax: async () => { throw new Error('测试桩不提供弛豫') },
  })
})

after(async () => {
  await fiber.dispose()
})

test('1. engine.availability：逐引擎如实报告（默认只报告不盖章——预检是查询不是变更）', async () => {
  const result = await handles.rt.tools.call('engine.availability', {})
  assert.equal(result.stamped, false)
  const byName = Object.fromEntries(result.engines.map(e => [e.name, e]))
  assert.equal(byName['fake-probe-ok'].status, 'available')
  assert.equal(byName['fake-probe-miss'].status, 'unknown-or-missing', '探测失败 = 未知或缺失，不区分两者（诚实）')
  assert.equal(byName['emt-mock'].probeSupport, 'none', 'mock 引擎无探测能力：按定义不回读（身份即诚实）')
  // 默认不盖章：指纹仍保持声明态（副作用门禁）
  assert.equal(handles.potential.get('fake-probe-ok')._fingerprint.version, 'unknown')
  assert.match(result.note, /注册表不因探测失败缩减/, '声明层完整性随交付声明')
})

test('2. engine.availability（stamp=true）：探测成功盖章升级实测态，失败者保持声明态', async () => {
  const result = await handles.rt.tools.call('engine.availability', { stamp: true })
  assert.equal(result.stamped, true)
  assert.equal(handles.potential.get('fake-probe-ok')._fingerprint.version, '9.9.9-fake', '盖章 = version 从 unknown 升级为实测值')
  assert.equal(handles.potential.get('fake-probe-miss')._fingerprint.version, 'unknown', '探测失败方不盖章（不拿未知冒充已知）')
  // 注册表不因探测失败缩减：失败引擎仍在（声明层完整，使用时由 ENGINE_UNAVAILABLE 拦）
  assert.ok(result.engines.some(e => e.name === 'fake-probe-miss'))
})
