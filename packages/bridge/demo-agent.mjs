// Agent 会话端到端演示（无真实 API Key）
//
// 形态：裸 cordis 进程内组装完整 dsh 运行时（sessions / tools / system-prompt /
// agents / agent-loop / llm），LLM 侧用 @deepseek-ai/dsh-llm-mock-server 脚本化
// 服务器 + 本文件内的最小 OpenAI 兼容适配器（MockAdapter）。
//
// 演示三段（mock server 的 toolName/toolArguments 为实例级全局单值，故分段重启；
// 阶段 B 换新端口，避免 undici 全局连接池复用已销毁的 keep-alive 连接）：
//   阶段 A：自然语言“加载铜的结构” → agent loop → tool_call(material.load) →
//           真实 Saturday 工具执行 → 工具结果回流 → success 收尾；
//   阶段 B：自然语言“弛豫” → tool_call(potential.relax) → EMT/LJ 真实计算 →
//           Trajectory 落盘（saturday/simulation/converged）；
//   阶段 C：自然语言“采样并联合排序” → tool_call(workflow.screen，args 携带
//           OU 采样候选）→ 逐候选真实单点回算 + 能量证据×似然证据联合权重 →
//           编排链谱系不断（§4.5：采样器交付的 {graph, source, logProb} 原样透传）。
//   阶段 D（⑯/⑮）：自然语言“把铜入库为锚点并做混合提案” → tool_call(sampler.anchor.add
//           + sampler.mixture）→ 锚点工具在 Agent 层暴露验证 + 阶段 B 弛豫收敛结构已自动入库，
//           混合提案走会话库路径（锚点来源层随交付呈现）。
//
// 运行：npm run demo:agent --workspace @saturday/bridge

import assert from 'node:assert'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import saturdayPlugin from './src/saturday.plugin.mjs'
import screeningPlugin from '@saturday/plugin-screening'
import samplerOuPlugin, { ouSampler } from '@saturday/plugin-sampler-ou'

// ── 最小 OpenAI 兼容适配器：fetch + SSE → dsh StreamChunk 协议 ────────
class MockAdapter extends LlmAdapter {
  constructor(baseURL, apiKey = 'mock-key') {
    super()
    this.baseURL = baseURL
    this.apiKey = apiKey
  }

  providerInfo(provider) {
    return { id: provider, name: 'Saturday mock LLM' }
  }

  // Message[] → OpenAI chat messages
  static toWireMessages(options) {
    const wire = []
    if (options.system) wire.push({ role: 'system', content: options.system })
    for (const m of options.messages) {
      if (m.role === 'assistant') {
        const toolCalls = m.content.filter(b => b.type === 'tool-call')
        const texts = m.content.filter(b => b.type === 'text').map(b => b.text).join('')
        const entry = { role: 'assistant', content: texts || null }
        if (toolCalls.length) {
          entry.tool_calls = toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          }))
        }
        wire.push(entry)
      } else if (m.source?.kind === 'tool') {
        const block = m.content[0]
        wire.push({
          role: 'tool',
          tool_call_id: block.toolCallId,
          content: block.content.map(b => b.text ?? JSON.stringify(b)).join(''),
        })
      } else {
        wire.push({ role: 'user', content: m.content.map(b => b.text ?? '').join('') })
      }
    }
    return wire
  }

  async *stream(options) {
    const body = {
      model: options.model,
      stream: true,
      messages: MockAdapter.toWireMessages(options),
    }
    if (options.tools?.length) {
      body.tools = options.tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
    }
    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    })
    if (!res.ok) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `HTTP ${res.status}`, code: 'PROVIDER_ERROR', status: res.status } } }
      return
    }

    // SSE 解析 → StreamChunk
    const blocks = new Map()   // openai tool_call index → { id, name, args }
    let textBlock = null       // 文本块的累积
    let finish = { kind: 'stop' }
    let usage = null

    const chunks = []
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop()
      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') continue
          chunks.push(JSON.parse(data))
        }
      }
    }

    for (const chunk of chunks) {
      if (chunk.usage) {
        usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 }
      }
      const choice = chunk.choices?.[0]
      if (!choice) continue
      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string' && delta.content) {
        if (textBlock === null) {
          textBlock = ''
          yield { type: 'block-start', index: 0, blockType: 'text' }
        }
        textBlock += delta.content
        yield { type: 'text-delta', index: 0, text: delta.content }
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let entry = blocks.get(tc.index)
          if (!entry) {
            entry = { id: tc.id, name: tc.function?.name ?? '', args: '' }
            blocks.set(tc.index, entry)
            const idx = tc.index + 1
            yield { type: 'block-start', index: idx, blockType: 'tool-call' }
            if (tc.id || entry.name) {
              yield { type: 'tool-call-delta', index: idx, id: entry.id, name: entry.name || undefined, argumentsDelta: '' }
            }
          }
          if (tc.function?.arguments) {
            entry.args += tc.function.arguments
            yield { type: 'tool-call-delta', index: tc.index + 1, id: entry.id, argumentsDelta: tc.function.arguments }
          }
        }
      }
      if (choice.finish_reason === 'tool_calls') finish = { kind: 'tool-calls' }
    }

    if (textBlock !== null) {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: textBlock } }
    }
    for (const [oIdx, entry] of blocks) {
      const idx = oIdx + 1
      yield { type: 'block-end', index: idx, block: { type: 'tool-call', id: entry.id, name: entry.name, arguments: entry.args } }
    }
    if (usage) yield { type: 'usage', usage }
    yield { type: 'finish', reason: finish }
  }
}

