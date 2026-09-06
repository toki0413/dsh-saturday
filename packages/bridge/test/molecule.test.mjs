// 分子 QC 扩展测试（C 阶段）：structure.fromSmiles → 弛豫（pbc=False 分子引擎）
// 断言按能力事实分支（sidecar 握手实测态 bridgeInfo.structureSources），不按档位身份——
// 三态各自封闭：无力环境（无 sidecar）/ 有桥无 RDKit（CI full-fidelity 只装 ase）/ 全能力真跑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import bridgePlugin from '@toki0413/bridge'

async function mount() {
  const ctx = new Context()
  const coreFiber = await ctx.registry.plugin({
    name: 'saturday',
    apply: (c) => bridgePlugin.apply(c, {}),
  })
  return { coreFiber, saturday: coreFiber.store.saturday }
}

test('分子 QC 三态：无桥显式失败 / 无 RDKit 实测态门禁 / 全能力甲醇全链', async () => {
  const { coreFiber, saturday } = await mount()
  const { rt, bridgeInfo } = saturday
  const hasSidecar = Boolean(bridgeInfo)
  const hasRdkit = Boolean(bridgeInfo?.structureSources?.['rdkit-struct'])

  try {
    if (!hasSidecar) {
      // 态一（zero-deps 档）：sidecar 通道不可达 → 显式失败，不静默
      await assert.rejects(
        () => rt.tools.call('structure.fromSmiles', { smiles: 'CO' }),
        err => /not connected|RDKit/.test(err.message),
        '无力/无源环境必须显式失败而非静默',
      )
      return
    }
    if (!hasRdkit) {
      // 态二（有桥无 RDKit，如 CI 精度档只装 ase）：握手实测态门禁拦截，
      // 错误码 RDKIT_UNAVAILABLE（不冒充可用、不静默降级到周期性源）
      await assert.rejects(
        () => rt.tools.call('structure.fromSmiles', { smiles: 'CO' }),
        err => err.code === 'RDKIT_UNAVAILABLE',
        'RDKit 缺失必须按实测态显式拒绝（structureSources 门禁）',
      )
      return
    }

    // 态三（全能力）：RDKit 生成甲醇 → 非周期 Material → 分子引擎弛豫
    const r = await rt.tools.call('structure.fromSmiles', { smiles: 'CO', seed: 42 })
    assert.ok(r.materialId)
    assert.equal(r.nAtoms, 6, 'CO 加氢 = CH3OH（6 原子）')
    // 化学式按代码库电负性排序约定（H2.20 < C2.55 < O3.44），非 Hill 记法
    assert.equal(r.formula, 'H4CO')
    assert.equal(r.forcefield, 'MMFF')

    const mat = await rt.getService('material').get(r.materialId)
    assert.equal(mat.graph.pbc.join(','), 'false,false,false', '分子体系 pbc=False 随图透传')
    assert.equal(mat.graph.smiles, 'CO', 'SMILES 随图透传（下游分子引擎重建拓扑依据）')

    // 分子弛豫：体系-引擎匹配 → RDKit MMFF/UFF（错配的 EMT/lj-mock 路径不得触碰）
    const relax = await rt.tools.call('potential.relax', { materialId: r.materialId })
    assert.equal(relax.converged, true, 'MMFF 弛豫应收敛')
    assert.ok(Number.isFinite(relax.energy), '分子弛豫能量有限')
    assert.match(relax.calculator, /^rdkit-/, '实际后端如实报告为分子引擎（非 ase-emt/lj-mock）')
  } finally {
    await coreFiber.dispose()
  }
})
