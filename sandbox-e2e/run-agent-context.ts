/**
 * Real Agent context-metrics regression.
 *
 * Uses the user's locally configured provider, production streamChatMessages,
 * and production AgentTools against an ignored public-repository clone. It
 * stores only numeric/status metrics. Prompt text, model output, tool output,
 * provider settings, and credentials are never printed or written to disk.
 *
 * Run: pnpm e2e:agent-context
 */
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { streamChatMessages, type ProviderFetch } from '../src/main/ai/OpenAICompatibleClient'
import { agentToolDefinitionsForShell, executeAgentTool } from '../src/main/agent/AgentTools'
import type { ContextMeasurement } from '../src/shared/contextMeter'
import type { AppSettings, ProviderSettings } from '../src/shared/types'

interface NumericRequestMetric extends ContextMeasurement {
  modelRequestIndex: number
  reportedPromptTokens: number | null
  reportedCompletionTokens: number | null
}

type ScenarioId = 'baseline' | 'cjk' | 'large-output' | 'image'

interface E2eScenario {
  id: ScenarioId
  markerName: string
  taskLines: string[]
  systemLines: string[]
  requiredToolName?: string
  imageDataUrl?: string
  largeOutputFixtureName?: string
}

interface E2eResult {
  scenario: ScenarioId
  passed: boolean
  elapsedMs: number
  providerReportedUsage: boolean
  modelRequestCount: number
  toolCallCount: number
  toolErrorCount: number
  totalToolResultChars: number
  maxToolResultChars: number
  requiredToolCallSatisfied: boolean
  imageSent: boolean
  markerCreated: boolean
  syntaxCheckSucceeded: boolean
  requests: NumericRequestMetric[]
}

const projectRoot = process.cwd()
const workspace = path.join(projectRoot, 'sandbox-e2e', 'agent-context-workspace', 'escape-string-regexp')
const resultPath = path.join(projectRoot, 'sandbox-e2e', 'agent-context-result.json')
const settingsPaths = [
  path.join(process.env.APPDATA ?? '', 'flashagent-assistant', 'settings.json'),
  // Match appIdentity's migration behavior without creating or changing user
  // data when this standalone E2E driver runs before Electron has launched.
  path.join(process.env.APPDATA ?? '', 'selection-assistant-lite', 'settings.json')
]

// A harmless 1×1 PNG. It is only used to make the provider receive an actual
// vision payload; no image bytes are printed or persisted by this driver.
const ONE_PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wlq6WAAAAAASUVORK5CYII='

