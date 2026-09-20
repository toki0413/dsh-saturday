// core：声明式引擎描述符装配 + 共享 codec + 金标准机制测试（零外部依赖、注入伪二进制）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { writeLammpsData, writePoscar, readPoscar, writeXyz, readXyz, writeCif, readCif, getCodec } from '../src/codecs.mjs'
import { cellFromParams, paramsFromCell } from '../src/codecs.mjs'
import { ATOMIC_MASS, SYMBOL } from '../src/elements.mjs'
import { makeDescriptorProvider, renderTemplate, parseByRegex, checkGoldens } from '../src/descriptor-provider.mjs'

const close = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps}) ${msg}`)

function fakeChild({ stdout = '', exitCode = 0, spawnError = null } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  setImmediate(() => {
    if (spawnError) return child.emit('error', spawnError)
    if (stdout) child.stdout.emit('data', Buffer.from(stdout))
    child.emit('close', exitCode)
  })
  return child
}
const cuGraph = { cell: [[3.615, 0, 0], [0, 3.615, 0], [0, 0, 3.615]], nodes: [{ number: 29, position: [0, 0, 0] }] }

const DESCRIPTOR = {
  name: 'eng', version: '0.0.1', displayName: 'ENG', binaryDefault: 'e',
  manifest: { capabilities: [{ type: 'relax', accuracy: 0.5, speed: 0.5, cost: 0.5, maxAtoms: 10 }],
    constraints: {}, eventGranularity: 'job',
    units: { energy: 'eV', length: 'Å', time: 'fs' }, fingerprint: { software: 'eng', method: 'm', version: 'unknown' } },
  versionProbe: { args: ['-v'], regex: 'VER\\s+(\\S+)' },
  availability: { requireConfig: [{ key: 'potentialFile', label: 'potential file' }] },
  structure: { inputFormat: 'lammps-data' },
  run: { dataFile: 'd.in', inputFile: 'i.in', args: ['-in', 'i.in'], template: 'pair {{potentialFile}} read {{dataFile}}\nprint E=@@ {{e}}\n' },
  output: { energy: { name: 'E', regex: 'E=@@\\s+(-?\\d+(?:\\.\\d+)?)' } },
  result: { converged: true, nSteps: 0 },
}

test('1. codec：writeLammpsData 忠实格式 + 质量走共享表 + 非正交/未知格式报错', () => {
  const data = writeLammpsData(cuGraph)
  assert.match(data, /^1 atoms$/m)
  assert.match(data, new RegExp(`1 ${ATOMIC_MASS[SYMBOL[29]]}\\s+# Cu`))
  assert.match(data, /0\.0 3\.615 xlo xhi/)
  assert.throws(() => writeLammpsData({ cell: [[1, 0.5, 0], [0, 1, 0], [0, 0, 1]], nodes: [{ number: 29, position: [0, 0, 0] }] }), e => e.code === 'CODEC_NONORTHOGONAL')
  assert.throws(() => getCodec('nope'), e => e.code === 'CODEC_UNKNOWN')
})

test('2. makeDescriptorProvider：relax 写结构→渲染→spawn→解析能量，字段齐', async () => {
  const p = makeDescriptorProvider(DESCRIPTOR, {
    potentialFile: 'P.ep', vars: { e: 'x' },
    spawnImpl: () => fakeChild({ stdout: 'blah\nE=@@ -2.71\n' }),
  })
  assert.equal(p.name, 'eng')
  assert.equal(p.manifest.eventGranularity, 'job')
  const r = await p.relax({ graph: cuGraph })
  close(r.energy, -2.71, 1e-12)
  assert.equal(r.engine, 'eng'); assert.equal(r.calculator, 'eng')
  assert.equal(r.n_steps, 0); assert.equal(r.converged, true); assert.ok(r.jobId)
})

test('3. probeVersion / probeAvailability：横幅解析、缺配置/不可达分支', async () => {
  const ok = makeDescriptorProvider(DESCRIPTOR, { potentialFile: 'P', spawnImpl: () => fakeChild({ stdout: 'VER 1.2.3' }) })
  assert.equal(await ok.probeVersion(), '1.2.3')
  assert.deepEqual(await ok.probeAvailability(), { ok: true, reason: 'ENG 1.2.3' })
  const noPot = makeDescriptorProvider(DESCRIPTOR, { spawnImpl: () => fakeChild() })
  assert.equal((await noPot.probeAvailability()).ok, false)
  assert.match((await noPot.probeAvailability()).reason, /potential file/)
  const noBin = makeDescriptorProvider(DESCRIPTOR, { potentialFile: 'P', spawnImpl: () => fakeChild({ spawnError: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }) })
  assert.equal(await noBin.probeVersion(), null)
  assert.match((await noBin.probeAvailability()).reason, /not runnable/)
})

