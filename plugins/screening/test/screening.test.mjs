// @saturday/plugin-screening 契约测试（契约 §4.3）
// 不依赖 Python sidecar：material/potential 服务由 stub 插件提供，
// 验证的是"工作流插件形态"本身：服务依赖显式解析、逐变体事件、不吞错。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import plugin, { screenDopants } from '../src/index.mjs'
import { Material, PrototypeLibResolver, PotentialRegistry } from '@saturday/core'
import { workflowContract } from '@saturday/contract-tests'

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
      ctx.fiber.store.stub = { materialService, potential, events }
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

// ── 多组分凸包接线（第 1.5 档）：注入 references 后元素数 ≥ 3 升级为统一成分空间凸包 ──
// 能量模型：refCu/refAg/refNi 均 -3.0 → ΔH_f(Cu3Ag) = −0.05（稳定，低于包络），
// ΔH_f(Cu3Ni) = +0.05（不稳定）；端点全零 → 包络即 z=0 超平面，判据闭式可写。
test('5. 多组分凸包：三元系升级（mode=multi-component，闭式判据对账）', async () => {
  const energies = { Cu: -12.0, Cu3Ag: -12.2, Cu3Ni: -11.8 } // 4 原子：每原子 −3.0 / −3.05 / −2.95
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => ({
    jobId: `job-${material.formula}`, engine: 'stub-engine',
    converged: true, energy: energies[material.formula], n_steps: 5,
  })))
  const { materialService } = coreFiber.store.stub
  const cu = await materialService.load('Cu')

  const result = await screenDopants({
    material: cu, dopants: ['Ag', 'Ni'],
    potential: coreFiber.store.stub.potential,
    references: { Cu: -3.0, Ag: -3.0, Ni: -3.0 },
  })
  assert.equal(result.thermo.mode, 'multi-component', '三元系必须走多组分凸包')
  assert.equal(result.thermo.hullDimension, 2, '3 元素 → d=2 成分空间')
  assert.equal(result.thermo.level, 'stub-engine')
  const byFormula = Object.fromEntries(result.ranked.map(r => [r.formula, r]))
  // 端点全零 → 包络 = z=0 超平面：energyAboveHull = max(0, ΔH_f) 闭式
  assert.ok(Math.abs(byFormula.Cu3Ni.energyAboveHull - 0.05) < 1e-12, '不稳定候选：距离恰为 ΔH_f')
  assert.equal(byFormula.Cu3Ag.energyAboveHull, 0, '稳定候选（ΔH_f<0）：低于包络，钳到 0')
  assert.equal(byFormula.Cu.energyAboveHull, 0, '基体端点在包上')
  await coreFiber.dispose()
})

test('6. 二元路径保持：单掺杂时 mode=binary，判据不变', async () => {
  const energies = { Cu: -12.0, Cu3Ag: -12.2 }
  const coreFiber = await ctx.registry.plugin(stubCorePlugin(() => async (material) => ({
    jobId: `job-${material.formula}`, engine: 'stub-engine',
    converged: true, energy: energies[material.formula], n_steps: 5,
  })))
  const { materialService } = coreFiber.store.stub
  const cu = await materialService.load('Cu')

  const result = await screenDopants({
    material: cu, dopants: ['Ag'],
    potential: coreFiber.store.stub.potential,
    references: { Cu: -3.0, Ag: -3.0 },
  })
  assert.equal(result.thermo.mode, 'binary')
  const ag = result.ranked.find(r => r.formula === 'Cu3Ag')
  assert.ok(Math.abs(ag.energyAboveHull - Math.max(0, ag.formationEnthalpy)) < 1e-12)
  await coreFiber.dispose()
})

// ── 接入契约套件（§8.3：兼容性由测试承诺）：纯编排层走 screenDopants，
//    缺依赖断言走工具层（此时无核心服务挂载，最后执行）──
workflowContract({
  subject: 'screen',
  formula: 'Cu',
  dopants: ['Ag', 'Ni'],
  runTest: async ({ relaxImpl, dopants, emit }) => {
    const material = await Material.create({ modalities: { formula: 'Cu' } }, new PrototypeLibResolver())
    const potential = new PotentialRegistry({ on() {}, emit() {} })
    potential.register({
      name: 'contract-stub',
      manifest: {
        capabilities: [{ type: 'relax', accuracy: 0.5, speed: 0.99, cost: 0.01, maxAtoms: 200 }],
        constraints: {},
        eventGranularity: 'job',
      },
      relax: relaxImpl,
    })
    await potential.activate('contract-stub')
    return screenDopants({ material, dopants, potential, emit })
  },
  missingDeps: () => screenRt.tools.call('workflow.screen', { materialId: 'x', dopants: ['Ag'] }),
})
