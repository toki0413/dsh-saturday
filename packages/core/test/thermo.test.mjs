// @saturday/core 热力学第一档纯层测试：严格形成焓 + 二元凸包
// 诚实纪律的纯函数侧：缺参考态显式报错、超成分范围显式报错、不静默假设零点。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formationEnthalpy, convexHull, energyAboveHull,
  multiConvexHull, energyAboveHullMulti, MULTI_HULL_MAX_SUBSETS,
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

// ── 多组分凸包（第 1.5 档）：显式穷举单形下包络 ────────────────

test('9. 二元退化对账：multiConvexHull 与二元实现数值一致（同一物理量）', () => {
  const cu = { composition: { Cu: 1 }, energy: 0 }
  const ni = { composition: { Ni: 1 }, energy: 0 }
  // 稳定内点：两侧实现都应判在包上；不稳定内点：两侧都应给出同一弦上方距离 0.05
  const stableMulti = multiConvexHull([cu, ni, { composition: { Cu: 0.75, Ni: 0.25 }, energy: -0.1 }])
  const stableLegacy = convexHull([{ x: 0, y: 0 }, { x: 0.25, y: -0.1 }, { x: 1, y: 0 }])
  assert.equal(stableMulti.d, 1)
  assert.deepEqual(stableMulti.elements, ['Cu', 'Ni'])
  assert.equal(stableMulti.vertices.length, 3, '稳定内点必入包')
  assert.ok(Math.abs(
    energyAboveHullMulti({ composition: { Cu: 0.75, Ni: 0.25 }, energy: -0.1 }, stableMulti)
    - energyAboveHull({ x: 0.25, y: -0.1 }, stableLegacy)) < 1e-12, '包上点：两侧均为 0')
  const unstableMulti = multiConvexHull([cu, ni, { composition: { Cu: 0.75, Ni: 0.25 }, energy: 0.05 }])
  const unstableLegacy = convexHull([{ x: 0, y: 0 }, { x: 0.25, y: 0.05 }, { x: 1, y: 0 }])
  const multiDist = energyAboveHullMulti({ composition: { Cu: 0.75, Ni: 0.25 }, energy: 0.05 }, unstableMulti)
  const legacyDist = energyAboveHull({ x: 0.25, y: 0.05 }, unstableLegacy)
  assert.ok(Math.abs(multiDist - legacyDist) < 1e-12, `不稳定点：两侧距离一致（${multiDist} vs ${legacyDist}）`)
  assert.ok(Math.abs(multiDist - 0.05) < 1e-12)
  assert.equal(unstableMulti.nSubsets, 3, 'C(3,2)=3 个线段子集（诚实量）')
})

test('10. 三元四边形：稳定相入包、同成分竞争相出局、包上/包上方距离闭式', () => {
  const al = { composition: { Al: 1 }, energy: 0 }
  const b = { composition: { B: 1 }, energy: 0 }
  const cuEnd = { composition: { Cu: 1 }, energy: 0 }
  const stablePhase = { composition: { Al: 1 / 3, B: 1 / 3, Cu: 1 / 3 }, energy: -0.3 }
  const competitor = { composition: { Al: 1 / 3, B: 1 / 3, Cu: 1 / 3 }, energy: 0.1 }
  const r = multiConvexHull([al, b, cuEnd, stablePhase, competitor])
  assert.equal(r.d, 2)
  assert.equal(r.vertices.length, 4, '三端点 + 稳定相入包，竞争相出局')
  assert.ok(!r.vertices.some(v => v.energy === 0.1), '同成分高能量相不得入包')
  assert.equal(r.nSubsets, 10, 'C(5,3)=10（诚实量）')
  // 包上方：同成分查询，包络 = −0.3 → 距离闭式可验
  assert.ok(Math.abs(energyAboveHullMulti({ composition: { Al: 1 / 3, B: 1 / 3, Cu: 1 / 3 }, energy: 0 }, r) - 0.3) < 1e-9)
  assert.equal(energyAboveHullMulti({ composition: { Al: 1 / 3, B: 1 / 3, Cu: 1 / 3 }, energy: -0.3 }, r), 0, '包上顶点为 0')
})

