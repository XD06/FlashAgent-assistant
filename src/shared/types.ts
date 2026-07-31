export type TriggerMode = 'selected' | 'shortcut'
export type FilterMode = 'default' | 'whitelist' | 'blacklist'
export type ActionType = 'copy' | 'search' | 'prompt' | 'speak'
export type AppLanguage = 'zh-CN' | 'en'
export type ThemeMode = 'system' | 'light' | 'dark'
export type ProviderApiType = 'openai' | 'anthropic'
/** 'on' lets the model use its default; other values request explicit reasoning control. */
export type ReasoningMode = 'on' | 'off' | 'low' | 'medium' | 'high'

export interface ProviderSettings {
  apiType: ProviderApiType
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
}

export interface ProviderTemplate {
  id: string
  name: string
  provider: ProviderSettings
}

export interface ShortcutSettings {
  toggleAssistant: string
  processSelection: string
  captureScreen: string
  chat: string
}

export type McpTransport = 'stdio' | 'http'

/** One configured MCP server. stdio spawns a local process; http connects to
 * a remote endpoint (Streamable HTTP with SSE fallback). */
export interface McpServerConfig {
  id: string
  name: string
  transport: McpTransport
  /** stdio: full command line, e.g. "npx -y @modelcontextprotocol/server-everything". */
  command?: string
  /** stdio: extra environment variables, one KEY=VALUE per line. */
  env?: string
  /** http: server URL. */
  url?: string
  enabled: boolean
}

/** Connection status snapshot for the extensions panel. */
export interface McpServerStatus {
  id: string
  name: string
  state: 'connecting' | 'connected' | 'error' | 'disabled'
  error?: string
  toolNames: string[]
}

/** A skill discovered under userData/skills/<dir>/SKILL.md, or a linked
 * external folder (reused in place, not copied). */
export interface SkillInfo {
  id: string
  name: string
  description: string
  file: string
  enabled: boolean
  /** True when the skill lives outside the skills dir (linked folder). */
  linked?: boolean
}

export interface ActionItem {
  id: string
  name: string
  enabled: boolean
  icon: string
  type: ActionType
  promptTemplate?: string
  searchUrlTemplate?: string
  /** Provider template to use for this action. Empty/undefined = follow the active provider. */
  providerTemplateId?: string
  /** Override the provider's model for this action. Empty/undefined = provider default. */
  model?: string
  /** Reasoning behavior for this action. Defaults to 'on' (model default). */
  reasoning?: ReasoningMode
  /** Whether web search is enabled for this action. Undefined = follow global setting. */
  webSearch?: boolean
  /** Optional global shortcut that opens a type-in window for this action. */
  shortcut?: string
}

export interface AppSettings {
  language: AppLanguage
  theme: ThemeMode
  enabled: boolean
  triggerMode: TriggerMode
  compactToolbar: boolean
  showToolbarAppIcon: boolean
  followToolbar: boolean
  rememberWindowSize: boolean
  autoClose: boolean
  autoPin: boolean
  actionWindowWidth: number
  actionWindowHeight: number
  chatWindowWidth?: number
  chatWindowHeight?: number
  fontFamily: string
  fontSize: number
  autoLaunch: boolean
  filterMode: FilterMode
  filterList: string[]
  provider: ProviderSettings
  providerTemplates: ProviderTemplate[]
  activeProviderTemplateId: string
  webSearchEnabled: boolean
  /** Manual proxy URL (http/https). Empty = follow system proxy, else direct. */
  proxyUrl: string
  /** Model used to compress long chat history. Empty = current chat model. */
  compressModel: string
  /** Chat context attention budget in tokens; compression triggers at 95%.
   * Set to match the context window of the model in use. */
  contextWindowTokens: number
  /** Model used for screenshot AI vision. Empty = current chat model. */
  visionModel: string
  /** Full-access mode: agent tools run without per-call approval; dangerous
   * commands still pause for confirmation and forbidden ones are blocked. */
  agentFullAccess: boolean
  shortcuts: ShortcutSettings
  actions: ActionItem[]
  mcpServers: McpServerConfig[]
  /** Skills the user switched off; newly discovered skills default to on. */
  disabledSkills: string[]
  /** External folders reused as skills in place (each contains a SKILL.md). */
  linkedSkillDirs: string[]
}

