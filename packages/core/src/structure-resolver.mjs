// StructureResolver —— 结构解析 seam
// 化学式本身不含结构信息：formula-only 构建必须显式声明结构来源。
// v0：内置原型库；后续接 Materials Project / 生成式模型（接口不变）。

import { Z } from './elements.mjs'

/** fcc 立方原胞（4 原子），实验晶格常数 */
function fcc(element, a) {
  return {
    source: `prototype:A1-fcc(a=${a})`, polymorphRank: 0,
    // 单质在自身凸包上，能量距定义为零（与 §7 “EMT 零点恰为元素平衡 fcc”一致）
    energyAboveHull: 0,
    cell: [[a, 0, 0], [0, a, 0], [0, 0, a]],
    frac: [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]],
    numbers: Array(4).fill(Z[element]),
  }
}

/** 内置原型库：每种结构给出晶胞与原子位置（分数坐标） */
const PROTOTYPE_LIB = {
  Si: [
    {
      source: 'prototype:A4-diamond', polymorphRank: 0, energyAboveHull: 0,
      cell: [[5.431, 0, 0], [0, 5.431, 0], [0, 0, 5.431]],
      // 金刚石常规晶胞，8 原子
      frac: [
        [0.00, 0.00, 0.00], [0.00, 0.50, 0.50], [0.50, 0.00, 0.50], [0.50, 0.50, 0.00],
        [0.25, 0.25, 0.25], [0.25, 0.75, 0.75], [0.75, 0.25, 0.75], [0.75, 0.75, 0.25],
      ],
      numbers: Array(8).fill(Z.Si),
    },
  ],
  Ar: [fcc('Ar', 5.26)],
  // EMT 支持的 fcc 金属（实验晶格常数；EMT 弛豫会落到自己的平衡值——这就是真实物理）
  Cu: [fcc('Cu', 3.615)],
  Ag: [fcc('Ag', 4.085)],
  Al: [fcc('Al', 4.050)],
  Ni: [fcc('Ni', 3.524)],
  Au: [fcc('Au', 4.078)],
  Pd: [fcc('Pd', 3.891)],
  Pt: [fcc('Pt', 3.924)],
  TiO2: [
    // 多晶型演示：金红石稳定（rank 0），锐钛矿亚稳（rank 1）
    {
      source: 'prototype:C4-rutile', polymorphRank: 0, energyAboveHull: 0.0,
      cell: [[4.594, 0, 0], [0, 4.594, 0], [0, 0, 2.959]],
      frac: [[0, 0, 0], [0.5, 0.5, 0.5], [0.305, 0.305, 0], [0.695, 0.695, 0], [0.195, 0.805, 0.5], [0.805, 0.195, 0.5]],
      numbers: [Z.Ti, Z.Ti, Z.O, Z.O, Z.O, Z.O],
    },
    {
      source: 'prototype:C5-anatase', polymorphRank: 1, energyAboveHull: 0.02,
      cell: [[3.785, 0, 0], [0, 3.785, 0], [0, 0, 9.514]],
      frac: [[0, 0, 0], [0, 0.5, 0.25], [0, 0, 0.208], [0, 0, -0.208], [0, 0.5, 0.458], [0, 0.5, 0.042]],
      numbers: [Z.Ti, Z.Ti, Z.O, Z.O, Z.O, Z.O],
    },
  ],
  LiFePO4: [
    {
      source: 'mp-19017', polymorphRank: 0, energyAboveHull: 0.0,
      cell: [[10.334, 0, 0], [0, 6.011, 0], [0, 0, 4.693]],
      // 橄榄石 Pnma（简化写出 4 个代表位，spike 用；完整 28 原子结构由 file 模态导入）
      frac: [[0, 0, 0], [0.282, 0.25, 0.974], [0.094, 0.25, 0.417], [0.457, 0.25, 0.208]],
      numbers: [Z.Li, Z.Fe, Z.O, Z.O],
    },
  ],
}

function fracToCart(frac, cell) {
  return frac.map(([fx, fy, fz]) => [
    fx * cell[0][0] + fy * cell[1][0] + fz * cell[2][0],
    fx * cell[0][1] + fy * cell[1][1] + fz * cell[2][1],
    fx * cell[0][2] + fy * cell[1][2] + fz * cell[2][2],
  ])
}

export class StructureNotFoundError extends Error {
  constructor(formula) {
    super(`No structure found for formula "${formula}". ` +
          `Available in prototype-lib: ${Object.keys(PROTOTYPE_LIB).join(', ')}`)
    this.code = 'STRUCTURE_NOT_FOUND'
  }
}

/** 原型库 Resolver（seam 实现之一） */
export class PrototypeLibResolver {
  name = 'prototype-lib'

  /** @returns {Promise<ResolvedStructure[]>} 按 polymorphRank 升序 */
  async resolve(formula) {
    const entries = PROTOTYPE_LIB[formula]
    if (!entries) throw new StructureNotFoundError(formula)
    return entries.map(e => ({
      graph: {
        nodes: e.numbers.map((z, i) => ({ id: i, number: z, position: fracToCart(e.frac, e.cell)[i] })),
        edges: [],
        periodic: true,
        cell: e.cell,
      },
      source: e.source,
      polymorphRank: e.polymorphRank,
      energyAboveHull: e.energyAboveHull,
    }))
  }
}
