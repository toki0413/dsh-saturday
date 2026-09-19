// 准谐近似（Quasi-Harmonic Approximation）纯函数层 —— 把 phonon-bz 的振动自由能与 EOS 静态能接成
// 有限温晶体学：F(V,T)=E_static(V)+F_vib(V,T)，对每个 T 极小化得 V(T)，热膨胀 α=(1/V)dV/dT。
//
// 语义与边界（诚实）：
//   - "准谐"= 声子频率随体积变化（ω(V)）、但不含本征非谐（声子-声子衰移/寿命）；这是把谐振荡子
//     自由能在每个体积独立求值再对 V 最小化的平均场近似，比谐近似能给出热膨胀，但强非谐体系会偏。
//   - 极小化在给定体积网格上求，网格间用"过最低点三点抛物线顶点"做连续插值（各向同性体变：V∝scale³）；
//     网格越稀插值越粗，随交付报告网格与拟合残差，不假装是解析平衡态。
//   - α 由 V(T) 中心差分，端点单侧差分；T→0 应回到 E_static 的平衡体积（数值核对）。
//   - 不碰引擎：E_static(V)、F_vib(V,T) 由调用方（工具层）算好后注入。

function qhaError(code, msg) { const e = new Error(`${msg} (${code})`); e.code = code; return e }

/** 过三点的抛物线 y=a·x²+b·x+c 的顶点 x*=-b/(2a)；开口不向上（a≤0）或退化 → ok=false */
export function parabolaVertex(x0, y0, x1, y1, x2, y2) {
  if (x0 === x1 || x1 === x2 || x0 === x2) return { x: x1, ok: false }
  const s01 = (y0 - y1) / (x0 - x1)   // a(x0+x1)+b
  const s12 = (y1 - y2) / (x1 - x2)   // a(x1+x2)+b
  const a = (s01 - s12) / (x0 - x2)
  if (!(a > 0)) return { x: x1, ok: false }  // 非开口向上 → 无内部极小
  const b = s01 - a * (x0 + x1)
  return { x: -b / (2 * a), ok: true }
}

/**
 * 准谐热膨胀：给定体积网格标度、静态能、逐温度振动自由能，求 V(T) 与 α(T)。
 * @param {object} opts
 * @param {number}   opts.baseVolume            scale=1（种子弛豫结构）对应体积（Å³）
 * @param {number[]} opts.scales                各向同性线度标度网格（升序，含接近 1 的点）
 * @param {number[]} opts.eStatic               各标度静态总能 E_static(scale)（eV），长度对齐 scales
 * @param {number[][]} opts.fvibMeV             fvibMeV[i][j]=scale i 在温度 temperatures[j] 的振动自由能（meV/cell）
 * @param {number[]} opts.temperatures          温度网格（K，升序）
 * @returns {{equilibrium, points:[{T,scale,volume,alphaPerK,fMinEV,parabolaFitOk}], note}}
 */
