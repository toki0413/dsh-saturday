// 元素周期表（MVP 所需子集）
export const Z = {
  H: 1, Li: 3, C: 6, O: 8, Al: 13, Si: 14, Ar: 18,
  Ti: 22, Fe: 26, Ni: 28, Cu: 29, Pd: 46, Ag: 47, Pt: 78, Au: 79,
}

export const SYMBOL = Object.fromEntries(Object.entries(Z).map(([s, z]) => [z, s]))

/** Pauling 电负性（无机化学式书写惯例：电正性元素在前，如 TiO2、Cu3Ni） */
const EN = {
  H: 2.20, Li: 0.98, C: 2.55, O: 3.44, Al: 1.61, Si: 1.90, Ar: 0.0,
  Ti: 1.54, Fe: 1.83, Ni: 1.91, Cu: 1.90, Pd: 2.20, Ag: 1.93, Pt: 2.28, Au: 2.54,
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
