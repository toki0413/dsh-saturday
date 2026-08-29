// @saturday/plugin-mace 契约测试（契约 §4.2 / §5.2）
// 本机无需安装 mace-torch/torch：探测与执行器全部注入伪实现，
// 验证 ML 势引擎的契约形状：可用性预检、显式失败、注册即 effect、画像路由。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/index.mjs'
import { MaceProvider } from '../src/mace-provider.mjs'
import { LammpsProvider } from '@saturday/plugin-lammps'
import { PotentialRegistry } from '@saturday/core'
import { potentialProviderContract } from '@saturday/contract-tests'

/** 伪子进程：可控地发 close / error（探测路径不用 stdout/stdin） */
function fakeChild({ exitCode = 0, spawnError = null } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  setImmediate(() => spawnError ? child.emit('error', spawnError) : child.emit('close', exitCode))
  return child
}

/** 伪执行器：确定性能量输出（幂等断言依赖确定性） */
const fakeRunner = async () => ({ converged: true, energy: -13.42, n_steps: 7 })

test('1. 可用性预检：`import mace` 探测成功/失败都如实反映', async () => {
  const ok = new MaceProvider({ spawnImpl: () => fakeChild({ exitCode: 0 }) })
  assert.equal(await ok.checkImpl(), true)

  const missing = new MaceProvider({ spawnImpl: () => fakeChild({ exitCode: 1 }) })
  assert.equal(await missing.checkImpl(), false)

  const noPython = new MaceProvider({ spawnImpl: () => fakeChild({ spawnError: new Error('ENOENT') }) })
  assert.equal(await noPython.checkImpl(), false, 'spawn error 视同不可用')
})

test('2. mace 缺失：relax 显式报 ENGINE_UNAVAILABLE，绝不静默降级', async () => {
  const provider = new MaceProvider({ checkImpl: async () => false })
  const material = { graph: { nodes: [], edges: [], periodic: true, cell: [[1,0,0],[0,1,0],[0,0,1]] } }
  await assert.rejects(
    () => provider.relax(material),
    err => err.code === 'ENGINE_UNAVAILABLE' && /never silently substitutes/.test(err.message),
  )
})

test('3. 插件入口：缺 "potential" 服务即挂载失败（契约 §2）', async () => {
  const ctx = new Context()
  await assert.rejects(
    () => Promise.resolve().then(() => plugin.apply(ctx, {})),
    /requires service "potential"/,
  )
})

test('4. 注册即 effect：挂载进注册表，卸载自动注销', async () => {
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin({
    name: 'stub-core',
    apply(ctx) {
      const registry = new PotentialRegistry({ on() {}, emit() {} })
      ctx.reflect.provide('potential', registry)
      ctx.fiber.store.registry = registry
    },
  })
  const registry = coreFiber.store.registry
  const maceFiber = await ctx.registry.plugin({
    name: 'saturday-mace',
    apply: (ctx) => plugin.apply(ctx, { checkImpl: async () => true, runImpl: fakeRunner }),
  })
  assert.ok(registry.providers.has('mace'), 'provider registered on mount')
  await maceFiber.dispose()
  assert.equal(registry.providers.has('mace'), false, 'provider withdrawn on unmount')
  await coreFiber.dispose()
})

test('5. 画像路由：validation 选 mace（精度优先），screening 选 lammps（便宜优先）', () => {
  const reg = new PotentialRegistry({ on() {}, emit() {} })
  reg.register(new MaceProvider({ checkImpl: async () => true, runImpl: fakeRunner }))
  reg.register(new LammpsProvider({ potentialFile: 'Cu.eam.alloy' }))

  assert.equal(reg.autoRoute({ type: 'relax', nAtoms: 100, profile: 'validation' }).name, 'mace',
    'validation 画像：ML 势精度 0.88 > 经典势 0.7')
  assert.equal(reg.autoRoute({ type: 'relax', nAtoms: 100, profile: 'screening' }).name, 'lammps',
    'screening 画像：经典势更便宜（0.15 < 0.25）且够快')
})

// ── 标准契约套件（§4.2 + §5.2，伪执行器驱动）─────────────────────
potentialProviderContract({
  subject: 'mace',
  createProvider: () => new MaceProvider({ checkImpl: async () => true, runImpl: fakeRunner }),
  runnable: true,
  runFormula: 'Cu',
  unavailable: {
    createProvider: () => new MaceProvider({ checkImpl: async () => false }),
    code: 'ENGINE_UNAVAILABLE',
  },
})
