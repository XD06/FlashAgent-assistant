import { exec } from 'node:child_process'
import type { McpServerConfig, McpServerStatus } from '@shared/types'
import type { ToolDefinition } from '../ai/OpenAICompatibleClient'
import {
  buildMcpToolName,
  dedupeMcpToolName,
  mcpConfigKey,
  parseEnvBlock,
  sanitizeMcpCommandTokens,
  tokenizeCommand
} from './mcpUtil'

// MCP SDK is large (~hundreds of KB). Load it only when a server is actually
// connected — most installs never enable MCP and should not pay the cost at boot.
type Client = import('@modelcontextprotocol/sdk/client/index.js').Client

interface ManagedTool {
  /** Prefixed name exposed to the model (mcp__server__tool). */
  exposedName: string
  /** Original tool name on the server. */
  toolName: string
  /** Server-declared readOnlyHint annotation, when provided. */
  readOnlyHint?: boolean
  definition: ToolDefinition
}

interface ManagedServer {
  config: McpServerConfig
  configKey: string
  client: Client | null
  state: 'connecting' | 'connected' | 'error'
  error?: string
  tools: ManagedTool[]
}

const CALL_TIMEOUT_MS = 120_000

/** Close a client and reap its process tree. On Windows stdio servers run
 * behind a cmd.exe wrapper (see openClient); transport.close() only kills the
 * wrapper, orphaning the actual server (npx → node …), so take the whole tree
 * down by pid first while the parent is still alive. */
function closeClient(client: Client): void {
  const transport = client.transport as { pid?: number | null } | undefined
  const pid = typeof transport?.pid === 'number' ? transport.pid : null
  if (process.platform === 'win32' && pid !== null) {
    exec(`taskkill /pid ${pid} /t /f`, () => void client.close().catch(() => undefined))
    return
  }
  void client.close().catch(() => undefined)
}

let sdkPromise: Promise<{
  Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client
  StdioClientTransport: typeof import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport
  getDefaultEnvironment: typeof import('@modelcontextprotocol/sdk/client/stdio.js').getDefaultEnvironment
  StreamableHTTPClientTransport: typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport
  SSEClientTransport: typeof import('@modelcontextprotocol/sdk/client/sse.js').SSEClientTransport
}> | null = null

function loadMcpSdk() {
  if (!sdkPromise) {
    sdkPromise = Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      import('@modelcontextprotocol/sdk/client/sse.js')
    ]).then(([index, stdio, http, sse]) => ({
      Client: index.Client,
      StdioClientTransport: stdio.StdioClientTransport,
      getDefaultEnvironment: stdio.getDefaultEnvironment,
      StreamableHTTPClientTransport: http.StreamableHTTPClientTransport,
      SSEClientTransport: sse.SSEClientTransport
    }))
  }
  return sdkPromise
}

/** Keeps MCP client connections alive for the app lifetime, mirrors the
 * enabled servers from settings, and routes prefixed tool calls. */
export class McpManager {
  private servers = new Map<string, ManagedServer>()
  private proxyResolver?: () => Promise<string | null> | string | null | undefined

  /** Set dynamic resolver for effective proxy URL (injected from main app). */
  setProxyResolver(resolver: () => Promise<string | null> | string | null | undefined): void {
    this.proxyResolver = resolver
  }

