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
import { pathToFileURL } from 'node:url'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { streamChatMessages, type ProviderFetch } from '../src/main/ai/OpenAICompatibleClient'
import { agentToolDefinitionsForShell, executeAgentTool, resolveCommandShell, shellSyntaxLabel } from '../src/main/agent/AgentTools'
import { buildAgentSystemPrompt, type AgentPromptVariant } from '../src/main/agent/AgentPrompt'
import { buildAssistantSystemPrompt } from '../src/shared/actions'
import type { ContextMeasurement } from '../src/shared/contextMeter'
import type { AppSettings, ProviderSettings } from '../src/shared/types'

interface NumericRequestMetric extends ContextMeasurement {
  modelRequestIndex: number
  reportedPromptTokens: number | null
  reportedCompletionTokens: number | null
}

type ScenarioId = 'baseline' | 'cjk' | 'large-output' | 'image' | 'repair' | 'public-regression'

interface E2eScenario {
  id: ScenarioId
  markerName: string
  taskLines: string[]
  requiredToolNames?: string[]
  observationToolNames?: string[]
  imageDataUrl?: string
  largeOutputFixtureName?: string
  repairFixture?: boolean
  publicRegressionFixture?: boolean
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
  requiredToolCallsSatisfied: boolean
  repairFixturePassed: boolean
  publicRegressionFixturePassed: boolean
  observedOptionalToolCalls: string[]
  intermediateVisibleTextCount: number
  promptVariant: AgentPromptVariant
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
    observationToolNames: ['list_dir', 'search_files'],
    taskLines: [
      'Work only in the provided isolated repository.',
      'Inspect package metadata and the JavaScript entry module.',
      'Create AGENT_CONTEXT_E2E.md in the repository root with one short factual line.',
      'Run a Node syntax check for the entry module.',
      'Do not install dependencies, do not change existing source or configuration, and use tools for every action.',
      'When done, give a concise evidence-based summary.'
    ],
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
  },
  'large-output': {
    id: 'large-output',
    markerName: 'AGENT_CONTEXT_E2E_LARGE_OUTPUT.md',
    largeOutputFixtureName: 'AGENT_CONTEXT_E2E_LARGE_OUTPUT.txt',
    requiredToolNames: ['read_file'],
    taskLines: [
      'Work only in the provided isolated repository.',
      'First use read_file to inspect AGENT_CONTEXT_E2E_LARGE_OUTPUT.txt. Do not use a shell command to read that file.',
      'Then inspect package metadata and the JavaScript entry module.',
      'Create AGENT_CONTEXT_E2E_LARGE_OUTPUT.md in the repository root with one short factual line.',
      'Run a Node syntax check for the entry module.',
      'Do not install dependencies or change existing source or configuration. Use tools for every action.',
      'When done, give a concise evidence-based summary.'
    ],
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
  },
  repair: {
    id: 'repair',
    markerName: 'AGENT_PROMPT_REPAIR_UNUSED.md',
    repairFixture: true,
    requiredToolNames: ['read_file', 'edit_file', 'run_command'],
    observationToolNames: ['list_dir', 'search_files', 'write_file'],
    taskLines: [
      'Work only in the provided isolated repository.',
      'Fix only AGENT_PROMPT_FIXTURE.mjs so AGENT_PROMPT_FIXTURE.test.mjs passes.',
      'Before editing, inspect both fixture files with read_file. Do not edit the test file.',
      'Use edit_file, not write_file or a shell command, for the source change.',
      'Run node AGENT_PROMPT_FIXTURE.test.mjs after editing. A passing test is required completion evidence.',
      'Do not install dependencies or modify other existing source or configuration. Use tools for every action.',
      'When done, give a concise evidence-based summary.'
    ]
  },
  'public-regression': {
    id: 'public-regression',
    markerName: 'AGENT_PUBLIC_REGRESSION_UNUSED.md',
    publicRegressionFixture: true,
    taskLines: [
      'Work only in the provided isolated checkout of the public escape-string-regexp repository.',
      'A downstream regression report says escapeStringRegexp(\'foo - bar\') now returns an output that leaves the hyphen unescaped, breaking use in Unicode regular expressions.',
      'Investigate the report and fix the defect with the smallest justified change. Limit source changes to index.js; do not alter package metadata or existing tests.',
      'The repository\'s AVA dependencies are intentionally unavailable. Do not install dependencies; choose an appropriate built-in Node verification for the reported behavior.',
      'When done, give a concise evidence-based summary.'
    ]
  }
}

const cliArgs = process.argv.slice(2)
const traceEnabled = cliArgs.includes('--trace')

function readScenario(): E2eScenario {
  const requested = cliArgs.find((arg) => !arg.startsWith('--')) ?? 'baseline'
  if (requested in scenarios) return scenarios[requested as ScenarioId]
  throw new Error(`Unknown E2E scenario: ${requested}`)
}

