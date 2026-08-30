// @saturday/plugin-sampler-ou —— OU（Ornstein-Uhlenbeck）参考结构采样器
// 契约 §4.5 sampler seam 第二实证：似然声明从 'none'（微扰）升档到 'exact'
// （OU 转移密度是闭式高斯，逐点精确可求值）。
// 采样语义而非求逆；候选必须连同非唯一性一起呈现，且可回算验证
// （生成 → 弛豫 → 核对闭环由工作流层编排，§4.5 oracle 条款）。

import { createCordisAdapter } from '@saturday/kernel'
import { compositionFromNumbers } from '@saturday/core'
import { ouSampler, samplerError, ouSampleMixture } from './sampler.mjs'
import { createAnchorStore, mixtureTargetFromRetrieved } from './anchor-store.mjs'

export { ouSampler, ouStd, ouLogProb, mulberry32, samplerError, SAMPLER_NAME, uEqFromHarmonicTemperature, KB_EV_PER_K, ouMixtureLogProb, ouSampleMixture } from './sampler.mjs'
export { createAnchorStore, mixtureTargetFromRetrieved } from './anchor-store.mjs'

export default {
  name: 'saturday-sampler-ou',

  async apply(ctx, config = {}) {
    const { defineTool } = await import('@deepseek-ai/dsh-tools').catch(() => ({}))
    const rt = createCordisAdapter(ctx, { ...config, defineTool })

    rt.provideService('sampler/ou-perturbation', ouSampler)
    // ⑩ 锚点会话库：自监督进场的数据管道在工具层的落点——闭环产出的锚点入库，
    // 供 sampler.mixture 检索引导混合提案。会话级内存库（不跨会话持久化）：
    // 锚点积累与闭环运行同生命周期，不伪造库外数据。
    const anchorStore = createAnchorStore()
    rt.provideService('sampler/anchor-store', anchorStore)

    // ⑮ 闭环轨迹自动入库（自监督数据管道第二段）：弛豫收敛且引擎交付了终态结构时，
    // 弛豫后结构自动入库为锚点（谱系自动声明：job:<jobId> + 引擎 + 能量，出处可追溯）。
    // 三道门禁：① 未收敛不入库（不收敛的结构不是盆地底，入库即伪造数据燃料）；
    // ② 引擎未交付终态（旧协议）不入库（诚实缺省，不拿输入结构冒充弛豫产物）；
    // ③ 同来源重复入库不重复累计（幂等）。
    rt.on('saturday/simulation/converged', event => {
      const p = event?.payload
      if (!p?.result?.converged) return
      if (!p?.relaxedStructure?.nodes?.length) return
      const source = `job:${p.jobId}#engine=${p.engine}`
      if (anchorStore.entries().some(e => e.source === source)) return
      anchorStore.add({
        graph: p.relaxedStructure,
        source,
        composition: compositionFromNumbers(p.relaxedStructure.nodes.map(n => n.number)),
        ...(p.material?.formula ? { formula: p.material.formula } : {}),
        ...(typeof p.result?.energy === 'number' ? { energy: p.result.energy } : {}),
      })
    })

    rt.registerTool({
      name: 'sampler.ou',
      description: 'OU 参考结构采样（§4.5 采样语义）：均值回归锚定 referenceId 的受控扩散，' +
                   '采样 n 个候选并附精确提议似然（logProb）。候选是分布上的采样点而非唯一解；' +
                   '局部采样器（盆地内），请送入引擎回算验证后再使用。',
      parameters: {
        referenceId: { type: 'string', required: true, description: '参考结构材料 ID' },
        n: { type: 'integer', default: 8, description: '候选数量' },
        seed: { type: 'integer', default: 1, description: '随机种子（确定性复现）' },
        uEq: { type: 'number', default: 0.05, description: '平衡态每坐标涨落幅度（Å）' },
        gammaDt: { type: 'number', default: 1.0, description: 'γΔ 无量纲摩擦时间尺度积（小→贴近参考，大→近平稳）' },
        temperatureK: { type: 'number', description: '采样器自身温度声明（可选；声明 ≠ 替换：不改变采样行为，' +
          '只随交付呈现供消费方做温差诚实核对；标定建议值可用 uEqFromHarmonicTemperature 换算）' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        // 服务依赖在调用时解析：缺依赖显式报错，不静默降级（契约 §2）
        const materialService = rt.getService('material')
        if (!materialService) {
          throw samplerError('SAMPLER_UNAVAILABLE',
            'sampler.ou requires service "material" (mount the saturday core plugin first)')
        }
        const reference = await materialService.get(args.referenceId)
        const candidates = await ouSampler.sample(
          { reference },
          { n: args.n, seed: args.seed, uEq: args.uEq, gammaDt: args.gammaDt, temperatureK: args.temperatureK },
        )
        return {
          sampler: ouSampler.name,
          semantics: 'sampling',
          likelihood: 'exact',
          invertible: false,
          n: candidates.length,
          candidates,
          note: '候选是 OU 提议核（均值回归锚定参考的受控扩散）的采样点，不构成唯一解；' +
                'exact 指提议核自身的闭式高斯似然（logProb 已附），不是能量面上的玻尔兹曼似然——' +
                '热力学加权仍须引擎回算（候选不自证）；OU 单峰，定位为局部采样器',
        }
      },
    })

    rt.registerTool({
      name: 'sampler.anchor.add',
      description: '混合提案锚点入库（⑩，自监督数据管道）：闭环产出的参考结构（已注册材料或直交付 graph）' +
                   '入会话锚点库；谱系必填（无来源声明的数据不入库）；组分自动从结构提取（可覆写）。' +
                   '入库即声明：锚点来自闭环轨迹，出处可追溯。',
      parameters: {
        materialId: { type: 'string', description: '已注册材料 ID（与 graph 二选一）' },
        graph: { type: 'object', additionalProperties: true, description: '直交付结构（含非空 nodes；与 materialId 二选一）' },
        source: { type: 'string', description: '谱系声明（直交付时必填；材料入库缺省声明为 material:<id>）' },
        composition: { type: 'object', additionalProperties: true, description: '组分覆写（缺省从结构节点原子序机械提取）' },
        energy: { type: 'number', description: '锚点能量（可选，闭环回算产出；入库只做记录不参与检索排序）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
      },
      async execute(args = {}) {
        let graph = args.graph
        let source = args.source
        let composition = args.composition
        let formula
        if (args.materialId) {
          const materialService = rt.getService('material')
          if (!materialService) {
            throw samplerError('SAMPLER_UNAVAILABLE',
              'sampler.anchor.add requires service "material" (mount the saturday core plugin first)')
          }
          const m = await materialService.get(args.materialId)
          graph = m.graph
          formula = m.formula
          composition = composition ?? compositionFromNumbers(m.graph.nodes.map(n => n.number))
          // 材料入库的谱系声明：材料本体自带 lineage，来源声明 = 材料身份（出处可追溯）
          source = source ?? `material:${args.materialId}`
        }
        if (!graph) {
          throw samplerError('ANCHOR_INVALID', '锚点入库需提供 materialId 或 graph 之一（结构是锚点的本体）')
        }
        if (!source) {
          throw samplerError('ANCHOR_INVALID',
            '直交付锚点必须携带来源声明（source）：无谱系数据不入库（锚点来自闭环轨迹，出处必须可追溯）')
        }
        const entry = anchorStore.add({ graph, source, composition, ...(formula ? { formula } : {}), ...(args.energy !== undefined ? { energy: args.energy } : {}) })
        // 锚点本体不外泄：显式剔除 graph（不用 undefined 覆盖——dsh 出口关卡要求无损 JSON，
        // undefined 值会触发 'value is not lossless JSON' 拒付，实证于 demo:agent 阶段 D）
        const { graph: _body, ...entryPublic } = entry
        return { added: true, size: anchorStore.size(), entry: entryPublic, note: '锚点本体已入库（graph 不外泄，检索与混合采样在库内消费）' }
      },
    })

    rt.registerTool({
      name: 'sampler.mixture',
      description: '锚点引导的混合采样（⑩）：从会话锚点库检索（拓扑硬门禁 + 组分 L1 距离）→ 最大余数法配额 → ' +
                   'OU 混合提案（似然 exact，逐候选可独立重算）。空库/无匹配显式报错（不伪造锚点）；' +
                   '候选不自证，请送入引擎回算后接 workflow.screen（sampled 透传）。' +
                   '也支持 anchors 内联（单次调用即用，不经过会话库）。',
      parameters: {
        composition: { type: 'object', additionalProperties: true, description: '目标组分（检索排序偏好；缺省只按拓扑过滤）' },
        nAtoms: { type: 'integer', description: '拓扑门禁（会话库路径必填）' },
        topK: { type: 'integer', default: 4, description: '参与混合的锚点数上限' },
        weights: { type: 'array', items: { type: 'number' }, description: '混合权重（与检索结果等长；缺省均匀）' },
        anchors: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: '内联锚点（与库检索二选一）：每项 {"graph":{...},"source":"...","composition":{...},"weight":1}',
        },
        n: { type: 'integer', default: 8, description: '候选数量' },
        seed: { type: 'integer', default: 1, description: '随机种子（确定性复现）' },
        uEq: { type: 'number', default: 0.05, description: '平衡态每坐标涨落幅度（Å）' },
        gammaDt: { type: 'number', default: 1.0, description: 'γΔ 无量纲摩擦时间尺度积' },
        temperatureK: { type: 'number', description: '采样器自身温度声明（可选；声明 ≠ 替换）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
      },
      async execute(args = {}) {
        let retrieved
        let origin
        if (args.anchors?.length) {
          // 内联路径：单次调用即用，走同一个库纯层（门禁/排序/目标构造不另开一条路）
          const inline = createAnchorStore()
          for (const a of args.anchors) inline.add(a)
          const nNodes = inline.entries()[0].graph.nodes.length
          retrieved = inline.retrieve({ nAtoms: nNodes, composition: args.composition })
          origin = 'inline'
        } else {
          if (!Number.isInteger(args.nAtoms) || args.nAtoms < 1) {
            throw samplerError('ANCHOR_INVALID', '会话库检索必须提供正整数 nAtoms（拓扑门禁是混合采样的同拓扑前置）')
          }
          retrieved = anchorStore.retrieve({ nAtoms: args.nAtoms, composition: args.composition, topK: args.topK })
          origin = 'session-store'
        }
        // 空检索 → ANCHOR_EMPTY（不伪造锚点：先让闭环积累数据，再谈混合提案）；
        // 两条路径共用同一条纯层目标构造（门禁不另开旁路）
        const target = mixtureTargetFromRetrieved(retrieved, args.weights !== undefined ? { weights: args.weights } : {})
        const candidates = await ouSampleMixture(target, {
          n: args.n, seed: args.seed, uEq: args.uEq, gammaDt: args.gammaDt, temperatureK: args.temperatureK,
        })
        return {
          sampler: ouSampler.name,
          semantics: 'sampling',
          likelihood: 'exact',
          invertible: false,
          anchorOrigin: origin,
          anchors: retrieved.map(r => ({ source: r.anchor.source, distance: r.distance })),
          n: candidates.length,
          candidates,
          note: '候选是锚点引导混合提案（OU 提议核高斯混合）的采样点：exact 指提议核自身的闭式似然，' +
                '不是能量面上的玻尔兹曼似然——候选不自证，请送入引擎回算后接 workflow.screen（sampled 透传）；' +
                (origin === 'session-store' ? '锚点来自会话库（闭环积累），检索距离随交付呈现（null = 组分不可考）' : '锚点为调用方内联（单次调用即用，不入会话库）'),
        }
      },
    })

    ctx.fiber.store.saturdaySamplerOu = { rt, anchorStore }
  },
}
