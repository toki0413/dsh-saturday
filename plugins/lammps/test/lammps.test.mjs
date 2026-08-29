// @saturday/plugin-lammps 契约测试（契约 §4.2 / §5.2）
// 本机无需安装 LAMMPS：执行器注入伪二进制，
// 验证批处理引擎的契约形状：事件粒度门禁、显式失败、注册即 effect。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/index.mjs'
import { LammpsProvider, toLammpsData, parseFinalEnergy } from '../src/lammps-provider.mjs'
import { Material, PrototypeLibResolver, PotentialRegistry } from '@saturday/core'

/** 伪子进程：可控地发 stdout / error / close */
function fakeChild({ stdout = '', exitCode = 0, spawnError = null } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  setImmediate(() => {
    if (spawnError) return child.emit('error', spawnError)
    if (stdout) child.stdout.emit('data', Buffer.from(stdout))
    child.emit('close', exitCode)
  })
  return child
}

test('1. 数据文件生成：Cu fcc 原胞 → LAMMPS data file（原子数/质量/盒边界）', async () => {
  const cu = await Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())
  const data = toLammpsData(cu.graph)
  assert.match(data, /^4 atoms$/m)
  assert.match(data, /1 atom types/)
  assert.match(data, /0\.0 3\.615 xlo xhi/)
  assert.match(data, /1 63\.546\s+# Cu/)
  assert.match(data, /^Atoms$/m)
})

test('2. manifest 契约形状：事件粒度 job，细粒度监听被显式拒绝（§5.2）', () => {
  const provider = new LammpsProvider()
  assert.equal(provider.manifest.eventGranularity, 'job')
  assert.equal(provider.manifest.constraints.requiresLicense, false)
  assert.ok(provider.manifest.capabilities[0].maxAtoms >= 1e6, '经典势的百万原子级定位')

  const reg = new PotentialRegistry({ on() {}, emit() {} })
  reg.register(provider)
  assert.throws(
    () => reg.assertCanMonitor(provider, 'iteration'),
    err => err.code === 'GRANULARITY_UNAVAILABLE',
  )
  reg.assertCanMonitor(provider, 'job')   // 任务级监听合法
})

test('3. 二进制缺失：relax 显式报 ENGINE_UNAVAILABLE，绝不静默降级', async () => {
  const cu = await Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())
  const provider = new LammpsProvider({
    potentialFile: 'Cu.eam.alloy',
    spawnImpl: () => fakeChild({ spawnError: Object.assign(new Error('spawn lmp ENOENT'), { code: 'ENOENT' }) }),
  })
  await assert.rejects(
    () => provider.relax(cu),
    err => err.code === 'ENGINE_UNAVAILABLE' && /never silently substitutes/.test(err.message),
  )
  // 势文件未配置同样显式失败
  const noPot = new LammpsProvider({ spawnImpl: () => fakeChild() })
  await assert.rejects(() => noPot.relax(cu), err => err.code === 'ENGINE_UNAVAILABLE')
})

test('4. 伪二进制全链路：数据文件 + 输入脚本 → 日志能量解析', async () => {
  const cu = await Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())
  const provider = new LammpsProvider({
    potentialFile: 'Cu.eam.alloy',
    spawnImpl: () => fakeChild({ stdout: 'LAMMPS output...\nSATURDAY_ENERGY -14.0832\n' }),
  })
  const result = await provider.relax(cu)
  assert.equal(result.engine, 'lammps')
  assert.equal(result.calculator, 'lammps')
  assert.equal(result.converged, true)
  assert.ok(Math.abs(result.energy - (-14.0832)) < 1e-9)
  assert.ok(result.jobId)
  assert.equal(result.n_steps, 0, 'job 粒度：不回传步进细节')
  assert.equal(parseFinalEnergy('x SATURDAY_ENERGY -1.5e2 y'), -150)
})

test('5. 插件生命周期：注册即 effect，卸载自动注销（§2）', async () => {
  const ctx = new Context()
  // stub 核心：只提供 potential 服务
  const coreFiber = await ctx.registry.plugin({
    name: 'stub-core',
    apply(ctx) {
      const potential = new PotentialRegistry({ on() {}, emit() {} })
      ctx.reflect.provide('potential', potential)
      ctx.fiber.store.potential = potential
    },
  })
  const potential = coreFiber.store.potential

  const fiber = await ctx.registry.plugin({
    name: 'saturday-lammps',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  assert.ok(potential.get('lammps'), 'provider registered on mount')

  await fiber.dispose()
  assert.throws(() => potential.get('lammps'), /not registered/, 'provider withdrawn on dispose')

  // 缺 potential 服务：apply 即报错（失败即不挂载）
  const ctx2 = new Context()
  await assert.rejects(
    () => Promise.resolve().then(() => plugin.apply(ctx2, {})),
    /requires service "potential"/,
  )
  await coreFiber.dispose()
})

test('6. 激活引擎被注销：激活指针自动重置', async () => {
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin({
    name: 'stub-core',
    apply(ctx) {
      const potential = new PotentialRegistry({ on() {}, emit() {} })
      ctx.reflect.provide('potential', potential)
      ctx.fiber.store.potential = potential
    },
  })
  const potential = coreFiber.store.potential
  const fiber = await ctx.registry.plugin({
    name: 'saturday-lammps',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  await potential.activate('lammps')
  assert.equal(potential.activeProvider, 'lammps')
  await fiber.dispose()
  assert.equal(potential.activeProvider, null, 'active pointer reset when provider withdrawn')
  await coreFiber.dispose()
})
