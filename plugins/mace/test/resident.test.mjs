// 常驻 batch 模式测试（注入 fake bridge，无需 torch/GPU）
// 覆盖：能力声明随模式生成（实现什么声明什么）、relax/calculate/md 经协议调用、
// md 参数门禁 JS 侧前置、连接级失败 ENGINE_UNAVAILABLE、一次性形态显式拒绝未实现能力、
// probeVersion 常驻回读、插件挂载成功/就绪失败两分支（不注册 + registered:false）、
// PotentialRegistry 路由集成（calculate 任务可选中常驻 mace，一次性形态被能力过滤挡住）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { PotentialRegistry } from '@toki0413/core'
import plugin, { MaceProvider } from '../src/index.mjs'

const graph = {
  nodes: [
    { id: 0, number: 29, position: [0, 0, 0] },
    { id: 1, number: 29, position: [1.8, 0, 0] },
  ],
  edges: [], periodic: true, cell: [[3.6, 0, 0], [0, 3.6, 0], [0, 0, 3.6]],
}
const material = { graph, nAtoms: 2, formula: 'Cu2' }

function fakeBridge({ failConnect = false } = {}) {
  const calls = []
  return {
    calls,
    sidecarInfo: null,
    async connect() {
      if (failConnect) throw new Error('Failed to launch Python sidecar: spawn python ENOENT')
      this.sidecarInfo = { sidecar: 'saturday-mace', version: '0.3.16-fake', model: 'medium', device: 'cuda' }
    },
    async call(method, params) {
      calls.push({ method, params })
      if (method === 'relax') return { converged: true, energy: -8.17, n_steps: 5, positions: [[0, 0, 0], [1.8, 0, 0]], calculator: 'mace:medium' }
      if (method === 'calculate') return { energy: -8.1, forces: [[0, 0, 0], [0, 0, 0.1]], calculator: 'mace:medium' }
      if (method === 'md') return { energy: -8.0, temperature_K: 297.3, steps: params.params.steps, ensemble: 'NVT-Langevin', calculator: 'mace:medium' }
      throw new Error(`Unknown method: ${method}`)
    },
    async disconnect() { calls.push({ method: '__disconnect' }) },
  }
}

test('1. 能力声明随模式生成：一次性仅 relax；常驻 relax+calculate+md（实现什么声明什么）', () => {
  const one = new MaceProvider()
  assert.deepEqual(one.manifest.capabilities.map(c => c.type), ['relax'],
    '一次性形态不得因常驻形态存在而虚报 calculate/md')
  const res = new MaceProvider({ resident: true, bridge: fakeBridge() })
  assert.deepEqual(res.manifest.capabilities.map(c => c.type).sort(), ['calculate', 'md', 'relax'])
})

test('2. 常驻 relax/calculate/md 经 bridge 协议调用：方法名与 graph 载荷正确、结果透传', async () => {
  const b = fakeBridge()
  const p = new MaceProvider({ resident: true, bridge: b })
  const r = await p.relax(material, { fmax: 0.05 })
  assert.equal(r.engine, 'mace')
  assert.equal(r.converged, true)
  assert.equal(r.energy, -8.17)
  const c = await p.calculate(material)
  assert.ok(Array.isArray(c.forces) && c.forces.length === 2, 'forces 随行（phonon forceProvider 依赖此形状）')
  const m = await p.md(material, { temperatureK: 300, steps: 10 })
  assert.equal(m.ensemble, 'NVT-Langevin')
  assert.equal(m.temperature_K, 297.3)
  assert.deepEqual(b.calls.map(x => x.method), ['relax', 'calculate', 'md'])
  assert.deepEqual(b.calls[0].params.graph, graph, 'graph 原样入载荷')
})

test('3. md 参数门禁 JS 侧前置：非法 temperatureK/steps/dtFs 均 MD_PARAMS_INVALID（不烧远程作业）', async () => {
  const p = new MaceProvider({ resident: true, bridge: fakeBridge() })
  for (const bad of [{}, { temperatureK: 0 }, { temperatureK: 'x' }, { temperatureK: 300, steps: 0 }, { temperatureK: 300, dtFs: -1 }]) {
    await assert.rejects(() => p.md(material, bad), err => err.code === 'MD_PARAMS_INVALID')
  }
})

test('4. 连接级失败 → ENGINE_UNAVAILABLE（绝不静默换引擎）；一次性形态 calculate/md/connect 显式拒绝', async () => {
  const dead = new MaceProvider({ resident: true, bridge: fakeBridge({ failConnect: true }) })
  await assert.rejects(() => dead.relax(material), err => err.code === 'ENGINE_UNAVAILABLE')
  const one = new MaceProvider()
  await assert.rejects(() => one.calculate(material), err => err.code === 'CAPABILITY_NOT_IMPLEMENTED')
  await assert.rejects(() => one.md(material, { temperatureK: 300 }), err => err.code === 'CAPABILITY_NOT_IMPLEMENTED')
  await assert.rejects(() => one.connect(), err => err.code === 'MODE_UNSUPPORTED')
})

test('5. probeVersion 常驻回读 = hello 实测版本；握手失败诚实 null（不冒充已知）', async () => {
  assert.equal(await new MaceProvider({ resident: true, bridge: fakeBridge() }).probeVersion(), '0.3.16-fake')
  assert.equal(await new MaceProvider({ resident: true, bridge: fakeBridge({ failConnect: true }) }).probeVersion(), null)
})

test('6. 插件挂载（常驻）：握手成功即注册 + hello 随 store；卸载注销且断连收尸；就绪失败不注册', async () => {
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

  const b = fakeBridge()
  const fiber = await ctx.registry.plugin({
    name: 'saturday-mace',
    apply: (c) => plugin.apply(c, { resident: true, bridge: b }),
  })
  assert.ok(potential.get('mace'), '常驻握手成功即注册')
  assert.equal(fiber.store.saturdayMace.hello.version, '0.3.16-fake', 'hello 实测态随 store 呈现')
  await fiber.dispose()
  assert.throws(() => potential.get('mace'), /not registered/, '卸载注销')
  assert.ok(b.calls.some(x => x.method === '__disconnect'), '卸载断连（sidecar 收尸，不留孤儿进程）')

  const fiber2 = await ctx.registry.plugin({
    name: 'saturday-mace',
    apply: (c) => plugin.apply(c, { resident: true, bridge: fakeBridge({ failConnect: true }) }),
  })
  assert.equal(fiber2.store.saturdayMace.registered, false, '就绪失败不注册（mace/lammps 先例门禁）')
  assert.throws(() => potential.get('mace'), /not registered/)
  await fiber2.dispose()
  await coreFiber.dispose()
})

test('7. 路由集成：常驻声明 calculate → calculate 任务可选中 mace；一次性形态 NO_CAPABLE_PROVIDER', () => {
  const rt = { on() {}, emit() {} }
  const regOne = new PotentialRegistry(rt)
  regOne.register(new MaceProvider())
  assert.throws(
    () => regOne.resolveProvider({ engine: 'auto' }, { type: 'calculate', nAtoms: 2 }),
    err => err.code === 'NO_CAPABLE_PROVIDER',
    '一次性形态未声明 calculate，能力过滤必须挡住它')
  const regRes = new PotentialRegistry(rt)
  regRes.register(new MaceProvider({ resident: true, bridge: fakeBridge() }))
  assert.equal(regRes.resolveProvider({ engine: 'auto' }, { type: 'calculate', nAtoms: 2 }).name, 'mace')
})
