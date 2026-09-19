// 高斯过程回归 + 单目标贝叶斯优化（1D）——零依赖纯数值，供 workflow.bayesOptimize 消费。
//
// 定位（诚实）：GP 是有噪声观测下的后验均值/方差模型，用作昂贵黑箱目标 E(x) 的代理；
//   采集函数 LCB(x)=mu−kappa·sigma（极小化版 UCB， exploitation−exploration）指导下一评估点。
//   这是随机优化的启发式：不承诺收敛到全局最优、不承诺有限步内到 ε-邻域；对平滑单峰目标
//   经验上少评估逼近极小。数值全闭式可对账（Cholesky 解 SPD、GP 插值性质、合成目标 BO 收敛）。
//
// 纪律：纯函数、无外部依赖（自带 Cholesky 与回代）；病态（非正定/退化核）显式抛错，不静默加
//   大抖动掩盖——jitter 只加极小对角并在诊断里报告，让调用方知情。1D 输入（体变标度）。

function gpError(code, msg) { const e = new Error(`${msg} (${code})`); e.code = code; return e }

/** RBF（平方指数）核：k(a,b)=sf²·exp(−(a−b)²/(2·ls²)) */
export function rbf(a, b, { ls = 1.0, sf = 1.0 } = {}) {
  const d = a - b
  return sf * sf * Math.exp(-0.5 * (d * d) / (ls * ls))
}

/** Cholesky 下三角 L（A=LLᵀ），非正定即显式抛错 */
export function cholesky(A) {
  const n = A.length
  const L = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j]
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k]
      if (i === j) {
        if (s <= 1e-18) throw gpError('GP_NOT_POSITIVE_DEFINITE', `Cholesky pivot ${i} non-positive (${s}); 观测/核退化`)
        L[i][i] = Math.sqrt(s)
      } else {
        L[i][j] = s / L[j][j]
      }
    }
  }
  return L
}
function solveLower(L, b) {
  const n = L.length, y = new Array(n)
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i] }
  return y
}
function solveUpper(U, b) { // U 上三角
  const n = U.length, x = new Array(n)
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let k = i + 1; k < n; k++) s -= U[i][k] * x[k]; x[i] = s / U[i][i] }
  return x
}

/**
 * GP 训练：给定观测 (xs, ys)，常数先验均值 + 高斯噪声（极小 jitter 保数值稳定），
 * 预计算 K 的 Cholesky 与 alpha=K⁻¹(y−mean) 供后验闭式使用。
 */
export function gpTrain(xs, ys, { ls = 1.0, sf = 1.0, noise = 1e-6, mean = 0 } = {}) {
  const n = xs.length
  if (n !== ys.length || n === 0) throw gpError('GP_BAD_INPUT', 'gpTrain requires non-empty xs,ys of equal length')
  const K = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => rbf(xs[i], xs[j], { ls, sf }) + (i === j ? noise : 0)))
  const L = cholesky(K)
  const z = ys.map(y => y - mean)
  // 解 K·alpha=z：先 L·yv=z（下三角前代），再 Lᵀ·alpha=yv（上三角回代）
  const yv = solveLower(L, z)
  const LT = L[0].map((_, c) => L.map(r => r[c])) // Lᵀ
  const alpha = solveUpper(LT, yv)
  return { xs, ys, mean, ls, sf, noise, alpha, L, n }
}

/** GP 后验：对查询 x 给 (mean, variance)。variance 数值下限夹到 ≥0。 */
export function gpPredict(model, x) {
  const { xs, mean, ls, sf, alpha } = model
  const kstar = xs.map(xi => rbf(x, xi, { ls, sf }))
  let mu = mean
  for (let i = 0; i < kstar.length; i++) mu += kstar[i] * alpha[i]
  // var = k(x,x) − k*ᵀ K⁻¹ k*；用已有 Cholesky 解 K v = k*
  const yv = solveLower(model.L, kstar)
  const LT = model.L[0].map((_, c) => model.L.map(r => r[c]))
  const v = solveUpper(LT, yv)
  let kkv = 0
  for (let i = 0; i < kstar.length; i++) kkv += kstar[i] * v[i]
  const variance = Math.max(0, rbf(x, x, { ls, sf }) - kkv)
  return { mean: mu, variance }
}