function readPromptVariant(): AgentPromptVariant {
  const raw = cliArgs.find((arg) => arg.startsWith('--prompt='))?.slice('--prompt='.length)
  if (raw === 'baseline') return 'baseline'
  if (!raw || raw === 'focused') return raw === 'focused' ? 'focused' : 'baseline'
  throw new Error(`Unknown prompt variant: ${raw}`)
}

function trace(label: string, value: string): void {
  if (!traceEnabled) return
  console.log(`\n===== ${label} =====\n${value}`)
}

function buildLargeOutputFixture(): string {
  const line = 'This controlled fixture measures a large read_file result without retaining it in metrics.\n'
  return line.repeat(Math.ceil(24_000 / line.length))
}

async function prepareRepairFixture(): Promise<void> {
  await fs.writeFile(
    path.join(workspace, 'AGENT_PROMPT_FIXTURE.mjs'),
    `export function normalizeSlug(value) {\n  if (typeof value !== 'string') throw new TypeError('Expected a string')\n  return value.trim().toLowerCase()\n}\n`,
    'utf8'
  )
  await fs.writeFile(
    path.join(workspace, 'AGENT_PROMPT_FIXTURE.test.mjs'),
    `import assert from 'node:assert/strict'\nimport { normalizeSlug } from './AGENT_PROMPT_FIXTURE.mjs'\n\nassert.equal(normalizeSlug('  Flash   Agent  '), 'flash-agent')\nassert.equal(normalizeSlug('Already-Slug'), 'already-slug')\nconsole.log('fixture passed')\n`,
    'utf8'
  )
}

async function preparePublicRegressionFixture(): Promise<void> {
  const entryPath = path.join(workspace, 'index.js')
  const original = [
    'export default function escapeStringRegexp(string) {',
    "\tif (typeof string !== 'string') {",
    "\t\tthrow new TypeError('Expected a string');",
    '\t}',
    '',
    '\treturn string',
    "\t\t.replace(/[|\\\\{}()[\\]^$+*?.]/g, '\\\\$&')",
    "\t\t.replace(/-/g, '\\\\x2d');",
    '}',
    ''
  ].join('\n')
  const regression = original.replace(".replace(/-/g, '\\\\x2d');", ".replace(/-/g, '-');")
  if (regression === original) throw new Error('failed to inject public regression fixture')
  await fs.writeFile(entryPath, regression, 'utf8')
}

async function validatePublicRegressionFixture(): Promise<boolean> {
  const entryUrl = pathToFileURL(path.join(workspace, 'index.js')).href
  const { default: escapeStringRegexp } = await import(`${entryUrl}?agent-e2e=${Date.now()}`) as {
    default: (input: string) => string
  }
  const escaped = escapeStringRegexp('foo - bar')
  if (escaped !== 'foo \\x2d bar') return false
  new RegExp(escapeStringRegexp('-'), 'u')
  return true
}

