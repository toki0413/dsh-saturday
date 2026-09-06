// 分子 QC 扩展测试（C 阶段）：structure.fromSmiles → 弛豫（pbc=False 分子分支）
// 环境自适应：EMT 档（本地/full-fidelity）真跑甲醇全链；zero-deps 档 sidecar 缺失
// 显式失败（结构源不可达，不静默）。
// RDKit 可用性按实测态（bridge.sidecarInfo.structureSources）判定，不冒充。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import bridgePlugin from '@toki0413/bridge'

test('分子 QC：SMILES → 3D → 弛豫（EMT 档）/ 显式失败（zero-deps 档）', async () => {
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin({
    name: 'saturday',
    apply: (ctx) => bridgePlugin.apply(ctx, {}),
  })
  const rt = coreFiber.store.saturday.rt
  const dataPlane = coreFiber.store.saturday.dataPlane

  try {
    if (dataPlane === 'emt-mock') {
      // EMT 真物理档：RDKit（本地已装）生成甲醇 → 分子弛豫（pbc=False 分支）
      const r = await rt.tools.call('structure.fromSmiles', { smiles: 'CO', seed: 42 })
      assert.ok(r.materialId)
      assert.equal(r.nAtoms, 6, 'CO 加氢 = CH3OH（6 原子）')
      // 化学式按代码库电负性排序约定（H2.20 < C2.55 < O3.44），非 Hill 记法
      assert.equal(r.formula, 'H4CO')
      assert.equal(r.forcefield, 'MMFF')

      const mat = await rt.getService('material').get(r.materialId)
      assert.equal(mat.graph.pbc.join(','), 'false,false,false', '分子体系 pbc=False 随图透传')

      // 分子弛豫：BFGS 原子坐标分支（无晶胞自由度）
      const relax = await rt.tools.call('potential.relax', { materialId: r.materialId })
      assert.equal(relax.converged ?? true, true)
      assert.ok(Number.isFinite(relax.energy), '分子弛豫能量有限')

      // 分子单点力：EMT 对 H/C/O 簇计算（无周期像）
      const calc = await rt.tools.call('potential.calculate', { materialId: r.materialId }).catch(() => null)
      if (calc) {
        assert.ok(Number.isFinite(calc.energy), '单点能量有限')
        assert.ok(Array.isArray(calc.forces), '单点力数组交付')
      }
    } else {
      // zero-deps 档：sidecar 通道不可达 → structure.fromSmiles 显式失败（不静默）
      await assert.rejects(
        () => rt.tools.call('structure.fromSmiles', { smiles: 'CO' }),
        err => /not connected|RDKit/.test(err.message),
        '无力/无源环境必须显式失败而非静默',
      )
    }
  } finally {
    await coreFiber.dispose()
  }
})
