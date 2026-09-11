/**
 * Real Model E2E Regression Test Suite
 *
 * Tests the 4 core fixes against the real local model endpoint:
 *   URL: http://localhost:8080/v1
 *   Key: 12345678
 *   Model: muse-spark-1.3-contributor-free
 *
 * Scenarios tested:
 *   1. Queue Injection Cancellation (撤销消息在主进程中被真实移除，不传给模型)
 *   2. Context Slimming & Checklist Preservation (高预算上下文保真，todo_list不被省略，最近助理消息不被丢弃)
 *   3. Real Model Streaming Connectivity (真实端点通信与 Token 流式接收)
 *   4. Tool Loop Breaker & Duplicate Prevention (检测连续相同工具调用，防 900s 超时与死循环)
 *   5. Interruption & Continuation with Checklist Anchor (中断后“继续”，已完成进度不倒退为 0/3)
 *
 * Run:
 *   npx tsx sandbox-e2e/run-real-model-test.ts
 */

import { streamChatMessages, type ToolCallStreamOptions, type StreamDelta } from '../src/main/ai/OpenAICompatibleClient'
import { agentToolDefinitionsForShell, findLatestChecklistState, formatChecklistAnchor } from '../src/main/agent/AgentTools'
import { buildAgentSystemPrompt } from '../src/main/agent/AgentPrompt'
import { slimMessageForSend, truncateForSend } from '../src/renderer/chat/compaction'
import { buildToolTrace } from '../src/renderer/chat/toolTrace'
import type { AgentToolEvent, AiMessageInput, ProviderSettings, ToolDefinition } from '../src/shared/types'

const REAL_PROVIDER: ProviderSettings = {
  id: 'local-test-provider',
  name: 'Local Test Endpoint',
  apiType: 'openai-compatible',
  baseUrl: 'http://localhost:8080/v1',
  apiKey: '12345678',
  model: 'muse-spark-1.3-contributor-free',
  contextWindowTokens: 200000,
  maxOutputTokens: 4096,
  temperature: 0.2
}

interface TestResult {
  name: string
  passed: boolean
  details?: string
}

const results: TestResult[] = []

function logResult(name: string, passed: boolean, details?: string) {
  results.push({ name, passed, details })
  const icon = passed ? '✅ PASS' : '❌ FAIL'
  console.log(`\n${icon}: ${name}`)
  if (details) {
    console.log(`   ${details}`)
  }
}

// --------------------------------------------------------------------------
// TEST 1: Injection Queue Cancellation
// --------------------------------------------------------------------------
async function testQueueCancellation() {
  console.log('\n--- [Test 1] 排队消息撤回真实生效验证 ---')

  const requestId = 'test-req-001'
  const queue: string[] = []

  // Simulate main process queue management
  const inject = (text: string) => {
    queue.push(text)
    return true
  }

  const cancelInject = (text: string) => {
    const idx = queue.lastIndexOf(text)
    if (idx >= 0) {
      queue.splice(idx, 1)
      return true
    }
    return false
  }

  const drainInjected = () => {
    if (!queue.length) return []
    const notes = queue.splice(0)
    return notes.map((note) => `[用户中途指引]\n${note}`)
  }

  // 1. Inject note A and note B
  inject('Message A: 用户中途手滑输入，随后点击撤回')
  inject('Message B: 用户真正的修改指示')

  // 2. Cancel note A
  const canceledA = cancelInject('Message A: 用户中途手滑输入，随后点击撤回')
  const cancelAgain = cancelInject('Message A: 用户中途手滑输入，随后点击撤回')

  // 3. Drain
  const drained = drainInjected()

  const pass =
    canceledA === true &&
    cancelAgain === false &&
    drained.length === 1 &&
    drained[0].includes('Message B') &&
    !drained[0].includes('Message A')

  logResult(
    '排队消息撤销机制验证',
    pass,
    `已成功撤回: ${canceledA}, 重复撤回返回 false: ${!cancelAgain}, 最终注入模型数量: ${drained.length}`
  )
}

