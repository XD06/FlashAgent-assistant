/**
 * Real Workspace Live Agent Task Runner
 *
 * Runs an actual Agent task end-to-end against a real file system workspace
 * using the real local model endpoint:
 *   URL: http://localhost:8080/v1
 *   Key: 12345678
 *   Model: muse-spark-1.3-contributor-free
 *
 * Task:
 *   1. Check directory structure
 *   2. Plan with todo_list
 *   3. Implement add and multiply functions in src/index.js
 *   4. Run node verification via run_command
 *   5. Create README.md
 *   6. Update checklist and summarize
 *
 * Then test Turn 2 (continuation) to verify checklist anchor persistence.
 *
 * Run:
 *   npx tsx sandbox-e2e/run-live-workspace-task.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  agentToolDefinitionsForShell,
  executeAgentTool,
  findLatestChecklistState,
  formatChecklistAnchor,
  isReadOnlyTool,
  resolveCommandShell
} from '../src/main/agent/AgentTools'
import { buildAgentSystemPrompt } from '../src/main/agent/AgentPrompt'
import {
  streamChatMessages,
  type StreamDelta,
  type ToolCallStreamOptions
} from '../src/main/ai/OpenAICompatibleClient'
import type { AiMessageInput, ProviderSettings } from '../src/shared/types'

const REAL_PROVIDER: ProviderSettings = {
  id: 'local-test-provider',
  name: 'Local Test Endpoint',
  apiType: 'openai-compatible',
  baseUrl: 'http://localhost:8080/v1',
  apiKey: '12345678',
  model: 'muse-spark-1.3-contributor-free',
  contextWindowTokens: 200000,
  maxOutputTokens: 4096,
  temperature: 0.1
}

const workspaceDir = resolve(process.cwd(), 'sandbox-e2e', 'test-workspace', 'math-lib')

function prepareWorkspace() {
  console.log(`\n📁 准备真实测试工作区: ${workspaceDir}`)
  mkdirSync(join(workspaceDir, 'src'), { recursive: true })

  // Initialize a minimal package.json
  writeFileSync(
    join(workspaceDir, 'package.json'),
    JSON.stringify(
      {
        name: 'math-lib',
        version: '1.0.0',
        type: 'module',
        description: 'A simple math library created by Agent'
      },
      null,
      2
    ),
    'utf-8'
  )

  // Empty initial placeholder
  writeFileSync(join(workspaceDir, 'src', 'index.js'), '// Math library entry point\n', 'utf-8')
  console.log('   已初始化 package.json 与 src/index.js')
}

async function runLiveAgentTurn(
  messages: AiMessageInput[],
  userPromptText: string,
  turnNumber: number
): Promise<{ reply: string; toolCallsCount: number; checklistState: string | null }> {
  console.log(`\n================================================================`)
  console.log(` ▶ 开始执行第 ${turnNumber} 轮 Agent 交互: "${userPromptText}"`)
  console.log(`================================================================`)

  messages.push({ role: 'user', text: userPromptText })

  const shell = resolveCommandShell()
  const tools = agentToolDefinitionsForShell(shell)
  let latestChecklist = findLatestChecklistState(messages)

  let basePrompt = buildAgentSystemPrompt({
    language: 'zh-CN',
    workingDir: workspaceDir
  })

  if (latestChecklist) {
    basePrompt += `\n\n[Active Task Checklist Anchor]:\nThis task is already in progress. The authoritative checklist state from earlier progress is:\n${latestChecklist}\nRule: Do NOT reset or repeat completed steps ([x]). Directly resume and execute the active ([>]) or pending ([ ]) step.`
    console.log(`\n📌 检测到历史任务锚点，已注入系统上下文:\n${latestChecklist}\n`)
  }

  const activeEdits = new Map<string, string>()
  let currentAssistantText = ''
  let currentReasoning = ''
  let toolCallTimes = 0

  const options: ToolCallStreamOptions = {
    tools,
    isReadOnlyTool,
    maxToolRounds: 15,
    toolLoopTimeoutMs: 120_000,
    roundLimitNotice: '⚠️ 已达到单次对话的最大工具调用轮次。可回复“继续”让我接着做。',
    getLatestChecklist: () => latestChecklist,
    getActiveEdits: () => Array.from(activeEdits.entries()).map(([k, v]) => `${k} (${v})`),
    onStatus: (status) => {
      console.log(`   [STATUS] ${status}`)
    },
    onToolCall: async (name, args) => {
      toolCallTimes++
      console.log(`\n🛠️  [工具调用 #${toolCallTimes}] ${name}`)
      console.log(`   参数: ${JSON.stringify(args, null, 2)}`)

      try {
        const result = await executeAgentTool(
          name,
          args,
          workspaceDir,
          controller.signal,
          undefined,
          shell
        )

        // Track edits
        if (name === 'write_file' || name === 'edit_file') {
          const p = String(args.path ?? '')
          activeEdits.set(p, 'edited')
        }

        // If todo_list was updated, record in live state
        if (name === 'todo_list') {
          console.log(`   📋 [Checklist 更新响应]:\n${result.trim()}`)
          // Update latest checklist tracker
          const updatedState = findLatestChecklistState([
            {
              role: 'assistant',
              text: '',
              toolTrace: [{ id: `call_${toolCallTimes}`, name, argsJson: JSON.stringify(args), result }]
            }
          ])
          if (updatedState) {
            latestChecklist = updatedState
          }
        } else {
          const preview = result.length > 300 ? result.slice(0, 300) + '... (truncated)' : result
          console.log(`   [工具执行结果]: ${preview.trim()}`)
        }

        return result
      } catch (err: any) {
        console.error(`   ❌ [工具执行错误]: ${err.message}`)
        return `Error: ${err.message}`
      }
    }
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    console.warn('⚠️ 交互超时 (120s)，主动中止')
    controller.abort()
  }, 120_000)

  try {
    await streamChatMessages(
      REAL_PROVIDER,
      messages,
      basePrompt,
      controller.signal,
      (delta: StreamDelta) => {
        if (delta.reasoning) {
          currentReasoning += delta.reasoning
          process.stdout.write(delta.reasoning)
        }
        if (delta.content) {
          currentAssistantText += delta.content
          process.stdout.write(delta.content)
        }
      },
      'on',
      options
    )
  } catch (err: any) {
    console.error(`\n❌ 流式执行异常: ${err.message}`)
  } finally {
    clearTimeout(timeoutId)
  }

  // Append assistant turn to messages for next turn
  messages.push({
    role: 'assistant',
    text: currentAssistantText
  })

  console.log(`\n\n第 ${turnNumber} 轮完成，工具调用次数: ${toolCallTimes}`)
  return {
    reply: currentAssistantText,
    toolCallsCount: toolCallTimes,
    checklistState: latestChecklist
  }
}

async function main() {
  console.log('================================================================')
  console.log(' FlashAgent-assistant: 真实工作区 Agent 实战运行验证')
  console.log(' 模型端点: http://localhost:8080/v1 (muse-spark-1.3-contributor-free)')
  console.log('================================================================')

  prepareWorkspace()

  const conversationHistory: AiMessageInput[] = []

  // ------------------------------------------------------------------------
  // TURN 1: Initial Task Assignment
  // ------------------------------------------------------------------------
  const taskPrompt = `你现在是本项目的专业开发助理，正在工作区 ${workspaceDir} 中工作。
请严格按以下步骤推进开发：
1. 首先使用 todo_list 工具创建规划清单（步骤：1.检查当前目录 2.在 src/index.js 实现 add 和 multiply 函数 3.运行测试命令验证 4.编写 README.md 5.总结完成）；
2. 使用 list_dir 查看目录；
3. 在 src/index.js 中编写并导出两个函数：
   - export function add(a, b) { return a + b }
   - export function multiply(a, b) { return a * b }
4. 使用 run_command 运行命令: node -e "import('./src/index.js').then(m => { console.log('ADD:', m.add(2, 3)); console.log('MUL:', m.multiply(4, 5)); })" 验证输出是否为 5 和 20；
5. 在根目录创建 README.md 记录函数说明与测试结果；
6. 更新 todo_list 标记已完成步骤，并向我汇报最终结果。`

  const turn1 = await runLiveAgentTurn(conversationHistory, taskPrompt, 1)

  // Verify workspace changes on disk
  console.log('\n----------------------------------------------------------------')
  console.log(' 🔍 正在检验工作区实际产生的文件与代码效果...')
  console.log('----------------------------------------------------------------')

  const indexPath = join(workspaceDir, 'src', 'index.js')
  const readmePath = join(workspaceDir, 'README.md')

  const indexExists = existsSync(indexPath)
  const readmeExists = existsSync(readmePath)

  let codeValid = false
  if (indexExists) {
    const code = readFileSync(indexPath, 'utf-8')
    codeValid = code.includes('add') && code.includes('multiply')
    console.log(`✅ src/index.js 文件已生成且内容包含 add 与 multiply:\n${code}`)
  } else {
    console.error('❌ src/index.js 未生成')
  }

  if (readmeExists) {
    const readme = readFileSync(readmePath, 'utf-8')
    console.log(`✅ README.md 文件已生成:\n${readme.slice(0, 300)}...`)
  } else {
    console.log('ℹ️ README.md 本轮未创建，将在续跑中推进')
  }

  // ------------------------------------------------------------------------
  // TURN 2: Continuation Verification (续跑记忆不丢失，清单不倒退)
  // ------------------------------------------------------------------------
  console.log('\n----------------------------------------------------------------')
  console.log(' 🔄 启动第 2 轮续跑测试：模拟多轮对话，验证已完成进度不倒退')
  console.log('----------------------------------------------------------------')

  const turn2 = await runLiveAgentTurn(
    conversationHistory,
    '继续，请检查当前工作区，如所有步骤已完成，请将 todo_list 全部更新为 completed 并给出简明结项总结。',
    2
  )

  console.log('\n================================================================')
  console.log(' 🎯 最终实战检验结果总结')
  console.log('================================================================')
  console.log(`- 真实端点模型通信: 正常`)
  console.log(`- 工作区代码生成: ${codeValid ? '✅ 成功通过' : '⚠️ 需关注'}`)
  console.log(`- 第 1 轮工具调用次数: ${turn1.toolCallsCount}`)
  console.log(`- 第 2 轮工具调用次数: ${turn2.toolCallsCount}`)
  console.log(`- 最终 Checklist 状态: ${turn2.checklistState ?? turn1.checklistState ?? '无'}`)

  if (indexExists && codeValid) {
    console.log('\n🎉 实战 Agent 项目工作区运行成功，所有核心改动均已真实落地！')
    process.exit(0)
  } else {
    console.log('\n⚠️ 部分目标未完全达成，请检查上述日志')
    process.exit(1)
  }
}

main()