const scenarios: Record<ScenarioId, E2eScenario> = {
  baseline: {
    id: 'baseline',
    markerName: 'AGENT_CONTEXT_E2E.md',
    taskLines: [
      'Work only in the provided isolated repository.',
      'Inspect package metadata and the JavaScript entry module.',
      'Create AGENT_CONTEXT_E2E.md in the repository root with one short factual line.',
      'Run a Node syntax check for the entry module.',
      'Do not install dependencies, do not change existing source or configuration, and use tools for every action.',
      'When done, give a concise evidence-based summary.'
    ],
    systemLines: [
      'You are a precise coding agent in an isolated regression workspace.',
      'Use the provided file and command tools for all inspection and actions.',
      'Do not claim an action completed without its matching successful tool result.'
    ]
  },
  cjk: {
    id: 'cjk',
    markerName: 'AGENT_CONTEXT_E2E_CJK.md',
    taskLines: [
      '只在给定的隔离仓库中工作。',
      '检查 package 元数据和 JavaScript 入口模块。',
      '在仓库根目录创建 AGENT_CONTEXT_E2E_CJK.md，其中只写一行简短且可核实的事实。',
      '对入口模块执行 Node 语法检查。',
      '不要安装依赖，不要改动已有源码或配置；每一项检查和写入都必须通过工具完成。',
      '完成后给出简短、有证据的中文总结。'
    ],
    systemLines: [
      '你是隔离回归工作区中的精确编码 Agent。',
      '所有检查和操作都必须使用已提供的文件与命令工具。',
      '没有对应成功工具结果时，不得声称操作已完成。'
    ]
  },
  'large-output': {
    id: 'large-output',
    markerName: 'AGENT_CONTEXT_E2E_LARGE_OUTPUT.md',
    largeOutputFixtureName: 'AGENT_CONTEXT_E2E_LARGE_OUTPUT.txt',
    requiredToolName: 'read_file',
    taskLines: [
      'Work only in the provided isolated repository.',
      'First use read_file to inspect AGENT_CONTEXT_E2E_LARGE_OUTPUT.txt. Do not use a shell command to read that file.',
      'Then inspect package metadata and the JavaScript entry module.',
      'Create AGENT_CONTEXT_E2E_LARGE_OUTPUT.md in the repository root with one short factual line.',
      'Run a Node syntax check for the entry module.',
      'Do not install dependencies or change existing source or configuration. Use tools for every action.',
      'When done, give a concise evidence-based summary.'
    ],
    systemLines: [
      'You are a precise coding agent in an isolated regression workspace.',
      'Use the provided file and command tools for all inspection and actions.',
      'Do not claim an action completed without its matching successful tool result.'
    ]
  },
  image: {
    id: 'image',
    markerName: 'AGENT_CONTEXT_E2E_IMAGE.md',
    imageDataUrl: ONE_PIXEL_PNG,
    taskLines: [
      'Work only in the provided isolated repository.',
      'Treat the attached image as input to this context-accounting regression; do not infer any unstated visual detail from it.',
      'Inspect package metadata and the JavaScript entry module.',
      'Create AGENT_CONTEXT_E2E_IMAGE.md in the repository root with one short factual line.',
      'Run a Node syntax check for the entry module.',
      'Do not install dependencies or change existing source or configuration. Use tools for every action.',
      'When done, give a concise evidence-based summary.'
    ],
    systemLines: [
      'You are a precise coding agent in an isolated regression workspace.',
      'Use the provided file and command tools for all inspection and actions.',
      'Do not claim an action completed without its matching successful tool result.'
    ]
  }
}

function readScenario(): E2eScenario {
  const requested = process.argv[2] ?? 'baseline'
  if (requested in scenarios) return scenarios[requested as ScenarioId]
  throw new Error(`Unknown E2E scenario: ${requested}`)
}

function buildLargeOutputFixture(): string {
  const line = 'This controlled fixture measures a large read_file result without retaining it in metrics.\n'
  return line.repeat(Math.ceil(24_000 / line.length))
}

