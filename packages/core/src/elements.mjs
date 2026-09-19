// 元素周期表（MVP 所需子集）
export const Z = {
  H: 1, Li: 3, C: 6, O: 8, Al: 13, Si: 14, Ar: 18,
  Ti: 22, Fe: 26, Ni: 28, Cu: 29, Pd: 46, Ag: 47, Pt: 78, Au: 79,
}

export const SYMBOL = Object.fromEntries(Object.entries(Z).map(([s, z]) => [z, s]))

/** Pauling 电负性（无机化学式书写惯例：电正性元素在前，如 TiO2、Cu3Ni）。
 *  导出供通用组成特征化（compositionFeatureVector）与证据源复用；缺数据的元素显式报错不默认。 */
export const EN = {
  H: 2.20, Li: 0.98, C: 2.55, O: 3.44, Al: 1.61, Si: 1.90, Ar: 0.0,
  Ti: 1.54, Fe: 1.83, Ni: 1.91, Cu: 1.90, Pd: 2.20, Ag: 1.93, Pt: 2.28, Au: 2.54,
}

/** 标准原子量（g/mol，IUPAC 2021），按元素符号索引。
 *  共享质量表：LAMMPS 数据文件 codec、将来的引擎描述符等均引此表，
 *  不再各自自带 MASSES（消除“多张质量表各自漂移”）。未覆盖元素显式报错不默认。 */
export const ATOMIC_MASS = {
  H: 1.008, Li: 6.94, C: 12.011, O: 15.999, Al: 26.982, Si: 28.085, Ar: 39.948,
  Ti: 47.867, Fe: 55.845, Ni: 58.693, Cu: 63.546, Pd: 106.42, Ag: 107.868, Pt: 195.084, Au: 196.967,
}

/** 由原子序数数组合成化学式字符串（如 Cu3Ni、Cu3Ag） */
export function composeFormula(numbers) {
  const count = new Map()
  for (const z of numbers) count.set(z, (count.get(z) ?? 0) + 1)
  return [...count.entries()]
    .sort((a, b) => {
      const [sa, sb] = [SYMBOL[a[0]] ?? '', SYMBOL[b[0]] ?? '']
      return (EN[sa] ?? 99) - (EN[sb] ?? 99) || sa.localeCompare(sb)
    })
    .map(([z, n]) => `${SYMBOL[z] ?? `X${z}`}${n > 1 ? n : ''}`)
    .join('')
}

/**
 * 通用组成特征向量（定长、与具体元素集无关）：分数加权电负性均值、加权标准差、平均原子序数。
 * 供 GP 代理/证据源等消费；仅用本表既有权威数据（EN + Z），不引入未经核对的新常数。
 * @param {Object<string,number>} composition 元素符号→计数（如 {Cu:3, Ag:1}）
 * @returns {number[]} [meanEN, stdEN, meanZ]
 */
export function compositionFeatureVector(composition) {
  const entries = Object.entries(composition ?? {}).filter(([, n]) => n > 0)
  if (entries.length === 0) throw new Error('compositionFeatureVector requires a non-empty composition (COMPOSITION_EMPTY)')
  const total = entries.reduce((s, [, n]) => s + n, 0)
  const feats = entries.map(([sym, n]) => {
    const en = EN[sym], z = Z[sym]
    if (!Number.isFinite(en) || !Number.isFinite(z)) {
      throw new Error(`no electronegativity/atomic-number data for element "${sym}"; extend core/elements explicitly (ELEMENT_DATA_MISSING)`)
    }
    return { f: n / total, en, z }
  })
  const meanEN = feats.reduce((s, x) => s + x.f * x.en, 0)
  const meanZ = feats.reduce((s, x) => s + x.f * x.z, 0)
  const varEN = feats.reduce((s, x) => s + x.f * (x.en - meanEN) ** 2, 0)
  return [meanEN, Math.sqrt(varEN), meanZ]
}