  /** Build full child process environment for stdio MCP servers.
   * Injects proxy settings and essential OS variables stripped by SDK's default environment. */
  private async buildMcpEnvironment(configEnv?: string): Promise<Record<string, string>> {
    const sdk = await loadMcpSdk()
    const baseEnv = sdk.getDefaultEnvironment()

    // Forward critical OS variables
    const extraSysEnv: Record<string, string> = {}
    for (const key of ['COMSPEC', 'PATHEXT', 'TMP', 'TEMP', 'USERPROFILE', 'HOME', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']) {
      const val = process.env[key]
      if (val) extraSysEnv[key] = val
    }

    // Inject proxy so npx / npm / python can download packages without timing out
    const proxyEnv: Record<string, string> = {}
    try {
      const effectiveProxy = this.proxyResolver
        ? await this.proxyResolver()
        : (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || null)
      if (effectiveProxy) {
        proxyEnv.HTTP_PROXY = effectiveProxy
        proxyEnv.HTTPS_PROXY = effectiveProxy
        proxyEnv.http_proxy = effectiveProxy
        proxyEnv.https_proxy = effectiveProxy
        proxyEnv.ALL_PROXY = effectiveProxy
        proxyEnv.all_proxy = effectiveProxy
        proxyEnv.npm_config_proxy = effectiveProxy
        proxyEnv.npm_config_https_proxy = effectiveProxy
      }
    } catch {
      /* ignore proxy lookup errors during boot */
    }

    const noProxy = process.env.NO_PROXY || process.env.no_proxy
    if (noProxy) {
      proxyEnv.NO_PROXY = noProxy
      proxyEnv.no_proxy = noProxy
    }

    return {
      ...baseEnv,
      ...extraSysEnv,
      ...proxyEnv,
      ...parseEnvBlock(configEnv)
    }
  }

  /** Reconcile connections with the configured server list. */
  sync(configs: McpServerConfig[]): void {
    const wanted = new Map(configs.filter((c) => c.enabled).map((c) => [c.id, c]))
    for (const [id, entry] of this.servers) {
      const next = wanted.get(id)
      if (!next || mcpConfigKey(next) !== entry.configKey) {
        this.drop(id)
      } else if (entry.config.name !== next.name) {
        entry.config = next
        const taken = this.takenExposedNames(next.id)
        entry.tools = entry.tools.map((tool) => {
          const exposedName = dedupeMcpToolName(buildMcpToolName(next.name, tool.toolName), taken)
          taken.add(exposedName)
          return {
            ...tool,
            exposedName,
            definition: {
              ...tool.definition,
              name: exposedName,
              description: `[MCP:${next.name}] ${tool.definition.description.replace(/^\[MCP:[^\]]+\]\s*/, '')}`
            }
          }
        })
      }
    }
    for (const config of wanted.values()) {
      if (!this.servers.has(config.id)) {
        void this.connect(config)
      }
    }
  }

  /** Drop and re-establish one server connection (panel "reconnect" button). */
  reconnect(configs: McpServerConfig[], id: string): void {
    this.drop(id)
    const config = configs.find((c) => c.id === id && c.enabled)
    if (config) void this.connect(config)
  }

  /** Drop every connection and re-establish enabled ones. Needed when the
   * proxy changes: existing sockets keep using the old route. */
  reconnectAll(configs: McpServerConfig[]): void {
    for (const id of [...this.servers.keys()]) this.drop(id)
    this.sync(configs)
  }

  /** Exposed names already claimed by other servers — the namespace the next
   * tool registration must stay unique within. */
  private takenExposedNames(excludeServerId: string): Set<string> {
    const taken = new Set<string>()
    for (const [id, entry] of this.servers) {
      if (id === excludeServerId) continue
      for (const tool of entry.tools) taken.add(tool.exposedName)
    }
    return taken
  }

  private drop(id: string): void {
    const entry = this.servers.get(id)
    if (!entry) return
    this.servers.delete(id)
    if (entry.client) {
      closeClient(entry.client)
      entry.client = null
    }
  }

  private async connect(config: McpServerConfig): Promise<void> {
    const entry: ManagedServer = {
      config,
      configKey: mcpConfigKey(config),
      client: null,
      state: 'connecting',
      tools: []
    }
    this.servers.set(config.id, entry)
    const stderrBuffer: string[] = []
    let client: Client | null = null
    try {
      client = await this.openClient(config, stderrBuffer)
      // The server may have been removed/edited while we were connecting.
      if (this.servers.get(config.id) !== entry) {
        closeClient(client)
        return
      }
      // Own the client before the first await: a reconnect/delete during
      // listTools must be able to close it, and a listTools failure below must
      // not leave an orphaned server process behind.
      entry.client = client
      const listed = await client.listTools(undefined, { timeout: CALL_TIMEOUT_MS })
      if (this.servers.get(config.id) !== entry) {
        closeClient(client)
        entry.client = null
        return
      }
      const taken = this.takenExposedNames(config.id)
      entry.tools = listed.tools.map((tool) => {
        const exposedName = dedupeMcpToolName(buildMcpToolName(config.name, tool.name), taken)
        taken.add(exposedName)
        const annotations = (tool as { annotations?: { readOnlyHint?: boolean } }).annotations
        const readOnlyHint = typeof annotations?.readOnlyHint === 'boolean' ? annotations.readOnlyHint : undefined
        return {
          exposedName,
          toolName: tool.name,
          readOnlyHint,
          definition: {
            name: exposedName,
            description: `[MCP:${config.name}] ${tool.description ?? ''}`.slice(0, 800),
            parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }
          }
        }
      })
      entry.state = 'connected'
    } catch (error) {
      if (this.servers.get(config.id) !== entry) {
        // A drop/reconnect already closed (or is closing) this client.
        if (client && entry.client === client) closeClient(client)
        return
      }
      if (entry.client) {
        closeClient(entry.client)
        entry.client = null
      }
      entry.state = 'error'
      const baseErr = error instanceof Error ? error.message : String(error)
      const recentLogs = stderrBuffer.length > 0 ? stderrBuffer.slice(-2).join('; ') : ''
      entry.error = recentLogs && !baseErr.includes(recentLogs) ? `${baseErr} (${recentLogs})` : baseErr
      console.error(`[MCP:${config.name}] Connection failed: ${entry.error}`)
    }
  }

