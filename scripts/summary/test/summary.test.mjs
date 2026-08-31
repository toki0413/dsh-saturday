// 摘要层测试：TAP 解析 / 附录 A 表格解析 / 摘要组装门禁与确定性 / 真实小仓冒烟。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { parseTestTap, parseMilestoneTable, buildSummary } from '../summary-core.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
// 本测试自身跑在 node --test runner 内：子进程不得继承 NODE_TEST_* 环境（嵌套 runner 行为异常）
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NODE_TEST')))

test('1. parseTestTap：正常汇总解析；缺汇总行显式报错', () => {
  assert.deepEqual(parseTestTap('ok 1 - x\n# pass 7\n# fail 0\n'), { pass: 7, fail: 0 })
  assert.deepEqual(parseTestTap('# pass 3\n# fail 2'), { pass: 3, fail: 2 })
  assert.throws(() => parseTestTap('ok 1 - x\n'), /TAP_INCOMPLETE_OUTPUT/)
  assert.throws(() => parseTestTap(null), /TAP_UNDEFINED_INPUT/)
})

test('2. parseMilestoneTable：三列解析 + 条款内含竖线合并 + 空表显式报错', () => {
  const md = [
    '## 附录 A：契约测试映射（基线）', '',
    '| # | 契约条款 | 现有测试 |',
    '|---|---|---|',
    '| 1 | 条款甲 | 测试 1 |',
    '| 2 | 条款含|竖线 | 测试 2、3 |',
    '正文结束',
  ].join('\n')
  const rows = parseMilestoneTable(md)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { index: 1, clause: '条款甲', evidence: '测试 1' })
  assert.equal(rows[1].clause, '条款含|竖线', '条款内竖线必须合并保留')
  assert.throws(() => parseMilestoneTable('没有表'), /MILESTONE_TABLE_MISSING/)
})