test('4. relax 缺二进制显式 ENGINE_UNAVAILABLE（注入错误工厂），不静默降级', async () => {
  const p = makeDescriptorProvider(DESCRIPTOR, {
    potentialFile: 'P', vars: { e: 'x' },
    spawnImpl: () => fakeChild({ spawnError: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }),
    EngineUnavailableError: (b, c) => Object.assign(new Error(`unavail ${b}: ${c}; never substitutes`), { code: 'ENGINE_UNAVAILABLE' }),
  })
  await assert.rejects(() => p.relax({ graph: cuGraph }), e => e.code === 'ENGINE_UNAVAILABLE' && /never substitutes/.test(e.message))
})

test('5. renderTemplate 缺变量报错 / parseByRegex 无标记报错', () => {
  assert.equal(renderTemplate('a {{x}}', { x: 1 }), 'a 1')
  assert.throws(() => renderTemplate('a {{y}}', { x: 1 }), e => e.code === 'DESCRIPTOR_MISSING_VAR')
  assert.throws(() => parseByRegex('no marker', { regex: 'V (\\d+)', name: 'v' }), e => e.code === 'DESCRIPTOR_OUTPUT_UNPARSED')
})

test('6. checkGoldens 机制：命中容差通过、超容差失败、未声明如实标 declared=false', async () => {
  const g = { ...DESCRIPTOR, goldens: [{ label: 'Cu', expectEnergy: -2.71, tol: 1e-3 }] }
  assert.equal((await checkGoldens({ descriptor: g, relaxOne: () => Promise.resolve(-2.71) })).passed, true)
  const bad = await checkGoldens({ descriptor: g, relaxOne: () => Promise.resolve(-9.9) })
  assert.equal(bad.passed, false); assert.equal(bad.results[0].ok, false)
  const none = await checkGoldens({ descriptor: DESCRIPTOR, relaxOne: () => Promise.resolve(0) })
  assert.equal(none.declared, false); assert.match(none.note, /未声明金标准/)
  await assert.rejects(() => checkGoldens({ descriptor: { goldens: [{ label: 'x', expectEnergy: 0 }] }, relaxOne: () => Promise.resolve(0) }), e => e.code === 'GOLDEN_BAD_TOL')
})

test('7. POSCAR 写入→读取往返（立方胞 Direct，分数↔笛卡尔互逆）', () => {
  const a = 3.615
  const graph = { cell: [[a, 0, 0], [0, a, 0], [0, 0, a]], nodes: [{ number: 29, position: [0, 0, 0] }, { number: 29, position: [a / 2, a / 2, a / 2] }] }
  const back = readPoscar(writePoscar(graph))
  assert.equal(back.nodes.length, 2)
  for (let i = 0; i < 2; i++) for (let k = 0; k < 3; k++) close(back.nodes[i].position[k], graph.nodes[i].position[k], 1e-6)
  assert.equal(back.nodes[0].number, 29)
})

test('8. POSCAR 读取：按元素分组 Direct + Cartesian + 未知元素报错', () => {
  const txt = ['Cu2Ag', '1', '4 0 0', '0 4 0', '0 0 4', 'Cu Ag', '2 1', 'Direct', '0 0 0', '0.5 0.5 0.5', '0.25 0.25 0.25'].join('\n')
  const g = readPoscar(txt)
  assert.deepEqual(g.nodes.map(n => n.number), [29, 29, 47])
  close(g.nodes[1].position[0], 2, 1e-9); close(g.nodes[2].position[0], 1, 1e-9)
  const cart = ['x', '1', '2 0 0', '0 2 0', '0 0 2', 'Cu', '1', 'Cartesian', '1 1 1'].join('\n')
  close(readPoscar(cart).nodes[0].position[0], 1, 1e-9)
  assert.throws(() => readPoscar(['x', '1', '1 0 0', '0 1 0', '0 0 1', 'Cu Zz', '1 1', 'Direct', '0 0 0', '0 0 0'].join('\n')), e => e.code === 'POSCAR_NO_SYMBOLS')
})