/** LCB 采集（极小化）：mu − kappa·sigma，越小越该评估 */
export function lcb(model, x, kappa = 2.0) {
  const { mean, variance } = gpPredict(model, x)
  return mean - kappa * Math.sqrt(variance)
}

/**
 * 单目标贝叶斯优化（1D 极小化昂贵黑箱）。async objective(x)→number。
 * @param {{lo:number, hi:number, objective:AsyncFunction|Function, init?:number[], iterations?:number,
 *          kappa?:number, ls?:number, sf?:number, noise?:number, gridN?:number}} cfg
 * @returns {Promise<{ bestX, bestY, evaluations, history:[{x,y,via}], gpSampled:number[], note }>}
 */
export async function boMinimize({
  lo, hi, objective, init, iterations = 8, kappa = 2.0,
  ls, sf = 1.0, noise = 1e-6, gridN = 121,
} = {}) {
  if (!(hi > lo)) throw gpError('GP_BAD_BOUNDS', `require hi>lo; got lo=${lo} hi=${hi}`)
  if (typeof objective !== 'function') throw gpError('GP_BAD_OBJECTIVE', 'boMinimize requires objective(x)')
  const span = hi - lo
  const _ls = ls ?? span / 4
  const xs = [], ys = []
  const history = []
  // 冷启动：初值网格（缺省 3 点，端点+中点）
  const starts = init && init.length ? init : [lo + 0.15 * span, lo + 0.5 * span, lo + 0.85 * span]
  for (const x of starts) { const y = await objective(x); xs.push(x); ys.push(y); history.push({ x, y, via: 'init' }) }
  let bestI = ys.indexOf(Math.min(...ys))
  for (let it = 0; it < iterations; it++) {
    const model = gpTrain(xs, ys, { ls: _ls, sf, noise, mean: 0 })
    // 在均匀网格上最小化 LCB 选下一点
    let bx = null, bA = Infinity
    for (let g = 0; g < gridN; g++) {
      const x = lo + (span * g) / (gridN - 1)
      const a = lcb(model, x, kappa)
      if (a < bA) { bA = a; bx = x }
    }
    const y = await objective(bx)
    xs.push(bx); ys.push(y); history.push({ x: bx, y, via: 'lcb' })
    if (y < ys[bestI]) bestI = ys.length - 1
  }
  return {
    bestX: xs[bestI], bestY: ys[bestI],
    evaluations: xs.length,
    history,
    note: 'GP（RBF 核 + Cholesky）代理 + LCB 采集的 1D 贝叶斯优化；引擎/目标为唯一 oracle，' +
      '不声明全局最优（启发式，平滑单峰经验少评估逼近），ls 缺省 (hi−lo)/4。',
  }
}

// ── 多目标（Pareto）贝叶斯优化：目标向量均最小化，2D 超体积扫掠精确 ─────────
/** 非支配集（minimize 所有目标）：去掉被任一点支配者；保持输入序。 */
export function paretoFront(points) {
  const objs = points.length ? points[0].obj.length : 0
  const dom = (a, b) => { // a 支配 b：a 每目标 ≤ b 且至少一个严格 <
    let anyStrict = false
    for (let k = 0; k < objs; k++) {
      if (a.obj[k] > b.obj[k]) return false
      if (a.obj[k] < b.obj[k]) anyStrict = true
    }
    return anyStrict
  }
  return points.filter(p => !points.some(q => q !== p && dom(q, p)))
}

/**
 * 2D 超体积（最小化，ref 支配所有点）：按 obj0 升序扫掠，取运行 obj1 下降的前沿。
 * 只统计 obj0<ref0 且 obj1<ref1 的点。闭式可验证。
 */
