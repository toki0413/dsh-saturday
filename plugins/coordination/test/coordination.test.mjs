// plugin-coordination 纯函数层测试 —— 全部锚在闭式已知值上（教科书配位数 / 解析 α 下限 / ΣCN=2M 恒等式）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coordinationAnalysis, neighborPairs, autoCutoff, isPeriodic } from '../src/coordination.mjs'

const CU = 29, AG = 47, AU = 79, C = 6, H = 1, O = 8, NA_OUT = 11, CL_OUT = 17   // 后两者不在 core 15 元素子集内
const cellOf = (a) => [[a, 0, 0], [0, a, 0], [0, 0, a]]
/** 分数坐标（立方胞）→ 笛卡尔 AtomGraph 节点表 */
function crystal(a, basis) {
  return basis.map(([z, f]) => ({ number: z, position: [f[0] * a, f[1] * a, f[2] * a] }))
}
const fcc = (z) => [[z, [0, 0, 0]], [z, [0, .5, .5]], [z, [.5, 0, .5]], [z, [.5, .5, 0]]]
const shift = (basis, d) => basis.map(([z, f]) => [z, f.map(v => +(v + d).toFixed(9))])
const MOL_CELL = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]

test('1. 理想 fcc：自动壳层间隙给教科书 CN=12，ΣCN=2·键数，键长=a/√2', () => {
  const a = 3.615
  const out = coordinationAnalysis({ cell: cellOf(a), nodes: crystal(a, fcc(CU)) })
  assert.equal(out.method, 'shell-gap')
  assert.equal(out.periodic, true)
  assert.ok(Math.abs(out.rCut - Math.sqrt(a * (a / Math.SQRT2))) < 1e-9, `切点应为 √(d_min·a)：${out.rCut}`)
  assert.deepEqual([...new Set(out.perAtom.map(p => p.cn))], [12], 'fcc 每原子 CN=12')
  assert.equal(out.cnStats.count, 4)
  assert.equal(out.totalBonds, 24, '4 原子 × CN12 / 2')
  assert.deepEqual(out.cnSumIdentity, { sumCn: 48, bondsTimes2: 48 }, '恒等式 ΣCN=2M 必须成立')
  const cu = out.bonds.find(b => b.pair === 'Cu-Cu')
  assert.equal(cu.count, 24)
  assert.ok(Math.abs(cu.min - a / Math.SQRT2) < 1e-9, `最短键长应为 a/√2=${a / Math.SQRT2}`)
  assert.equal(cu.max, cu.min, '同一壳层内键长全同（理想晶格）')
  assert.deepEqual([...new Set(out.perAtom.map(p => p.ambiguous))], [0], '切点落在间隙中点，无模糊邻居')
})

test('2. 理想 bcc / 金刚石：CN=8 与 CN=4（自动判据不写死元素）', () => {
  const aW = 3.165
  const bcc = coordinationAnalysis({ cell: cellOf(aW), nodes: crystal(aW, [[CU, [0, 0, 0]], [CU, [.5, .5, .5]]]) })
  assert.ok(Math.abs(bcc.rCut - Math.sqrt((aW * Math.sqrt(3) / 2) * aW)) < 1e-9, `bcc 切点 ${bcc.rCut}`)
  assert.deepEqual([...new Set(bcc.perAtom.map(p => p.cn))], [8], 'bcc 第一壳层 8 个')
  assert.equal(bcc.totalBonds, 8, '2 原子 × CN8 / 2')
  assert.deepEqual(bcc.cnSumIdentity, { sumCn: 16, bondsTimes2: 16 })

  const aC = 3.567
  const basis = [...fcc(C), ...shift(fcc(C), 0.25)]     // 金刚石 = fcc + (¼,¼,¼)
  const dm = coordinationAnalysis({ cell: cellOf(aC), nodes: crystal(aC, basis) })
  assert.equal(dm.perAtom.length, 8)
  assert.deepEqual([...new Set(dm.perAtom.map(p => p.cn))], [4], '金刚石 CN=4')
  assert.ok(Math.abs(dm.bonds[0].min - aC * Math.sqrt(3) / 4) < 1e-9, '键长 = √3a/4')
  assert.equal(dm.totalBonds, 16, '8 原子 × CN4 / 2')
})

