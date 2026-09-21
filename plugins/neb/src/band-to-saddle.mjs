// plugin-neb 纯函数层：NEB 带 + QMM 鞍点复核的组合（带只当初值，不当结论）。
//
// 为什么要有这一层：packages/bridge/docs/experiments/neb-optimizer-trials.md 里四个带步长方案
// （全局 Euler、FIRE、两种单调回溯、逐像元独立步长）在同一位置停滞，症结是带参数化本身
// （nudged 力把切向真力投影掉，像元无法沿路滑动均衡间距）。继续换步长已无收益，
// 所以这里改变分工：带负责给出粗糙路径与最高点位置，鞍点由 #129 的 QMM 求解器复核并判 index-1。
//
// 实测依据（ljDoubleWell，弯带 kink=0.4 / 1.2，oracle 势垒 0.883988）：
//   带自身：barrier 0.937545（偏 5.4e-2）/ 1.343775（偏 4.6e-1），均未收敛；
//   取带最高点作 QMM 初值：两者均收敛到距对称鞍点 1e-9 处，barrier 0.883988（偏差 0.00e+0），负特征值数 1。
//
// 分工边界：复核只在带给出的点附近做局部搜索（trust region 取带跨度的量级），不承诺找到连接两端的
// 那条路径上的鞍点；若两端之间存在多个鞍点，结果对应带最高点最近的那个。带不收敛时这里仍会给结论，
// 但 report 会同时标出带未收敛（bandConverged=false），不把复核成功当作带收敛。

import { neb, analysisError } from './neb.mjs'
import { saddleSearch } from './saddle.mjs'

/**
 * 先拉带，再用带的最高点复核鞍点。
 * @param {{energy:Function, gradient:Function, hessian?:Function, start:number[], end:number[],
 *          nImages?:number, springK?:number, ftol?:number, maxSteps?:number, climb?:boolean,
 *          initialBand?:number[][], refine?:boolean, refineRadius?:number, refineOpts?:object}} a
 */
export function nebRefined(a = {}) {
  const { energy, gradient, hessian, refine = true, refineRadius = null, refineOpts = null, ...bandArgs } = a
  const band = neb({ energy, gradient, ...bandArgs })
  const span = band.images.length > 1
    ? Math.hypot(...band.images[band.images.length - 1].map((v, i) => v - band.images[0][i]))
    : 0
  const base = {
    ...band,
    bandBarrierForward: band.barrierForward,
    bandBarrierReverse: band.barrierReverse,
    refined: false,
    refinement: null,
  }
  if (refine !== true) return base

  const startTop = band.images[band.saddleIndex]
  const saddle = saddleSearch({
    energy, gradient, hessian, start: startTop,
    opts: { radius: refineRadius ?? Math.max(span, 1e-6), ...refineOpts },
  })
  const eSaddle = saddle.energy
  const eEnds = [band.energies[0], band.energies[band.energies.length - 1]]

  const refinement = {
    method: 'QMM 复核（#129 analysis.saddleSearch 的同一实现），初值=带最高点',
    usedBandTop: startTop,
    bandTopToSaddle: Math.hypot(...saddle.x.map((v, i) => v - startTop[i])),
    startedAtStationary: saddle.nSteps === 0,     // 带最高点已在鞍点上：复核无需走步
    reason: saddle.reason,
    nSteps: saddle.nSteps,
    stationary: saddle.report.stationary,
    insideTrustRegion: saddle.report.insideTrustRegion,
    gradNorm: saddle.gradNorm,
    eigenvalues: saddle.eigenvalues,
    negativeCount: saddle.negativeCount,
    energyGradientEvals: saddle.energyGradientEvals,
    sideMinima: saddle.barriers?.minima ?? null,
  }

  return {
    ...base,
    // 复核成功才替换势垒口径；失败保留带的估读值并显式说明
    refinedSaddle: saddle.converged ? saddle.x : null,
    barrierForward: saddle.converged ? eSaddle - eEnds[0] : band.barrierForward,
    barrierReverse: saddle.converged ? eSaddle - eEnds[eEnds.length - 1] : band.barrierReverse,
    refined: saddle.converged,
    saddleVerified: saddle.converged && saddle.negativeCount === 1,
    refinement,
    report: {
      bandConverged: band.converged,
      bandTriviallyStationary: band.convergence.trivialStationary === true,
      saddleConverged: saddle.converged,
      indexOne: saddle.negativeCount === 1,
      barrierSource: saddle.converged ? 'QMM 复核的鞍点能量' : '带内最高点（未复核，仅作上界估读）',
      note: '带未收敛不代表复核失败：两者分开报。带收敛也不代表鞍点成立——需 index-1 才算。',
    },
    note: band.note + '；势垒口径：refined=true 时取 QMM 复核鞍点能量（refinedSaddle 为其坐标），'
      + '否则退回带内最高点（未验证，偏高）',
  }
}

export { analysisError }