  private async openClient(config: McpServerConfig, stderrBuffer: string[]): Promise<Client> {
    const sdk = await loadMcpSdk()
    if (config.transport === 'stdio') {
      const rawTokens = tokenizeCommand(config.command ?? '')
      const { command, args } = sanitizeMcpCommandTokens(rawTokens)
      const env = await this.buildMcpEnvironment(config.env)
      const transport = new sdk.StdioClientTransport({
        command,
        args,
        env,
        stderr: 'pipe'
      })
      transport.stderr?.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim()
          if (trimmed) {
            console.log(`[MCP:${config.name}] ${trimmed}`)
            stderrBuffer.push(trimmed)
            if (stderrBuffer.length > 20) stderrBuffer.shift()
          }
        }
      })
      const client = new sdk.Client({ name: 'flashagent-assistant', version: '1.0.0' })
      await client.connect(transport, { timeout: CALL_TIMEOUT_MS })
      return client
    }
    const url = new URL(config.url ?? '')
    // Streamable HTTP is the current standard; fall back to legacy SSE.
    try {
      const client = new sdk.Client({ name: 'flashagent-assistant', version: '1.0.0' })
      await client.connect(new sdk.StreamableHTTPClientTransport(url), { timeout: CALL_TIMEOUT_MS })
      return client
    } catch {
      const client = new sdk.Client({ name: 'flashagent-assistant', version: '1.0.0' })
      await client.connect(new sdk.SSEClientTransport(url), { timeout: CALL_TIMEOUT_MS })
      return client
    }
  }

  /** Return schemas only for connected servers the caller explicitly chose to
   * inject. An empty set intentionally means no MCP schema reaches the model. */
  getToolDefinitions(injectedServerIds: ReadonlySet<string>): ToolDefinition[] {
    const defs: ToolDefinition[] = []
    for (const entry of this.servers.values()) {
      if (entry.state === 'connected' && injectedServerIds.has(entry.config.id)) {
        defs.push(...entry.tools.map((tool) => tool.definition))
      }
    }
    return defs
  }

  ownsTool(exposedName: string): boolean {
    return this.route(exposedName) !== null
  }

  getReadOnlyHint(exposedName: string): boolean | undefined {
    return this.route(exposedName)?.tool.readOnlyHint
  }

  private route(exposedName: string): { entry: ManagedServer; tool: ManagedTool } | null {
    for (const entry of this.servers.values()) {
      const tool = entry.tools.find((t) => t.exposedName === exposedName)
      if (tool) return { entry, tool }
    }
    return null
  }

  /** Human-readable "server · tool" label for approval cards. */
  describeTool(exposedName: string): string {
    const found = this.route(exposedName)
    return found ? `${found.entry.config.name} · ${found.tool.toolName}` : exposedName
  }

  async callTool(exposedName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const found = this.route(exposedName)
    if (!found?.entry.client) throw new Error(`Unknown MCP tool: ${exposedName}`)
    const result = await found.entry.client.callTool(
      { name: found.tool.toolName, arguments: args },
      undefined,
      { signal, timeout: CALL_TIMEOUT_MS }
    )
    const content = Array.isArray(result.content) ? result.content : []
    const text = content
      .map((item) => (item.type === 'text' ? item.text : `[${item.type} content]`))
      .join('\n')
      .trim()
    if (result.isError) throw new Error(text || 'MCP tool returned an error')
    return text || '(empty result)'
  }

  /** Status list for the extensions panel, covering disabled servers too. */
  getStatuses(configs: McpServerConfig[]): McpServerStatus[] {
    return configs.map((config) => {
      const entry = this.servers.get(config.id)
      if (!config.enabled || !entry) {
        return { id: config.id, name: config.name, state: 'disabled', toolNames: [] }
      }
      return {
        id: config.id,
        name: config.name,
        state: entry.state,
        error: entry.error,
        toolNames: entry.tools.map((tool) => tool.toolName)
      }
    })
  }

  closeAll(): void {
    for (const id of [...this.servers.keys()]) this.drop(id)
  }
}

export const mcpManager = new McpManager()