// ── 演示编排 ─────────────────────────────────────────────────────────
/** 轮询等待条件成立：followup 后驱动器异步启动，whenIdle 可能在启动前就结算 */
async function waitFor(cond, timeoutMs = 30000, diag = null) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等待超时（${timeoutMs / 1000}s）${diag ? '；诊断: ' + diag() : ''}`)
    }
    await new Promise(r => setTimeout(r, 50))
  }
}

async function main() {
  console.log('═══ Saturday Agent 会话端到端演示（mock LLM，无 API Key）═══\n')

  // 1. 组装 dsh 运行时（裸 cordis，全部真实服务；ToolRuntime inject 依赖 systemPrompt，须后挂）
  const ctx = new Context()
  ctx.plugin(SessionStore)
  ctx.plugin(SystemPrompt)
  ctx.plugin(ToolRuntime)
  ctx.plugin(AgentRegistry)
  ctx.plugin(LlmRuntime)
  ctx.plugin(AgentLoop)

  // 2. 挂 Saturday 主插件（material/potential 服务 + material.load / potential.relax 工具）
  const saturdayFiber = ctx.registry.plugin(saturdayPlugin)
  await saturdayFiber
  // 筛选工作流插件（阶段 C：采样候选联合排序，编排链谱系不断）
  const screeningFiber = await ctx.registry.plugin({
    name: 'saturday-screening',
    apply: (ctx) => screeningPlugin.apply(ctx, {}),
  })
  // OU 采样器插件（阶段 D：sampler.anchor.add / sampler.mixture 工具在 Agent 层暴露；
  // 同时挂 ⑮ 自动入库监听：阶段 B 弛豫收敛结构自动进会话锚点库）
  const samplerFiber = await ctx.registry.plugin({
    name: 'saturday-sampler-ou',
    apply: (ctx) => samplerOuPlugin.apply(ctx, {}),
  })

  // 3. 阶段 A：mock server 脚本 = [tool_call(material.load), success]
  let server = await startMockLlmServer({
    port: 8231,
    apiKey: 'mock-key',
    sequence: ['tool_call_success', 'success'],
    toolName: 'material.load',
    toolArguments: JSON.stringify({ query: 'Cu' }),
    successText: '已加载铜（Cu）的面心立方结构。',
  })
  const adapter = new MockAdapter(server.baseURL, 'mock-key')
  ctx.llm.registerAdapter(['mock'], adapter)

  const handle = await ctx.agents.create({
    sessionId: 'saturday-demo-session',
    agentOptions: { provider: 'mock', model: 'mock-model' },
  })
  const agent = handle.agent
  console.log('[agent] 会话已创建:', agent.id)

  console.log('[user ] 帮我加载铜的晶体结构')
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: '帮我加载铜的晶体结构' }],
    source: { kind: 'user' },
  }))
  await waitFor(() => server.requests.length >= 2)
  await agent.whenIdle()

  // 断言阶段 A：第一次请求携带工具定义；第二次请求含工具结果；工具真实执行
  assert.ok(server.requests.length >= 2, '阶段 A 应有至少两次模型请求')
  const req1 = server.requests[0].body
  assert.ok(Array.isArray(req1.tools) && req1.tools.some(t => t.function?.name === 'material.load'),
    '第一次请求应携带 material.load 工具 schema')
  const req2 = server.requests[1].body
  const toolMsg = req2.messages.find(m => m.role === 'tool')
  assert.ok(toolMsg, '第二次请求应包含工具结果消息')
  assert.ok(typeof toolMsg.content === 'string' && toolMsg.content.startsWith('{'),
    `工具结果应为 JSON 文本，实际: ${toolMsg.content}`)
  const loadResult = JSON.parse(toolMsg.content)
  console.log('[tool ] material.load 执行结果:', JSON.stringify(loadResult))
  assert.equal(loadResult.formula, 'Cu')
  console.log('[ok   ] 阶段 A：自然语言 → material.load → 结果回流 → 收尾 ✓\n')

  // 4. 阶段 B：重启 mock server，脚本 = [tool_call(potential.relax), success]
  //    换新端口：同端口重启时 undici 全局连接池会复用已销毁的 keep-alive
  //    连接 → ECONNRESET（实证）；新端口下直接改 adapter.baseURL 即可。
  await server.close()
  server = await startMockLlmServer({
    port: 8232,
    apiKey: 'mock-key',
    sequence: ['tool_call_success', 'success'],
    toolName: 'potential.relax',
    toolArguments: JSON.stringify({ materialId: loadResult.materialId, simulatedSeconds: 0.2 }),
    successText: '结构弛豫完成，能量见工具结果。',
  })
  adapter.baseURL = server.baseURL

  console.log('[user ] 对刚才加载的结构做弛豫')
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: '对刚才加载的结构做弛豫' }],
    source: { kind: 'user' },
  }))
  await waitFor(() => server.requests.length >= 2)
  await agent.whenIdle()

  // 阶段 B 请求携带阶段 A 全部历史：最后一条工具消息才是 relax 结果
  const relaxToolMsg = server.requests[1]?.body.messages.filter(m => m.role === 'tool').at(-1)
  assert.ok(relaxToolMsg, '阶段 B 第二次请求应包含工具结果消息')
  const relaxResult = JSON.parse(relaxToolMsg.content)
  console.log('[tool ] potential.relax 执行结果:',
    JSON.stringify({ energy: relaxResult.energy, engine: relaxResult.engine, calculator: relaxResult.calculator }))
  assert.ok(typeof relaxResult.energy === 'number', 'relax 应返回数值能量')
  console.log('[ok   ] 阶段 B：自然语言 → potential.relax → 真实计算 → 收尾 ✓\n')

  // 5. 阶段 C：采样 → 联合排序（⑰ 编排链实证）。
  //    mock 模型只能发单工具调用：编排层把 OU 采样交付（{graph, source, logProb}）
  //    直接打包进 workflow.screen 的 sampled 参数——谱系在编排层不断（§4.5）；
  //    工具内部逐候选真实单点回算（候选不自证）+ 能量证据 × 似然证据联合权重。
  const cuMaterial = await ctx.reflect.get('material').get(loadResult.materialId)
  const sampledCandidates = await ouSampler.sample(
    { reference: cuMaterial }, { n: 4, seed: 7, uEq: 0.03, gammaDt: 1.0 },
  )
  await server.close()
  server = await startMockLlmServer({
    port: 8233,
    apiKey: 'mock-key',
    sequence: ['tool_call_success', 'success'],
    toolName: 'workflow.screen',
    toolArguments: JSON.stringify({
      materialId: loadResult.materialId,
      dopants: [],
      sampled: sampledCandidates.map(c => ({ graph: c.graph, source: c.source, logProb: c.logProb })),
      sampledSource: 'sampler.ou',
      temperatureK: 300,
    }),
    successText: '采样候选已完成单点回算与联合排序。',
  })
  adapter.baseURL = server.baseURL

  console.log('[user ] 对铜做热涨落采样，并按能量与似然联合排序')
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: '对铜做热涨落采样，并按能量与似然联合排序' }],
    source: { kind: 'user' },
  }))
  await waitFor(() => server.requests.length >= 2)
  await agent.whenIdle()

  const screenToolMsg = server.requests[1]?.body.messages.filter(m => m.role === 'tool').at(-1)
  assert.ok(screenToolMsg, '阶段 C 第二次请求应包含工具结果消息')
  const screenResult = JSON.parse(screenToolMsg.content)
  const joint = screenResult.sampledJoint
  assert.ok(joint, 'workflow.screen 应返回 sampledJoint 段')
  assert.equal(joint.entries.length, sampledCandidates.length, '全部采样候选回算成功')
  const wSum = joint.entries.reduce((a, e) => a + e.weight, 0)
  assert.ok(Math.abs(wSum - 1) < 1e-9, '联合权重归一')
  assert.deepEqual(joint.sourceNames, ['boltzmann:emt-mock', 'proposal:sampler.ou'])
  console.log('[tool ] workflow.screen 联合排序:',
    JSON.stringify({
      n: joint.entries.length,
      top: { weight: +joint.entries[0].weight.toFixed(4), energy: +joint.entries[0].energy.toFixed(5) },
      ess: +joint.essFraction.toFixed(3),
      sources: joint.sourceNames,
    }))
  console.log('[ok   ] 阶段 C：自然语言 → 采样交付透传 → 真实单点回算 → 联合权重 → 收尾 ✓\n')

  // 6. 阶段 D（⑯/⑮）：锚点工具在 Agent 层暴露——入库 + 混合提案（会话库路径）。
  //    阶段 B 的弛豫收敛结构已由 ⑮ 自动入库（谱系自动声明），此处再经 Agent 手动入库
  //    一个材料锚点；混合提案从会话库检索（两锚点同拓扑）→ 配额 → 提案。
  //    两次调用分两个 server（mock 的 toolName 为实例级单值，与 B/C 同款模式无竞态）。
  await server.close()
  server = await startMockLlmServer({
    port: 8234,
    apiKey: 'mock-key',
    sequence: ['tool_call_success', 'success'],
    toolName: 'sampler.anchor.add',
    toolArguments: JSON.stringify({ materialId: loadResult.materialId }),
    successText: '铜已入库为锚点。',
  })
  adapter.baseURL = server.baseURL

  console.log('[user ] 把铜入库为锚点，再从会话锚点库做混合提案')
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: '把铜入库为锚点，再从会话锚点库做混合提案' }],
    source: { kind: 'user' },
  }))
  await waitFor(() => server.requests.length >= 2)
  await agent.whenIdle()

  const addToolMsg = server.requests[1]?.body.messages.filter(m => m.role === 'tool').at(-1)
  assert.ok(addToolMsg, '阶段 D1 应包含 sampler.anchor.add 结果')
  const addResult = JSON.parse(addToolMsg.content)
  assert.equal(addResult.added, true, '锚点经 Agent 工具入库成功')
  console.log('[tool ] sampler.anchor.add:', JSON.stringify({ source: addResult.entry.source, size: addResult.size }))

  await server.close()
  server = await startMockLlmServer({
    port: 8235,
    apiKey: 'mock-key',
    sequence: ['tool_call_success', 'success'],
    toolName: 'sampler.mixture',
    toolArguments: JSON.stringify({
      nAtoms: 4, composition: { Cu: 4 }, weights: [0.5, 0.5],
      n: 4, seed: 3, uEq: 0.03, gammaDt: 1.0,
    }),
    successText: '锚点已入库，混合提案完成。',
  })
  adapter.baseURL = server.baseURL
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: '继续：从会话锚点库做混合提案' }],
    source: { kind: 'user' },
  }))
  await waitFor(() => server.requests.length >= 2)
  await agent.whenIdle()

  const mixToolMsg = server.requests[1]?.body.messages.filter(m => m.role === 'tool').at(-1)
  assert.ok(mixToolMsg, '阶段 D2 应包含 sampler.mixture 结果')
  const mixResult = JSON.parse(mixToolMsg.content)
  assert.equal(mixResult.anchorOrigin, 'session-store', '混合提案走会话库路径（闭环积累的锚点）')
  assert.equal(mixResult.anchors.length, 2, '会话库命中两锚点（阶段 B 弛豫自动入库 + 手动入库）')
  assert.equal(mixResult.candidates.length, 4, '混合提案交付配额候选')
  assert.ok(mixResult.candidates.every(c => typeof c.logProb === 'number'), '逐候选似然随交付（exact）')
  console.log('[tool ] sampler.mixture:',
    JSON.stringify({
      anchorOrigin: mixResult.anchorOrigin,
      anchors: mixResult.anchors.map(a => a.source.split('#')[0]),
      n: mixResult.candidates.length,
    }))
  console.log('[ok   ] 阶段 D：自然语言 → 锚点入库 + 混合提案（会话库）→ 收尾 ✓\n')

  // 7. 回收（会话/工具/服务全部随 fiber 撤销；cordis 根 Context 无 dispose，撤插件 fiber 即可）
  await server.close()
  await handle.dispose()
  await samplerFiber.dispose()
  await screeningFiber.dispose()
  await saturdayFiber.dispose()
  await ctx.dispose?.()
  console.log('═══ 演示完成：agent loop 全程真实（工具执行、结果回流、多轮请求），仅模型侧为 mock ═══')
}

main().then(() => process.exit(0), err => {
  console.error('演示失败:', err)
  process.exit(1)
})
