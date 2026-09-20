// 结构↔文件格式编解码库 —— @toki0413/core 域无关纯数值/序列化，零外部依赖。
//
// 设计意图（SDK 泛化通用）：把"结构序列化"从每个引擎 provider 里抽出来共享。
//   一个格式（如 LAMMPS data / XYZ / CIF…）写一次 codec，所有读该格式的引擎只需一份
//   描述符（见 descriptor-provider.mjs），不必各写序列化代码；不支持的体系由 codec 自己守卫。
// 每个 codec = { name, write(graph, opts) → string, [read] }。write 产出的文本形态是契约的一部分
//   （引擎靠它喂数据），改动须带金标准回归（descriptor.goldens）。

import { SYMBOL, Z as Z_BY_SYMBOL, ATOMIC_MASS } from './elements.mjs'

function codecError(code, msg) { const e = new Error(`${msg} (${code})`); e.code = code; return e }

/**
 * LAMMPS data file（atom_style atomic，仅正交盒）。忠实格式：
 *   <N> atoms / <M> atom types / 盒边界 xlo..zhi / Masses（按类型）/ Atoms（按节点）。
 * 质量取自共享 ATOMIC_MASS（不再自带表）；缺质量/非正交盒显式报错，不静默。
 * @param {object} graph AtomGraph {cell, nodes:[{number,position}]}
 * @param {{masses?:Object<string,number>}} [opts] 覆盖质量表（一般不传，用 core 共享表）
 */
export function writeLammpsData(graph, { masses = ATOMIC_MASS } = {}) {
  const cell = graph.cell
  const offDiag = [0, 1, 2].some(i => [0, 1, 2].some(j => i !== j && Math.abs(cell[i][j]) > 1e-9))
  if (offDiag) throw codecError('CODEC_NONORTHOGONAL', 'LAMMPS data codec v0: only orthogonal cells supported')

  const numbers = graph.nodes.map(n => n.number)
  const species = [...new Set(numbers)].sort((a, b) => a - b)
  const typeOf = new Map(species.map((z, i) => [z, i + 1]))

  const lines = [
    '# Saturday → LAMMPS data file (atom_style atomic)',
    '',
    `${graph.nodes.length} atoms`,
    `${species.length} atom types`,
    '',
    `0.0 ${cell[0][0]} xlo xhi`,
    `0.0 ${cell[1][1]} ylo yhi`,
    `0.0 ${cell[2][2]} zlo zhi`,
    '',
    'Masses',
    '',
    ...species.map((z, i) => {
      const el = SYMBOL[z]
      const m = masses[el]
      if (!Number.isFinite(m)) throw codecError('CODEC_MASS_MISSING', `no atomic mass for element "${el}"; extend core/elements ATOMIC_MASS`)
      return `${i + 1} ${m}   # ${el}`
    }),
    '',
    'Atoms',
    '',
    ...graph.nodes.map((n, i) =>
      `${i + 1} ${typeOf.get(n.number)} ${n.position.map(x => x.toFixed(6)).join(' ')}`),
    '',
  ]
  return lines.join('\n')
}

/**
 * XYZ 分子/周期文件格式（element/number 通用）：行数=N、comment、每行 "符号 x y z"。
 * 与 lammps-data 不同格式——证明格式 writer 可横向新增，而 descriptor-provider 不改。
 */
export function writeXyz(graph, { comment = 'generated-by-saturday' } = {}) {
  const nodes = graph.nodes ?? []
  const sym = (n) => {
    if (typeof n.symbol === 'string') return n.symbol
    const s = SYMBOL[n.number]
    if (!s) throw codecError('CODEC_SYMBOL_MISSING', `no element symbol for atom ${JSON.stringify(n)}`)
    return s
  }
  const lines = [String(nodes.length), comment,
    ...nodes.map(n => `${sym(n)} ${n.position.map(x => x.toFixed(6)).join(' ')}`)]
  return lines.join('\n') + '\n'
}

/**
 * XYZ 读取→ {nodes:[{number,position(Å)}], comment}。与 writeXyz 对称。
 * xyz 无晶胞（分子/非周期）；首行原子数必须与后续行匹配。未知元素/非有限坐标显式报错。
 */
export function readXyz(text) {
  const lines = String(text).split(/\r?\n/)
  if (lines.length < 2) throw codecError('XYZ_TRUNCATED', 'xyz needs at least a count line and a comment line')
  const n = Number.parseInt(lines[0].trim(), 10)
  if (!Number.isFinite(n) || n < 0) throw codecError('XYZ_BAD_COUNT', `xyz first line must be atom count, got "${lines[0]}"`)
  const comment = lines[1]
  const coordLines = lines.slice(2).filter(s => s.trim().length > 0)
  if (coordLines.length < n) throw codecError('XYZ_TRUNCATED', `xyz expected ${n} atoms, got ${coordLines.length}`)
  const nodes = []
  for (let i = 0; i < n; i++) {
    const t = coordLines[i].trim().split(/\s+/)
    const z = Z_BY_SYMBOL[t[0]]
    if (!Number.isFinite(z)) throw codecError('ELEMENT_DATA_MISSING', `unknown element "${t[0]}" in xyz line ${i}`)
    const pos = [Number(t[1]), Number(t[2]), Number(t[3])]
    if (pos.some(v => !Number.isFinite(v))) throw codecError('XYZ_BAD_COORD', `xyz atom ${i}: non-finite coordinate "${coordLines[i]}"`)
    nodes.push({ number: z, position: pos })
  }
  return { nodes, comment }
}

