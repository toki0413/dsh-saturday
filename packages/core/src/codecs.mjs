// 结构↔文件格式编解码库 —— @toki0413/core 域无关纯数值/序列化，零外部依赖。
//
// 设计意图（SDK 泛化通用）：把"结构序列化"从每个引擎 provider 里抽出来共享。
//   一个格式（如 LAMMPS data / XYZ / CIF…）写一次 codec，所有读该格式的引擎只需一份
//   描述符（见 descriptor-provider.mjs），不必各写序列化代码；不支持的体系由 codec 自己守卫。
// 每个 codec = { name, write(graph, opts) → string, [read] }。write 产出的文本形态是契约的一部分
//   （引擎靠它喂数据），改动须带金标准回归（descriptor.goldens）。

import { SYMBOL, ATOMIC_MASS } from './elements.mjs'

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

/** 格式名 → codec。描述符用 structure.inputFormat 选它。 */
export const CODECS = {
  'lammps-data': { name: 'lammps-data', write: writeLammpsData },
}

/** 按名取 codec；未知格式显式报错（不猜序列化方式）。 */
export function getCodec(name) {
  const c = CODECS[name]
  if (!c) throw codecError('CODEC_UNKNOWN', `unknown structure format "${name}" (registered: ${Object.keys(CODECS).join(', ') || 'none'})`)
  return c
}
