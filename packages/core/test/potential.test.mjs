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