test('3. NaCl 型几何（取两种在册元素）：CN=6 且键全是异种，α 命中解析有限尺寸下限', () => {
  const a = 5.640
  const basis = [...fcc(CU), ...shift(fcc(CU), 0.5).map(([z, f]) => [AG, f])]
  const out = coordinationAnalysis({ cell: cellOf(a), nodes: crystal(a, basis) })
  assert.deepEqual([...new Set(out.perAtom.map(p => p.cn))], [6], 'NaCl 型每原子 CN=6')
  assert.equal(out.bonds.length, 1, '只应存在一种键（全为异种）')
  assert.equal(out.bonds[0].pair, 'Ag-Cu')
  assert.equal(out.totalBonds, 24)
  assert.equal(out.warrenCowley.length, 1)
  const n = out.nAtoms
  const floor = 1 - (n * (n - 1)) / (2 * 4 * 4)            // 全交替时 α 的解析下限（只由 N 决定）
  assert.ok(Math.abs(out.warrenCowley[0].alpha - floor) < 1e-12, `α 应精确等于 ${floor}，收到 ${out.warrenCowley[0].alpha}`)

  // 2×2×2 超胞（同一构型，N=64）：下限随 N 单调趋 −1，闭式对照
  const bigBasis = basis.flatMap(([z, f]) => {
    const list = []
    for (const t of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1]])
      list.push([z, f.map((v, k) => (v + t[k]) / 2)])
    return list
  })
  const outBig = coordinationAnalysis({ cell: cellOf(2 * a), nodes: crystal(2 * a, bigBasis) })
  assert.equal(outBig.nAtoms, 64)
  const floorBig = 1 - (64 * 63) / (2 * 32 * 32)
  assert.ok(Math.abs(outBig.warrenCowley[0].alpha - floorBig) < 1e-12, `超胞 α 应命中 ${floorBig}`)
  assert.ok(outBig.warrenCowley[0].alpha < out.warrenCowley[0].alpha, 'N 越大，同一有序构型的 α 越接近 −1')
})

test('3b. 不在 core 元素子集内的 Z 标为 Z<number>（不猜符号），分析照常跑', () => {
  const a = 5.640
  const basis = [...fcc(NA_OUT), ...shift(fcc(NA_OUT), 0.5).map(([z, f]) => [CL_OUT, f])]
  const out = coordinationAnalysis({ cell: cellOf(a), nodes: crystal(a, basis) })
  assert.deepEqual([...new Set(out.perAtom.map(p => p.symbol))].sort(), ['Z11', 'Z17'])
  assert.equal(out.bonds[0].pair, 'Z11-Z17')
  assert.deepEqual([...new Set(out.perAtom.map(p => p.cn))], [6], '符号回退不影响配位计数')
  assert.ok(Math.abs(out.warrenCowley[0].alpha - (1 - (8 * 7) / (2 * 4 * 4))) < 1e-12, 'α 与在册元素同一公式')
})

test('4. 相分离极限 α=+1 与"单根异种键 α=0"（有限尺寸参照的性质锚点）', () => {
  const sep = {
    cell: MOL_CELL, pbc: [false, false, false],
    nodes: [
      { number: CU, position: [0, 0, 0] }, { number: CU, position: [2.5, 0, 0] },
      { number: AG, position: [15, 0, 0] }, { number: AG, position: [17.5, 0, 0] },
    ],
  }
  const out = coordinationAnalysis(sep, { rCut: 3 })
  assert.equal(out.periodic, false)
  assert.equal(out.totalBonds, 2, '只有 Cu-Cu 与 Ag-Ag 两根键')
  assert.equal(out.warrenCowley[0].observed, 0)
  assert.ok(Math.abs(out.warrenCowley[0].alpha - 1) < 1e-12, '完全相分离 α=+1 精确')

  const dimer = {
    cell: MOL_CELL, pbc: [false, false, false],
    nodes: [{ number: CU, position: [0, 0, 0] }, { number: AG, position: [2.5, 0, 0] }],
  }
  const d = coordinationAnalysis(dimer, { rCut: 3 })
  assert.equal(d.warrenCowley[0].observed, 1)
  assert.ok(Math.abs(d.warrenCowley[0].expectedRandom - 1) < 1e-12, '随机参照也是 1 根')
  assert.ok(Math.abs(d.warrenCowley[0].alpha) < 1e-12, '一根异种键相对随机参照无偏离（不是有序证据）')
})

test('5. 截断依赖与"模糊邻居"如实上报', () => {
  const a = 3.615
  const g = { cell: cellOf(a), nodes: crystal(a, fcc(CU)) }
  assert.deepEqual([...new Set(coordinationAnalysis(g, { rCut: 2.6 }).perAtom.map(p => p.cn))], [12])
  assert.deepEqual([...new Set(coordinationAnalysis(g, { rCut: 3.7 }).perAtom.map(p => p.cn))], [18], '12+6：第二壳层进来')
  const onEdge = coordinationAnalysis(g, { rCut: (a / Math.SQRT2) * 1.005 })
  assert.equal(onEdge.method, 'explicit')
  assert.deepEqual([...new Set(onEdge.perAtom.map(p => p.ambiguous))], [12], 'rCut 贴着壳层：12 个邻居全标模糊')
  assert.deepEqual([...new Set(onEdge.perAtom.map(p => p.cn))], [12], '此时 CN 对半径敏感（是声明不是 bug）')
})

