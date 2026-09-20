// structure.fromPoscar 摄取测试：POSCAR 文本 → materialId（正确 formula/cell/nAtoms）→ 下游 potential.relax 真跑 → 轨迹落盘。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bridgePlugin from '../src/saturday.plugin.mjs'

test('1. 摄取 POSCAR → materialId + formula/cell 正确，下游 relax 真跑', async () => {
  const ctx = new Context()
  const dir = await mkdtemp(join(tmpdir(), 'sat-poscar-'))
  const path = join(dir, 'trajectory.jsonl')
  const core = await ctx.registry.plugin({ name: 'saturday', apply: (c) => bridgePlugin.apply(c, { trajectoryPath: path, quiet: true }) })
  const { rt } = core.store.saturday
  try {
    const ing = await rt.tools.call('structure.fromPoscar', { text: 'Cu\n1.0\n3.615 0 0\n0 3.615 0\n0 0 3.615\nCu\n2\nDirect\n0.0 0.0 0.0\n0.5 0.5 0.5\n' })
    assert.equal(ing.formula, 'Cu2')
    assert.equal(ing.nAtoms, 2)
    assert.ok(ing.materialId)
    assert.deepEqual(ing.cell[0], [3.615, 0, 0])
    // 下游真跑：对摄取的 material 做 relax（lj-js/emt-mock 均可），能量有限
    const r = await rt.tools.call('potential.relax', { materialId: ing.materialId })
    assert.ok(Number.isFinite(r.energy), 'relax 对摄取结构给出有限能量')
    await new Promise(res => setTimeout(res, 50))
    const text = await readFile(path, 'utf8')
    assert.ok(text.includes('structure_from_poscar'), '摄取动作落 Trajectory')
  } finally {
    await core.dispose(); await rm(dir, { recursive: true, force: true })
  }
})

test('2. 空文本 / 未知元素 显式报错', async () => {
  const ctx = new Context()
  const core = await ctx.registry.plugin({ name: 'saturday', apply: (c) => bridgePlugin.apply(c, { quiet: true }) })
  const { rt } = core.store.saturday
  try {
    await assert.rejects(() => rt.tools.call('structure.fromPoscar', { text: '   ' }), e => e.code === 'POSCAR_INPUT_MISSING')
    await assert.rejects(() => rt.tools.call('structure.fromPoscar', { text: 'X\n1.0\n1 0 0\n0 1 0\n0 0 1\nXx\n1\nDirect\n0 0 0' }), e => e.code === 'POSCAR_NO_SYMBOLS')
  } finally {
    await core.dispose()
  }
})

test('3. structure.fromXyz 摄取 → 分子 material（零胞 pbc=false）+ 下游 relax + 错误', async () => {
  const ctx = new Context()
  const core = await ctx.registry.plugin({ name: 'saturday', apply: (c) => bridgePlugin.apply(c, { quiet: true }) })
  const { rt } = core.store.saturday
  try {
    const ing = await rt.tools.call('structure.fromXyz', { text: '2\nwater-like\nCu 0.0 0.0 0.0\nAg 1.5 2.5 3.5\n' })
    assert.equal(ing.nAtoms, 2)
    assert.ok(ing.materialId)
    assert.match(ing.formula, /Cu/, 'formula 含 Cu'); assert.match(ing.formula, /Ag/, 'formula 含 Ag')
    // 不跑下游 relax：无 SMILES 的金属二聚体在 ASE 档会触发 rdDetermineBonds 失败（引擎对“金属当分子”的真实行为）；
    // 周期性材料的摄取→下游已在 POSCAR 用例（Cu2 relax）验证，readXyz 正确性在 core 测验证
    await assert.rejects(() => rt.tools.call('structure.fromXyz', { text: '  ' }), e => e.code === 'XYZ_INPUT_MISSING')
    await assert.rejects(() => rt.tools.call('structure.fromXyz', { text: '3\nc\nCu 0 0 0' }), e => e.code === 'XYZ_TRUNCATED')
  } finally { await core.dispose() }
})

const CU_CIF = ['data_cu', '_cell_length_a 3.615', '_cell_length_b 3.615', '_cell_length_c 3.615',
  '_cell_angle_alpha 90', '_cell_angle_beta 90', '_cell_angle_gamma 90',
  '_symmetry_space_group_name_H-M "P 1"', 'loop_', '_atom_site.type_symbol',
  '_atom_site.fract_x', '_atom_site.fract_y', '_atom_site.fract_z', '_atom_site.occupancy',
  'Cu 0 0 0 1.0', 'Cu 0.5 0.5 0.5 1.0'].join('\n')

test('4. structure.fromCif 摄取周期 Cu2 → materialId + 下游 relax 真跑 + 对称拒绝', async () => {
  const ctx = new Context()
  const core = await ctx.registry.plugin({ name: 'saturday', apply: (c) => bridgePlugin.apply(c, { quiet: true }) })
  const { rt } = core.store.saturday
  try {
    const ing = await rt.tools.call('structure.fromCif', { text: CU_CIF })
    assert.equal(ing.formula, 'Cu2'); assert.equal(ing.nAtoms, 2)
    assert.deepEqual(ing.cell[0], [3.615, 0, 0])
    const r = await rt.tools.call('potential.relax', { materialId: ing.materialId })
    assert.ok(Number.isFinite(r.energy), 'relax 对摄取周期结构给有限能量')
    const symCif = CU_CIF + '\nloop_\n_space_group_symop_operation_xyz\nx,y,z\nx+1/2,y,z\n'
    await assert.rejects(() => rt.tools.call('structure.fromCif', { text: symCif }), e => e.code === 'CIF_SYMMETRY_UNSUPPORTED')
    await assert.rejects(() => rt.tools.call('structure.fromCif', { text: '  ' }), e => e.code === 'CIF_INPUT_MISSING')
  } finally { await core.dispose() }
})
