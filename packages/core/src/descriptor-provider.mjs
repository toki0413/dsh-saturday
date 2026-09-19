// 声明式引擎 provider 装配运行时 —— @toki0413/core，SDK 化第一层（降接入成本）。
//
// 目的：让"包一个读某结构文件格式、命令行一进一出的批处理引擎"退化成写一份描述符（数据）+
//   选用一个共享 codec，不必手写 provider 代码。本模块把描述符装配成一个满足 PotentialProvider
//   seam（契约 §4.2）的 provider：manifest 直通、relax 走"写结构→渲染输入脚本→spawn→解析输出"、
//   probeVersion/probeAvailability/available 按描述符声明生成。
// 诚实边界：只覆盖"常见 CLI 一进一出 + 已有 codec 支持的输入格式"这一大类；复杂引擎（多步 prep、
//   重启、并行环境）仍走自己写 provider。缺配置/二进制不可达/输出无标记一律显式报错，绝不静默降级
//   到别的引擎（对齐 §4.2 路由契约与 EngineUnavailableError 先例）。
// 描述符是 JS 对象（非 YAML）：js-yaml 属外部依赖，违反零运行时依赖；纯数据 + 少量可选回调即可。

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCodec } from './codecs.mjs'

function descriptorError(code, msg) { const e = new Error(`${msg} (${code})`); e.code = code; return e }

/** {{var}} 占位渲染；缺变量显式报错（不静默留空 → 引擎会拿残缺脚本跑出无意义结果） */
export function renderTemplate(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw descriptorError('DESCRIPTOR_MISSING_VAR', `input template references {{${k}}} but no such value provided`)
    return String(vars[k])
  })
}

/** 取输出正则的最后一次匹配第 1 捕获组并 parseFloat；无匹配显式报错 */
export function parseByRegex(text, { regex, name = 'energy' }) {
  const re = new RegExp(regex, 'g')
  let last = null
  for (const m of text.matchAll(re)) last = m
  if (!last) throw descriptorError('DESCRIPTOR_OUTPUT_UNPARSED', `engine output missing ${name} marker /${regex}/`)
  return parseFloat(last[1])
}

/** 跑一次子进程，收集 stdout（+ stderr 供报错），返回 {code, out, err, spawnError} */
function runChild(spawnImpl, binary, args, opts = {}) {
  return new Promise(resolve => {
    let child
    try { child = spawnImpl(binary, args, opts) } catch (e) { return resolve({ spawnError: e }) }
    let out = '', err = ''
    if (child.stdout) child.stdout.on('data', d => out += d)
    if (child.stderr) child.stderr.on('data', d => err += d)
    child.on('error', e => resolve({ spawnError: e }))
    child.on('close', code => resolve({ code, out, err }))
  })
}

/**
 * 由描述符装配 provider。
 * @param {object} descriptor 见文件头（含 name/version/manifest/binaryDefault/versionProbe/availability/structure/run/output）
 * @param {{binary?:string, potentialFile?:string, vars?:object, spawnImpl?:Function,
 *          EngineUnavailableError?:Function}} opts
 */
