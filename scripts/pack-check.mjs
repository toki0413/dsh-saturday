// 55 发布形态预演（发布前演练批次）：逐包 `npm pack --dry-run` 干跑，机械核验——
//   ① 版本一致性：全部包版本与根包一致（发布物不夹带漂移版本）；
//   ② files 白名单生效：发布物不含测试/日志/临时产物（只含实现与必要数据面，同 ⑧/⑪ 纪律）；
//   ③ 发布物清单如实呈报（包名/条目数/解压体积随报告呈现，可人工复核）。
// 预演是核验不是发布：全程 --dry-run，不产生 .tgz 不触网。违规即非零退出（白名单是门禁不是建议）。

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const globs = root.workspaces ?? []

// workspaces 声明支持通配（如 plugins/*），机械展开为实际目录
const dirs = []
for (const g of globs) {
  if (g.includes('*')) {
    const base = g.split('*')[0].replace(/[/\\]$/, '')
    for (const name of readdirSync(join(repoRoot, base))) {
      const d = join(repoRoot, base, name)
      if (statSync(d).isDirectory()) dirs.push(d)
    }
  } else {
    dirs.push(join(repoRoot, g))
  }
}

// 发布物禁入形态：测试/日志/临时产物（⑧/⑪：测试/日志/临时产物不外泄）
const FORBIDDEN = [/^test\//, /(^|\/)test\//, /\.log$/, /\.tmp$/, /^\.git/]

const violations = []
const report = []
for (const d of dirs) {
  if (!existsSync(join(d, 'package.json'))) { report.push({ name: d.replace(repoRoot + '\\', '').replace(repoRoot + '/', ''), skip: '无 package.json（数据/资源目录，非包）' }); continue }
  const pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'))
  if (pkg.private === true) { report.push({ name: pkg.name, skip: 'private（不发布）' }); continue }
  let packed
  try {
    packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: d, encoding: 'utf8', shell: true }))  // Windows 下 npm 是 npm.cmd，需经 shell
  } catch (err) {
    violations.push(`${pkg.name}: npm pack 干跑失败（${String(err.message).split('\n')[0]}）`)
    report.push({ name: pkg.name, skip: '干跑失败（见违规清单）' })
    continue
  }
  const info = packed[0]
  const files = info.files.map(f => f.path)
  const bad = files.filter(f => FORBIDDEN.some(re => re.test(f)))
  if (bad.length > 0) violations.push(`${pkg.name}: 发布物夹带禁入形态 ${JSON.stringify(bad)}`)
  if (pkg.version !== root.version) {
    violations.push(`${pkg.name}: 版本漂移 ${pkg.version} ≠ 根包 ${root.version}`)
  }
  report.push({ name: pkg.name, version: pkg.version, entryCount: info.entryCount, unpackedKB: Math.round(info.unpackedSize / 1024) })
}

console.log(`══ 发布形态预演（55）：${report.length} 包干跑，根包版本 ${root.version} ══`)
for (const r of report) {
  console.log(r.skip ? `[SKP] ${r.name}: ${r.skip}` : `[OK ] ${r.name}@${r.version}  ${r.entryCount} 条目，解压 ${(r.unpackedKB)} KB`)
}
if (violations.length > 0) {
  console.error('\n══ 预演违规（发布形态门禁）══')
  for (const v of violations) console.error(`[BAD] ${v}`)
  process.exit(1)
}
console.log('══ 预演通过：版本一致 + 白名单无夹带（预演不是发布，未产生任何 .tgz）══')