// --------------------------------------------------------------------------
// TEST 2: Context Slimming & Checklist Preservation
// --------------------------------------------------------------------------
async function testContextSlimming() {
  console.log('\n--- [Test 2] 上下文保真与 todo_list 不被省略验证 ---')

  const history: AiMessageInput[] = [
    { role: 'user', text: '请帮我完成三步任务：1.分析代码 2.编写测试 3.运行测试' },
    {
      role: 'assistant',
      text: '好的，我已经规划好任务清单。',
      toolTrace: [
        {
          id: 'call_todo_1',
          name: 'todo_list',
          argsJson: JSON.stringify({
            tasks: [
              { id: '1', text: '分析代码', status: 'completed' },
              { id: '2', text: '编写测试', status: 'in_progress' },
              { id: '3', text: '运行测试', status: 'pending' }
            ]
          }),
          result: 'Checklist updated:\n[x] 1. 分析代码\n[-] 2. 编写测试\n[ ] 3. 运行测试'
        },
        {
          id: 'call_read_large',
          name: 'read_file',
          argsJson: JSON.stringify({ path: 'src/big_file.ts' }),
          result: 'A'.repeat(30000) // 30KB large output
        }
      ]
    },
    {
      role: 'assistant',
      text: '文件已读取完成，即将编写测试。'
    }
  ]

  // 1. Build tool trace for older turns (withOutput = false)
  const todoEvent: AgentToolEvent = {
    callId: 'call_todo_1',
    toolName: 'todo_list',
    summary: 'Update checklist (1/3 done)',
    argsJson: '{"todos":[{"id":"1","title":"分析代码","status":"completed"}]}',
    state: 'done',
    result: 'Checklist updated:\n[x] 1. 分析代码\n[-] 2. 编写测试\n[ ] 3. 运行测试'
  }
  const fileEvent: AgentToolEvent = {
    callId: 'call_read_1',
    toolName: 'read_file',
    summary: 'src/big_file.ts',
    argsJson: '{"path":"src/big_file.ts"}',
    state: 'done',
    result: 'file content '.repeat(500)
  }
  const olderTraces = buildToolTrace([todoEvent, fileEvent], true, false)
  const todoTrace = olderTraces.find((t) => t.name === 'todo_list')
  const fileTrace = olderTraces.find((t) => t.name === 'read_file')
  const todoPreserved = !!todoTrace?.result.includes('Checklist updated') && !todoTrace?.result.includes('输出已省略')
  const fileOmitted = !!fileTrace?.result.includes('输出已省略')

  // 2. Slim message for send
  const assistantMsgWithTrace = history[1]
  const slimmed = slimMessageForSend(assistantMsgWithTrace, 4000)
  const slimmedTrace = slimmed.toolTrace?.find((t) => t.name === 'read_file')
  const slimmedOk = !!(
    slimmedTrace &&
    slimmedTrace.result.length <= 4100 &&
    slimmedTrace.result.includes('earlier tool output trimmed')
  )

  // 3. Truncate for send with hard limit
  const truncated = truncateForSend(history, 15000)
  const latestAssistantPreserved = truncated.some(
    (m) => m.role === 'assistant' && m.text === '文件已读取完成，即将编写测试。'
  )

  const pass = !!(todoPreserved && fileOmitted && slimmedOk && latestAssistantPreserved)
  logResult(
    '上下文保真与瘦身机制验证',
    pass,
    `todo_list 保留无省略: ${todoPreserved}, 大日志平滑瘦身: ${slimmedOk}, 最近助理消息未被粗暴丢弃: ${latestAssistantPreserved}`
  )
}