test('3. parseMilestoneTable（真实契约文档）：76 条且摘要层条款可追溯', () => {
  const md = readFileSync(join(repoRoot, 'packages', 'bridge', 'docs', 'plugin-contract-v0.md'), 'utf8')
  const rows = parseMilestoneTable(md)
  assert.equal(rows.length, 76, '附录 A 当前应为 76 条实证映射')
  assert.ok(rows[rows.length - 1].evidence.includes('failure-drill') && rows[rows.length - 1].evidence.includes('perf-baseline'),
    '第 76 条证据指向故障演练 + 性能基线 + 发布形态预演（53/54/55）')
  assert.equal(rows[rows.length - 3].index, 74)
  assert.ok(rows[rows.length - 2].evidence.includes('anchor-trigger-derivation') && rows[rows.length - 2].evidence.includes('plugin-anchor-trigger'),
    '第 75 条证据指向修复四环接 Agent 层 + 判据证据链接线 + 触发条件就绪度报告（50/51/52）')
  assert.ok(rows[35].evidence.includes('scripts/summary'), '第 36 条（摘要层自身）证据必须可追溯到摘要层测试')
  assert.ok(rows[rows.length - 3].evidence.includes('anchor-repair-liveness') && rows[rows.length - 3].evidence.includes('plugin-anchor-save-load'),
    '第 74 条证据指向判据快照跨会话续供 + 修复后载荷活性闭环 + 质量维观测对账（㊽/㊾/㊿）')
  assert.ok(rows[rows.length - 4].evidence.includes('plugin-anchor-save-load') && rows[rows.length - 4].evidence.includes('plugin-anchor-trigger'),
    '第 73 条证据指向修复链接 Agent 层 + 判据快照跨会话续供 + 判据谱系质量维（㊺/㊻/㊼）')
  assert.ok(rows[rows.length - 5].evidence.includes('plugin-anchor-save-load') && rows[rows.length - 5].evidence.includes('anchor-trigger-derivation'),
    '第 72 条证据指向收尾判据快照 + 载荷侧修复原语 + 判据对账谱系化（㊷/㊸/㊹）')
  assert.ok(rows[rows.length - 6].evidence.includes('plugin-anchor-trigger') && rows[rows.length - 6].evidence.includes('plugin-anchor-save-load'),
    '第 71 条证据指向审计驱动的合流回填决策链 + 触发判据原型 + 审计修复建议通道（㊴/㊵/㊶）')
  assert.ok(rows[rows.length - 7].evidence.includes('anchor-merge-liveness') && rows[rows.length - 7].evidence.includes('plugin-anchor-save-load'),
    '第 70 条证据指向审计接 Agent 层 + 多载荷合并后的活性保持 + 锚点库容量观测（㊱/㊲/㊳）')
  assert.ok(rows[rows.length - 8].evidence.includes('plugin-anchor-save-load') && rows[rows.length - 8].evidence.includes('plugin-anchor-persist'),
    '第 69 条证据指向条目级版本戳 + 多载荷合并回填 + 载荷血缘审计（㉝/㉞/㉟）')
  assert.ok(rows[rows.length - 9].evidence.includes('anchor-lineage-refs') && rows[rows.length - 9].evidence.includes('plugin-anchor-save-load'),
    '第 68 条证据指向恢复闭环接 Agent 层 + 落盘侧谱系可追溯声明 + 落盘载荷完整性校验（㉚/㉛/㉜）')
  assert.ok(rows[rows.length - 10].evidence.includes('anchor-resume') && rows[rows.length - 10].evidence.includes('anchor-resume-liveness'),
    '第 67 条证据指向跨会话恢复端到端 + 回填后活性保持 + 自监督进场条件裁决（㉗/㉘/㉙）')
  assert.ok(rows[rows.length - 11].evidence.includes('plugin-anchor-save-load') && rows[rows.length - 11].evidence.includes('proposal-chain'),
    '第 66 条证据指向持久化落盘侧 + 排序层提案引用全链活性 + 持久化原语 Agent 层暴露（㉔/㉕/㉖）')
  assert.ok(rows[rows.length - 12].evidence.includes('plugin-mixture-derivation') && rows[rows.length - 12].evidence.includes('plugin-anchor-persist') && rows[rows.length - 12].evidence.includes('plugin-ternary'),
    '第 65 条证据指向提案谱系接推导登记簿 + 三元系可扩展性 + 持久化锚点库原型（㉑/㉒/㉓）')
  assert.ok(rows[rows.length - 13].evidence.includes('plugin-null-distance') && rows[rows.length - 13].evidence.includes('demo:anchor-auto'),
    '第 64 条证据指向全自动锚点闭环 + 不可考组分诚实降级链（⑱/⑲/⑳）')
  assert.ok(rows[rows.length - 14].evidence.includes('plugin-mixture-quota') && rows[rows.length - 14].evidence.includes('demo:agent'),
    '第 63 条证据指向锚点工具 Agent 层暴露 + 配额闭式对账（⑯/⑰）')
  assert.ok(rows[rows.length - 15].evidence.includes('anchor-autoingest'), '第 62 条证据指向闭环轨迹自动入库测试（⑮）')
  assert.ok(rows[rows.length - 16].evidence.includes('demo:anchor-guided') && rows[rows.length - 16].evidence.includes('plugin-anchor-tools'),
    '第 61 条证据指向锚点引导闭环端到端 + 工具链契约审查（⑫/⑭）')
  assert.ok(rows[rows.length - 17].evidence.includes('plugin-anchor-tools'), '第 60 条证据指向锚点引导混合提案工具层测试（⑩）')
  assert.ok(rows[rows.length - 18].evidence.includes('anchor-store'), '第 59 条证据指向锚点库测试（⑦）')
  assert.ok(rows[rows.length - 19].evidence.includes('availability'), '第 58 条证据指向可用性预检工具测试（⑥）')
  assert.ok(rows[rows.length - 20].evidence.includes('evidence'), '第 57 条证据指向证据源独立性机器审计测试（⑤）')
  assert.ok(rows[rows.length - 21].evidence.includes('plugin-screening'), '第 56 条证据指向混合熵第二内置源测试')
  assert.ok(rows[rows.length - 22].evidence.includes('demo-mixture-sampling'), '第 55 条证据指向多锚点混合采样真实演示')
  assert.ok(rows[rows.length - 23].evidence.includes('demo-availability'), '第 54 条证据指向可用性预检演示')
  assert.ok(rows[rows.length - 24].evidence.includes('units.test') && rows[rows.length - 24].evidence.includes('potential.test'),
    '第 53 条证据指向指纹实测态回读测试（通配三态 + 盖章三态）')
  assert.ok(rows[rows.length - 25].evidence.includes('plugin-screening'), '第 52 条证据指向换算审计通道测试')
  assert.ok(rows[rows.length - 26].evidence.includes('plugin-screening'), '第 51 条证据指向工具层参考态声明形态测试')
  assert.ok(rows[rows.length - 27].evidence.includes('demo-cross-engine'), '第 50 条证据指向跨引擎对照演示')
  assert.ok(rows[rows.length - 28].evidence.includes('potential.test'), '第 49 条证据指向 M2 激活门禁测试')
  assert.ok(rows[rows.length - 29].evidence.includes('units.test') && rows[rows.length - 29].evidence.includes('plugin-screening'),
    '第 48 条证据指向单位/指纹门禁测试（core 纯层 + 筛选层 M3）')
  assert.ok(rows[rows.length - 30].evidence.includes('plugin-sampler-ou'), '第 47 条证据指向多锚点混合采样测试')
  assert.ok(rows[rows.length - 31].evidence.includes('plugin-sampler-ou'), '第 46 条证据指向采样温度标定测试')
  assert.ok(rows[rows.length - 32].evidence.includes('plugin-screening'), '第 45 条证据指向证据源注册表化测试')
  assert.ok(rows[33].evidence.includes('plugin-free-energy'), '第 34 条证据指向自由能测试')
  assert.ok(rows.every(r => r.clause.length > 0 && r.evidence.length > 0))
})