export interface SelectedTextPayload {
  text: string
  programName?: string
  isFullscreen?: boolean
}

export interface ActionPayload {
  action: ActionItem
  selectedText: string
  isFullscreen?: boolean
  /** 'selection' runs immediately on selectedText; 'input' opens a type-in box first. */
  mode?: 'selection' | 'input'
  /** Optional image data URLs (e.g. screenshot vision) attached to the first user turn. */
  images?: string[]
}

/** One settled tool call from an earlier turn, replayed cross-turn. Kept
 * embedded in its assistant AiMessageInput (instead of separate messages)
 * so truncation and merging can never split a call from its result — the
 * protocol client expands the trace into native tool-call/tool-result
 * messages per API type. */
export interface ToolTraceEntry {
  /** Renderer-side call id — stable and unique across requests (provider
   * ids like "call_0" can collide between separate model requests). */
  id: string
  name: string
  /** Full arguments JSON as executed (bulk string values elided at source,
   * JSON stays valid). */
  argsJson: string
  /** Result text with the `[tool: … → status]` identity first line — capped
   * output, error message, or a rejection/omission note. */
  result: string
}

export interface AiMessageInput {
  role: 'user' | 'assistant'
  text: string
  images?: string[]
  /** Assistant only: tool calls that actually executed in that turn. The
   * protocol client replays them as native tool messages (grounded history
   * that looks like real tool use, not narration). */
  toolTrace?: ToolTraceEntry[]
}

export interface AiStreamRequest {
  requestId: string
  prompt?: string
  messages?: AiMessageInput[]
  systemPrompt?: string
  /** Resolve the provider from this template instead of the active one. */
  providerTemplateId?: string
  /** Override the provider's model for this request. */
  model?: string
  /** Force web search regardless of the model's decision. */
  forceSearch?: boolean
  /** Reasoning behavior for this request. Defaults to 'on' (model default). */
  reasoning?: ReasoningMode
  /** Enable the local mini-agent tools (file read/write/edit, shell commands). */
  agentMode?: boolean
  /** Base directory for relative paths and command cwd in agent mode. */
  workingDir?: string
  /** Inject long-term memory (global memory.md + workspace AGENTS.md). */
  useMemory?: boolean
  /** Include chat-window extensions: enabled MCP tools and the skills list. */
  useExtensions?: boolean
}

export type AgentToolState = 'pending-approval' | 'running' | 'done' | 'error' | 'rejected' | 'reverted'

/** A tool invocation surfaced to the renderer as part of the AI stream. */
export interface AgentToolEvent {
  callId: string
  toolName: string
  /** Short human-readable summary of the arguments (path, command, ...). */
  summary: string
  /** Full arguments JSON (bulk string values elided) — persisted so later
   * sends can replay the call natively via ToolTraceEntry. */
  argsJson?: string
  state: AgentToolState
  /** Truncated result or error text once the call finished. */
  result?: string
  /** For run_command: rolling live output while the command is running. */
  liveOutput?: string
  /** For write/edit: proposed old/new content so the UI can render a diff. */
  oldText?: string
  newText?: string
}

export interface AiChunkPayload {
  requestId: string
  /** 'injected' confirms a queued user note was delivered into the running
   * tool loop — `text` carries the note verbatim. */
  type: 'delta' | 'done' | 'error' | 'status' | 'reasoning' | 'tool' | 'injected' | 'usage'
  text?: string
  reasoning?: string
  error?: string
  tool?: AgentToolEvent
  /** Real token usage reported by the provider for the latest model request
   * — promptTokens is the actual size of the context that was sent. */
  usage?: { promptTokens: number; completionTokens: number }
}

export type SettingsPatch = Partial<Omit<AppSettings, 'provider' | 'shortcuts'>> & {
  provider?: Partial<ProviderSettings>
  shortcuts?: Partial<ShortcutSettings>
}
