// units.mjs 纯层测试（量纲分析最小落点：白名单 + 显式换算 + 一致性门禁）
// 换算系数全部先手算再对账（β 断言同款纪律）：
//   1 Ry = 13.6056981335 eV；1 Hartree = 27.211386245988 eV；
//   1 eV = 23.060547830619 kcal/mol；1 Bohr = 0.529177210903 Å；1 ps = 1000 fs。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertValidUnit, unitConvert, assertSameUnits,
  validateEngineUnits, validateEngineFingerprint, fingerprintEqual,
  UNIT_WHITELIST, BASE_UNITS,
} from '../src/index.mjs'

test('1. 白名单与维度归属：合法单位返回维度，未知单位显式拒绝', () => {
  assert.equal(assertValidUnit('eV'), 'energy')
  assert.equal(assertValidUnit('Ry'), 'energy')
  assert.equal(assertValidUnit('Bohr'), 'length')
  assert.equal(assertValidUnit('ps'), 'time')
  assert.equal(assertValidUnit('Angstrom'), 'length', 'ASCII 别名合法（输入侧宽容）')
  assert.throws(() => assertValidUnit('calorie'), err => err.code === 'UNIT_UNKNOWN')
  assert.throws(() => assertValidUnit(''), err => err.code === 'UNIT_UNKNOWN')
})

test('2. 显式换算闭式：手算对账（换算只经显式调用，无隐式路径）', () => {
  // 能量：2 Ry = 2 × 13.6056981335 eV
  assert.ok(Math.abs(unitConvert(2, 'Ry') - 27.211396267) < 1e-9)
  // 1 Hartree = 2 Ry（闭式关系：27.211386245988 / 13.6056981335 ≈ 2）
  assert.ok(Math.abs(unitConvert(1, 'Hartree', 'Ry') - 1.99999925) < 1e-6)
  // 1 eV = 23.060547830619 kcal/mol
  assert.ok(Math.abs(unitConvert(1, 'eV', 'kcal/mol') - 23.060547830619) < 1e-9)
  // 长度：1 Å = 1/0.529177210903 Bohr ≈ 1.8897261246
  assert.ok(Math.abs(unitConvert(1, 'Å', 'Bohr') - 1.8897261246257702) < 1e-9)
  // 时间：1 ps = 1000 fs
  assert.equal(unitConvert(1, 'ps'), 1000)
  // 同单位换算 = 恒等
  assert.equal(unitConvert(3.14, 'eV'), 3.14)
})

test('3. 换算门禁：跨维度/未知单位/非有限值均显式拒绝', () => {
  assert.throws(() => unitConvert(1, 'eV', 'Bohr'),
    err => err.code === 'UNIT_DIMENSION_MISMATCH', '能量 → 长度换算无定义')
  assert.throws(() => unitConvert(1, 'furlong'), err => err.code === 'UNIT_UNKNOWN')
  assert.throws(() => unitConvert(NaN, 'eV'), err => err.code === 'UNIT_INVALID_INPUT')
})

test('4. assertSameUnits 三态：一致放行 / 不一致抛码 / 未知单位抛码', () => {
  assertSameUnits('eV', 'eV', 'formation enthalpy')
  assert.throws(() => assertSameUnits('eV', 'Ry', 'formation enthalpy'),
    err => err.code === 'UNIT_MISMATCH',
    '不一致不自动换算：是否可比推回调用方显式决策')
  assert.throws(() => assertSameUnits('eV', 'banana'), err => err.code === 'UNIT_UNKNOWN')
})

test('5. manifest.units 校验：三元组齐全 + 维度错位拒绝 + Angstrom 归一', () => {
  assert.deepEqual(
    validateEngineUnits({ energy: 'eV', length: 'Å', time: 'fs' }),
    { energy: 'eV', length: 'Å', time: 'fs' })
  assert.deepEqual(
    validateEngineUnits({ energy: 'Ry', length: 'Angstrom', time: 'ps' }),
    { energy: 'Ry', length: 'Å', time: 'ps' }, 'ASCII 别名归一为 Å')
  // 三元组缺失
  assert.throws(() => validateEngineUnits({ energy: 'eV', length: 'Å' }),
    err => err.code === 'UNITS_MISSING')
  assert.throws(() => validateEngineUnits(undefined), err => err.code === 'UNITS_MISSING')
  // 维度错位：把长度单位声明在 energy 槽位
  assert.throws(() => validateEngineUnits({ energy: 'Bohr', length: 'Å', time: 'fs' }),
    err => err.code === 'UNIT_DIMENSION_MISMATCH')
})

test('6. manifest.fingerprint 校验：software/method 必填，version 缺失诚实降级 unknown', () => {
  assert.deepEqual(
    validateEngineFingerprint({ software: 'ase-emt', method: 'EMT', version: '3.23.0' }),
    { software: 'ase-emt', method: 'EMT', version: '3.23.0' })
  assert.deepEqual(
    validateEngineFingerprint({ software: 'lammps', method: 'EAM' }),
    { software: 'lammps', method: 'EAM', version: 'unknown' }, '版本不可得 → unknown，不冒充已知')
  assert.throws(() => validateEngineFingerprint({ method: 'EMT' }),
    err => err.code === 'FINGERPRINT_MISSING')
  assert.throws(() => validateEngineFingerprint({ software: '', method: 'EMT' }),
    err => err.code === 'FINGERPRINT_MISSING')
  assert.throws(() => validateEngineFingerprint(undefined), err => err.code === 'FINGERPRINT_MISSING')
})

test('7. fingerprintEqual：全同才同源，任一差异给出可读原因', () => {
  const a = { software: 'ase', method: 'EMT', version: '3.23.0' }
  assert.deepEqual(fingerprintEqual(a, { ...a }), { same: true, reason: null })
  assert.equal(fingerprintEqual(a, { ...a, method: 'DFT-PBE' }).same, false)
  assert.equal(fingerprintEqual(a, { ...a, version: '3.22.1' }).same, false)
  assert.ok(/software/.test(fingerprintEqual(a, { software: 'vasp', method: 'EMT', version: '3.23.0' }).reason))
  // version 缺失按 unknown 对齐：两边都缺 → 同源（不因"不可知"而拒绝组合）
  assert.equal(
    fingerprintEqual({ software: 'ase', method: 'EMT' }, { software: 'ase', method: 'EMT' }).same,
    true)
  assert.equal(fingerprintEqual(a, undefined).same, false)
})

test('8. 白名单与基准单位自洽：每维度基准单位在白名单内且因子为 1', () => {
  for (const [dim, base] of Object.entries(BASE_UNITS)) {
    assert.ok(base in UNIT_WHITELIST[dim], `${dim} 基准单位 ${base} 必须在白名单内`)
    assert.equal(UNIT_WHITELIST[dim][base], 1, '基准单位换算因子恒为 1')
  }
})