function writeResult(result: E2eResult): Promise<void> {
  return fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

async function main(): Promise<void> {
  if (!existsSync(workspace)) throw new Error('isolated public-repository workspace is missing')
  const scenario = readScenario()
  const markerPath = path.join(workspace, scenario.markerName)
  await fs.rm(markerPath, { force: true })
  if (scenario.largeOutputFixtureName) {
    await fs.writeFile(path.join(workspace, scenario.largeOutputFixtureName), buildLargeOutputFixture(), 'utf8')
  }
  const settingsRaw = await (async (): Promise<string> => {
    for (const candidate of settingsPaths) {
      try {
        return await fs.readFile(candidate, 'utf8')
      } catch {
        // Try the legacy location if the post-rebrand Electron migration has
        // not run on this machine yet.
      }
    }
    throw new Error('local provider settings are missing')
  })()
  const stored = JSON.parse(settingsRaw) as { settings?: AppSettings }
  const settings = stored.settings
  if (!settings?.provider) throw new Error('local provider settings are missing')
  const provider: ProviderSettings = settings.provider
  const proxyUrl = settings.proxyUrl.trim()
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
  const providerFetch: ProviderFetch = (url, init) =>
    undiciFetch(url as string, { ...(init as object), dispatcher } as never) as unknown as Promise<Response>

  const requests: NumericRequestMetric[] = []
  let toolCallCount = 0
  let toolErrorCount = 0
  let totalToolResultChars = 0
  let maxToolResultChars = 0
  const toolNames = new Set<string>()
  let syntaxCheckSucceeded = false
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 180_000)
  const started = Date.now()

  try {
    await streamChatMessages(
      provider,
      [{
        role: 'user',
        text: scenario.taskLines.join(' '),
        ...(scenario.imageDataUrl ? { images: [scenario.imageDataUrl] } : {})
      }],
      [...scenario.systemLines, `Working directory: ${workspace}`].join('\n'),
      controller.signal,
      () => {
        // Model output is intentionally not retained by this test driver.
      },
      'off',
      {
        fetcher: providerFetch,
        tools: agentToolDefinitionsForShell(settings.commandShell),
        maxToolRounds: 12,
        toolLoopTimeoutMs: 180_000,
        onContextMeasured: (measurement) => {
          requests.push({ ...measurement, reportedPromptTokens: null, reportedCompletionTokens: null })
        },
        shadowBudget: { contextWindowTokens: settings.contextWindowTokens },
        onUsage: (usage) => {
          const target = requests[requests.length - 1]
          if (target) {
            target.reportedPromptTokens = usage.promptTokens
            target.reportedCompletionTokens = usage.completionTokens
          }
        },
        onToolCall: async (name, args) => {
          toolCallCount += 1
          toolNames.add(name)
          try {
            const output = await executeAgentTool(name, args, workspace, controller.signal, undefined, settings.commandShell)
            totalToolResultChars += output.length
            maxToolResultChars = Math.max(maxToolResultChars, output.length)
            if (
              name === 'run_command' &&
              typeof args.command === 'string' &&
              args.command.includes('node --check') &&
              !output.startsWith('Exit code ')
            ) {
              syntaxCheckSucceeded = true
            }
            return output
          } catch {
            toolErrorCount += 1
            return '[Tool execution failed. Inspect the request and choose a safe alternative.]'
          }
        }
      }
    )
  } finally {
    clearTimeout(timeout)
  }

  const result: E2eResult = {
    scenario: scenario.id,
    passed:
      existsSync(markerPath) &&
      syntaxCheckSucceeded &&
      toolCallCount > 0 &&
      toolErrorCount === 0 &&
      requests.length > 0 &&
      (!scenario.requiredToolName || toolNames.has(scenario.requiredToolName)),
    elapsedMs: Date.now() - started,
    providerReportedUsage: requests.some((request) => request.reportedPromptTokens !== null),
    modelRequestCount: requests.length,
    toolCallCount,
    toolErrorCount,
    totalToolResultChars,
    maxToolResultChars,
    requiredToolCallSatisfied: !scenario.requiredToolName || toolNames.has(scenario.requiredToolName),
    imageSent: scenario.imageDataUrl !== undefined,
    markerCreated: existsSync(markerPath),
    syntaxCheckSucceeded,
    requests
  }
  await writeResult(result)
  // The console is deliberately content-free so it is safe in normal CI logs.
  console.log(JSON.stringify(result))
  if (!result.passed) process.exitCode = 1
}

main().catch(async () => {
  const result: E2eResult = {
    scenario: (process.argv[2] as ScenarioId | undefined) ?? 'baseline',
    passed: false,
    elapsedMs: 0,
    providerReportedUsage: false,
    modelRequestCount: 0,
    toolCallCount: 0,
    toolErrorCount: 0,
    totalToolResultChars: 0,
    maxToolResultChars: 0,
    requiredToolCallSatisfied: false,
    imageSent: false,
    markerCreated: false,
    syntaxCheckSucceeded: false,
    requests: []
  }
  await writeResult(result).catch(() => undefined)
  console.error('Agent context E2E failed without recording content.')
  process.exitCode = 1
})
