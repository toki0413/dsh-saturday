// @saturday/core 热力学第一档纯层测试：严格形成焓 + 二元凸包
// 诚实纪律的纯函数侧：缺参考态显式报错、超成分范围显式报错、不静默假设零点。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formationEnthalpy, convexHull, energyAboveHull,
  compositionFromNumbers, thermoError,
} from '../src/index.mjs'

test('1. 形成焓：显式零点下的逐原子归一计算', () => {
  // Cu3Ni：E = -12.4，参考 Cu=-3.0 / Ni=-2.9 → ΔH_f = (-12.4 − (3·(−3.0) + (−2.9))) / 4 = 0.025
  const dh = formationEnthalpy({
    energy: -12.4,
    composition: { Cu: 3, Ni: 1 },
    references: { Cu: -3.0, Ni: -2.9 },
  })
  assert.ok(Math.abs(dh - ((-12.4 - (3 * -3.0 + -2.9)) / 4)) < 1e-12)
})

test('2. 形成焓：缺参考态显式报错，绝不静默假设零点', () => {
  assert.throws(
    () => formationEnthalpy({ energy: -12.4, composition: { Cu: 3, Ni: 1 }, references: { Cu: -3.0 } }),
    err => err.code === 'THERMO_REFERENCE_MISSING' && /Ni/.test(err.message),
  )
  assert.throws(
    () => formationEnthalpy({ energy: -12.4, composition: { Cu: 3, Ni: 1 } }),
    err => err.code === 'THERMO_REFERENCE_MISSING',
  )
})

test('3. 形成焓：非法输入显式报错（能量非有限 / 计数非正整数 / 空成分）', () => {
  assert.throws(() => formationEnthalpy({ energy: NaN, composition: { Cu: 1 }, references: { Cu: 0 } }),
    err => err.code === 'THERMO_INVALID_INPUT')
  assert.throws(() => formationEnthalpy({ energy: -1, composition: { Cu: 1.5 }, references: { Cu: 0 } }),
    err => err.code === 'THERMO_INVALID_INPUT')
  assert.throws(() => formationEnthalpy({ energy: -1, composition: {}, references: {} }),
    err => err.code === 'THERMO_INVALID_INPUT')
})

test('4. compositionFromNumbers：原子序数 → 计数表；未知序数显式报错', () => {
  assert.deepEqual(compositionFromNumbers([29, 29, 29, 28]), { Cu: 3, Ni: 1 })
  assert.deepEqual(compositionFromNumbers([29]), { Cu: 1 })
  assert.throws(() => compositionFromNumbers([999]), err => err.code === 'THERMO_INVALID_INPUT')
})

test('5. 凸包：内点低于弦则入包（稳定相），高于弦则被弦覆盖', () => {
  // 稳定内点：ΔH_f < 0 → 三点全在包上
  const stable = convexHull([{ x: 0, y: 0 }, { x: 0.25, y: -0.1 }, { x: 1, y: 0 }])
  assert.equal(stable.hull.length, 3)
  // 不稳定内点：ΔH_f > 0 → 包退化为 0-0 弦
  const unstable = convexHull([{ x: 0, y: 0 }, { x: 0.25, y: 0.1 }, { x: 1, y: 0 }])
  assert.deepEqual(unstable.hull, [{ x: 0, y: 0 }, { x: 1, y: 0 }])
})

test('6. 凸包：同成分竞争相只留最低者；输入不足/非法显式报错', () => {
  const r = convexHull([
    { x: 0, y: 0 }, { x: 0.5, y: 0.05 }, { x: 0.5, y: -0.2 }, { x: 1, y: 0 },
  ])
  assert.deepEqual(r.hull.map(p => p.y), [0, -0.2, 0])
  assert.throws(() => convexHull([{ x: 0, y: 0 }]), err => err.code === 'THERMO_INVALID_INPUT')
  assert.throws(() => convexHull([{ x: 0, y: NaN }, { x: 1, y: 0 }]), err => err.code === 'THERMO_INVALID_INPUT')
})

test('7. energyAboveHull：弦上方距离正确、包上为 0、超范围显式报错', () => {
  const hull = convexHull([{ x: 0, y: 0 }, { x: 1, y: 0 }])
  assert.ok(Math.abs(energyAboveHull({ x: 0.25, y: 0.1 }, hull) - 0.1) < 1e-12)
  assert.equal(energyAboveHull({ x: 0.25, y: -0.05 }, hull), 0, '包下方钳到 0（数值容忍）')
  const hull2 = convexHull([{ x: 0, y: 0 }, { x: 0.5, y: -0.2 }, { x: 1, y: 0 }])
  assert.equal(energyAboveHull({ x: 0.5, y: -0.2 }, hull2), 0, '包上顶点为 0')
  assert.ok(Math.abs(energyAboveHull({ x: 0.25, y: 0 }, hull2) - 0.1) < 1e-12, '顶点与端点连线中点上方 0.1')
  assert.throws(() => energyAboveHull({ x: 1.5, y: 0 }, hull), err => err.code === 'THERMO_OUT_OF_RANGE')
})

test('8. thermoError：错误对象带 code（契约化错误族）', () => {
  const e = thermoError('THERMO_INVALID_INPUT', 'x')
  assert.equal(e.code, 'THERMO_INVALID_INPUT')
  assert.match(e.message, /\(THERMO_INVALID_INPUT\)$/)
})