test('6. 非周期分子：不用镜像、跨片段不误连、CN 由几何直接给', () => {
  const rOH = Math.hypot(0.757, 0.586, 0)
  const water = (ox) => ([
    { number: O, position: [ox, 0, 0] },
    { number: H, position: [ox + 0.757, 0.586, 0] },
    { number: H, position: [ox - 0.757, 0.586, 0] },
  ])
  const g = { cell: MOL_CELL, pbc: [false, false, false], nodes: [...water(0), ...water(15)] }
  const out = coordinationAnalysis(g, { rCut: 1.2 })
  assert.equal(isPeriodic(g), false)
  assert.equal(out.totalBonds, 4, '两个水分子共 4 根 O-H 键，无跨分子键')
  assert.deepEqual(out.perAtom.filter(p => p.symbol === 'O').map(p => p.cn), [2, 2])
  assert.deepEqual(out.perAtom.filter(p => p.symbol === 'H').map(p => p.cn), [1, 1, 1, 1])
  assert.ok(Math.abs(out.bonds[0].min - rOH) < 1e-9)
  assert.equal(neighborPairs(g.nodes, null, 1.2, false).length, 4, '非周期枚举只做胞内对')
})

test('7. 多组分：unordered 对不重复、随机参照同一式、α 对称归一', () => {
  const a = 3.615
  const basis = [[CU, [0, 0, 0]], [AG, [0, .5, .5]], [AU, [.5, 0, .5]], [CU, [.5, .5, 0]]]
  const out = coordinationAnalysis({ cell: cellOf(a), nodes: crystal(a, basis) })
  assert.deepEqual(out.warrenCowley.map(w => w.pair), ['Ag-Au', 'Ag-Cu', 'Au-Cu'], 'A-B 与 B-A 不重复计')
  const cnt = (s) => out.composition.find(c => c.symbol === s).count
  for (const w of out.warrenCowley) {
    const [sA, sB] = w.pair.split('-')
    assert.ok(Math.abs(w.expectedRandom - 2 * out.totalBonds * cnt(sA) * cnt(sB) / (4 * 3)) < 1e-12, `${w.pair} 随机参照一致`)
  }
  assert.equal(cnt('Cu'), 2)
  assert.equal(out.composition.length, 3)
})

test('8. 错误路径全部显式，不静默给假值', () => {
  assert.throws(() => coordinationAnalysis({ cell: cellOf(3.6), nodes: [] }), e => e.code === 'COORD_BAD_GRAPH')
  assert.throws(() => coordinationAnalysis(null), e => e.code === 'COORD_BAD_GRAPH')
  assert.throws(() => coordinationAnalysis({ cell: cellOf(3.6), nodes: [{ number: CU, position: [0, NaN, 0] }] }),
      e => e.code === 'COORD_BAD_GRAPH')
  assert.throws(() => coordinationAnalysis({ cell: cellOf(3.6), nodes: [{ number: 0, position: [0, 0, 0] }] }),
      e => e.code === 'COORD_BAD_GRAPH')
  const fccG = { cell: cellOf(3.615), nodes: crystal(3.615, fcc(CU)) }
  assert.throws(() => coordinationAnalysis(fccG, { rCut: 0 }), e => e.code === 'COORD_BAD_CUTOFF')
  assert.throws(() => coordinationAnalysis(fccG, { rCut: 'x' }), e => e.code === 'COORD_BAD_CUTOFF')
  const lone = { cell: MOL_CELL, pbc: [false, false, false], nodes: [{ number: CU, position: [0, 0, 0] }] }
  assert.throws(() => coordinationAnalysis(lone), e => e.code === 'COORD_NO_NEIGHBORS')
  assert.throws(() => autoCutoff([]), e => e.code === 'COORD_NO_NEIGHBORS')
})

test('9. 单原子胞靠晶格镜像定 d_min（原型库常见形态），简单立方 CN=6', () => {
  const a = 3.0
  const out = coordinationAnalysis({ cell: cellOf(a), nodes: [{ number: CU, position: [0, 0, 0] }] })
  assert.ok(Math.abs(out.rCut - Math.sqrt(a * a * Math.SQRT2)) < 1e-9, `切点 √(a·a√2)=${out.rCut}`)
  assert.deepEqual([...new Set(out.perAtom.map(p => p.cn))], [6], '简单立方 CN=6（邻居全来自自镜像）')
  assert.equal(out.totalBonds, 3, '1 原子 × CN6 / 2')
  assert.deepEqual(out.cnSumIdentity, { sumCn: 6, bondsTimes2: 6 }, '自镜像键计数不翻倍')
})
