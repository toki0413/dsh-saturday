#!/usr/bin/env node
// @toki0413/plugin-sdk 落盘 + CLI。
//   create-saturday-plugin <plugin-name> [outDir] [--descriptor <engine.json>]
// 有 --descriptor 用作者填好的描述符（JSON）；否则用起步模板（含 TODO，编辑 src/descriptor.mjs）。
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { enginePluginFiles } from './scaffold.mjs'

/** 把生成的文件映射写到 absDir 下，返回写入的相对路径列表。 */
export async function writePluginScaffold(absDir, spec) {
  const files = enginePluginFiles(spec)
  const written = []
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(absDir, rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
    written.push(rel)
  }
  return written
}

async function main() {
  const argv = process.argv.slice(2)
  const dpIdx = argv.indexOf('--descriptor')
  const descriptorPath = dpIdx >= 0 ? argv[dpIdx + 1] : null
  const positional = argv.filter((a, i) => !a.startsWith('--') && i !== (dpIdx + 1))
  const name = positional[0]
  const outDir = positional[1] ?? `./plugin-${name}`
  if (!name) { console.error('usage: create-saturday-plugin <name> [outDir] [--descriptor engine.json]'); process.exit(2) }
  let descriptor
  if (descriptorPath) descriptor = JSON.parse(await readFile(resolve(descriptorPath), 'utf8'))
  const spec = { name, descriptor }
  if (!descriptor) spec.descriptor = undefined // 让 scaffold 用起步模板
  const written = await writePluginScaffold(resolve(outDir), spec)
  console.log(`scaffolded plugin "${name}" -> ${resolve(outDir)}`)
  for (const f of written) console.log('  wrote', f)
  console.log('next: 编辑 src/descriptor.mjs 填 binary/模板/输出正则与 units；补真二进制 potentialProviderContract（见 plugins/lammps）。')
}

// 仅当作为脚本直接执行时运行 main（被 import 时不触发）。
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) { main().catch((e) => { console.error(String(e?.message || e)); process.exit(1) }) }
