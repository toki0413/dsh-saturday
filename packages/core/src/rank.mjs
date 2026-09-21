// @toki0413/core/rank —— 排序一致性统计（纯函数、零依赖、确定性）。
// 用途：跨引擎/跨代理对同一批候选的能量排序做一致性核对（Spearman ρ + 前 k 重合 + 平均绝对差）。
// 能量约定"越低越好"，故 top-k 取 k 个最小值。

function rankError(code, msg) { const e = new Error(`${msg} (${code})`); e.code = code; return e }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length

/** 平均秩（并列取均值，0 基）。长度 ≥1。 */
export function averageRanks(arr) {
  const n = arr.length
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
  const r = new Array(n)
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++
    const avg = (i + j) / 2
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg
    i = j + 1
  }
  return r
}

/** Pearson 相关（分母为零时返回 0，不 NaN）。 */
export function pearson(a, b) {
  if (a.length !== b.length || a.length === 0) throw rankError('RANK_LENGTH', 'pearson needs two equal non-empty arrays')
  const ma = mean(a), mb = mean(b)
  let num = 0, da = 0, db = 0
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y }
  const den = Math.sqrt(da * db)
  return den === 0 ? 0 : num / den
}

/** Spearman ρ = 秩的 Pearson。长度 <2 或常量序列按 0/1 处理（ρ 定义退化，如实返回 1 若同序）。 */
export function spearman(x, y) {
  if (x.length !== y.length || x.length === 0) throw rankError('RANK_LENGTH', 'spearman needs two equal non-empty arrays')
  if (x.length === 1) return 1
  return pearson(averageRanks(x), averageRanks(y))
}

/** 前 k 重合：两序列各取 k 个最小值的索引集，交/|k|。k 越界钳制到 [1, n]。 */
export function topKOverlap(x, y, k) {
  if (x.length !== y.length || x.length === 0) throw rankError('RANK_LENGTH', 'topKOverlap needs two equal non-empty arrays')
  const kk = Math.max(1, Math.min(k == null ? x.length : k, x.length))
  const bottomK = (arr) => new Set(arr.map((v, i) => [v, i]).sort((a, b) => (a[0] - b[0]) || (a[1] - b[1])).slice(0, kk).map(([, i]) => i))
  const ax = bottomK(x), ay = bottomK(y)
  let inter = 0
  for (const i of ax) if (ay.has(i)) inter++
  return { overlap: inter / kk, k: kk, shared: [...ax].filter((i) => ay.has(i)).length }
}

/** 平均绝对差（同序对应位）。 */
export function meanAbsDelta(x, y) {
  if (x.length !== y.length || x.length === 0) throw rankError('RANK_LENGTH', 'meanAbsDelta needs two equal non-empty arrays')
  return mean(x.map((v, i) => Math.abs(v - (y[i] ?? v))))
}
