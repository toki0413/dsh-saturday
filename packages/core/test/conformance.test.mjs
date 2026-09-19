// conformance report 测试：合规格全绿 + 逐项不合精确挂 + 金标准折入（不依赖执行，纯静态核验）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conformanceReport } from '../src/conformance.mjs'

const conforming = () => ({
  name: 'eng',
  manifest: {
    capabilities: [{ type: 'relax', accuracy: 0.7, speed: 0.8, cost: 0.2, maxAtoms: 1000 }],
    eventGranularity: 'job',
    units: { energy: 'eV', length: 'Å', time: 'fs' },
    fingerprint: { software: 'eng', method: 'm-EAM', version: 'unknown' },
  },
  relax: async () => ({ energy: 0 }),
})

const check = (rep, id) => rep.checks.find(c => c.id === id)

test('1. 合规格 provider → passed，units/fingerprint 归一', () => {
  const rep = conformanceReport({ provider: conforming() })
  assert.equal(rep.passed, true, rep.checks.filter(c => !c.ok).map(c => c.id).join(','))
  assert.deepEqual(rep.units, { energy: 'eV', length: 'Å', time: 'fs' })
  assert.equal(rep.fingerprint.version, 'unknown')
  assert.equal(rep.eventGranularity, 'job')
})

test('2. Angstrom 别名归一为 Å（复用 units 真相源，非另立）', () => {
  const p = conforming(); p.manifest.units = { energy: 'eV', length: 'Angstrom', time: 'fs' }
  assert.equal(conformanceReport({ provider: p }).units.length, 'Å')
})

test('3. 单位越白名单 → UNITS 挂', () => {
  const p = conforming(); p.manifest.units = { energy: 'kWh', length: 'Å', time: 'fs' }
  const rep = conformanceReport({ provider: p })
  assert.equal(rep.passed, false)
  assert.equal(check(rep, 'UNITS').ok, false)
  assert.match(check(rep, 'UNITS').detail, /UNIT_UNKNOWN/)
})

test('4. 缺指纹 / 能力值越界 / 粒度非法 / 声明能力无方法 → 各自精确挂', () => {
  let p = conforming(); delete p.manifest.fingerprint
  assert.equal(check(conformanceReport({ provider: p }), 'FINGERPRINT').ok, false)

  p = conforming(); p.manifest.capabilities[0].accuracy = 5
  assert.equal(check(conformanceReport({ provider: p }), 'CAPABILITIES').ok, false)

  p = conforming(); p.manifest.eventGranularity = 'second'
  assert.equal(check(conformanceReport({ provider: p }), 'EVENT_GRANULARITY').ok, false)

  p = conforming(); delete p.relax   // 声明 relax 但没有方法
  const rep = conformanceReport({ provider: p })
  assert.equal(check(rep, 'CAPABILITY_METHODS').ok, false)
  assert.match(check(rep, 'CAPABILITY_METHODS').detail, /CONF_METHOD_MISSING/)
})

test('5. 金标准折入：声明且失败 → GOLDENS 挂；未声明 → declared=false 但通过', () => {
  const failing = conformanceReport({ provider: conforming(), goldens: { declared: true, passed: false, results: [{}] } })
  assert.equal(failing.passed, false)
  assert.equal(check(failing, 'GOLDENS').ok, false)
  const none = conformanceReport({ provider: conforming() })
  assert.equal(none.goldens.declared, false)
  assert.equal(none.passed, true, '未声明金标准不算失败，只是不作通过证据')
})

test('6. 无 provider → passed=false 不崩', () => {
  const rep = conformanceReport({})
  assert.equal(rep.passed, false)
  assert.equal(check(rep, 'SUBJECT').ok, false)
})