export function hypervolume2d(points, ref) {
  const pts = points.filter(p => p.obj[0] < ref[0] && p.obj[1] < ref[1])
    .map(p => p.obj).sort((a, b) => a[0] - b[0])
  if (!pts.length) return 0
  // 取 obj1 严格下降的 Pareto 前沿（obj0 升序下）
  const front = []
  let best1 = Infinity
  for (const [f0, f1] of pts) { if (f1 < best1) { front.push([f0, f1]); best1 = f1 } }
  let hv = 0
  for (let i = 0; i < front.length; i++) {
    const xNext = i + 1 < front.length ? front[i + 1][0] : ref[0]
    hv += (xNext - front[i][0]) * (ref[1] - front[i][1])
  }
  return hv
}

/**
 * 多目标 1D 贝叶斯优化：每目标独立 GP，采集用"后验均值点加入前沿的超体积增益"（贪心，
 * 非完整 EHVI 积分，诚实声明）。async objectives:[(x)→f0,(x)→f1]。
 * @returns {Promise<{ pareto, hypervolume, evaluations, history, note }>}
 */
export async function boMinimizePareto({
  lo, hi, objectives, init, iterations = 8, ref, ls, sf = 1.0, noise = 1e-6, gridN = 121,
} = {}) {
  if (!(hi > lo)) throw gpError('GP_BAD_BOUNDS', `require hi>lo; got lo=${lo} hi=${hi}`)
  if (!Array.isArray(objectives) || objectives.length !== 2 || objectives.some(f => typeof f !== 'function')) {
    throw gpError('GP_BAD_OBJECTIVE', 'boMinimizePareto requires objectives=[f0,f1] (2 objectives, v1)')
  }
  const span = hi - lo
  const _ls = ls ?? span / 4
  const xs = [], ys0 = [], ys1 = []
  const history = []
  const starts = init && init.length ? init : [lo + 0.15 * span, lo + 0.5 * span, lo + 0.85 * span]
  for (const x of starts) { await evalAdd(x, 'init') }
  // ref 缺省：由 init 观测的最大目标加 20%+小边距推出（保证支配所有已知点）
  let refFinal = ref
  if (!Array.isArray(refFinal) || refFinal.length !== 2) {
    const m0 = Math.max(...ys0, 0), m1 = Math.max(...ys1, 0)
    refFinal = [m0 + Math.abs(m0) * 0.2 + 1e-6, m1 + Math.abs(m1) * 0.2 + 1e-6]
  }
  void ref
  function evalAdd(x, via) {
    return Promise.all(objectives.map(f => f(x))).then(([f0, f1]) => {
      xs.push(x); ys0.push(f0); ys1.push(f1); history.push({ x, obj: [f0, f1], via })
    })
  }
  const allPoints = () => xs.map((x, i) => ({ x, obj: [ys0[i], ys1[i]] }))
  for (let it = 0; it < iterations; it++) {
    const m0 = gpTrain(xs, ys0, { ls: _ls, sf, noise }), m1 = gpTrain(xs, ys1, { ls: _ls, sf, noise })
    const front = paretoFront(allPoints())
    const hv0 = hypervolume2d(front, refFinal)
    let bx = null, bGain = -Infinity
    for (let g = 0; g < gridN; g++) {
      const x = lo + (span * g) / (gridN - 1)
      const cand = { x, obj: [gpPredict(m0, x).mean, gpPredict(m1, x).mean] }
      const gain = hypervolume2d(paretoFront([...front, cand]), refFinal) - hv0
      if (gain > bGain) { bGain = gain; bx = x }
    }
    await evalAdd(bx, 'hv-gain')
  }
  const pareto = paretoFront(allPoints())
  return {
    pareto, hypervolume: hypervolume2d(pareto, refFinal),
    referencePoint: refFinal,
    evaluations: xs.length, history,
    note: '多目标(2)贝叶斯优化：逐目标独立 GP，采集用后验均值加入前沿的超体积增益（贪心，'
      + '非完整 EHVI 积分/不含采集中的不确定性）；不声明收敛到真实 Pareto 前沿。',
  }
}