function writeResult(result: E2eResult): Promise<void> {
  return fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

async function main(): Promise<void> {
  if (!existsSync(workspace)) throw new Error('isolated public-repository workspace is missing')
  const scenario = readScenario()
  const promptVariant = readPromptVariant()
  const markerPath = path.join(workspace, scenario.markerName)
  await fs.rm(markerPath, { force: true })
  if (scenario.largeOutputFixtureName) {
    await fs.writeFile(path.join(workspace, scenario.largeOutputFixtureName), buildLargeOutputFixture(), 'utf8')
  }
  if (scenario.repairFixture) await prepareRepairFixture()
  if (scenario.publicRegressionFixture) await preparePublicRegressionFixture()
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
  const observedOptionalToolCalls: string[] = []
  let syntaxCheckSucceeded = false
  let repairFixturePassed = false
  let publicRegressionFixturePassed = false
  let intermediateVisibleTextCount = 0
  let responseText = ''
  let reasoningText = ''
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 180_000)
  const started = Date.now()

  try {
    const systemPrompt = buildAgentSystemPrompt(
      {
        baseSystemPrompt: buildAssistantSystemPrompt({ language: settings.language }),
        workingDir: workspace,
        shellLabel: shellSyntaxLabel(resolveCommandShell(settings.commandShell))
      },
      promptVariant
    )
    trace('PROMPT VARIANT', promptVariant)
    trace('SYSTEM PROMPT', systemPrompt)
    trace('USER TASK', scenario.taskLines.join('\n'))

    await streamChatMessages(
      provider,
      [{
        role: 'user',
        text: scenario.taskLines.join(' '),
        ...(scenario.imageDataUrl ? { images: [scenario.imageDataUrl] } : {})
      }],
      systemPrompt,
      controller.signal,
      (delta) => {
        if (delta.content) responseText += delta.content
        if (delta.reasoning) reasoningText += delta.reasoning
      },
      'off',
      {
        fetcher: providerFetch,
        tools: agentToolDefinitionsForShell(settings.commandShell),
        maxToolRounds: 12,
        toolLoopTimeoutMs: 180_000,
        onContextMeasured: (measurement) => {
          requests.push({ ...measurement, reportedPromptTokens: null, reportedCompletionTokens: null })
          trace('REQUEST CONTEXT', JSON.stringify({ modelRequestIndex: requests.length - 1, ...measurement }, null, 2))
        },
        shadowBudget: { contextWindowTokens: settings.contextWindowTokens },
        onUsage: (usage) => {
          const target = requests[requests.length - 1]
          if (target) {
            target.reportedPromptTokens = usage.promptTokens
            target.reportedCompletionTokens = usage.completionTokens
          }
          trace('REQUEST USAGE', JSON.stringify(usage, null, 2))
        },
        onToolCall: async (name, args) => {
          if (responseText || reasoningText) {
            trace('MODEL RESPONSE', responseText || '(tool call without visible text)')
            if (reasoningText) trace('MODEL REASONING', reasoningText)
            if (responseText.trim()) intermediateVisibleTextCount += 1
            responseText = ''
            reasoningText = ''
          }
          toolCallCount += 1
          toolNames.add(name)
          if (scenario.observationToolNames?.includes(name)) observedOptionalToolCalls.push(name)
          trace('TOOL CALL', `${name}\n${JSON.stringify(args, null, 2)}`)
          try {
            const output = await executeAgentTool(name, args, workspace, controller.signal, undefined, settings.commandShell)
            trace('TOOL RESULT', output)
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
            if (
              scenario.repairFixture &&
              name === 'run_command' &&
              typeof args.command === 'string' &&
              args.command.includes('AGENT_PROMPT_FIXTURE.test.mjs') &&
              !output.startsWith('Exit code ')
            ) {
              repairFixturePassed = true
            }
            return output
          } catch (error) {
            trace('TOOL ERROR', error instanceof Error ? error.message : String(error))
            toolErrorCount += 1
            return '[Tool execution failed. Inspect the request and choose a safe alternative.]'
          }
        }
      }
    )
  } finally {
    clearTimeout(timeout)
  }
  if (scenario.publicRegressionFixture) {
    try {
      publicRegressionFixturePassed = await validatePublicRegressionFixture()
    } catch (error) {
      trace('INDEPENDENT VERIFICATION ERROR', error instanceof Error ? error.message : String(error))
    }
  }
  if (responseText || reasoningText) {
    trace('MODEL RESPONSE', responseText || '(no visible final text)')
    if (reasoningText) trace('MODEL REASONING', reasoningText)
  }

  const result: E2eResult = {
    scenario: scenario.id,
    passed:
      (scenario.repairFixture ? repairFixturePassed : scenario.publicRegressionFixture ? publicRegressionFixturePassed : existsSync(markerPath)) &&
      (scenario.repairFixture ? repairFixturePassed : scenario.publicRegressionFixture ? publicRegressionFixturePassed : syntaxCheckSucceeded) &&
      toolCallCount > 0 &&
      toolErrorCount === 0 &&
      requests.length > 0 &&
      (!scenario.repairFixture || repairFixturePassed),
    elapsedMs: Date.now() - started,
    providerReportedUsage: requests.some((request) => request.reportedPromptTokens !== null),
    modelRequestCount: requests.length,
    toolCallCount,
    toolErrorCount,
    totalToolResultChars,
    maxToolResultChars,
    requiredToolCallsSatisfied: !scenario.requiredToolNames || scenario.requiredToolNames.every((name) => toolNames.has(name)),
    repairFixturePassed,
    publicRegressionFixturePassed,
    observedOptionalToolCalls,
    intermediateVisibleTextCount,
    promptVariant,
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
    scenario: (cliArgs.find((arg) => !arg.startsWith('--')) as ScenarioId | undefined) ?? 'baseline',
    passed: false,
    elapsedMs: 0,
    providerReportedUsage: false,
    modelRequestCount: 0,
    toolCallCount: 0,
    toolErrorCount: 0,
    totalToolResultChars: 0,
    maxToolResultChars: 0,
    requiredToolCallsSatisfied: false,
    repairFixturePassed: false,
    publicRegressionFixturePassed: false,
    observedOptionalToolCalls: [],
    intermediateVisibleTextCount: 0,
    promptVariant: 'focused',
    imageSent: false,
    markerCreated: false,
    syntaxCheckSucceeded: false,
    requests: []
  }
  await writeResult(result).catch(() => undefined)
  console.error('Agent context E2E failed without recording content.')
  process.exitCode = 1
})
