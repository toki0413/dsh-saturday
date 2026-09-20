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
