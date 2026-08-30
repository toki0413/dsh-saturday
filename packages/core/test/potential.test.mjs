// PotentialRegistry 注册门禁 M1 自检（单位与指纹：异构引擎生态的泛化地基）
//
// 纪律：无单位声明/来源不可追溯的能量不得进入任何组合路径——注册即拒，
// 不给"先注册进去、以后再修"的侥幸通道（与未知证据源、粒度门禁同款诚实纪律）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PotentialRegistry } from '../src/index.mjs'

const baseManifest = () => ({
  capabilities: [{ type: 'calculate', accuracy: 0.5, speed: 0.99, cost: 0.05, maxAtoms: 200 }],
  constraints: {},
  eventGranularity: 'job',
  units: { energy: 'eV', length: 'Å', time: 'fs' },
  fingerprint: { software: 'stub', method: 'stub' },
})

test('1. 合法声明放行：归一后的 _units/_fingerprint 挂在 provider 上（不改写原 manifest）', () => {
  const reg = new PotentialRegistry(null)
  const provider = { name: 'ok-engine', manifest: { ...baseManifest(), units: { energy: 'eV', length: 'Angstrom', time: 'fs' } } }
  reg.register(provider)
  assert.deepEqual(provider._units, { energy: 'eV', length: 'Å', time: 'fs' }, 'ASCII 别名归一为 Å')
  assert.deepEqual(provider._fingerprint, { software: 'stub', method: 'stub', version: 'unknown' })
  assert.equal(provider.manifest.units.length, 'Angstrom', '原 manifest 不被改写（消费方只读归一形态）')
  assert.equal(reg.get('ok-engine'), provider)
})

test('2. 缺声明即拒：units 或 fingerprint 缺失 → 注册失败（无侥幸通道）', () => {
  const reg = new PotentialRegistry(null)
  const { units, fingerprint, ...noUnits } = baseManifest()
  assert.throws(() => reg.register({ name: 'no-units', manifest: noUnits }),
    err => err.code === 'UNITS_MISSING')
  const { units: u2, fingerprint: _f2, ...noBoth } = baseManifest()
  assert.throws(() => reg.register({ name: 'no-both', manifest: noBoth }),
    err => err.code === 'UNITS_MISSING')
  const { fingerprint: _f3, ...noFp } = baseManifest()
  assert.throws(() => reg.register({ name: 'no-fp', manifest: noFp }),
    err => err.code === 'FINGERPRINT_MISSING')
  assert.equal(reg.providers.size, 0, '拒绝注册不得留下半挂状态')
})

test('3. 非法/错位声明即拒：白名单外单位与维度错位都显式失败', () => {
  const reg = new PotentialRegistry(null)
  assert.throws(() => reg.register({ name: 'bad-unit', manifest: {
    ...baseManifest(), units: { energy: 'Rydberg-ish', length: 'Å', time: 'fs' },
  } }), err => err.code === 'UNIT_UNKNOWN', '白名单外单位不静默近似')
  assert.throws(() => reg.register({ name: 'mis-slotted', manifest: {
    ...baseManifest(), units: { energy: 'Bohr', length: 'Å', time: 'fs' },
  } }), err => err.code === 'UNIT_DIMENSION_MISMATCH', '长度单位声明进 energy 槽位即拒')
  assert.throws(() => reg.register({ name: 'no-software', manifest: {
    ...baseManifest(), fingerprint: { method: 'stub' },
  } }), err => err.code === 'FINGERPRINT_MISSING', 'software 缺失即拒（能量来源不可追溯）')
})

test('4. M2 激活门禁：热切换事件携带指纹差异声明（声明而非拒绝，与 §8.2 失效传播闭环）', async () => {
  const events = []
  const reg = new PotentialRegistry({ on() {}, emit: async (type, ev) => events.push(ev) })
  const engineOf = (name, fingerprint) => ({ name, manifest: { ...baseManifest(), fingerprint } })
  reg.register(engineOf('engine-a', { software: 'stub', method: 'stub' }))
  reg.register(engineOf('engine-b', { software: 'stub', method: 'DFT-PBE' }))
  reg.register(engineOf('engine-c', { software: 'stub', method: 'stub', version: 'unknown' }))
  reg.register(engineOf('engine-d', { software: 'stub', method: 'stub' }))
  await reg.activate('engine-a')
  assert.equal(events.length, 0, '首次激活不发事件（既有纪律不变）')
  await reg.activate('engine-b')
  assert.equal(events.length, 1)
  assert.equal(events[0].payload.previous, 'engine-a')
  assert.equal(events[0].payload.fingerprintChange.same, false, '异源切换：差异声明随事件呈现')
  assert.ok(/method/.test(events[0].payload.fingerprintChange.reason), '不可比原因可读（消费方据此知晓为何旧能量不再可比）')
  // 序列：a(stub/stub) → b(stub/DFT-PBE) → c(stub/stub) → d(stub/stub)；
  // 差异声明比较的是新引擎与前一激活引擎（热替换语义：旧能量是否仍可比）
  await reg.activate('engine-c')
  assert.equal(events[1].payload.fingerprintChange.same, false, '与前一引擎（engine-b）比较：method 不同仍声明差异')
  await reg.activate('engine-d')
  assert.equal(events[2].payload.fingerprintChange.same, true,
    '同源切换（version 两边缺视同 unknown，与 c 指纹全同）：失效传播照常但可比性声明诚实')
  await reg.activate('engine-d')
  assert.equal(events.length, 3, '重复激活同名引擎不发事件')
})

test('5. 实测态回读升级（①）：stampFingerprint 只丰富 version，非实测值即拒（不盖章冒充）', () => {
  const reg = new PotentialRegistry(null)
  const provider = { name: 'probe-engine', manifest: { ...baseManifest() } }
  reg.register(provider)
  assert.equal(provider._fingerprint.version, 'unknown', '注册后为声明态')
  // 探测成功 → 盖章升级为实测态；原 manifest 不被改写（与 M1 同款）
  const stamped = reg.stampFingerprint('probe-engine', { version: '3.23.0' })
  assert.deepEqual(stamped, { software: 'stub', method: 'stub', version: '3.23.0' })
  assert.equal(provider._fingerprint.version, '3.23.0')
  assert.equal(provider.manifest.fingerprint.version, undefined, '原 manifest 不改写（连 version 键都不补，声明态 ≠ 实测态）')
  // 探测失败方不得拿 unknown/空值/非字符串盖章（保持声明态，不污染指纹）
  for (const bad of ['unknown', '', null, 3.23, undefined]) {
    assert.throws(() => reg.stampFingerprint('probe-engine', { version: bad }),
      err => err.code === 'FINGERPRINT_STAMP_INVALID')
  }
  assert.equal(provider._fingerprint.version, '3.23.0', '非法盖章不得污染已升级指纹')
  assert.throws(() => reg.stampFingerprint('ghost-engine', { version: '1.0' }),
    /not registered/, '未注册引擎无章可盖')
})