const ws = [
  { dir: 'plugins\\a', name: '@saturday/plugin-a', version: '0.3.0', description: '甲', hasTests: true },
  { dir: 'plugins\\b', name: '@saturday/plugin-b', version: '0.3.0', description: '乙', hasTests: true },
]
const milestones = [{ index: 1, clause: '条款甲', evidence: '测试 1' }]

test('4. buildSummary：聚合正确，markdown 含全部包名/总数/实证清单', () => {
  const { markdown, json } = buildSummary({
    workspaces: ws,
    testResults: { 'plugins\\a': { pass: 5, fail: 0 }, 'plugins\\b': { pass: 3, fail: 0 } },
    milestones,
    generatedAt: '2026-08-29T00:00:00Z',
  })
  assert.equal(json.totalPass, 8)
  assert.equal(json.totalFail, 0)
  assert.equal(json.packageCount, 2)
  assert.ok(markdown.includes('@saturday/plugin-a'))
  assert.ok(markdown.includes('@saturday/plugin-b'))
  assert.ok(markdown.includes('8/8'), '总数必须呈现')
  assert.ok(markdown.includes('条款甲'))
  assert.ok(markdown.includes('2026-08-29T00:00:00Z'))
})

test('5. buildSummary 门禁：有测试但缺结果显式报错；失败用例显式标记不隐藏；无测试包诚实标记', () => {
  assert.throws(
    () => buildSummary({ workspaces: ws, testResults: { 'plugins\\a': { pass: 5, fail: 0 } }, milestones }),
    /SUMMARY_RESULT_MISSING/,
  )
  const { markdown } = buildSummary({
    workspaces: ws,
    testResults: { 'plugins\\a': { pass: 5, fail: 0 }, 'plugins\\b': { pass: 2, fail: 1 } },
    milestones,
    generatedAt: 't',
  })
  assert.ok(markdown.includes('FAIL 1'), '失败必须显式标记（诚实优先于好看）')
  // 无独立测试的包（如防腐层）：诚实标记且不计数，不静默也不报错
  const withKernel = buildSummary({
    workspaces: [...ws, { dir: 'packages\\kernel', name: '@saturday/kernel', version: '0.3.0', description: '防腐层', hasTests: false }],
    testResults: { 'plugins\\a': { pass: 5, fail: 0 }, 'plugins\\b': { pass: 3, fail: 0 } },
    milestones,
    generatedAt: 't',
  })
  assert.ok(withKernel.markdown.includes('无独立测试（由契约套件覆盖）'))
  assert.equal(withKernel.json.totalPass, 8, '无测试包不得计入汇总')
  assert.equal(withKernel.json.testedCount, 2)
  assert.throws(() => buildSummary({ workspaces: [], testResults: {}, milestones }), /SUMMARY_NO_WORKSPACES/)
  assert.throws(() => buildSummary({ workspaces: ws, testResults: {}, milestones: [] }), /SUMMARY_NO_MILESTONES/)
})

test('6. buildSummary 确定性：同输入（含注入时间）输出完全一致', () => {
  const opts = {
    workspaces: ws,
    testResults: { 'plugins\\a': { pass: 1, fail: 0 }, 'plugins\\b': { pass: 1, fail: 0 } },
    milestones,
    generatedAt: 'fixed',
  }
  assert.equal(buildSummary(opts).markdown, buildSummary(opts).markdown)
})

test('7. 冒烟：真实小包（plugins/replay）实跑 → TAP 解析 → 5/5', () => {
  // Windows 下不依赖通配符/目录参数：显式枚举测试文件（确定性）
  const testDir = join(repoRoot, 'plugins', 'replay', 'test')
  const files = readdirSync(testDir).filter(f => f.endsWith('.test.mjs')).sort().map(f => join(testDir, f))
  const out = execFileSync('node', ['--test', ...files], { cwd: repoRoot, encoding: 'utf8', env: cleanEnv })
  const r = parseTestTap(out)
  assert.equal(r.fail, 0)
  assert.equal(r.pass, 5, 'replay 当前基线 5 项（漂移即摘要与仓库脱节）')
})
