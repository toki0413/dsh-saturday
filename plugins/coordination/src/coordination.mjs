// plugin-coordination 纯函数层 —— 契约 §4.4 analysis seam：局域配位与短程有序分析。
//
// 定位：给一个结构（AtomGraph），回答筛选里天天要问、但仓内一直没有原语的三件事——
//  ① 每个原子的配位数（表面/间隙/富聚的直接判据）；
//  ② 键长分布按种对（A–A / A–B / B–B）分开的统计；
//  ③ 取代原子是"有序交替"还是"相分离富聚"（Warren–Cowley 短程有序参数 α）。
//
// 引擎无关、零依赖、确定性（无随机、无迭代不收敛风险）：只依赖结构本身，双档 CI 结果天然一致。
//
// 三处二义性不藏起来，全部作为输出字段随交付呈现：
//  1. **配位数依赖截断半径**：两种定义并存——调用方显式 rCut（method='explicit'），或自动
//     壳层间隙判据（method='shell-gap'：在 [d_min, 1.5·d_min] 窗口内取相邻壳层距离的最大
//     相对间隙、切在其几何均值；窗口内只有一层则取 1.5·d_min）。自动规则是启发式：理想
//     fcc/bcc/金刚石/NaCl 分别给出教科书 12/8/4/6（测试逐个锚定），对连续谱的非晶结构会
//     退化——退化时 rCut 落在峰上，逐原子 ambiguous 计数报出模糊邻居数，不假装修得对。
//  2. **α 的随机参照有有限尺寸下限**：用不重复抽样的超几何期望 E[N_AB]=2·M·N_A·N_B/(N(N−1))
//     （M=键数），小组胞里"全交替"到不了 −1，且该下限由 N 决定而非物理——故同时交付
//     observed 与 expectedRandom，不丢一个孤零零的 α。
//  3. **非周期体系**（零胞或 pbc 含 false，如 SMILES/XYZ 分子）不使用镜像：表面/孤立配位
//     缺失是几何事实，本层不与体相对照（调用方没给体相参考，就不臆造）。
//
// 计数约定（M=ΣCN/2 必须成立，测试锚定）：i<j 的一条记录代表一对邻居（两侧各 +1，键 +1）；
// i===j 的自镜像记录只取"规范半集"（首个非零平移分量为正），一条记录两侧邻居都在，
// 故该原子 CN +2、键 +1。

import { SYMBOL } from '@toki0413/core'

export function coordError(code, message) {
  const e = new Error(`${message} (${code})`)
  e.code = code
  return e
}

const AUTO_WINDOW = 1.5   // 自动壳层判据的搜索窗口上限（×d_min）
const AMBIG_TOL = 0.02    // 邻居距离与 rCut 相对偏差小于此值即计为"模糊邻居"

function det3(m) {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

/** 周期性判定：胞非退化且 pbc 未被显式置 false（原型库常缺 pbc 字段，按胞推断）。 */
export function isPeriodic(graph) {
  const cell = graph?.cell
  if (!Array.isArray(cell) || cell.length !== 3 || !Number.isFinite(det3(cell)) || Math.abs(det3(cell)) < 1e-9) return false
  const pbc = graph.pbc
  if (Array.isArray(pbc)) return pbc.slice(0, 3).every(Boolean)
  return true
}

/** 全部整数平移（含零），以及"规范半集"（首个非零分量为正）——自镜像去重靠后者 */
function shiftTable(cell, rMax, { half = false } = {}) {
  const ranges = [0, 1, 2].map(k => Math.ceil(rMax / Math.hypot(...cell[k])))
  const out = []
  for (let a = -ranges[0]; a <= ranges[0]; a++)
    for (let b = -ranges[1]; b <= ranges[1]; b++)
      for (let c = -ranges[2]; c <= ranges[2]; c++) {
        if (a === 0 && b === 0 && c === 0) continue
        if (half && !((a > 0) || (a === 0 && b > 0) || (a === 0 && b === 0 && c > 0))) continue
        out.push([
          a * cell[0][0] + b * cell[1][0] + c * cell[2][0],
          a * cell[0][1] + b * cell[1][1] + c * cell[2][1],
          a * cell[0][2] + b * cell[1][2] + c * cell[2][2],
        ])
      }
  return out
}

/**
 * 枚举 rMax 内的邻居记录（含镜像）。
 * @returns {Array<{i:number,j:number,d:number,weight:number}>} weight=1 普通对，2 自镜像对
 */
export function neighborPairs(nodes, cell, rMax, periodic) {
  const n = nodes.length
  const pos = nodes.map((nd) => nd.position)
  const out = []
  const full = periodic ? shiftTable(cell, rMax) : []
  const self = periodic ? shiftTable(cell, rMax, { half: true }) : []
  const keep = (i, j, dv, weight) => {
    const d = Math.hypot(...dv)
    if (d > 1e-9 && d <= rMax) out.push({ i, j, d, weight })
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      keep(i, j, pos[j].map((v, k) => v - pos[i][k]), 1)
      for (const sh of full) keep(i, j, pos[j].map((v, k) => v - pos[i][k] + sh[k]), 1)
    }
    for (const sh of self) keep(i, i, sh, 2)
  }
  return out
}

