// 运行时动词面测试（bridge 工具：capability.list / engine.attach / engine.detach）
// 覆盖：能力清单含源标识与在途作业数；attach 即时入池（不重启宿主）；
// detach 三策略经台账；attach/detach 决策动作落 Trajectory 可回放；
// refingerprinted → derivation 失效传播（热替换状态连续性端到端）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../src/saturday.plugin.mjs'
import derivationPlugin from '@toki0413/plugin-derivation'

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), 'saturday-rt-'))
  const trajPath = join(dir, 'trajectory.jsonl')
  const ctx = new Context()
  const core = await ctx.registry.plugin({
    name: 'saturday', apply: (c) => plugin.apply(c, { trajectoryPath: trajPath, quiet: true }),
  })
  const dv = await ctx.registry.plugin({
    name: 'saturday-derivation', apply: (c) => derivationPlugin.apply(c, {}),
  })
  const { rt, potential } = core.store.saturday
  return { ctx, core, dv, rt, potential, trajPath, dir }
}

test('1. capability.list：在册引擎带源标识/能力/在途作业数', async () => {
  const { core, rt, potential, dir, dv } = await boot()
  try {
    const out = await rt.tools.call('runtime.capability.list', {})
    assert.ok(out.engines.length >= 1)
    const e = out.engines.find(x => x.name === potential.activeProvider)
    assert.match(e.sourceId, /^engine:.+@[0-9a-f]{8}$/)
    assert.ok(Array.isArray(e.capabilities) && e.capabilities[0].type)
    assert.equal(typeof e.available, 'boolean',
      '在册引擎的可用性现在是可查询事实（探针已补齐：emt-mock/lj-js 真实握手或显式声明）')
    assert.equal(e.activeJobs, 0)
    assert.deepEqual(out.attached, [])
  } finally { await dv.dispose(); await core.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('2. attach 即时入池 → detach 经台账 → 再 attach（决策动作全程落 Trajectory）', async () => {
  const { core, rt, potential, trajPath, dir, dv } = await boot()
  try {
    const had = potential.providers.has('lj-js')
    const a = await rt.tools.call('runtime.engine.attach', { plugin: 'lj' })
    assert.equal(a.ok, true)
    assert.equal(a.mounted, 'saturday-lj')
    if (!had) {
      assert.deepEqual(a.providersGained, ['lj-js'], '注册即生效：无握手缓存')
      assert.match(a.engines[0].sourceId, /^engine:lj-js@/)
    }
    // 在途作业挡住拆除（refuse 缺省，绝不静默杀任务）
    const jid = potential.jobs.submit({ provider: had ? 'lj-js' : 'lj-js', kind: 'relax' })
    await assert.rejects(
      () => rt.tools.call('runtime.engine.detach', { engine: 'lj-js' }),
      err => err.code === 'ACTIVE_JOBS')
    potential.jobs.settle(jid)
    const d = await rt.tools.call('runtime.engine.detach', { engine: 'lj-js', onActive: 'drain' })
    assert.equal(d.detached, 'lj-js')
    assert.equal(potential.providers.has('lj-js'), false)
    const lines = (await readFile(trajPath, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l))
    assert.ok(lines.some(l => l.type === 'runtime_engine_attach' && l.mounted === 'saturday-lj'))
    assert.ok(lines.some(l => l.type === 'runtime_engine_detach' && l.engine === 'lj-js'))
  } finally { await dv.dispose(); await core.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('3. 重挂碰撞防护：宿主已挂的插件再 attach → 同名引擎显式拒绝，不静默替换', async () => {
  const { core, rt, potential, dir, dv } = await boot()
  try {
    // emt-mock 由核心插件注册；伪造一个同名重注册路径：直接调 register
    assert.throws(
      () => potential.register({ ...[...potential.providers.values()][0], name: 'emt-mock' }),
      err => err.code === 'PROVIDE_COLLISION')
  } finally { await dv.dispose(); await core.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('4. 热替换状态连续性：attach → 登记 engine 引用 → 盖章升实测版本 → 下游自动 stale', async () => {
  const { core, rt, potential, dir, dv } = await boot()
  try {
    await rt.tools.call('runtime.engine.attach', { plugin: 'lj' })
    if (!potential.providers.has('lj-js')) {
      // 本机无 Python 时核心插件已注册 lj-js：等价路径，继续
      assert.equal(core.store.saturday.dataPlane, 'lj-js')
    }
    const derivation = rt.getService('derivation')
    await derivation.record({ inputs: ['engine:lj-js'], output: 'result:derived-1', producer: 'test' })
    assert.equal(derivation.status('result:derived-1').status, 'valid')
    // 实测态盖章（unknown/旧值 → 新值）：sourceId 变 → refingerprinted 广播 → 失效传播
    await potential.stampFingerprint('lj-js', { version: '9.9.9-test' })
    assert.equal(derivation.status('result:derived-1').status, 'invalid')
  } finally { await dv.dispose(); await core.dispose(); await rm(dir, { recursive: true, force: true }) }
})
