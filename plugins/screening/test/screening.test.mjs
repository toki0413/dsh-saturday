// @saturday/plugin-screening 契约测试（契约 §4.3）
// 不依赖 Python sidecar：material/potential 服务由 stub 插件提供，
// 验证的是"工作流插件形态"本身：服务依赖显式解析、逐变体事件、不吞错。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/index.mjs'
import { Material, PrototypeLibResolver, PotentialRegistry } from '@saturday/core'

// ── stub 核心插件：只提供 material / potential 两个服务 ──────────
// 注：before() 钩子晚于模块体执行，relaxImpl 必须延迟捕获，不能直接闭包模块级变量
function stubCorePlugin(getRelaxImpl) {
  return {
    name: 'stub-core',
    async apply(ctx) {
      const relaxImpl = getRelaxImpl()
      const resolver = new PrototypeLibResolver()
      const store = new Map()
      const materialService = {
        async load(formula) {
          const m = await Material.create({ modalities: { formula } }, resolver)
          store.set(m.id, m)
          return m
        },
        async get(id) {
          const m = store.get(id)
          if (!m) throw new Error(`Unknown material id: ${id}`)
          return m
        },
      }
      const rt = { on() {}, emit() {} }
      const potential = new PotentialRegistry(rt)
      potential.register({
        name: 'stub-engine',
        manifest: {
          capabilities: [{ type: 'relax', accuracy: 0.5, speed: 0.99, cost: 0.01, maxAtoms: 200 }],
          constraints: {},
          eventGranularity: 'job',
        },
        relax: relaxImpl,
      })
      await potential.activate('stub-engine')
      // 事件收集必须在 fiber 作用域内（根上下文裸监听会让 emit 报错）
      const events = []
      ctx.events.on('saturday/simulation/converged', e => events.push(e))
      ctx.reflect.provide('material', materialService)
      ctx.reflect.provide('potential', potential)
      ctx.fiber.store.stub = { materialService, events }
    },
  }
}

let ctx, screenFiber, screenRt

before(async () => {
  ctx = new Context()
  screenFiber = await ctx.registry.plugin({
    name: 'saturday-screening',
    apply: (ctx) => plugin.apply(ctx, {}),
  })
  screenRt = screenFiber.store.saturdayScreening.rt
})

after(async () => {
  await screenFiber.dispose()
})

test('1. 工作流插件独立挂载：工具注册且归属本插件', () => {
  assert.deepEqual(screenRt.tools.list().map(t => t.name), ['workflow.screen'])
})

test('2. 缺核心服务必须显式报错，不得静默降级（契约 §2）', async () => {
  await assert.rejects(
    () => screenRt.tools.call('workflow.screen', { materialId: 'x', dopants: ['Ag'] }),
    /requires services "material" and "potential"/,
  )
})

test('3. 与核心服务组合：逐变体事件 + 排序正确（契约 §4.3）', async () => {
  // 确定性能量：掺杂越靠后能量越低，验证排序而非透传
  const energies = { Cu: -12.0, Cu3Ag: -12.4, Cu3Ni: -12.2 }

  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => ({
    jobId: `job-${material.formula}`, engine: 'stub-engine',
    converged: true, energy: energies[material.formula], n_steps: 5,
  })))
  const { materialService, events } = coreFiber.store.stub
  const cu = await materialService.load('Cu')

  const result = await screenRt.tools.call('workflow.screen', {
    materialId: cu.id, dopants: ['Ag', 'Ni'],
  })
  assert.equal(result.failed.length, 0)
  assert.deepEqual(result.ranked.map(r => r.formula), ['Cu3Ag', 'Cu3Ni', 'Cu'])
  // 逐变体事件：3 个变体 3 条事件，全部含 jobId 引用（薄载荷）
  assert.equal(events.length, 3)
  assert.ok(events.every(e => e.payload.jobId && e.payload.material.id))
  await coreFiber.dispose()
})

test('4. 单变体失败计入 failed，不中断整体（不吞错）', async () => {
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => {
    if (material.formula === 'Cu3Ni') throw new Error('stub: Ni 变体故意失败')
    return {
      jobId: `job-${material.formula}`, engine: 'stub-engine',
      converged: true, energy: -12.0, n_steps: 5,
    }
  }))
  const { materialService } = coreFiber.store.stub
  const cu = await materialService.load('Cu')

  const result = await screenRt.tools.call('workflow.screen', {
    materialId: cu.id, dopants: ['Ag', 'Ni'],
  })
  assert.equal(result.ranked.length, 2, '成功变体照常排序返回')
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].dopant, 'Ni')
  assert.match(result.failed[0].error, /故意失败/)
  await coreFiber.dispose()
})
