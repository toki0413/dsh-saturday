// @saturday/python-bridge 互转精度测试（路线 Week 9 验收：ASE 互转精度）
//
// 验证 Saturday graph ↔ ASE Atoms 往返无损：
//   Material.toDict() → sidecar roundtrip（dict → ase.Atoms → dict）→ 逐分量比对。
// JSON-lines 传输与 numpy float64 均为 IEEE754 双精度，理论上逐位无损；
// 本套件以 < 1e-12 的容差断言，任何超出都说明转换链引入了缩放/取整/单位换算。
//
// 范围声明（诚实纪律）：本套件覆盖 ASE 腿；pymatgen 腿待其进入依赖集后补。
// 缺 python/ASE 环境自动跳过。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PythonBridge } from '../src/index.mjs'
import { Material, PrototypeLibResolver } from '@saturday/core'

/** 2D 数组逐元素最大绝对差 */
function maxDiff(a, b) {
  assert.equal(a.length, b.length, '行数不一致')
  let m = 0
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].length, b[i].length, `第 ${i} 行列数不一致`)
    for (let j = 0; j < a[i].length; j++) {
      m = Math.max(m, Math.abs(a[i][j] - b[i][j]))
    }
  }
  return m
}

/** 连接主 sidecar；缺 python/ASE 则跳过当前用例 */
async function connectOrSkip(t) {
  const bridge = new PythonBridge()
  try {
    await bridge.connect()
  } catch {
    t.skip('python unavailable in this environment')
    return null
  }
  if (!bridge.sidecarInfo.calculators['ase-emt']) {
    await bridge.disconnect()
    t.skip('ASE unavailable in this environment')
    return null
  }
  return bridge
}

test('1. 握手：sidecar 声明版本 ≥ 0.3.0（roundtrip 算子的出现版本）', async t => {
  const bridge = new PythonBridge()
  try {
    await bridge.connect()
  } catch {
    t.skip('python unavailable in this environment')
    return
  }
  try {
    const [major, minor] = bridge.sidecarInfo.version.split('.').map(Number)
    assert.ok(major > 0 || minor >= 3, `sidecar 版本 ${bridge.sidecarInfo.version} 应 ≥ 0.3.0`)
  } finally {
    await bridge.disconnect()
  }
})

test('2. 原型结构互转：TiO2 金红石（非立方晶胞 + 分数坐标展开）往返无损', async t => {
  const bridge = await connectOrSkip(t)
  if (!bridge) return
  try {
    const m = await Material.create({ modalities: { formula: 'TiO2' } }, new PrototypeLibResolver())
    const dict = m.toDict()
    const back = await bridge.call('roundtrip', { structure: dict })

    assert.deepEqual(back.numbers, dict.numbers, '原子序数应逐位一致')
    assert.deepEqual(back.pbc, [true, true, true], '周期性应保留')
    assert.ok(maxDiff(back.positions, dict.positions) < 1e-12, '位置往返误差应 < 1e-12')
    assert.ok(maxDiff(back.cell, dict.cell) < 1e-12, '晶胞往返误差应 < 1e-12')
  } finally {
    await bridge.disconnect()
  }
})

test('3. 三斜晶胞 + 无理坐标：苛刻数值下仍逐位往返', async t => {
  const bridge = await connectOrSkip(t)
  if (!bridge) return
  try {
    // 非正交晶胞 + sqrt 系数坐标：专门压测浮点转换链
    const cell = [[3.1, 0.4, 0], [0, 4.7, 0.9], [0.3, 0, 5.2]]
    const positions = [
      [Math.SQRT2, Math.PI / 3, 0.123456789012345],
      [0, 4.7 / 2, 2.6 - 1e-9],
    ]
    const structure = { numbers: [29, 8], positions, cell }
    const back = await bridge.call('roundtrip', { structure })

    assert.deepEqual(back.numbers, structure.numbers)
    assert.ok(maxDiff(back.positions, positions) < 1e-12, '无理坐标往返误差应 < 1e-12')
    assert.ok(maxDiff(back.cell, cell) < 1e-12, '三斜晶胞往返误差应 < 1e-12')
  } finally {
    await bridge.disconnect()
  }
})
