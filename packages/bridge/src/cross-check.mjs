// 跨引擎对账（A/B）比较器纯层 —— 同一 material 被两个或多个引擎回算后,并列其结果、算逐对差、
// 按单位三元组判可比性,并如实标注指纹差异(不阻断:差异本身就是 A/B 想要的信号)。
// 纪律:可比 = 单位三元组全同;不自动换算(§units "换算只提供,绝不自动进入比较路径");异单位仅报
// 原始数值 + comparable=false,由调用方决定要不要显式换算或拒拼。指纹差异不判不可比 —— 只把
// fingerprintEqual 的 same/reason 一并呈现,让审计者看到"同单位不同源"这个正是 A/B 想暴露的情况。

import { fingerprintEqual } from '@toki0413/core/units'

function ccError(code, msg) { const e = new Error(`${msg} (${code})`); e.code = code; return e }
const sameUnits = (a, b) => a.energy === b.energy && a.length === b.length && a.time === b.time

/**
 * @param {Array<{engine:string, energyPerAtom:number, units:{energy,length,time},
 *                fingerprint:{software,method,version}, calculator?:string,
 *                converged?:boolean|null, jobId?:string}>} runs
 */
export function crossCompare(runs) {
  if (!Array.isArray(runs) || runs.length < 2) throw ccError('CROSS_NEED_TWO', `crossCompare requires >=2 engine runs; got ${runs?.length ?? 0}`)
  runs.forEach((r, i) => {
    if (!r?.engine) throw ccError('CROSS_BAD_RUN', `run ${i}: engine name required`)
    if (!Number.isFinite(r?.energyPerAtom)) throw ccError('CROSS_BAD_RUN', `run ${i} (${r.engine}): energyPerAtom must be finite`)
    const u = r.units
    if (!u || !u.energy || !u.length || !u.time) throw ccError('CROSS_BAD_RUN', `run ${i} (${r.engine}): units triple {energy,length,time} required`)
    const f = r.fingerprint
    if (!f || typeof f.software !== 'string' || typeof f.method !== 'string') throw ccError('CROSS_BAD_RUN', `run ${i} (${r.engine}): fingerprint.software/method required`)
  })

  const pairs = []
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i], b = runs[j]
      const sameU = sameUnits(a.units, b.units)
      const fe = fingerprintEqual(a.fingerprint, b.fingerprint)
      pairs.push({
        a: a.engine, b: b.engine,
        sameUnits: sameU,
        comparable: sameU,               // 仅按单位三元组;不自动换算
        deltaEnergyPerAtom: a.energyPerAtom - b.energyPerAtom,
        fingerprintSame: fe.same,
        fingerprintReason: fe.reason ?? null,
      })
    }
  }
  return {
    runs, pairs,
    nEngines: runs.length,
    allComparable: pairs.every(p => p.comparable),
    note: '跨引擎对账:可比性只按单位三元组判(不自动换算,§units 纪律);指纹差异如实呈现不阻断——' +
          '同单位不同指纹正是 A/B 想暴露的比较,若指纹已知且不同,差值就是"引擎/版本"分歧的直接读数;' +
          'unknown 版本按通配处理,同源判定 reason 会标"含未验证维"。',
  }
}