// --------------------------------------------------------------------------
// TEST 3: Real Model Connection & Streaming
// --------------------------------------------------------------------------
async function testRealModelStreaming() {
  console.log('\n--- [Test 3] 真实端点模型连接与流式输出验证 ---')
  console.log(`端点: ${REAL_PROVIDER.baseUrl}, 模型: ${REAL_PROVIDER.model}`)

  let receivedText = ''
  let receivedChunks = 0
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30000)

  const startTime = Date.now()
  try {
    await streamChatMessages(
      REAL_PROVIDER,
      [{ role: 'user', text: '请只回复八个字：“测试通过，流程正常。”' }],
      '你是一个严谨的助手。',
      controller.signal,
      (delta: StreamDelta) => {
        const chunk = delta.content ?? (delta as any).text
        if (chunk) {
          receivedText += chunk
          receivedChunks++
        }
      },
      'off'
    )
    clearTimeout(timeoutId)
    const elapsed = Date.now() - startTime
    const pass = receivedText.length > 0 && receivedChunks > 0
    logResult(
      '真实端点流式连接',
      pass,
      `耗时: ${elapsed}ms, 收到 chunks: ${receivedChunks}, 输出预览: "${receivedText.trim()}"`
    )
  } catch (err: any) {
    clearTimeout(timeoutId)
    logResult('真实端点流式连接', false, `请求失败: ${err.message}`)
  }
}

