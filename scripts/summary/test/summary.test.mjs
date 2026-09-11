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

test('3. parseMilestoneTable（真实契约文档）：88 条且摘要层条款可追溯', () => {
  const md = readFileSync(join(repoRoot, 'packages', 'bridge', 'docs', 'plugin-contract-v0.md'), 'utf8')
  const rows = parseMilestoneTable(md)
  assert.equal(rows.length, 88, '附录 A 当前应为 88 条实证映射')
  // 绝对索引断言（第 k 条 = rows[k-1]）：插入新条目时只需改总数断言 + 顶部加新断言，
  // 历史断言不漂移（倒数索引链在条目插入时会整体漂移，已废弃——实证教训）
  const at = (k) => rows[k - 1]
  assert.ok(at(88).clause.includes('真机') && at(88).evidence.includes('AutoDL'),
      '第 88 条证据指向 HPC 远程执行真机实证（云端 SSH 实测）')
  assert.ok(at(87).clause.includes('required') && at(87).evidence.includes('mcp-server'),
      '第 87 条证据指向 MCP required 语义直通（schema 不对宿主撒谎）')
  assert.ok(at(86).clause.includes('MP 结构源') && at(86).evidence.includes('plugin-mp'),
      '第 86 条证据指向 MP 结构源挂载可用性门禁（凭据缺失不注册）')
  assert.ok(at(85).clause.includes('LAMMPS') && at(85).evidence.includes('plugin-lammps'),
      '第 85 条证据指向 LAMMPS 挂载可用性探测（干净安装实机审计驱动修复）')
  assert.ok(at(84).clause.includes('RSS') && at(84).evidence.includes('plugin-rss'),
      '第 84 条证据指向 RSS 随机结构搜索采样器（§4.5 非 flow 生成式第二实证）')
  assert.ok(at(83).clause.includes('分子') && at(83).evidence.includes('molecule'),
    '第 83 条证据指向分子 QC 扩展（非周期域模型 + fromSmiles + RDKit 分子引擎路由）')
  assert.ok(at(82).evidence.includes('python-bridge') && at(82).clause.includes('远程'),
    '第 82 条证据指向 HPC 远程执行（传输抽象 + 站点配置 + 注入式 SSH）')
  assert.ok(at(81).evidence.includes('plugin-phonon') && at(81).clause.includes('超胞列位移'),
    '第 81 条证据指向 phonon 簇边界伪影修复（超胞列位移法）')
  assert.ok(at(80).evidence.includes('plugin-phonon'),
    '第 80 条证据指向 Γ 点声子分析（力注入式 + 声学和规则 + 两层虚频语义）')
  assert.ok(at(79).evidence.includes('plugin-sampler-flow'),
    '第 79 条证据指向 sampler seam 可逆性首实证')
  assert.ok(at(78).evidence.includes('fallback-lj'),
    '第 78 条证据指向数据面优雅回退测试')
  assert.ok(at(77).evidence.includes('plugin-lj'),
    '第 77 条证据指向零依赖引擎契约套件 + 闭式对账测试')
  assert.ok(at(76).evidence.includes('failure-drill') && at(76).evidence.includes('perf-baseline'),
    '第 76 条证据指向故障注入 + 性能基线 + 发布形态核验')
  assert.ok(at(75).evidence.includes('anchor-trigger-derivation') && at(75).evidence.includes('plugin-anchor-trigger'),
    '第 75 条证据指向修复四环接 Agent 层 + 判据证据链接线 + 触发条件就绪度报告')
  assert.ok(at(74).evidence.includes('anchor-repair-liveness') && at(74).evidence.includes('plugin-anchor-save-load'),
    '第 74 条证据指向判据快照跨会话续供 + 修复后载荷活性闭环 + 质量维观测对账')
  assert.ok(at(73).evidence.includes('plugin-anchor-save-load') && at(73).evidence.includes('plugin-anchor-trigger'),
    '第 73 条证据指向修复链接 Agent 层 + 判据快照跨会话续供 + 判据谱系质量维')
  assert.ok(at(72).evidence.includes('plugin-anchor-save-load') && at(72).evidence.includes('anchor-trigger-derivation'),
    '第 72 条证据指向收尾判据快照 + 载荷侧修复原语 + 判据对账谱系化')
  assert.ok(at(71).evidence.includes('plugin-anchor-trigger') && at(71).evidence.includes('plugin-anchor-save-load'),
    '第 71 条证据指向审计驱动的合流回填决策链 + 触发判据原型 + 审计修复建议通道')
  assert.ok(at(70).evidence.includes('anchor-merge-liveness') && at(70).evidence.includes('plugin-anchor-save-load'),
    '第 70 条证据指向审计接 Agent 层 + 多载荷合并后的活性保持 + 锚点库容量观测')
  assert.ok(at(69).evidence.includes('plugin-anchor-save-load') && at(69).evidence.includes('plugin-anchor-persist'),
    '第 69 条证据指向条目级版本戳 + 多载荷合并回填 + 载荷血缘审计')
  assert.ok(at(68).evidence.includes('anchor-lineage-refs') && at(68).evidence.includes('plugin-anchor-save-load'),
    '第 68 条证据指向恢复闭环接 Agent 层 + 落盘侧谱系可追溯声明 + 落盘载荷完整性校验')
  assert.ok(at(67).evidence.includes('anchor-resume') && at(67).evidence.includes('anchor-resume-liveness'),
    '第 67 条证据指向跨会话恢复全链路 + 回填后活性保持')
  assert.ok(at(66).evidence.includes('plugin-anchor-save-load') && at(66).evidence.includes('proposal-chain'),
    '第 66 条证据指向持久化落盘侧 + 排序层提案引用全链活性 + 持久化原语 Agent 层暴露')
  assert.ok(at(65).evidence.includes('plugin-mixture-derivation') && at(65).evidence.includes('plugin-anchor-persist') && at(65).evidence.includes('plugin-ternary'),
    '第 65 条证据指向提案谱系接推导登记簿 + 三元系可扩展性 + 持久化锚点库原型')
  assert.ok(at(64).evidence.includes('plugin-null-distance') && at(64).evidence.includes('demo:anchor-auto'),
    '第 64 条证据指向全自动锚点闭环 + 不可考组分诚实降级链')
  assert.ok(at(63).evidence.includes('plugin-mixture-quota') && at(63).evidence.includes('demo:agent'),
    '第 63 条证据指向锚点工具 Agent 层暴露 + 配额闭式对账')
  assert.ok(at(62).evidence.includes('anchor-autoingest'), '第 62 条证据指向闭环轨迹自动入库测试')
  assert.ok(at(61).evidence.includes('demo:anchor-guided') && at(61).evidence.includes('plugin-anchor-tools'),
    '第 61 条证据指向锚点引导闭环端到端 + 工具链契约审查')
  assert.ok(at(60).evidence.includes('plugin-anchor-tools'), '第 60 条证据指向锚点引导混合提案工具层测试')
  assert.ok(at(59).evidence.includes('anchor-store'), '第 59 条证据指向锚点库测试')
  assert.ok(at(58).evidence.includes('availability'), '第 58 条证据指向可用性预检工具测试')
  assert.ok(at(57).evidence.includes('evidence'), '第 57 条证据指向证据源独立性机器审计测试')
  assert.ok(at(56).evidence.includes('plugin-screening'), '第 56 条证据指向混合熵第二内置源测试')
  assert.ok(at(55).evidence.includes('demo-mixture-sampling'), '第 55 条证据指向多锚点混合采样真实演示')
  assert.ok(at(54).evidence.includes('demo-availability'), '第 54 条证据指向可用性预检演示')
  assert.ok(at(53).evidence.includes('units.test') && at(53).evidence.includes('potential.test'),
    '第 53 条证据指向指纹实测态回读测试（通配三态 + 盖章三态）')
  assert.ok(at(52).evidence.includes('plugin-screening'), '第 52 条证据指向换算审计通道测试')
  assert.ok(at(51).evidence.includes('plugin-screening'), '第 51 条证据指向工具层参考态声明形态测试')
  assert.ok(at(50).evidence.includes('demo-cross-engine'), '第 50 条证据指向跨引擎对照演示')
  assert.ok(at(49).evidence.includes('potential.test'), '第 49 条证据指向 M2 激活门禁测试')
  assert.ok(at(48).evidence.includes('units.test') && at(48).evidence.includes('plugin-screening'),
    '第 48 条证据指向单位/指纹门禁测试（core 纯层 + 筛选层 M3）')
  assert.ok(at(47).evidence.includes('plugin-sampler-ou'), '第 47 条证据指向多锚点混合采样测试')
  assert.ok(at(46).evidence.includes('plugin-sampler-ou'), '第 46 条证据指向采样温度标定测试')
  assert.ok(at(45).evidence.includes('plugin-screening'), '第 45 条证据指向证据源注册表化测试')
  assert.ok(rows[35].evidence.includes('scripts/summary'), '第 36 条（摘要层自身）证据必须可追溯到摘要层测试')
  assert.ok(rows[33].evidence.includes('plugin-free-energy'), '第 34 条证据指向自由能测试')
  assert.ok(rows.every(r => r.clause.length > 0 && r.evidence.length > 0))
})

const ws = [
  { dir: 'plugins\\a', name: '@toki0413/plugin-a', version: '0.3.0', description: '甲', hasTests: true },
  { dir: 'plugins\\b', name: '@toki0413/plugin-b', version: '0.3.0', description: '乙', hasTests: true },
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
  assert.ok(markdown.includes('@toki0413/plugin-a'))
  assert.ok(markdown.includes('@toki0413/plugin-b'))
  assert.ok(markdown.includes('8/8'), '总数必须呈现')
  assert.ok(markdown.includes('条款甲'))
  assert.ok(markdown.includes('2026-08-29T00:00:00Z'))
})

test('5. buildSummary 门禁：有测试但缺结果显式报错；失败用例显式标记不隐藏；无测试包显式标记', () => {
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
  assert.ok(markdown.includes('FAIL 1'), '失败必须显式标记')
  // 无独立测试的包（如防腐层）：显式标记且不计数，不静默也不报错
  const withKernel = buildSummary({
    workspaces: [...ws, { dir: 'packages\\kernel', name: '@toki0413/kernel', version: '0.3.0', description: '防腐层', hasTests: false }],
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