/** 晶格最近邻距离（单原子胞没有 within-cell 对时 d_min 的来源） */
function latticeNearest(cell) {
  let best = Infinity
  for (const v of shiftTable(cell, Math.max(...[0, 1, 2].map(k => Math.hypot(...cell[k]))))) best = Math.min(best, Math.hypot(...v))
  return best
}

/**
 * 自动截断半径（壳层间隙判据）。@param {number[]} distances 窗口内全部邻居距离记录
 */
export function autoCutoff(distances) {
  const ds = distances.filter(Number.isFinite)
  if (!ds.length) throw coordError('COORD_NO_NEIGHBORS', '结构内无任何近邻，无法定截断半径（孤立原子请显式传 rCut）')
  const dMin = Math.min(...ds)
  if (!(dMin > 0)) throw coordError('COORD_BAD_GEOMETRY', `最近邻距离非正：${dMin}`)
  const vals = [...new Set(ds.filter(d => d <= AUTO_WINDOW * dMin + 1e-12).map(d => +d.toFixed(9)))].sort((a, b) => a - b)
  let cut = AUTO_WINDOW * dMin
  let bestRatio = 1
  for (let k = 1; k < vals.length; k++) {
    const ratio = vals[k] / vals[k - 1]
    if (ratio > bestRatio) { bestRatio = ratio; cut = Math.sqrt(vals[k - 1] * vals[k]) }
  }
  return { rCut: cut, dMin, shellsInWindow: vals.length, gapRatio: bestRatio }
}

const stats = (xs) => {
  if (!xs.length) return null
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  return {
    count: xs.length, mean,
    std: Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length),
    min: Math.min(...xs), max: Math.max(...xs),
  }
}
const symOf = (nd) => SYMBOL[nd.number] ?? `Z${nd.number}`
const pairKey = (sa, sb) => (sa < sb ? `${sa}-${sb}` : `${sb}-${sa}`)

/**
 * 局域配位与短程有序分析。
 * @param {{cell:number[][],nodes:{number:number,position:number[]}[],pbc?:boolean[]}} graph
 * @param {{rCut?:number}} [opts] 传 rCut 走显式定义，否则走自动壳层间隙判据
 */