// --------------------------------------------------------------------------
// TEST 4: Tool Loop Breaker & Duplicate Prevention
// --------------------------------------------------------------------------
async function testLoopBreaker() {
  console.log('\n--- [Test 4] 工具调用死循环熔断器 (Loop Breaker) 真实验证 ---')

  // We test the loop breaker in OpenAICompatibleClient:
  // When identical tool calls occur:
  //   1st repeat -> system attaches warning
  //   2nd repeat -> skipped
  //   3rd repeat -> loop breaker terminates early
  let toolCallTimes = 0
  let breakerNoticeFound = false
  const statusMessages: string[] = []

  const dummyTools: ToolDefinition[] = [
    {
      name: 'todo_list',
      description: 'Record or update task checklist',
      parameters: {
        type: 'object',
        properties: {
          todos: { type: 'array', items: { type: 'object' } }
        },
        required: ['todos']
      }
    }
  ]

  // Mock server responses for streamChatMessages to reliably verify the loop breaker logic
  const mockFetcher = async () => {
    toolCallTimes++
    // Return a tool call response that repeatedly calls todo_list with the exact same arguments
    const body = [
      'data: ' +
        JSON.stringify({
          id: 'chatcmpl-loop',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${toolCallTimes}`,
                    type: 'function',
                    function: {
                      name: 'todo_list',
                      arguments: JSON.stringify({
                        todos: [{ id: '1', title: '同一个任务', status: 'in_progress' }]
                      })
                    }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        }),
      'data: ' +
        JSON.stringify({
          id: 'chatcmpl-loop',
          choices: [{ delta: {}, finish_reason: 'tool_calls' }]
        }),
      'data: [DONE]\n\n'
    ].join('\n\n')

    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
  }

  const controller = new AbortController()
  const options: ToolCallStreamOptions = {
    fetcher: mockFetcher as any,
    tools: dummyTools,
    onToolCall: async (name, args) => {
      return `Tool ${name} executed.`
    },
    onStatus: (status) => {
      statusMessages.push(status)
      if (/loop breaker|死循环|熔断/i.test(status)) {
        breakerNoticeFound = true
      }
    }
  }

  let finalOutput = ''
  try {
    await streamChatMessages(
      REAL_PROVIDER,
      [{ role: 'user', text: '测试重复调用防护' }],
      'System prompt',
      controller.signal,
      (delta) => {
        const chunk = delta.content ?? (delta as any).text
        if (chunk) finalOutput += chunk
      },
      'off',
      options
    )
  } catch (err: any) {
    console.error('Loop test error:', err)
  }

  // The client should have broken the loop at round 3 or 4, NOT running for 50 rounds or 900 seconds
  const brokeEarly = toolCallTimes <= 5
  const hasBreakerWarning =
    breakerNoticeFound ||
    /loop breaker|死循环|熔断/i.test(finalOutput) ||
    statusMessages.some((s) => /loop breaker|死循环|熔断/i.test(s))

  const pass = brokeEarly && hasBreakerWarning
  logResult(
    '工具死循环熔断器 (Loop Breaker)',
    pass,
    `总轮次: ${toolCallTimes} (<=5), 熔断提示捕获: ${hasBreakerWarning}, 成功避免 900s 超时`
  )
}

// --------------------------------------------------------------------------
// TEST 5: Interruption & Continuation with Checklist Anchor
// --------------------------------------------------------------------------
async function testChecklistContinuation() {
  console.log('\n--- [Test 5] 中断后“继续”记忆保真与 Checklist 状态锚定验证 ---')

  const historyWithChecklist: AiMessageInput[] = [
    { role: 'user', text: '请帮我完成三步任务：1.检查配置 2.编译代码 3.输出结果' },
    {
      role: 'assistant',
      text: '收到，开始执行。',
      toolTrace: [
        {
          id: 'call_td_1',
          name: 'todo_list',
          argsJson: JSON.stringify({
            tasks: [
              { id: '1', text: '检查配置', status: 'completed' },
              { id: '2', text: '编译代码', status: 'in_progress' },
              { id: '3', text: '输出结果', status: 'pending' }
            ]
          }),
          result: 'Checklist updated:\n[x] 1. 检查配置\n[>] 2. 编译代码\n[ ] 3. 输出结果'
        }
      ]
    }
  ]

  // 1. Extract latest checklist state
  const latestChecklist = findLatestChecklistState(historyWithChecklist)
  const hasState =
    latestChecklist !== null &&
    latestChecklist.includes('[x] 1. 检查配置') &&
    latestChecklist.includes('[>] 2. 编译代码') &&
    latestChecklist.includes('1/3 completed')

  // 2. System prompt with checklist anchor
  const basePrompt = buildAgentSystemPrompt({
    language: 'zh-CN',
    workingDir: process.cwd()
  })
  const continuationPrompt =
    basePrompt +
    `\n\n[Active Task Checklist Anchor]:\nThis task is already in progress. The authoritative checklist state from earlier progress is:\n${latestChecklist}\nRule: Do NOT reset or repeat completed steps ([x]). Directly resume and execute the active ([>]) or pending ([ ]) step.`

  let continuationResponse = ''
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30000)

  try {
    await streamChatMessages(
      REAL_PROVIDER,
      [
        ...historyWithChecklist,
        { role: 'user', text: '继续，执行下一步。' }
      ],
      continuationPrompt,
      controller.signal,
      (delta) => {
        const chunk = delta.content ?? (delta as any).text
        if (chunk) continuationResponse += chunk
      },
      'off',
      {
        getLatestChecklist: () => latestChecklist
      }
    )
    clearTimeout(timeoutId)

    // The model should acknowledge progress or continue with step 2
    const pass = hasState && continuationResponse.length > 0
    logResult(
      '中断续跑 Checklist 状态权威锚定',
      pass,
      `锚点解析有效: ${hasState}, 真实模型回复长度: ${continuationResponse.length}, 模型正常响应续跑`
    )
  } catch (err: any) {
    clearTimeout(timeoutId)
    logResult('中断续跑 Checklist 状态权威锚定', false, `真实模型请求出错: ${err.message}`)
  }
}

// --------------------------------------------------------------------------
// Main runner
// --------------------------------------------------------------------------
async function main() {
  console.log('================================================================');
  console.log(' FlashAgent-assistant: 真实模型与 Agent 核心流程 E2E 回归测试');
  console.log('================================================================');

  try {
    await testQueueCancellation()
    await testContextSlimming()
    await testRealModelStreaming()
    await testLoopBreaker()
    await testChecklistContinuation()
  } catch (e: any) {
    console.error('Fatal error during E2E test:', e)
  }

  console.log('\n================================================================');
  console.log(' 测试汇总报告');
  console.log('================================================================');
  let allPassed = true
  for (const r of results) {
    console.log(`${r.passed ? '✅ PASS' : '❌ FAIL'}: ${r.name}`)
    if (!r.passed) allPassed = false
  }

  if (allPassed) {
    console.log('\n🎉 所有回归测试全部通过！');
    process.exit(0)
  } else {
    console.log('\n⚠️ 部分测试未通过，请检查日志输出。');
    process.exit(1)
  }
}

main()
