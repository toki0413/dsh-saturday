// Agent 会话端到端演示（无真实 API Key）
//
// 形态：裸 cordis 进程内组装完整 dsh 运行时（sessions / tools / system-prompt /
// agents / agent-loop / llm），LLM 侧用 @deepseek-ai/dsh-llm-mock-server 脚本化
// 服务器 + 本文件内的最小 OpenAI 兼容适配器（MockAdapter）。
//
// 演示两段（mock server 的 toolName/toolArguments 为实例级全局单值，故分段重启；
// 阶段 B 换新端口，避免 undici 全局连接池复用已销毁的 keep-alive 连接）：
//   阶段 A：自然语言"加载铜的结构" → agent loop → tool_call(material.load) →
//           真实 Saturday 工具执行 → 工具结果回流 → success 收尾；
//   阶段 B：自然语言"弛豫" → tool_call(potential.relax) → EMT/LJ 真实计算 →
//           Trajectory 落盘（saturday/simulation/converged）。
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

  // 5. 回收（会话/工具/服务全部随 fiber 撤销；cordis 根 Context 无 dispose，撤插件 fiber 即可）
  await server.close()
  await handle.dispose()
  await saturdayFiber.dispose()
  await ctx.dispose?.()
  console.log('═══ 演示完成：agent loop 全程真实（工具执行、结果回流、多轮请求），仅模型侧为 mock ═══')
}

main().then(() => process.exit(0), err => {
  console.error('演示失败:', err)
  process.exit(1)
})
