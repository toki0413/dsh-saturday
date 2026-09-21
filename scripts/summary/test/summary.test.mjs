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

test('3. parseMilestoneTable（真实契约文档）：130 条且摘要层条款可追溯', () => {
  const md = readFileSync(join(repoRoot, 'packages', 'bridge', 'docs', 'plugin-contract-v0.md'), 'utf8')
  const rows = parseMilestoneTable(md)
  assert.equal(rows.length, 130, '附录 A 当前应为 130 条实证映射')
  // 绝对索引断言（第 k 条 = rows[k-1]）：插入新条目时只需改总数断言 + 顶部加新断言，
  // 历史断言不漂移（倒数索引链在条目插入时会整体漂移，已废弃——实证教训）
  const at = (k) => rows[k - 1]
  assert.ok(at(130).clause.includes('带降为初值') && at(130).evidence.includes('band-to-saddle.test'),
      '第 130 条证据指向 NEB 带作初值 + QMM 势垒复核')
  assert.ok(at(129).clause.includes('鞍点搜索') && at(129).evidence.includes('saddle.test'),
      '第 129 条证据指向 QMM 鞍点搜索 analysis.saddleSearch')
  assert.ok(at(128).clause.includes('climbing-image') && at(128).evidence.includes('trivialStationary'),
      '第 128 条证据指向 NEB 收敛加固与 climbing-image')
  assert.ok(at(127).clause.includes('点阵参数') && at(127).evidence.includes('lattice-solve.test'),
      '第 127 条证据指向实测峰位点阵参数精修 analysis.xrd.latticeFromPeaks')
  assert.ok(at(126).clause.includes('短程有序') && at(126).evidence.includes('coordination.test'),
      '第 126 条证据指向局域配位与短程有序 analysis.coordination')
  assert.ok(at(125).clause.includes('排序一致性') && at(125).evidence.includes('rank.test'),
      '第 125 条证据指向跨引擎排序一致性 runtime.engine.rank')
  assert.ok(at(124).clause.includes('无头') && at(124).evidence.includes('cli.test'),
      '第 124 条证据指向无头一次性 CLI')
  assert.ok(at(123).clause.includes('生成式提议器') && at(123).evidence.includes('generative-explore'),
      '第 123 条证据指向生成器喂进 explore 旗舰端到端')
  assert.ok(at(122).clause.includes('Vinet') && at(122).evidence.includes('fitVinet'),
      '第 122 条证据指向 EOS Vinet 多方程')
  assert.ok(at(121).clause.includes('杨氏模量') && at(121).evidence.includes('AU_BAD_INPUT'),
      '第 121 条证据指向弹性方向力学各向异性')
  assert.ok(at(120).clause.includes('接 CIF') && at(120).evidence.includes('cif-engine'),
      '第 120 条证据指向 descriptor 端到端接 CIF 引擎')
  assert.ok(at(119).clause.includes('去重') && at(119).evidence.includes('EIG_NOT_SQUARE'),
      '第 119 条证据指向特征值去重进 core/eig')
  assert.ok(at(118).clause.includes('各向异性声速') && at(118).evidence.includes('eig3Symmetric'),
      '第 118 条证据指向弹性各向异性声速')
  assert.ok(at(117).clause.includes('端到端接 POSCAR') && at(117).evidence.includes('poscar-engine'),
      '第 117 条证据指向 descriptor 端到端接 POSCAR 引擎')
  assert.ok(at(116).clause.includes('声速') && at(116).evidence.includes('acousticFromModuli'),
      '第 116 条证据指向弹性→声速与 Debye 温度')
  assert.ok(at(115).clause.includes('可插拔提议器') && at(115).evidence.includes('alt-perturb'),
      '第 115 条证据指向探索/主动学习接可插拔提议器')
  assert.ok(at(114).clause.includes('CIF 结构摄取') && at(114).evidence.includes('cellFromParams'),
      '第 114 条证据指向 CIF 结构摄取')
  assert.ok(at(113).clause.includes('XYZ 结构摄取') && at(113).evidence.includes('fromXyz'),
      '第 113 条证据指向 XYZ 结构摄取')
  assert.ok(at(112).clause.includes('结构摄取') && at(112).evidence.includes('structure_from_poscar'),
      '第 112 条证据指向 POSCAR 结构摄取')
  assert.ok(at(111).clause.includes('A/B 对账') && at(111).evidence.includes('cross-check'),
      '第 111 条证据指向跨引擎 A/B 对账')
  assert.ok(at(110).clause.includes('POSCAR') && at(110).evidence.includes('getCodec'),
      '第 110 条证据指向 POSCAR 结构 codec')
  assert.ok(at(109).clause.includes('plugin-sdk') && at(109).evidence.includes('potentialProviderContract'),
      '第 109 条证据指向引擎插件脚手架 plugin-sdk')
  assert.ok(at(108).clause.includes('会话分支账本') && at(108).evidence.includes('branch-ledger'),
      '第 108 条证据指向会话分支账本')
  assert.ok(at(107).clause.includes('泛化验证') && at(107).evidence.includes('writeXyz'),
      '第 107 条证据指向 SDK 声明式引擎泛化验证')
  assert.ok(at(106).clause.includes('一致性合规') && at(106).evidence.includes('conformance'),
      '第 106 条证据指向一致性合规报告')
  assert.ok(at(105).clause.includes('声明式引擎描述符') && at(105).evidence.includes('makeDescriptorProvider'),
      '第 105 条证据指向 SDK 声明式引擎描述符 + 共享 codec')
  assert.ok(at(104).clause.includes('筛选证据源') && at(104).evidence.includes('compositionFeatureVector'),
      '第 104 条证据指向 GP 能量证据源（泛化通用）')
  assert.ok(at(103).clause.includes('多目标贝叶斯优化') && at(103).evidence.includes('pareto'),
      '第 103 条证据指向多目标贝叶斯优化')
  assert.ok(at(102).clause.includes('相鉴定') && at(102).evidence.includes('phase-match'),
      '第 102 条证据指向 XRD 相鉴定')
  assert.ok(at(101).clause.includes('准谐') && at(101).evidence.includes('phonon-qha'),
      '第 101 条证据指向准谐近似热膨胀')
  assert.ok(at(100).clause.includes('贝叶斯优化') && at(100).evidence.includes('gp'),
      '第 100 条证据指向 GP 代理贝叶斯优化')
  assert.ok(at(99).clause.includes('主动学习闭环') && at(99).evidence.includes('plugin-explore'),
      '第 99 条证据指向 basin-hopping 主动学习闭环')
  assert.ok(at(98).clause.includes('streamable-http') && at(98).evidence.includes('http'),
      '第 98 条证据指向 streamable-http 传输入口')
  assert.ok(at(97).clause.includes('粉末衍射') && at(97).evidence.includes('plugin-xrd'),
      '第 97 条证据指向 X 射线粉末衍射（analysis seam 第四实证）')
  assert.ok(at(96).clause.includes('布里渊区声子热力学') && at(96).evidence.includes('phonon-bz'),
      '第 96 条证据指向全 BZ 声子热力学（analysis seam 扩展）')
  assert.ok(at(95).clause.includes('探针') && at(95).evidence.includes('resident'),
      '第 95 条证据指向可用性探针全引擎补齐')
  assert.ok(at(92).clause.includes('作业台账') && at(92).evidence.includes('core jobs'),
      '第 92 条证据指向作业台账与 detach 三策略')
  assert.ok(at(93).clause.includes('源标识') && at(93).clause.includes('refingerprinted'),
      '第 93 条证据指向引擎源标识与热替换状态连续性')
  assert.ok(at(94).clause.includes('运行时动词面') && at(94).evidence.includes('runtime-tools'),
      '第 94 条证据指向运行时动词面三工具')
  assert.ok(at(90).clause.includes('弹性张量') && at(90).evidence.includes('plugin-elasticity'),
      '第 90 条证据指向弹性张量 6×6（analysis seam 第三实证）')
  assert.ok(at(91).clause.includes('md 原语') && at(91).evidence.includes('plugin-mace'),
      '第 91 条证据指向 MACE 常驻 md 对齐 free-energy 消费约定')
  assert.ok(at(89).clause.includes('MACE 常驻') && at(89).evidence.includes('plugin-mace'),
      '第 89 条证据指向 MACE 常驻 batch 与按实现补声明')
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
