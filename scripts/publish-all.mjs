// 发布脚本：逐包 `npm publish --access public`——发布是真实动作，故门禁先行：
//   一者 登录态门禁：未登录即拒（不替用户猜测凭据）；
//   二者 幂等门禁：注册表已存在同版本即跳过（重跑不重复发布、不报错中断）；
//   三者 失败如实呈报：任一包发布失败即记录并以非零退出收尾（不吞错、不静默继续假装成功）。
// 用法：先 `npm login`，再 `node scripts/publish-all.mjs`（--dry-run 只核验不发布）。

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dryRun = process.argv.includes('--dry-run')
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

// workspaces 通配展开（同 pack-check.mjs 的机械展开）
const dirs = []
for (const g of root.workspaces ?? []) {
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

// 登录态门禁：未登录即拒
let user
try {
  user = execFileSync('npm', ['whoami'], { encoding: 'utf8', shell: true }).trim()
} catch {
  console.error('[BAD] 未登录 npm（npm whoami 失败）——请先 `npm login` 再跑本脚本。')
  process.exit(1)
}
console.log(`══ 发布（${dryRun ? 'dry-run 核验' : '真实发布'}）：登录身份 ${user}，根包版本 ${root.version} ══`)
// 作用域提示：@toki0413/* 是个人 scope，要求登录账户即 scope owner（toki0413），否则注册表拒绝

const failures = []
const published = []
const skipped = []
for (const d of dirs) {
  if (!existsSync(join(d, 'package.json'))) continue
  const pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'))
  if (pkg.private === true) { skipped.push(`${pkg.name}（private）`); continue }
  if (pkg.version !== root.version) { failures.push(`${pkg.name}: 版本漂移 ${pkg.version} ≠ ${root.version}`); continue }
  // 幂等门禁：注册表已存在同版本即跳过
  let existing = null
  try {
    existing = execFileSync('npm', ['view', `${pkg.name}@${pkg.version}`, 'version'], { encoding: 'utf8', shell: true }).trim()
  } catch { /* 404 = 未发布，属预期形态 */ }
  if (existing === pkg.version) { skipped.push(`${pkg.name}@${pkg.version}（注册表已在场）`); continue }
  if (dryRun) { published.push(`${pkg.name}@${pkg.version}（dry-run：未真实发布）`); continue }
  try {
    execFileSync('npm', ['publish', '--access', 'public'], { cwd: d, encoding: 'utf8', shell: true })
    published.push(`${pkg.name}@${pkg.version}`)
    console.log(`[OK ] ${pkg.name}@${pkg.version} 已发布`)
  } catch (err) {
    failures.push(`${pkg.name}: ${String(err.stderr || err.message).split('\n')[0]}`)
    console.error(`[BAD] ${pkg.name} 发布失败：${String(err.stderr || err.message).split('\n')[0]}`)
  }
}

console.log(`\n══ 结果：发布 ${published.length}，跳过 ${skipped.length}，失败 ${failures.length} ══`)
for (const s of skipped) console.log(`[SKP] ${s}`)
if (failures.length > 0) {
  console.error('══ 失败清单（不吞错）══')
  for (const f of failures) console.error(`[BAD] ${f}`)
  process.exit(1)
}