export function quasiharmonic({ baseVolume, scales, eStatic, fvibMeV, temperatures } = {}) {
  if (!(baseVolume > 0)) throw qhaError('QHA_BAD_INPUT', 'baseVolume must be > 0')
  if (!Array.isArray(scales) || scales.length < 3) throw qhaError('QHA_BAD_INPUT', 'scales needs >=3 points for parabola refinement')
  if (!Array.isArray(eStatic) || eStatic.length !== scales.length) throw qhaError('QHA_BAD_INPUT', 'eStatic must align with scales')
  if (!Array.isArray(temperatures) || temperatures.length === 0) throw qhaError('QHA_BAD_INPUT', 'temperatures must be non-empty')
  if (!Array.isArray(fvibMeV) || fvibMeV.length !== scales.length || fvibMeV.some(row => !Array.isArray(row) || row.length !== temperatures.length)) {
    throw qhaError('QHA_BAD_INPUT', 'fvibMeV must be [nScales][nTemperatures]')
  }
  // 校验升序
  for (let i = 1; i < scales.length; i++) if (!(scales[i] > scales[i - 1])) throw qhaError('QHA_BAD_INPUT', 'scales must be strictly increasing')

  const n = scales.length
  const volumeAt = (scale) => baseVolume * scale ** 3

  function minimizeIndex(F) { // 网格最小点下标
    let im = 0
    for (let i = 1; i < n; i++) if (F[i] < F[im]) im = i
    return im
  }
  function refineMin(F) { // 返回 {scale, fMin, ok}
    const im = minimizeIndex(F)
    if (im === 0 || im === n - 1) return { scale: scales[im], fMin: F[im], ok: false } // 边界，无三点 bracket
    const p = parabolaVertex(scales[im - 1], F[im - 1], scales[im], F[im], scales[im + 1], F[im + 1])
    if (!p.ok) return { scale: scales[im], fMin: F[im], ok: false }
    const sc = Math.min(Math.max(p.x, scales[0]), scales[n - 1])
    // fMin 取网格最低能量（诚实上界，不假装是连续极小值）；scale 用抛物线顶点插值
    return { scale: sc, fMin: F[im], ok: true }
  }

  // T=0：仅静态能
  const eq0 = refineMin(eStatic)
  // 逐温度 F(scale)=E_static + F_vib/1000（eV）
  const perT = temperatures.map((T, j) => {
    const F = scales.map((_, i) => eStatic[i] + fvibMeV[i][j] / 1000)
    const r = refineMin(F)
    return { T, scale: r.scale, volume: volumeAt(r.scale), fMinEV: r.fMin, parabolaFitOk: r.ok }
  })
  // α = (1/V) dV/dT；对 V(T) 中心差分，端点单侧
  const alphas = perT.map((p, k) => {
    const lo = Math.max(0, k - 1), hi = Math.min(perT.length - 1, k + 1)
    const dT = perT[hi].T - perT[lo].T
    const dV = perT[hi].volume - perT[lo].volume
    return dT > 0 ? (1 / p.volume) * (dV / dT) : NaN
  })
  const points = perT.map((p, k) => ({ ...p, alphaPerK: alphas[k] }))

  return {
    equilibriumT0: { scale: eq0.scale, volume: volumeAt(eq0.scale), eStaticEV: eq0.fMin },
    volumeAt0: volumeAt(eq0.scale),
    points,
    note: '准谐近似：ω 随体积变、不含本征非谐（声子衰移/寿命）；F(V,T)=E_static(V)+F_vib(V,T) ' +
      '在体积网格上求极小、网格间三点抛物线插值（V∝scale³）。α 由 V(T) 数值差分；parabolaFitOk=false ' +
      '表示落在网格边界、未内部插值。热膨胀数值非解析平衡态，随网格密疏而定。',
  }
}

/** 由 V(T) 曲线上两点估模式 Grüneisen 参数近似 γ ≈ -d lnω / d lnV（需 ω(V)；此处由 fvib 二阶导不稳，留给调用方按 ω 序列算）。 */
export function gruneisenFromFreqs({ volumes, omegaByVolume }) {
  if (!Array.isArray(volumes) || volumes.length < 2 || !Array.isArray(omegaByVolume) || omegaByVolume.length !== volumes.length) {
    throw qhaError('QHA_BAD_INPUT', 'gruneisen needs volumes[] and omegaByVolume[] of equal length >=2')
  }
  // 逐模式（按频率升序对齐）γ_m = - dlnω_m / dlnV，取两端线性拟合斜率负值
  const m = omegaByVolume[0].length
  const gammas = new Array(m).fill(0)
  for (let p = 0; p < m; p++) {
    const xs = volumes.map(Math.log), ys = omegaByVolume.map(w => Math.log(Math.abs(w[p]) || 1e-12))
    let sx = 0, sy = 0, sxx = 0, sxy = 0
    for (let i = 0; i < xs.length; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i] }
    const slope = (xs.length * sxy - sx * sy) / (xs.length * sxx - sx * sx || 1e-30)
    gammas[p] = -slope
  }
  return { modeGammas: gammas, gammaAvg: gammas.reduce((a, b) => a + b, 0) / (m || 1) }
}