export function makeDescriptorProvider(descriptor, opts = {}) {
  if (!descriptor?.name || !descriptor?.manifest) throw descriptorError('DESCRIPTOR_BAD', 'descriptor requires name + manifest')
  const spawnImpl = opts.spawnImpl ?? spawn
  const binary = opts[descriptor.config?.binaryKey ?? 'binary'] ?? descriptor.binaryDefault
  const vars = { ...(descriptor.run?.vars ?? {}), ...opts.vars ?? {} }
  if (opts.potentialFile !== undefined) vars.potentialFile = opts.potentialFile
  const codec = getCodec(descriptor.structure?.inputFormat)
  const makeUnavailable = opts.EngineUnavailableError
    ?? ((b, cause) => descriptorError('ENGINE_UNAVAILABLE', `engine "${descriptor.name}" binary "${b}" unavailable: ${cause}`))

  const provider = {
    name: descriptor.name,
    version: descriptor.version,
    manifest: descriptor.manifest,

    async probeVersion() {
      const vp = descriptor.versionProbe
      if (!vp) return null
      const r = await runChild(spawnImpl, binary, vp.args)
      if (r.spawnError) return null
      const m = r.out.match(new RegExp(vp.regex))
      return r.code === 0 && m ? m[1].trim() : null
    },

    async probeAvailability() {
      const need = descriptor.availability?.requireConfig ?? []
      for (const req of need) {
        if (opts[req.key] === undefined || opts[req.key] === null) {
          return { ok: false, reason: `no ${req.label ?? req.key} configured (config.${req.key})` }
        }
      }
      const version = await provider.probeVersion()
      if (!version) return { ok: false, reason: `binary "${binary}" not runnable (probe failed)` }
      return { ok: true, reason: `${descriptor.displayName ?? descriptor.name} ${version}` }
    },

    async available() { return (await provider.probeAvailability()).ok },

    async relax(material, params = {}) {
      const need = descriptor.availability?.requireConfig ?? []
      for (const req of need) {
        if (!opts[req.key]) throw makeUnavailable(binary, `no ${req.label ?? req.key} configured (config.${req.key})`)
      }
      const jobId = randomUUID()
      const dir = await mkdtemp(join(tmpdir(), `saturday-${descriptor.name}-`))
      await writeStructure(dir, material)
      const script = renderTemplate(descriptor.run.template, { dataFile: descriptor.run.dataFile, ...vars })
      await writeFile(join(dir, descriptor.run.inputFile ?? 'input.engine'), script)
      const t0 = Date.now()
      const r = await runChild(spawnImpl, binary, descriptor.run.args, { cwd: dir })
      if (r.spawnError) throw makeUnavailable(binary, r.spawnError.message)
      if (r.code !== 0) throw new Error(`${descriptor.name} exited with code ${r.code}: ${(r.err || '').slice(0, 200)}`)
      const energy = parseByRegex(r.out, descriptor.output.energy)
      return {
        jobId, engine: descriptor.name, converged: descriptor.result?.converged ?? true,
        energy, n_steps: descriptor.result?.nSteps ?? 0, calculator: descriptor.name,
        wall_seconds: (Date.now() - t0) / 1000,
      }
    },

    async calculate(material, params = {}) {
      if (!descriptor.calculate) throw descriptorError('CAPABILITY_UNSUPPORTED', `engine "${descriptor.name}" declares no calculate capability`)
      const jobId = randomUUID()
      const dir = await mkdtemp(join(tmpdir(), `saturday-${descriptor.name}-`))
      await writeStructure(dir, material)
      const script = renderTemplate(descriptor.calculate.template, { dataFile: descriptor.run.dataFile, ...vars })
      await writeFile(join(dir, descriptor.run.inputFile ?? 'input.engine'), script)
      const r = await runChild(spawnImpl, binary, descriptor.calculate.args ?? descriptor.run.args, { cwd: dir })
      if (r.spawnError) throw makeUnavailable(binary, r.spawnError.message)
      if (r.code !== 0) throw new Error(`${descriptor.name} exited with code ${r.code}: ${(r.err || '').slice(0, 200)}`)
      return { jobId, engine: descriptor.name, energy: parseByRegex(r.out, descriptor.output.energy), calculator: descriptor.name }
    },
  }

  async function writeStructure(dir, material) {
    const text = codec.write(material.graph, descriptor.structure.writeOpts ?? {})
    await writeFile(join(dir, descriptor.run.dataFile), text)
  }
  return provider
}

/**
 * 金标准回归（SDK 信任层机制）：声明若干个"已知体系 + 参考能量 + 容差"，每次回放与预期比对，
 * 抓"换版本/编译器/单位悄悄错"。诚实：本函数只做机制，参考值必须由作者从有据可查的真实运行填入
 * （不臆造物理数字）；无声明 → passed=true 但 declared=false（如实标"未声明金标准"，不算通过也就算无证据）。
 * @param {{descriptor:object, relaxOne:(golden:object)=>Promise<number>}} p
 *        relaxOne(golden) 由调用方提供（通常是 provider.relax 到某 Material 后取 energy）。
 * @returns {{passed:boolean, declared:boolean, results:Array<{label,expect,got,delta,tol,ok}>, note}}
 */
export async function checkGoldens({ descriptor, relaxOne }) {
  const goldens = descriptor?.goldens ?? []
  const results = []
  for (const g of goldens) {
    if (!Number.isFinite(g.tol) || g.tol < 0) throw descriptorError('GOLDEN_BAD_TOL', `golden "${g.label}" needs a non-negative finite tol`)
    const got = await relaxOne(g)
    const delta = got - g.expectEnergy
    results.push({ label: g.label, expect: g.expectEnergy, got, delta, tol: g.tol, ok: Math.abs(delta) <= g.tol })
  }
  const passed = results.every(r => r.ok)
  return {
    passed, declared: goldens.length > 0, results,
    note: goldens.length === 0
      ? '未声明金标准：机制就位但无参考值，不作通过证据（真实数值须从有据可查的引擎运行填入）'
      : '金标准为声明的参考能量±容差；超容差即判失败（版本/单位回归信号）',
  }
}
