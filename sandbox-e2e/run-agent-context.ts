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

interface E2eResult {
  passed: boolean
  elapsedMs: number
  providerReportedUsage: boolean
  modelRequestCount: number
  toolCallCount: number
  toolErrorCount: number
  markerCreated: boolean
  syntaxCheckSucceeded: boolean
  requests: NumericRequestMetric[]
}

const projectRoot = process.cwd()
const workspace = path.join(projectRoot, 'sandbox-e2e', 'agent-context-workspace', 'escape-string-regexp')
const markerPath = path.join(workspace, 'AGENT_CONTEXT_E2E.md')
const resultPath = path.join(projectRoot, 'sandbox-e2e', 'agent-context-result.json')
const settingsPaths = [
  path.join(process.env.APPDATA ?? '', 'flashagent-assistant', 'settings.json'),
  // Match appIdentity's migration behavior without creating or changing user
  // data when this standalone E2E driver runs before Electron has launched.
  path.join(process.env.APPDATA ?? '', 'selection-assistant-lite', 'settings.json')
]

function writeResult(result: E2eResult): Promise<void> {
  return fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

async function main(): Promise<void> {
  if (!existsSync(workspace)) throw new Error('isolated public-repository workspace is missing')
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
  let syntaxCheckSucceeded = false
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 180_000)
  const started = Date.now()

  try {
    await streamChatMessages(
      provider,
      [{
        role: 'user',
        text: [
          'Work only in the provided isolated repository.',
          'Inspect package metadata and the JavaScript entry module.',
          'Create AGENT_CONTEXT_E2E.md in the repository root with one short factual line.',
          'Run a Node syntax check for the entry module.',
          'Do not install dependencies, do not change existing source or configuration, and use tools for every action.',
          'When done, give a concise evidence-based summary.'
        ].join(' ')
      }],
      [
        'You are a precise coding agent in an isolated regression workspace.',
        'Use the provided file and command tools for all inspection and actions.',
        'Do not claim an action completed without its matching successful tool result.',
        `Working directory: ${workspace}`
      ].join('\n'),
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
        onUsage: (usage) => {
          const target = requests[requests.length - 1]
          if (target) {
            target.reportedPromptTokens = usage.promptTokens
            target.reportedCompletionTokens = usage.completionTokens
          }
        },
        onToolCall: async (name, args) => {
          toolCallCount += 1
          try {
            const output = await executeAgentTool(name, args, workspace, controller.signal, undefined, settings.commandShell)
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
    passed: existsSync(markerPath) && syntaxCheckSucceeded && toolCallCount > 0 && toolErrorCount === 0 && requests.length > 0,
    elapsedMs: Date.now() - started,
    providerReportedUsage: requests.some((request) => request.reportedPromptTokens !== null),
    modelRequestCount: requests.length,
    toolCallCount,
    toolErrorCount,
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
    passed: false,
    elapsedMs: 0,
    providerReportedUsage: false,
    modelRequestCount: 0,
    toolCallCount: 0,
    toolErrorCount: 0,
    markerCreated: false,
    syntaxCheckSucceeded: false,
    requests: []
  }
  await writeResult(result).catch(() => undefined)
  console.error('Agent context E2E failed without recording content.')
  process.exitCode = 1
})
