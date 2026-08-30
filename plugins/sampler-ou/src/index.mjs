// @saturday/plugin-sampler-ou —— OU（Ornstein-Uhlenbeck）参考结构采样器
// 契约 §4.5 sampler seam 第二实证：似然声明从 'none'（微扰）升档到 'exact'
// （OU 转移密度是闭式高斯，逐点精确可求值）。
// 采样语义而非求逆；候选必须连同非唯一性一起呈现，且可回算验证
// （生成 → 弛豫 → 核对闭环由工作流层编排，§4.5 oracle 条款）。

import { createCordisAdapter } from '@saturday/kernel'
import { compositionFromNumbers } from '@saturday/core'
import { randomUUID } from 'node:crypto'
import { writeFileSync, readFileSync } from 'node:fs'
import { ouSampler, samplerError, ouSampleMixture } from './sampler.mjs'
import { createAnchorStore, mixtureTargetFromRetrieved } from './anchor-store.mjs'

export { ouSampler, ouStd, ouLogProb, mulberry32, samplerError, SAMPLER_NAME, uEqFromHarmonicTemperature, KB_EV_PER_K, ouMixtureLogProb, ouSampleMixture } from './sampler.mjs'
export { createAnchorStore, mixtureTargetFromRetrieved } from './anchor-store.mjs'
export { trajectoryTriggerAssessment } from './anchor-trigger.mjs'

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
        batchId: { type: 'string', description: '提案批次标识（可选；缺省随机生成，用于推导登记簿引用对账）' },
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
        // ㉑ 提案层谱系登记（活性上下文 §8.2）：derivation 服务可选——未注入行为不变（与
        // workflow.screen 同款：纯编排层零依赖）；注入时登记一层提案推导：
        // 输入 = 可追溯锚点来源（归一化为 material:<id>/job:<id>：自动入库谱系 `job:<id>#engine=<name>`
        // 取 # 前段），不可追溯来源（内联/其他形态）不冒充推导输入，随交付如实声明。
        let derivationRecord
        const derivation = rt.getService('derivation')
        if (derivation) {
          const anchorRefs = [...new Set(retrieved
            .map(r => r.anchor.source.split('#')[0])
            .filter(ref => ref.startsWith('material:') || ref.startsWith('job:')))]
          const untrackedSources = retrieved.map(r => r.anchor.source)
            .filter(s => !anchorRefs.includes(s.split('#')[0]))
          if (anchorRefs.length > 0) {   // 全不可追溯时不伪登记（没有可声明的输入就不登记）
            const bid = args.batchId ?? randomUUID()
            const proposalRef = `result:mixture-${bid}`
            derivation.record({ inputs: anchorRefs, output: proposalRef, producer: 'sampler.mixture' })
            derivationRecord = { batchId: bid, proposalRef, anchorRefs, untrackedSources }
          } else {
            derivationRecord = { batchId: null, proposalRef: null, anchorRefs: [], untrackedSources,
              note: '全部锚点来源不可追溯（非 material:/job: 形态）：不伪登记，谱系声明随交付呈现' }
          }
        }
        return {
          sampler: ouSampler.name,
          semantics: 'sampling',
          likelihood: 'exact',
          invertible: false,
          anchorOrigin: origin,
          anchors: retrieved.map(r => ({ source: r.anchor.source, distance: r.distance })),
          n: candidates.length,
          candidates,
          ...(derivationRecord ? { derivation: derivationRecord } : {}),
          note: '候选是锚点引导混合提案（OU 提议核高斯混合）的采样点：exact 指提议核自身的闭式似然，' +
                '不是能量面上的玻尔兹曼似然——候选不自证，请送入引擎回算后接 workflow.screen（sampled 透传）；' +
                (origin === 'session-store' ? '锚点来自会话库（闭环积累），检索距离随交付呈现（null = 组分不可考）' : '锚点为调用方内联（单次调用即用，不入会话库）'),
        }
      },
    })

    // ㉓ 持久化锚点库原型：库间搬运原语（导出/导入）——跨会话持久化的第一段。
    // 诚实边界：库自身仍是会话级内存库，导出只交付无损 JSON 有效载荷，
    // 落盘与跨会话恢复由调用方负责（原型不引入文件 I/O，不伪造库外数据）。
    // ㉝ 载荷形态升版：/2 起条目携带版本戳（损坏定位从“整体非载荷”下沉到条目级）。
    const STORE_VERSION = 'saturday-anchor-store/2'
    const ENTRY_VERSION = 'saturday-anchor-entry/1'
    const stampedEntries = () => anchorStore.entries().map(e => ({ entryVersion: ENTRY_VERSION, ...e }))
    const normRef = source => (typeof source === 'string' ? source.split('#')[0] : null)
    const isTrackableRef = ref => !!ref && (ref.startsWith('material:') || ref.startsWith('job:'))
    rt.registerTool({
      name: 'sampler.anchor.export',
      description: '导出会话锚点库全量条目（无损 JSON 有效载荷）：跨会话持久化的原语。' +
                   '库自身不落盘——导出交付由调用方保存与回填（诚实边界：不伪造库外数据）。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
      },
      async execute() {
        return {
          version: STORE_VERSION,
          size: anchorStore.size(),
          entries: stampedEntries(),
          note: '锚点库全量导出（含 graph 本体 + 条目版本戳）：无损 JSON；跨会话落盘与回填由调用方负责',
        }
      },
    })

    // ㉓ 库间搬运原语的共享导入循环（导入工具与文件回填共用：门禁不另开旁路）。
    // 谱系门禁复用库层；同谱系幂等跳过（重放安全）；单条拒绝不中断整批（如实记录）。
    function importEntries(entries, indexMap) {
      let added = 0
      let skipped = 0
      const rejected = []
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        const origIndex = indexMap ? indexMap[i] : i   // ㉝ 拒绝索引定位回载荷原位（过滤后不丢定位能力）
        if (typeof e?.source !== 'string' || e.source.trim().length === 0) {
          rejected.push({ index: origIndex, reason: '无来源声明：导入同样受谱系门禁约束（无谱系数据不入库）' })
          continue
        }
        if (anchorStore.entries().some(x => x.source === e.source)) { skipped++; continue }   // 幂等：同谱系不重复累计（与 ⑮ 同款）
        try {
          anchorStore.add(e)   // graph 本体门禁由库层复用（缺 graph 即拒）
          added++
        } catch (err) {
          rejected.push({ index: origIndex, reason: `库层门禁拒绝：${err.message}` })   // 单条拒绝不中断整批导入（如实记录）
        }
      }
      return { added, skipped, rejected }
    }

    rt.registerTool({
      name: 'sampler.anchor.import',
      description: '从导出载荷回填锚点：逐条入库（谱系门禁复用库层：无来源即拒），' +
                   '同谱系已在库则跳过（导入幂等，重放安全）。返回入库/跳过/拒绝明细。',
      parameters: {
        entries: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: '导出载荷的 entries 数组（每项 {graph, source, composition?, formula?, energy?}）',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
      },
      async execute(args = {}) {
        if (!Array.isArray(args.entries)) {
          throw samplerError('ANCHOR_INVALID', 'import 必须提供 entries 数组（导出载荷的 entries 字段）')
        }
        const { added, skipped, rejected } = importEntries(args.entries)
        return {
          added, skipped, rejected,
          size: anchorStore.size(),
          note: '导入完成：谱系门禁复用库层，同谱系幂等跳过；导出载荷由调用方提供（库不伪造库外数据）',
        }
      },
    })

    // ㉔ 持久化落盘侧：库间搬运原语的文件端（导出载荷 ↔ 磁盘）。
    // 诚实边界：路径由调用方显式声明（库不自作主张读写文件系统）；
    // 文件缺失/损坏显式报错（不静默返回空库冒充成功）。
    rt.registerTool({
      name: 'sampler.anchor.save',
      description: '把会话锚点库落盘到调用方指定路径（导出载荷的磁盘端）：无损 JSON，' +
                   '跨会话恢复用 sampler.anchor.load。路径显式声明（库不自作主张读写文件系统）。',
      parameters: {
        path: { type: 'string', description: '目标文件路径（调用方显式声明）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
      },
      async execute(args = {}) {
        if (typeof args.path !== 'string' || args.path.trim().length === 0) {
          throw samplerError('ANCHOR_PERSIST', 'save 必须提供目标路径（路径由调用方显式声明，库不自作主张）')
        }
        const payload = { version: STORE_VERSION, size: anchorStore.size(), entries: stampedEntries() }
        writeFileSync(args.path, JSON.stringify(payload, null, 2))
        return { saved: true, path: args.path, size: payload.size, note: '锚点库已落盘（无损 JSON；恢复用 sampler.anchor.load）' }
      },
    })

    // ㉝ 载荷门禁与条目审计（load 门禁先行段与 audit 只读观测共用：检查形态不分叉）。
    // 返回 { ok: false, reason } 或 { ok: true, payload, cleanEntries, indexMap, stampRejected }。
    function checkPayload(path) {
      let raw
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        return { ok: false, reason: `载荷文件不可读（不存在或无权限）：${path}——不静默返回空库冒充成功` }
      }
      let payload
      try {
        payload = JSON.parse(raw)
      } catch {
        return { ok: false, reason: `载荷不是合法 JSON（文件损坏或非导出载荷）：${path}` }
      }
      if (!Array.isArray(payload?.entries)) {
        return { ok: false, reason: `载荷缺少 entries 数组（非 sampler.anchor.export/save 产物，不猜测冒充）：${path}` }
      }
      // ㉜ 完整性校验：版本门禁（未知形态不静默接受）+ size 声明对账（声明 ≠ 实质即拒）。
      if (payload.version !== STORE_VERSION) {
        return { ok: false, reason: `载荷版本不受支持（声明 ${payload.version ?? '无'}，当前仅支持 ${STORE_VERSION}）：${path}——不静默接受未知形态` }
      }
      if (payload.size !== payload.entries.length) {
        return { ok: false, reason: `载荷完整性声明与实质不符（声明 size=${payload.size}，实际 entries=${payload.entries.length}）：${path}` }
      }
      // ㉝ 条目级版本戳：损坏定位到条目（含载荷原位索引），不连坐合法条目。
      const cleanEntries = []
      const indexMap = []
      const stampRejected = []
      payload.entries.forEach((e, i) => {
        if (e?.entryVersion !== ENTRY_VERSION) {
          stampRejected.push({ index: i, reason: `条目版本戳缺失/未知（声明 ${e?.entryVersion ?? '无'}，当前仅支持 ${ENTRY_VERSION}）：损坏定位到条目级，不连坐` })
        } else {
          cleanEntries.push(e)
          indexMap.push(i)
        }
      })
      return { ok: true, payload, cleanEntries, indexMap, stampRejected }
    }

    // ㉞ path（单载荷）与 paths（多载荷合并）二选一，路径必须调用方显式声明。
    function resolveLoadPaths(args, tool) {
      const hasPath = typeof args.path === 'string' && args.path.trim().length > 0
      const hasPaths = Array.isArray(args.paths) && args.paths.length > 0
      if (hasPath === hasPaths) {
        throw samplerError('ANCHOR_PERSIST', `${tool} 必须且只能提供 path（单载荷）或 paths（多载荷）之一：路径由调用方显式声明`)
      }
      const paths = hasPath ? [args.path] : args.paths
      if (paths.some(p => typeof p !== 'string' || p.trim().length === 0)) {
        throw samplerError('ANCHOR_PERSIST', `${tool} 的 paths 中存在非法路径（路径必须为非空字符串，调用方显式声明）`)
      }
      return paths
    }

    rt.registerTool({
      name: 'sampler.anchor.load',
      description: '从调用方指定路径回填锚点（落盘载荷 → 会话库，支持 path 单载荷或 paths 多载荷合并）：' +
                   '门禁先行——全部文件先过完整性检查（读/解析/版本/size/条目版本戳），全过才开始回填（出错时库零污染）；' +
                   '回填复用导入门禁（谱系/本体/幂等同款）；交付附逐文件明细与 lineageRefs（磁盘数据起点的可追溯声明）。',
      parameters: {
        path: { type: 'string', description: '单载荷文件路径（与 paths 二选一，调用方显式声明）' },
        paths: { type: 'array', items: { type: 'string' }, description: '多载荷文件路径（与 path 二选一；同谱系幂等门禁天然兜底跨载荷重复）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
      },
      async execute(args = {}) {
        const paths = resolveLoadPaths(args, 'load')
        // ㉞ 门禁先行：先完成全部文件的完整性检查，任何一份不过 → 整批拒绝（此时尚未写入任何条目，库零污染）。
        const checked = paths.map(p => ({ path: p, ...checkPayload(p) }))
        const failed = checked.find(c => !c.ok)
        if (failed) {
          throw samplerError('ANCHOR_PERSIST', `${failed.reason}（门禁先行：整批拒绝，未回填任何条目）`)
        }
        const files = []
        let added = 0
        let skipped = 0
        const rejected = []
        for (const c of checked) {
          const r = importEntries(c.cleanEntries, c.indexMap)
          const fileRejected = [...c.stampRejected, ...r.rejected].sort((a, b) => a.index - b.index)
          added += r.added
          skipped += r.skipped
          rejected.push(...fileRejected)
          files.push({ path: c.path, added: r.added, skipped: r.skipped, rejected: fileRejected })
        }
        // ㉛ lineageRefs：磁盘数据起点的可追溯声明——归一化后失效传播可从此起点发起（与 ㉑ 归一规则同款：取 # 前段）。
        const lineageRefs = [...new Set(checked.flatMap(c => c.payload.entries
          .map(e => normRef(e.source))
          .filter(isTrackableRef)))]
        return {
          loaded: true,
          ...(paths.length === 1 ? { path: paths[0] } : { paths }),
          files, added, skipped, rejected,
          size: anchorStore.size(), lineageRefs,
          note: '落盘载荷已回填（门禁先行，单条损坏不连坐）：门禁与导入工具同款（谱系/本体/幂等）；lineageRefs 为磁盘数据起点的可追溯声明；库自身仍会话级',
        }
      },
    })

    // ㉟ 载荷血缘审计（只读观测）：回填前的一手数据质量观测面——三态声明可追溯/不可追溯/损坏；
    // 审计不回填、不污染库；单文件异常如实入报告不连坐其余文件。
    // ㊶ 修复建议通道：观测面从“呈现问题”走向“指明出路”——对非可追溯条目随报告交付
    // 可操作的修复声明（缺什么、回填时会怎样）；仍保持只读，不越权代改。
    function classifyEntry(e) {
      if (e?.entryVersion !== ENTRY_VERSION) {
        return { state: 'corrupt', hint: `版本戳缺失或未知（期望 ${ENTRY_VERSION}）：条目级损坏，回填必拒` }
      }
      if (typeof e?.source !== 'string' || e.source.trim().length === 0) {
        return { state: 'corrupt', hint: '来源声明缺失：条目级损坏，回填必拒' }
      }
      if (!isTrackableRef(normRef(e.source))) {
        return { state: 'untracked', hint: '来源非可追溯形态（期望 material: 或 job: 前缀）：可回填但不可追溯，建议声明可追溯起源' }
      }
      return { state: 'traceable', hint: null }
    }

    rt.registerTool({
      name: 'sampler.anchor.audit',
      description: '审计调用方指定路径载荷的血缘完整率（只读，不回填）：逐条目三态——可追溯（来源归一化为 material:/job:）/' +
                   '不可追溯（有来源但非可追溯形态）/损坏（版本戳缺失或来源缺失，回填必拒）；' +
                   '非可追溯条目附修复建议（指明出路，不代改）；异常如实入报告，不连坐。',
      parameters: {
        path: { type: 'string', description: '单载荷文件路径（与 paths 二选一）' },
        paths: { type: 'array', items: { type: 'string' }, description: '多载荷文件路径（与 path 二选一）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
      },
      async execute(args = {}) {
        const paths = resolveLoadPaths(args, 'audit')
        const files = paths.map(p => {
          const c = checkPayload(p)
          if (!c.ok) return { path: p, ok: false, reason: c.reason }
          const tally = { traceable: 0, untracked: 0, corrupt: 0 }
          const repairHints = []
          c.payload.entries.forEach((e, index) => {
            const { state, hint } = classifyEntry(e)
            tally[state]++
            if (state !== 'traceable') repairHints.push({ index, state, hint })
          })
          return { path: p, ok: true, version: c.payload.version, size: c.payload.size, ...tally, repairHints }
        })
        return {
          audited: true,
          ...(paths.length === 1 ? { path: paths[0] } : { paths }),
          files,
          size: anchorStore.size(),
          note: '审计为只读观测：不回填、库不变（size 为审计时库状态）；三态 = 可追溯/不可追溯/损坏；repairHints 为非可追溯条目的修复建议（指明出路，不代改）',
        }
      },
    })

    // ㊳ 锚点库容量观测（只读）：与 ㉟ 载荷审计构成“库内 + 库外”双观测面——
    // 为 ㉘ 触发条件的“足够轨迹”提供量化读数；观测不变更库。
    rt.registerTool({
      name: 'sampler.anchor.stats',
      description: '会话锚点库容量观测（只读，不变更）：条目数 + 谱系形态分布（material:/job:/其他）+ 组分声明覆盖——' +
                   '与 sampler.anchor.audit（库外载荷观测）构成双观测面。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
      },
      async execute() {
        const entries = anchorStore.entries()
        const lineage = { material: 0, job: 0, other: 0 }
        let withComposition = 0
        for (const e of entries) {
          const ref = normRef(e.source)
          if (ref?.startsWith('material:')) lineage.material++
          else if (ref?.startsWith('job:')) lineage.job++
          else lineage.other++
          if (e.composition && typeof e.composition === 'object' && Object.keys(e.composition).length > 0) withComposition++
        }
        return {
          size: entries.length, lineage, withComposition,
          note: '库内观测（只读不变更）：lineage 为归一化谱系形态分布（取 # 前段）；withComposition 为带组分声明的条目数',
        }
      },
    })

    ctx.fiber.store.saturdaySamplerOu = { rt, anchorStore }
  },
}