/** 3×3 逆矩阵（行向量约定），奇异即报错。 */
function invert3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (Math.abs(det) < 1e-12) throw codecError('CODEC_SINGULAR_CELL', 'cell matrix singular; cannot convert to fractional')
  const id = 1 / det
  return [
    [(e * i - f * h) * id, (c * h - b * i) * id, (b * f - c * e) * id],
    [(f * g - d * i) * id, (a * i - c * g) * id, (c * d - a * f) * id],
    [(d * h - e * g) * id, (b * g - a * h) * id, (a * e - b * d) * id],
  ]
}
const rowTimes = (v, M) => [0, 1, 2].map(k => v[0] * M[0][k] + v[1] * M[1][k] + v[2] * M[2][k])

/**
 * VASP POSCAR 写入（Direct/分数坐标，按元素分组——canonical，能喂真 VASP；支持非正交胞）。
 * positions 为绝对 Å（行向量约定 pos=f·cell）。
 */
export function writePoscar(graph, { comment = 'generated-by-saturday', scale = 1 } = {}) {
  const nodes = graph.nodes ?? []
  if (nodes.length === 0) throw codecError('CODEC_EMPTY', 'writePoscar requires at least one atom')
  const species = [...new Set(nodes.map(n => n.number))]
  const order = []
  for (const z of species) nodes.forEach((n, i) => { if (n.number === z) order.push(i) })
  const counts = species.map(z => nodes.filter(n => n.number === z).length)
  const inv = invert3(graph.cell)
  const lines = [comment, String(scale)]
  for (const row of graph.cell) lines.push(row.map(v => v.toFixed(10)).join(' '))
  lines.push(species.map(z => SYMBOL[z] ?? (() => { throw codecError('CODEC_SYMBOL_MISSING', `no symbol for Z=${z}`) })()).join(' '))
  lines.push(counts.join(' '))
  lines.push('Direct')
  for (const idx of order) {
    const f = rowTimes(nodes[idx].position, inv)
    lines.push(f.map(v => v.toFixed(8)).join(' '))
  }
  return lines.join('\n') + '\n'
}

/**
 * VASP POSCAR 读取 → {cell, nodes:[{number, position(Å)}]}。支持 Direct/Cartesian、scale、按元素分组。
 * 要求现代含元素符号行；未知元素/奇异胞显式报错。
 */
export function readPoscar(text) {
  const L = String(text).split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0)
  if (L.length < 8) throw codecError('POSCAR_TRUNCATED', 'POSCAR needs >=8 lines (comment/scale/3 cell/symbols/counts/mode/coords)')
  const scale = Number(L[1]) || 1
  const cell = [2, 3, 4].map(i => L[i].split(/\s+/).map(Number)).map(r => r.map(v => v * scale))
  const symTokens = L[5].split(/\s+/)
  const counts = L[6].split(/\s+/).map(Number)
  if (!symTokens.every(t => t in Z_BY_SYMBOL)) {
    throw codecError('POSCAR_NO_SYMBOLS', 'POSCAR element-symbol line required (legacy count-only POSCAR not supported)')
  }
  const numbers = []
  symTokens.forEach((s, k) => { const z = Z_BY_SYMBOL[s]; if (!Number.isFinite(z)) throw codecError('ELEMENT_DATA_MISSING', `unknown element "${s}"`); for (let c = 0; c < (counts[k] || 0); c++) numbers.push(z) })
  const cartesian = /^c/i.test(L[7])
  const coordLines = L.slice(8).filter(s => s.length > 0)
  if (coordLines.length < numbers.length) throw codecError('POSCAR_TRUNCATED', `expected ${numbers.length} coord lines, got ${coordLines.length}`)
  const nodes = numbers.map((z, i) => {
    const raw = coordLines[i].split(/\s+/).slice(0, 3).map(Number)
    const position = cartesian ? raw : rowTimes(raw, cell)
    return { number: z, position }
  })
  return { cell, nodes }
}

/** 格式名 → codec。描述符用 structure.inputFormat 选它。 */
export const CODECS = {
  'lammps-data': { name: 'lammps-data', write: writeLammpsData },
  'xyz': { name: 'xyz', write: writeXyz, read: readXyz },
  'poscar': { name: 'poscar', write: writePoscar, read: readPoscar },
}

/** 按名取 codec；未知格式显式报错（不猜序列化方式）。 */
export function getCodec(name) {
  const c = CODECS[name]
  if (!c) throw codecError('CODEC_UNKNOWN', `unknown structure format "${name}" (registered: ${Object.keys(CODECS).join(', ') || 'none'})`)
  return c
}
