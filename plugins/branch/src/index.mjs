// @toki0413/plugin-branch —— 会话分支账本插件（契约：把模拟当可回退的规划树）。
// 四个动词：fork（起一条决策线）/ record（把某支算得的数值挂到 subject/key，add-only）/
// compare（只读并列各支可见值与差）/ trunk（选一条为主干，非破坏）。
// 语义纪律见 ./branch-ledger.mjs：结果不可变、可见性沿祖先链、无破坏式合并——与可逆性边界对齐。
// 纯账本逻辑在 branch-ledger.mjs（可独立闭式测）；此处只做服务提供 + 工具接线 + 决策落 Trajectory。

import { createCordisAdapter } from '@toki0413/kernel'
import { createSessionLedger } from './branch-ledger.mjs'

export { createSessionLedger } from './branch-ledger.mjs'

const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

export default {
  name: 'saturday-branch',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)
    const ledger = createSessionLedger({ rootId: config.rootId })
    rt.provideService('session', ledger)

    rt.registerTool({
      name: 'session.fork',
      description: '从某决策线（默认当前主干）分叉一条新支：只登记父子与分叉点序号，不复制/改动任何已有状态，' +
        '不重跑任何计算。fork 前的账本历史对子支共享可见，fork 后各支记录彼此隔离。动作落 Trajectory（决策可溯源）。',
      parameters: {
        from: { type: 'string', description: '父分支 id（默认当前主干）' },
        id: { type: 'string', description: '新分支 id（默认自动 branch-N，确定性递增）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render },
      async execute(args) {
        const b = ledger.fork({ from: args.from ?? undefined, id: args.id })
        await rt.appendTrajectory?.({ type: 'session_fork', branch: b.id, parent: b.parent, forkedAtSeq: b.forkedAtSeq })
        return b
      },
    })

    rt.registerTool({
      name: 'session.record',
      description: '把某支上算得的一个数值挂到 (subject,key)（如 energy/gap/aboveHull）：add-only，同键再记则最新一条' +
        '对该支及其后代生效、旧记录保留不覆盖（结果不可变）。非数值信息放 meta 串。',
      parameters: {
        branch: { type: 'string', description: '目标分支（默认当前主干）' },
        subject: { type: 'string', required: true, description: '被记录对象（如材料 id / 化学式）' },
        key: { type: 'string', required: true, description: '指标名（如 energy）' },
        value: { type: 'number', required: true, description: '数值（引擎回算/分析产出的标量）' },
        meta: { type: 'string', description: '非数值备注（引擎/指纹/单位/来源等，随结果如实记录）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render },
      async execute(args) { return ledger.record(args) },
    })

    rt.registerTool({
      name: 'session.compare',
      description: '只读对照：并列各分支（默认全部）对同一 (subject,key) 的可见值、是否分歧、数值跨度。' +
        '沿祖先链取每支最新可见值（fork 前共享、fork 后各支独立）。不合并、不改任何状态。',
      parameters: {
        subject: { type: 'string', required: true, description: '被对照对象' },
        key: { type: 'string', required: true, description: '指标名' },
        branches: { type: 'array', items: { type: 'string' }, description: '限定对照的分支子集（默认全部）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render },
      async execute(args) { return ledger.compare(args) },
    })

    rt.registerTool({
      name: 'session.trunk',
      description: '选一条决策线为主干（trunk）：只是移动指针 + 审计，绝不删除其它分支或其记录——' +
        '选主干是决策，不是回退；其余支仍完整在场、可继续对照。动作落 Trajectory。',
      parameters: { branch: { type: 'string', required: true, description: '设为主干的分支 id' } },
      output: { schema: { type: 'object', additionalProperties: true }, render },
      async execute(args) {
        const r = ledger.markTrunk({ branch: args.branch })
        await rt.appendTrajectory?.({ type: 'session_trunk', trunk: r.trunk })
        return r
      },
    })

    rt.registerTool({
      name: 'session.status',
      description: '会话分支树快照：主干、各支（父/分叉点/祖先链/是否主干）、记录数。只读，便于 Agent 看清当前规划树。',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true }, render },
      async execute() { return ledger.status() },
    })

    ctx.fiber.store.saturdayBranch = { rt, ledger }
  },
}
