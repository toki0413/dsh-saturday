// electronicView 补齐测试（路线 Week 9 验收：产生一条 CalculationRecord 而非同步返回）
//
// 修订 #9 的三条纪律断言：
//  1. 能力门禁：引擎未声明的性质显式拒绝（绝不静默返回 null）
//  2. 交付物是 CalculationRecord（计算产物引用）+ 谱系条目
//  3. 诚实失败不留产物：门禁拒绝时谱系不追加条目

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  Material, PrototypeLibResolver, PotentialRegistry,
  makeCalculationRecord,
} from '@saturday/core'
import { EmtMockProvider } from '../src/compute/emt-provider.mjs'

async function loadSi() {
  return Material.create({ modalities: { formula: 'Si' } }, new PrototypeLibResolver())
}

/** 势函数引擎替身：无电子结构（同 emt-mock 的声明形态） */
function makePotentialLikeProvider(name = 'pot-like') {
  return {
    name,
    version: '0.1.0',
    manifest: {
      capabilities: [
        { type: 'calculate', accuracy: 0.5, speed: 0.99, cost: 0.05, maxAtoms: 200, properties: ['stress'] },
      ],
      constraints: { requiresLicense: false },
      eventGranularity: 'iteration',
    },
    async calculate(material) {
      return { jobId: randomUUID(), engine: name, energy: -1.23, calculator: 'fake' }
    },
  }
}

/** DFT 类引擎替身：声明电子结构性质并真实给出 */
function makeDftLikeProvider(name = 'dft-like') {
  return {
    name,
    version: '0.1.0',
    manifest: {
      capabilities: [
        { type: 'calculate', accuracy: 0.95, speed: 0.3, cost: 0.9, maxAtoms: 500, properties: ['stress', 'bandgap', 'dos'] },
      ],
      constraints: { requiresLicense: false },
      eventGranularity: 'job',
    },
    async calculate(material, params = {}) {
      // 声明的性质全部真实给出（dos 大数组走对象存储引用，路线第 11 章形态）
      return {
        jobId: randomUUID(), engine: name, energy: -5.4, bandgap: 1.12,
        dos: { ref: 'obj-store/dos-1' }, calculator: 'fake-dft',
      }
    },
  }
}

test('1. 能力门禁：势函数引擎请求电子结构性质 → PROPERTY_UNSUPPORTED', async () => {
  const reg = new PotentialRegistry(null)
  reg.register(new EmtMockProvider(null))   // bridge 不会被调用：门禁先拦截
  const provider = reg.get('emt-mock')
  assert.throws(
    () => reg.assertCalculable(provider, ['bandgap', 'dos']),
    err => err.code === 'PROPERTY_UNSUPPORTED' && /never silently approximated/.test(err.message),
  )
})

test('2. 基线量 + 已声明者放行：energy/forces/stress 不触发门禁', async () => {
  const reg = new PotentialRegistry(null)
  reg.register(new EmtMockProvider(null))
  reg.assertCalculable(reg.get('emt-mock'), ['energy', 'forces', 'stress'])
})

test('3. electronicView 交付 CalculationRecord：引用 + 谱系条目（Week 9 验收）', async () => {
  const si = await loadSi()
  const reg = new PotentialRegistry(null)
  reg.register(makeDftLikeProvider())
  await reg.activate('dft-like')

  const view = await si.electronicView(reg)
  assert.equal(view.source, 'calculation')
  assert.equal(view.calculationId, view.record.id)
  assert.equal(view.record.materialId, si.id)
  assert.equal(view.record.formula, 'Si')
  assert.equal(view.record.engine, 'dft-like')
  assert.equal(view.record.values.bandgap, 1.12)
  assert.deepEqual(view.record.values.dos, { ref: 'obj-store/dos-1' })
  assert.deepEqual(view.record.unsupported, [])

  // 谱系条目：append-only 溯源（calculationId 可反查）
  const entry = si.lineage.find(l => l.operation === 'electronic-calculated')
  assert.ok(entry, '谱系应含 electronic-calculated 条目')
  assert.equal(entry.detail.calculationId, view.record.id)
  assert.deepEqual(entry.detail.requested, ['bandgap', 'dos'])
})

test('4. 诚实失败不留产物：门禁拒绝时不产生记录、不污染谱系', async () => {
  const si = await loadSi()
  const reg = new PotentialRegistry(null)
  reg.register(makePotentialLikeProvider())
  await reg.activate('pot-like')
  const lineageBefore = si.lineage.length

  await assert.rejects(
    () => si.electronicView(reg),
    err => err.code === 'PROPERTY_UNSUPPORTED',
  )
  assert.equal(si.lineage.length, lineageBefore, '被拒绝的计算不得追加谱系条目')
})

test('5. 记录级防御：引擎漏给的性质进 unsupported 而非 values', () => {
  const material = { id: 'm-1', formula: 'Cu' }
  const record = makeCalculationRecord({
    material, engine: 'leaky', requested: ['bandgap'],
    result: { jobId: 'j-1' },   // 引擎没给 bandgap（门禁被绕过的假想场景）
  })
  assert.deepEqual(record.values, {})
  assert.deepEqual(record.unsupported, ['bandgap'])
})
