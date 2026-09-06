// @toki0413/dsh-bridge —— Saturday 的 cordis 插件入口
// 形态符合 dsh 插件规范：导出 { name, apply(ctx) }。
// 在 dsh 中：作为 profile 组合的一行挂载；在裸 cordis 中：ctx.registry.plugin() 挂载（开发/CI）。

import { createCordisAdapter } from '@toki0413/kernel'
import { loadClusters } from '@toki0413/python-bridge'
import { PrototypeLibResolver, MaterialService, PotentialRegistry } from '@toki0413/core'
import { EmtMockProvider } from './compute/emt-provider.mjs'
import { PythonBridge } from '@toki0413/python-bridge'
import { LjProvider } from '@toki0413/plugin-lj'

export default {
  name: 'saturday',

  async apply(ctx, config = {}) {
    // dsh 静态插件路径需要 defineTool（@deepseek-ai/dsh-tools）；
    // 裸 cordis / CI 环境无此包，优雅降级到本地注册表
    const { defineTool } = await import('@deepseek-ai/dsh-tools').catch(() => ({}))
    const rt = createCordisAdapter(ctx, { ...config, defineTool })

    // ── 组装核心服务 ────────────────────────────────────────────
    const resolver = new PrototypeLibResolver()
    const materialService = new MaterialService(resolver)
    const potential = new PotentialRegistry(rt)

    // 数据面形态双轨（开箱即用纪律）：
    //  - Python 可用 → emt-mock sidecar（有 ASE 时自动走真 EMT，无 ASE 走 LJ 兑底）
    //  - Python 不可用 → 显式回退零依赖纯 JS 引擎 lj-js（横幅如实报告，
    //    非静默降级：指纹独立为 lj-js，能量进组合路径前照常过 M1 门禁）
    // 远程例外：config.bridge.cluster 指向站点配置（~/.saturday/clusters.json）时，
    // sidecar 经 SSH 在远程执行——远程连接失败直接抛出，绝不静默回退本地
    //（远程语义是算力选择：用户指定 cluster 就是要求在哪算，回退本地 = 违背指令）
    const bridgeOpts = { ...config.bridge }
    if (bridgeOpts.cluster) {
      const clusters = loadClusters(bridgeOpts.clustersPath)
      if (!clusters[bridgeOpts.cluster]) {
        throw new Error(
          `cluster "${bridgeOpts.cluster}" not in site config ` +
          `(known: ${Object.keys(clusters).join(', ') || 'none'})`,
        )
      }
      bridgeOpts.transport = clusters[bridgeOpts.cluster]
    }
    const bridge = new PythonBridge(bridgeOpts)
    let dataPlane = 'emt-mock'
    try {
      await bridge.connect()
      potential.register(new EmtMockProvider(bridge))
      await potential.activate('emt-mock')
      // sidecar 生命周期绑定到插件 fiber：卸载时断开
      rt.effect(() => () => bridge.disconnect(), 'python-bridge')
    } catch (err) {
      if (config.bridge?.cluster) {
        // 远程集群语义：用户指定在哪算就在哪算——失败显式上抛，不回退本地
        throw new Error(
          `remote cluster "${config.bridge.cluster}" unreachable: ${err.message.split('\n')[0]}；` +
          '远程语义是算力选择，不回退本地（如需本机运行请移除 cluster 配置）',
        )
      }
      dataPlane = 'lj-js'
      potential.register(new LjProvider())
      await potential.activate('lj-js')
      if (!config.quiet) {
        console.log(
          `[saturday] Python 数据面不可用（${err.message.split('\n')[0]}）\n` +
          '[saturday] 已显式回退到零依赖纯 JS 引擎 lj-js（LJ 玩具势，指纹如实声明）；' +
          '安装 Python+ASE 可解锁 EMT 精度',
        )
      }
    }

    // 服务注册即效果：插件卸载时自动回收（Cordis provide 语义）
    rt.provideService('material', materialService)
    rt.provideService('potential', potential)

    // ── Agent 工具（dsh 内走 harness；裸 cordis 走本地注册表）──
    rt.registerTool({
      name: 'material.load',
      description: '加载材料结构。支持化学式（如 "Si"、"TiO2"）；' +
                   'TiO2 等多晶型材料可用 polymorphRank 选择晶型。',
      // schema 方言：schemastery 扁平式（官方工具插件实证格式，非 JSON Schema）
      parameters: {
        query: { type: 'string', required: true, description: '化学式' },
        polymorphRank: { type: 'integer', description: '多晶型序号，默认 0（最稳定）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        // dsh 工具出口要求：结果需经 render 投影为内容块（适配清单 §9 未竟项，Agent 会话实证补齐）
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value) }]
        },
      },
      async execute(args) {
        const m = await materialService.load(args.query, { polymorphRank: args.polymorphRank ?? 0 })
        const resolved = m.lineage.find(l => l.operation === 'structure-resolved')
        return {
          materialId: m.id,
          formula: m.formula,
          nAtoms: m.nAtoms,
          structureOrigin: resolved?.detail,
        }
      },
    })

    rt.registerTool({
      name: 'potential.relax',
      description: '对材料做结构弛豫。引擎为 EMT：Python sidecar 有 ASE 时走真实 EMT ' +
                   '（UnitCellFilter + BFGS），否则回退 LJ 玩具势（结果中 calculator 字段标明）。',
      parameters: {
        materialId: { type: 'string', required: true },
        engine: { type: 'string', default: 'auto' },
        simulatedSeconds: { type: 'number', description: '模拟计算耗时（演示长任务）', default: 0.5 },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value) }]
        },
      },
      async execute(args) {
        const material = await materialService.get(args.materialId)
        const provider = potential.resolveProvider(
          { engine: args.engine },
          { type: 'relax', nAtoms: material.nAtoms },
        )
        const result = await provider.relax(material, { simulated_seconds: args.simulatedSeconds })

        // 弛豫后终态随交付呈现（自动入库的数据燃料）：引擎返回终态坐标时构造
        // 弛豫后结构入事件（薄事件厚数据：结构体在场，消费方按 converged 门禁消费）；
        // 引擎不返回终态（旧协议/不支持）则如实缺省，自动入库静默跳过不伪造。
        const relaxedStructure = Array.isArray(result.positions) && result.positions.length === material.nAtoms
          ? {
              nodes: material.graph.nodes.map((node, i) => ({ ...node, position: result.positions[i] })),
              edges: material.graph.edges,
              periodic: material.graph.periodic,
              cell: Array.isArray(result.cell) ? result.cell : material.graph.cell,
            }
          : undefined

        // 事件 → Trajectory（append-only 溯源）
        const event = {
          type: 'saturday/simulation/converged',
          payload: {
            jobId: result.jobId,
            material: { id: material.id, formula: material.formula },
            result: {
              energy: result.energy,
              scale: result.scale,
              nSteps: result.n_steps,
              converged: Boolean(result.converged),
            },
            engine: result.engine,
            wallSeconds: result.wall_seconds,
            ...(relaxedStructure ? { relaxedStructure } : {}),
          },
        }
        await rt.emit(event.type, event)
        return result
      },
    })

    // workflow.screen 已迁出为独立插件 @toki0413/plugin-screening（契约 §4.3：工作流不进核心）

    // 可用性预检：把声明态→实测态回读暴露给 Agent 层——
    // 逐已注册引擎探测运行时版本（探测失败不报错：诚实降级保持声明态），
    // 探测成功且 stamp=true 时盖章升级指纹实测态（§4.2 路由契约不变：
    // 不可用引擎不从注册表移除，使用时由 ENGINE_UNAVAILABLE 拦，绝不静默替换）。
    rt.registerTool({
      name: 'engine.availability',
      description: '可用性预检：逐已注册引擎探测运行时版本并如实报告（注册 = 声明层，可用 = 运行时层）。' +
                   '探测成功且 stamp=true 时把指纹 version 从声明态 "unknown" 盖章升级为实测值；' +
                   '探测失败保持 "unknown"（不拿未知冒充已知）。同一份代码在不同环境给出不同的表，两种都正确。',
      parameters: {
        stamp: { type: 'boolean', default: false,
                 description: '探测成功时是否盖章升级指纹实测态（默认只报告不副作用；预检是查询不是变更）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value) }]
        },
      },
      async execute({ stamp = false } = {}) {
        const engines = []
        for (const [name, provider] of potential.providers) {
          let version = null
          if (typeof provider.probeVersion === 'function') {
            try { version = await provider.probeVersion() } catch { version = null }
          }
          if (version && stamp) potential.stampFingerprint(name, { version })
          const fp = provider._fingerprint
          engines.push({
            name,
            status: version ? 'available' : 'unknown-or-missing',
            fingerprint: { software: fp.software, method: fp.method, version: fp.version },
            probeSupport: typeof provider.probeVersion === 'function' ? 'probeVersion' : 'none',
          })
        }
        return {
          engines,
          stamped: Boolean(stamp),
          note: 'status 只反映版本探测成败（探测失败 = 未知或缺失，不区分两者——区分需真实计算，超出预检权限）；' +
                '注册表不因探测失败缩减（声明层完整），使用时由 ENGINE_UNAVAILABLE 门禁拦下',
        }
      },
    })

    // 计算事件统一落 Trajectory（relaxedStructure 是事件内消费字段，薄事件纪律下不重复落盘）
    rt.on('saturday/simulation/converged', async event => {
      const { relaxedStructure, ...rest } = event.payload
      await rt.appendTrajectory({
        type: 'material_calculation_complete',
        ...(relaxedStructure ? { relaxedStructureDelivered: true } : {}),
        ...rest,
      })
    })

    // 分析类事件同样落 Trajectory（薄载荷）：自由能曲线等分析结果与计算事件同一溯源链
    rt.on('saturday/analysis/complete', async event => {
      await rt.appendTrajectory({
        type: 'analysis_complete',
        ...event.payload,
      })
    })

    // 活性上下文（§8.2）：势函数热替换是失效源。若同 Context 挂了推导登记簿，
    // 沿 engine:<旧引擎> 传播失效（依赖它的所有导出量——候选能量、筛选排序——全链置 invalid）；
    // 未挂载时静默跳过（derivation 是可选插件，不构成本插件依赖）。
    rt.on('saturday/potential/activated', async event => {
      const derivation = rt.getService('derivation')
      const { engine, previous } = event.payload
      if (derivation && previous) {
        await derivation.invalidate(
          `engine:${previous}`,
          `势函数热替换：比较基准由 ${previous} 切换为 ${engine}，旧引擎产出的导出量需重算或作废`,
        )
      }
    })

    // 运行时句柄外挂到 fiber.store（cordis v4：apply 只能返回 void 或 disposer，
    // 不能返回任意对象——返回对象会被当作 effect 而拒绝）；
    // dataPlane 如实声明当前数据面形态（'emt-mock' | 'lj-js'），演示与工具据此呈现
    ctx.fiber.store.saturday = { rt, materialService, potential, dataPlane }
  },
}