export function coordinationAnalysis(graph, { rCut } = {}) {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    throw coordError('COORD_BAD_GRAPH', 'analysis.coordination requires a material graph with nodes (material-structure input)')
  }
  for (const [i, nd] of graph.nodes.entries()) {
    const p = nd?.position
    if (!Array.isArray(p) || p.length !== 3 || p.some(v => !Number.isFinite(v))) {
      throw coordError('COORD_BAD_GRAPH', `节点 ${i} 的 position 必须是三个有限数（收到 ${JSON.stringify(p)}）`)
    }
    if (!Number.isInteger(nd.number) || nd.number < 1) throw coordError('COORD_BAD_GRAPH', `节点 ${i} 的 number 必须是正整数`)
  }
  if (rCut != null && (!Number.isFinite(rCut) || rCut <= 0)) {
    throw coordError('COORD_BAD_CUTOFF', `rCut 必须是正有限数或省略；收到 ${rCut}`)
  }
  const nodes = graph.nodes
  const n = nodes.length
  const periodic = isPeriodic(graph)
  const cell = periodic ? graph.cell : null

  // 定截断半径：先估 d_min（within-cell 对 + 晶格最近邻），再在 1.5·d_min 窗口内取壳层间隙
  let cutoff
  if (rCut != null) {
    cutoff = { rCut, dMin: null, shellsInWindow: null, gapRatio: null }
  } else {
    const seed = neighborPairs(nodes, cell, Infinity, false).map(p => p.d)
    if (periodic) seed.push(latticeNearest(cell))
    const d0 = Math.min(...seed.filter(Number.isFinite))
    if (!Number.isFinite(d0) || d0 <= 0) {
      throw coordError('COORD_NO_NEIGHBORS', `无有效近邻距离，无法自动定截断半径（d_min=${d0}）；请显式传 rCut`)
    }
    cutoff = autoCutoff(neighborPairs(nodes, cell, AUTO_WINDOW * d0 * 1.001, periodic).map(p => p.d))
  }

  const pairs = neighborPairs(nodes, cell, cutoff.rCut, periodic)
  const acc = nodes.map((nd, i) => ({ index: i, number: nd.number, symbol: symOf(nd), cn: 0, sum: 0, nearest: null, ambiguous: 0 }))
  const symAt = (k) => acc[k].symbol   // i===j 的自镜像记录取同一种对键
  const bondDist = new Map()
  const bondCount = new Map()
  const crossBonds = new Map()
  const speciesCount = new Map()
  for (const nd of nodes) { const s = symOf(nd); speciesCount.set(s, (speciesCount.get(s) ?? 0) + 1) }

  for (const { i, j, d, weight } of pairs) {
    const a = acc[i]
    a.cn += weight
    a.sum += d * weight
    a.nearest = a.nearest == null ? d : Math.min(a.nearest, d)
    if (j !== i) {
      const b = acc[j]
      b.cn += weight
      b.sum += d * weight
      b.nearest = b.nearest == null ? d : Math.min(b.nearest, d)
    }
    if (Math.abs(d - cutoff.rCut) <= AMBIG_TOL * cutoff.rCut) {
      a.ambiguous += weight
      if (j !== i) acc[j].ambiguous += weight
    }
    const key = pairKey(a.symbol, symAt(j))
    if (!bondDist.has(key)) { bondDist.set(key, []); bondCount.set(key, 0); crossBonds.set(key, 0) }
    bondDist.get(key).push(d)
    bondCount.set(key, bondCount.get(key) + 1)
    if (a.symbol !== symAt(j)) crossBonds.set(key, crossBonds.get(key) + 1)
  }

  const perAtom = acc.map(a => ({
    index: a.index, number: a.number, symbol: a.symbol, cn: a.cn,
    nearestDistance: a.nearest, meanNbDistance: a.cn > 0 ? a.sum / a.cn : null, ambiguous: a.ambiguous,
  }))
  const cnList = perAtom.map(p => p.cn)
  const distribution = {}
  for (const cn of cnList) distribution[cn] = (distribution[cn] ?? 0) + 1
  const totalBonds = [...bondCount.values()].reduce((a, b) => a + b, 0)

  const bonds = [...bondDist.entries()].map(([pair, ds]) => ({ pair, bonds: bondCount.get(pair), ...stats(ds) }))
    .sort((x, y) => y.bonds - x.bonds)

  // Warren–Cowley：对称归一 + 有限尺寸（不重复抽样）随机参照
  const symbols = [...speciesCount.keys()].sort()
  const warrenCowley = []
  for (let x = 0; x < symbols.length; x++) {
    for (let y = x + 1; y < symbols.length; y++) {
      const sA = symbols[x], sB = symbols[y]
      const NA = speciesCount.get(sA), NB = speciesCount.get(sB)
      const observed = crossBonds.get(pairKey(sA, sB)) ?? 0
      const expectedRandom = n > 1 ? (2 * totalBonds * NA * NB) / (n * (n - 1)) : 0
      warrenCowley.push({
        pair: pairKey(sA, sB), observed, expectedRandom,
        alpha: expectedRandom > 0 ? 1 - observed / expectedRandom : null,
        note: expectedRandom > 0
          ? 'α=1−观测异种键/随机参照；+1=完全相分离（无异种键），负值=有序交替。'
            + `随机参照含有限尺寸校正 N/(N−1)（N=${n}），小组胞的有序下限到不了 −1。`
          : '随机参照为 0（键数或组分数不足），α 无定义而非等于 0。',
      })
    }
  }

  return {
    method: rCut != null ? 'explicit' : 'shell-gap',
    periodic,
    rCut: cutoff.rCut,
    cutoff: cutoff.dMin == null
      ? `显式 rCut=${cutoff.rCut}（调用方给定）`
      : `自动壳层间隙：d_min=${cutoff.dMin.toFixed(4)} Å，窗口 [d_min, ${AUTO_WINDOW}·d_min] 内 ${cutoff.shellsInWindow} 个壳层、最大相对间隙 ${cutoff.gapRatio.toFixed(4)}，切在其几何均值`,
    nAtoms: n,
    composition: symbols.map(s => ({ symbol: s, count: speciesCount.get(s), fraction: speciesCount.get(s) / n })),
    perAtom,
    cnStats: { ...stats(cnList), distribution },
    bonds,
    totalBonds,
    cnSumIdentity: { sumCn: cnList.reduce((a, b) => a + b, 0), bondsTimes2: 2 * totalBonds },
    warrenCowley,
    declaration: '配位数依赖截断半径（本法' + (rCut != null ? '为显式给定' : '由壳层间隙启发式导出') + '）；'
      + `模糊邻居（与 rCut 相对偏差 <${AMBIG_TOL * 100}%）逐原子计数，非零则该值对半径敏感。`
      + (periodic ? '周期体系按镜像枚举，计数满足 ΣCN=2·键数。' : '非周期体系（零胞或 pbc=false）不用镜像：配位缺失是几何事实，本层不与体相对照。')
      + 'α 的随机参照是"键两端独立随机取种"的超几何期望，小 N 时有序下限受 N 限制。'
      + '元素符号取自 core 的 15 元素子集，表外 Z 标为 Z<number>（不猜符号，计数不受影响）。',
  }
}