test('9. 非正交胞 POSCAR 往返 + poscar codec 可被 provider 用', () => {
  const getCodec2 = getCodec('poscar')
  assert.ok(getCodec2 && typeof getCodec2.write === 'function' && typeof getCodec2.read === 'function', 'poscar codec 有 write+read')
  const s = 1.8075
  const cell = [[0, s, s], [s, 0, s], [s, s, 0]] // fcc 原胞（非正交）
  const graph = { cell, nodes: [{ number: 29, position: [0, 0, 0] }, { number: 29, position: [s * 1.5, s * 1.5, s * 0.5] }] }
  const back = readPoscar(writePoscar(graph))
  for (let i = 0; i < 2; i++) for (let k = 0; k < 3; k++) close(back.nodes[i].position[k], graph.nodes[i].position[k], 1e-6, `atom${i}.${k}`)
})

test('10. XYZ 写入→读取往返 + 计数不符/未知元素报错 + getCodec xyz 有 read', () => {
  const graph = { cell: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], nodes: [{ number: 29, position: [0, 0, 0] }, { number: 47, position: [1.5, 2.5, 3.5] }] }
  const back = readXyz(writeXyz(graph, { comment: 'm' }))
  assert.deepEqual(back.nodes.map(n => n.number), [29, 47])
  close(back.nodes[1].position[1], 2.5, 1e-6); assert.equal(back.comment, 'm')
  assert.ok(typeof getCodec('xyz').read === 'function', 'xyz codec 现为可读写')
  assert.throws(() => readXyz('5\nc\nCu 0 0 0'), e => e.code === 'XYZ_TRUNCATED')
  assert.throws(() => readXyz('1\nc\nZz 0 0 0'), e => e.code === 'ELEMENT_DATA_MISSING')
})

test('11. CIF 写入→读取往返（立方 + 三斜）+ 对称/占位/缺 tag 拒绝 + 品胞参数互逆', () => {
  const rt = (cell) => {
    const graph = { cell, nodes: [{ number: 29, position: [0, 0, 0] }, { number: 47, position: [1.2, 2.3, 3.4] }] }
    const back = readCif(writeCif(graph))
    for (let i = 0; i < 2; i++) for (let k = 0; k < 3; k++) close(back.nodes[i].position[k], graph.nodes[i].position[k], 1e-4, `atom${i}.${k}`)
    assert.deepEqual(back.nodes.map(n => n.number), [29, 47])
  }
  rt([[3.615, 0, 0], [0, 3.615, 0], [0, 0, 3.615]])                         // 立方
  rt(cellFromParams(4, 5, 6, 80, 70, 60))                                   // 三斜
  const p = paramsFromCell(cellFromParams(4, 5, 6, 80, 70, 60))
  close(p.a, 4, 1e-6); close(p.b, 5, 1e-6); close(p.c, 6, 1e-6); close(p.gamma, 60, 1e-6)  // 参数↔向量互逆
  assert.ok(typeof getCodec('cif').read === 'function' && typeof getCodec('cif').write === 'function', 'cif codec 读写齐')
  // 对称性操作 → 拒
  assert.throws(() => readCif('data_x\n_cell_length_a 4\n_cell_length_b 4\n_cell_length_c 4\n_cell_angle_alpha 90\n_cell_angle_beta 90\n_cell_angle_gamma 90\nloop_\n_symmetry_equiv_pos_as_xyz\nx,y,z\n'), e => e.code === 'CIF_SYMMETRY_UNSUPPORTED')
  // 部分占位 → 拒
  const occCif = 'data_x\n_cell_length_a 4\n_cell_length_b 4\n_cell_length_c 4\n_cell_angle_alpha 90\n_cell_angle_beta 90\n_cell_angle_gamma 90\nloop_\n_atom_site.type_symbol\n_atom_site.fract_x\n_atom_site.fract_y\n_atom_site.fract_z\n_atom_site.occupancy\nCu 0 0 0 0.5\n'
  assert.throws(() => readCif(occCif), e => e.code === 'CIF_OCCUPANCY_UNSUPPORTED')
  // 缺 cell tag → 拒
  assert.throws(() => readCif('data_x\n_cell_length_a 4\nloop_\n_atom_site.type_symbol\n_atom_site.fract_x\n_atom_site.fract_y\n_atom_site.fract_z\nCu 0 0 0\n'), e => e.code === 'CIF_MISSING_TAG')
})
