// @toki0413/plugin-mp 契约测试（契约 §4.1）
// HTTP 传输注入 stub，无需真实 API Key：验证 seam 形状与谱系写入（修订 #8）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import plugin from '../src/index.mjs'
import { MaterialsProjectResolver } from '../src/mp-resolver.mjs'
import { Material } from '@toki0413/core'
import { structureResolverContract } from '@toki0413/contract-tests'

// ── MP 风格响应夹具（真实 API 的 JSON 结构，裁剪到契约所需字段）──
const MP_FIXTURES = {
  TiO2: [
    {
      material_id: 'mp-2657',
      energy_above_hull: 0.0,
      structure: {
        lattice: { matrix: [[4.594, 0, 0], [0, 4.594, 0], [0, 0, 2.959]] },
        sites: [
          { species: [{ element: 'Ti' }], xyz: [0, 0, 0] },
          { species: [{ element: 'Ti' }], xyz: [2.297, 2.297, 1.4795] },
          { species: [{ element: 'O' }], xyz: [1.401, 1.401, 0] },
          { species: [{ element: 'O' }], xyz: [3.193, 3.193, 0] },
          { species: [{ element: 'O' }], xyz: [0.895, 3.699, 1.4795] },
          { species: [{ element: 'O' }], xyz: [3.699, 0.895, 1.4795] },
        ],
      },
    },
    {
      material_id: 'mp-390',
      energy_above_hull: 0.02,
      structure: {
        lattice: { matrix: [[3.785, 0, 0], [0, 3.785, 0], [0, 0, 9.514]] },
        sites: [
          { species: [{ element: 'Ti' }], xyz: [0, 0, 0] },
          { species: [{ element: 'Ti' }], xyz: [1.8925, 1.8925, 4.757] },
          { species: [{ element: 'O' }], xyz: [0, 0, 1.9789] },
          { species: [{ element: 'O' }], xyz: [0, 0, 7.5351] },
          { species: [{ element: 'O' }], xyz: [1.8925, 1.8925, 2.8341] },
          { species: [{ element: 'O' }], xyz: [1.8925, 1.8925, 6.6799] },
        ],
      },
    },
  ],
}

function stubFetch({ status = 200 } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const formula = new URL(url).searchParams.get('formula')
    const data = MP_FIXTURES[formula] ?? []
    return { ok: status === 200, status, json: async () => ({ data }) }
  }
  impl.calls = calls
  return impl
}

test('1. seam 形状：候选按 hull 能量排序并赋 polymorphRank（契约 §4.1）', async () => {
  const fetchImpl = stubFetch()
  const resolver = new MaterialsProjectResolver({ apiKey: 'stub-key', fetchImpl })
  assert.equal(resolver.name, 'materials-project')

  const candidates = await resolver.resolve('TiO2')
  assert.equal(candidates.length, 2)
  assert.deepEqual(candidates.map(c => c.polymorphRank), [0, 1])
  assert.equal(candidates[0].source, 'mp-2657')   // 金红石最稳定
  assert.equal(candidates[1].source, 'mp-390')    // 锐钛矿亚稳
  assert.equal(candidates[0].graph.nodes.length, 6)
  assert.equal(candidates[0].graph.periodic, true)
  // 请求头携带 API Key
  assert.equal(fetchImpl.calls[0].init.headers['X-API-KEY'], 'stub-key')
})

test('2. 无结果抛 STRUCTURE_NOT_FOUND；缺 Key 抛 MP_API_KEY_MISSING（显式，不静默）', async () => {
  const resolver = new MaterialsProjectResolver({ apiKey: 'stub-key', fetchImpl: stubFetch() })
  await assert.rejects(
    () => resolver.resolve('Xx99'),
    err => err.code === 'STRUCTURE_NOT_FOUND',
  )
  const noKey = new MaterialsProjectResolver({ fetchImpl: stubFetch() })
  await assert.rejects(
    () => noKey.resolve('TiO2'),
    err => err.code === 'MP_API_KEY_MISSING',
  )
})

test('3. seam 可互换：MP 结构经 Material.create 落谱系（修订 #8）', async () => {
  const resolver = new MaterialsProjectResolver({ apiKey: 'stub-key', fetchImpl: stubFetch() })
  const m = await Material.create({ modalities: { formula: 'TiO2' } }, resolver)
  assert.equal(m.nAtoms, 6)
  const resolved = m.lineage.find(l => l.operation === 'structure-resolved')
  assert.equal(resolved.detail.resolver, 'materials-project')
  assert.equal(resolved.detail.source, 'mp-2657')
})

test('4. 插件挂载：服务与工具就位，工具输出只含引用信息', async () => {
  const ctx = new Context()
  const fiber = await ctx.registry.plugin({
    name: 'saturday-mp',
    apply: (ctx) => plugin.apply(ctx, { apiKey: 'stub-key', fetchImpl: stubFetch() }),
  })
  const { rt } = fiber.store.saturdayMp
  assert.ok(ctx.reflect.get('structure-resolver.materials-project'))
  assert.deepEqual(rt.tools.list().map(t => t.name), ['structure.resolve'])

  const out = await rt.tools.call('structure.resolve', { query: 'TiO2' })
  assert.equal(out.candidates.length, 2)
  assert.equal(out.candidates[0].source, 'mp-2657')
  // polymorphRank 过滤
  const picked = await rt.tools.call('structure.resolve', { query: 'TiO2', polymorphRank: 1 })
  assert.deepEqual(picked.candidates.map(c => c.source), ['mp-390'])
  await fiber.dispose()
  assert.equal(ctx.reflect.get('structure-resolver.materials-project'), undefined)
})

// ── 标准契约套件（§4.1，传输用 stub，无需真实 API Key）───────────
structureResolverContract({
  subject: 'materials-project',
  createResolver: () => new MaterialsProjectResolver({ apiKey: 'stub-key', fetchImpl: stubFetch() }),
  knownFormula: 'TiO2',
})
