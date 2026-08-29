// 摘要层纯函数（零依赖）——把仓库实证状态压缩成可再生摘要。
//
// 诚实边界：
//  - 摘要不是手写文档：每个字段可追溯到来源（测试输出 / package.json / 契约文档附录 A），
//    任何状态变更后重跑生成器即同步，不靠人工维护；
//  - 计数对账门禁：汇总数与逐包实跑结果不一致时显式报错，不静默出摘要；
//  - 失败不隐藏：任何包有失败用例，摘要里显式标记（诚实优先于好看）。

/** 解析 node --test 的 TAP 输出，取 # pass / # fail 计数；缺行显式报错 */
export function parseTestTap(tapText) {
  if (typeof tapText !== 'string') {
    throw new Error('parseTestTap: 输入必须是字符串（TAP_UNDEFINED_INPUT）')
  }
  const pass = tapText.match(/^# pass (\d+)\s*$/m)
  const fail = tapText.match(/^# fail (\d+)\s*$/m)
  if (!pass || !fail) {
    throw new Error('parseTestTap: TAP 输出缺少 "# pass"/"# fail" 汇总行（TAP_INCOMPLETE_OUTPUT）')
  }
  return { pass: Number(pass[1]), fail: Number(fail[1]) }
}

/**
 * 解析契约文档附录 A 的实证映射表：| # | 契约条款 | 现有测试 | 三列。
 * 条款内含半角竖线时合并中间列；表不存在时显式报错（摘要不得凭空编实证清单）。
 */
export function parseMilestoneTable(markdown) {
  const lines = String(markdown).split('\n')
  const rows = []
  let inTable = false
  for (const line of lines) {
    const t = line.trim()
    if (/^\|\s*#\s*\|/.test(t)) { inTable = true; continue }
    if (!inTable) continue
    if (/^\|[\s\-:|]+\|$/.test(t)) continue // 分隔行
    if (!t.startsWith('|')) break // 表结束
    const cells = t.split('|').slice(1, -1).map(c => c.trim())
    if (cells.length < 3 || !/^\d+$/.test(cells[0])) continue
    // 中间列可能含竖线：首列是序号、末列是证据，其余合并为条款
    rows.push({
      index: Number(cells[0]),
      clause: cells.slice(1, cells.length - 1).join('|'),
      evidence: cells[cells.length - 1],
    })
  }
  if (rows.length === 0) {
    throw new Error('parseMilestoneTable: 未找到附录 A 实证映射表（MILESTONE_TABLE_MISSING）')
  }
  return rows
}

/**
 * 组装摘要（纯函数：给定输入，产出 markdown + json）。
 * @param {Object} opts
 * @param {Array<{dir: string, name: string, version: string, description: string, hasTests: boolean}>} opts.workspaces
 *        hasTests=false 的包（如防腐层，由契约套件覆盖）诚实标记“无独立测试”，不计入汇总；
 *        hasTests=true 但缺结果的包显式报错（不得静默出摘要）
 * @param {Object<string, {pass: number, fail: number}>} opts.testResults 按 dir 索引
 * @param {Array<{index, clause, evidence}>} opts.milestones
 * @param {string} [opts.generatedAt] 生成时间（确定性测试可注入）
 */
export function buildSummary({ workspaces, testResults, milestones, generatedAt }) {
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    throw new Error('buildSummary: workspaces 不能为空（SUMMARY_NO_WORKSPACES）')
  }
  if (!Array.isArray(milestones) || milestones.length === 0) {
    throw new Error('buildSummary: milestones 不能为空（SUMMARY_NO_MILESTONES）')
  }
  const rows = workspaces.map(w => {
    const r = testResults?.[w.dir]
    if (!r) {
      if (w.hasTests === false) {
        return { ...w, pass: null, fail: null }
      }
      throw new Error(`buildSummary: 包 ${w.dir} 有测试但缺结果——不得静默出摘要（SUMMARY_RESULT_MISSING）`)
    }
    return { ...w, pass: r.pass, fail: r.fail }
  })
  const totalPass = rows.reduce((s, r) => s + (r.pass ?? 0), 0)
  const totalFail = rows.reduce((s, r) => s + (r.fail ?? 0), 0)
  const testedCount = rows.filter(r => r.pass !== null).length

  const md = []
  md.push('# Saturday 项目摘要（自动生成，请勿手改）')
  md.push('')
  md.push(`生成时间：${generatedAt ?? new Date().toISOString()}`)
  md.push('')
  md.push(`**回归基线：${totalPass}/${totalPass + totalFail}**（${rows.length} 个包，其中 ${testedCount} 个含独立测试；重跑 \`npm run summary\` 即可再生本文件）`)
  md.push('')
  md.push('| 包 | 描述 | 测试 |')
  md.push('|---|---|---|')
  for (const r of rows) {
    const count = r.pass === null ? '— 无独立测试（由契约套件覆盖）' : `${r.pass}/${r.pass + r.fail}${r.fail > 0 ? ` **FAIL ${r.fail}**` : ''}`
    md.push(`| \`${r.name}\` | ${r.description} | ${count} |`)
  }
  md.push('')
  md.push(`## 实证条款（契约文档附录 A，${milestones.length} 条）`)
  md.push('')
  for (const m of milestones) {
    md.push(`- **#${m.index}** ${m.clause}（证据：${m.evidence}）`)
  }
  md.push('')
  md.push('> 诚实声明：本摘要由生成器从测试输出、package.json 与契约文档机械汇编；')
  md.push('> 未包含在以上来源中的内容一律不出现。失败用例显式标记，不隐藏。')

  const json = {
    generatedAt: generatedAt ?? new Date().toISOString(),
    totalPass, totalFail, packageCount: rows.length, testedCount,
    packages: rows.map(r => ({ dir: r.dir, name: r.name, version: r.version, pass: r.pass, fail: r.fail })),
    milestones,
  }
  return { markdown: md.join('\n'), json }
}
