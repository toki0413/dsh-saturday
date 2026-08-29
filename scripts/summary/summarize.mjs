// 摘要生成器：实跑全部包测试 + 扫描 package.json + 提取契约文档附录 A
// → 输出仓库根 SUMMARY.md / SUMMARY.json（可再生，勿手改）。
// 用法：node scripts/summary/summarize.mjs [--root <repoRoot>]

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTestTap, parseMilestoneTable, buildSummary } from './summary-core.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const rootArg = process.argv.indexOf('--root')
const root = rootArg >= 0 ? resolve(process.argv[rootArg + 1]) : resolve(here, '..', '..')
// 防御：若本脚本被嵌在 node --test runner 内调用，子进程不得继承 NODE_TEST_* 环境
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NODE_TEST')))

// 1. 扫描 workspaces（packages/* + plugins/*，与根 package.json 声明一致）
const workspaces = []
for (const group of ['packages', 'plugins']) {
  const gdir = join(root, group)
  for (const name of readdirSync(gdir).sort()) {
    const dir = join(gdir, name)
    if (!statSync(dir).isDirectory()) continue
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) continue
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const rel = `${group}/${name}`.replaceAll('/', process.platform === 'win32' ? '\\' : '/')
    workspaces.push({ dir: rel, name: pkg.name, version: pkg.version, description: pkg.description ?? '' })
  }
}

// 2. 逐包实跑测试（串行，避免 sidecar 并发碰撞——回归纪律延续）；
//    Windows 下 cmd 不展开通配符，显式枚举测试文件（确定性）；
//    无测试目录的包（如防腐层）诚实标记 hasTests=false，不静默跳过也不报错。
const testResults = {}
let totalPass = 0
let totalFail = 0
for (const w of workspaces) {
  const testDir = join(root, w.dir, 'test')
  const files = existsSync(testDir)
    ? readdirSync(testDir).filter(f => f.endsWith('.test.mjs')).sort().map(f => join(testDir, f))
    : []
  if (files.length === 0) {
    w.hasTests = false
    console.log(`[SKP] ${w.dir}  无独立测试（由契约套件覆盖）`)
    continue
  }
  w.hasTests = true
  let out = ''
  try {
    // --test-concurrency=1：包内串行——并发各拉 Python sidecar + OpenBLAS 线程会内存竞态（与回归脚本同款纪律）
    out = execFileSync('node', ['--test', '--test-concurrency=1', ...files], { cwd: root, encoding: 'utf8', env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    // node --test 在有失败用例时非零退出，但 stdout 仍是完整 TAP
    out = (e.stdout ?? '') + (e.stderr ?? '')
  }
  const r = parseTestTap(out)
  testResults[w.dir] = r
  totalPass += r.pass
  totalFail += r.fail
  console.log(`[${r.fail === 0 ? 'OK ' : 'FAIL'}] ${w.dir}  pass=${r.pass} fail=${r.fail}`)
}

// 3. 契约文档附录 A = 实证清单来源
const contractMd = readFileSync(join(root, 'packages', 'bridge', 'docs', 'plugin-contract-v0.md'), 'utf8')
const milestones = parseMilestoneTable(contractMd)

// 4. 组装并落盘（对账门禁在 buildSummary 内：缺结果显式报错）
const { markdown, json } = buildSummary({ workspaces, testResults, milestones })
writeFileSync(join(root, 'SUMMARY.md'), markdown + '\n', 'utf8')
writeFileSync(join(root, 'SUMMARY.json'), JSON.stringify(json, null, 2) + '\n', 'utf8')
console.log(`==== SUMMARY 生成完毕：${totalPass}/${totalPass + totalFail}（${workspaces.length} 包，${milestones.length} 条实证）====`)