test('11. 非轴对齐单形重心插值闭式核验（不靠数值巧合）', () => {
  // 端点能量全 0，稳定相 (1/3,1/3,1/3) = −0.3；查询 (Al 0.5, B 0.25, Cu 0.25)：
  // 重心解 λ_p = 0.75、λ_Al = 0.25、λ_B = 0 → 包络 = 0.75·(−0.3) = −0.225 → 距离闭式 0.075。
  const r = multiConvexHull([
    { composition: { Al: 1 }, energy: 0 },
    { composition: { B: 1 }, energy: 0 },
    { composition: { Cu: 1 }, energy: 0 },
    { composition: { Al: 1 / 3, B: 1 / 3, Cu: 1 / 3 }, energy: -0.3 },
  ])
  const q = { composition: { Al: 0.5, B: 0.25, Cu: 0.25 }, energy: -0.15 }
  const dist = energyAboveHullMulti(q, r)
  assert.ok(Math.abs(dist - 0.075) < 1e-9, `重心插值闭式：期望 0.075，实测 ${dist}`)
})

test('12. 端点纪律（第一档延续）：缺元素端点显式报错，不外推不静默', () => {
  assert.throws(
    () => multiConvexHull([
      { composition: { Al: 1 }, energy: 0 },
      { composition: { B: 1 }, energy: 0 },
      // 缺 Cu 端点：三元成分空间不完整
      { composition: { Al: 1 / 3, B: 1 / 3, Cu: 1 / 3 }, energy: -0.3 },
    ]),
    err => err.code === 'THERMO_REFERENCE_MISSING' && /Cu/.test(err.message),
  )
})

test('13. 门禁：成分归一/空点集/单元素/组合上限，逐项显式报错', () => {
  assert.throws(() => multiConvexHull([]), err => err.code === 'THERMO_INVALID_INPUT')
  assert.throws(() => multiConvexHull([{ composition: { Al: 0.5 }, energy: 0 }]),
    err => err.code === 'THERMO_INVALID_INPUT')
  assert.throws(() => multiConvexHull([{ composition: { Al: 1 }, energy: 0 }]),
    err => err.code === 'THERMO_INVALID_INPUT')
  assert.throws(() => multiConvexHull([{ composition: { Al: 1 }, energy: NaN }, { composition: { B: 1 }, energy: 0 }]),
    err => err.code === 'THERMO_INVALID_INPUT')
  // 组合上限：8 元素 19 点 → C(19,8)=75582 > 上限，显式报错不换近似算法
  const els = ['Al', 'B', 'C', 'Cu', 'F', 'H', 'Li', 'Na']
  const points = els.map(el => ({ composition: { [el]: 1 }, energy: 0 }))
  for (let i = 0; i < 11; i++) {
    const composition = {}
    els.forEach((el, k) => { composition[el] = ((k + i * 3) % 7 + 1) })
    const total = Object.values(composition).reduce((a, v) => a + v, 0)
    els.forEach(el => { composition[el] /= total })
    points.push({ composition, energy: -0.01 * i })
  }
  assert.ok(points.length === 19)
  assert.throws(() => multiConvexHull(points),
    err => err.code === 'THERMO_TOO_MANY_COMBINATIONS' && new RegExp(String(MULTI_HULL_MAX_SUBSETS)).test(err.message))
})

test('14. 查询门禁：包外成分显式报错不外推；负分数/非归一拒绝', () => {
  const r = multiConvexHull([
    { composition: { Al: 1 }, energy: 0 },
    { composition: { B: 1 }, energy: 0 },
    { composition: { Cu: 1 }, energy: 0 },
  ])
  // 非归一成分（和 ≠ 1）：拒绝而非外推
  assert.throws(() => energyAboveHullMulti({ composition: { Al: 0.9, B: 0.9 }, energy: 0 }, r),
    err => err.code === 'THERMO_INVALID_INPUT')
  // 负分数：拒绝（成分空间外不外推）
  assert.throws(() => energyAboveHullMulti({ composition: { Al: 1.2, B: -0.2 }, energy: 0 }, r),
    err => err.code === 'THERMO_INVALID_INPUT')
  // 非有限能量：拒绝
  assert.throws(() => energyAboveHullMulti({ composition: { Al: 0.5, B: 0.5 }, energy: NaN }, r),
    err => err.code === 'THERMO_INVALID_INPUT')
})
