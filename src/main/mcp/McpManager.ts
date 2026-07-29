import { exec } from 'node:child_process'
import type { McpServerConfig, McpServerStatus } from '@shared/types'
import type { ToolDefinition } from '../ai/OpenAICompatibleClient'
import { buildMcpToolName, mcpConfigKey, parseEnvBlock, tokenizeCommand } from './mcpUtil'

// MCP SDK is large (~hundreds of KB). Load it only when a server is actually
// connected — most installs never enable MCP and should not pay the cost at boot.
type Client = import('@modelcontextprotocol/sdk/client/index.js').Client

interface ManagedTool {
  /** Prefixed name exposed to the model (mcp__server__tool). */
  exposedName: string
  /** Original tool name on the server. */
  toolName: string
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

  /** Reconcile connections with the configured server list. */
  sync(configs: McpServerConfig[]): void {
    const wanted = new Map(configs.filter((c) => c.enabled).map((c) => [c.id, c]))
    for (const [id, entry] of this.servers) {
      const next = wanted.get(id)
      if (!next || mcpConfigKey(next) !== entry.configKey) {
        this.drop(id)
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

  private drop(id: string): void {
    const entry = this.servers.get(id)
    if (!entry) return
    this.servers.delete(id)
    if (entry.client) closeClient(entry.client)
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
    try {
      const client = await this.openClient(config)
      // The server may have been removed/edited while we were connecting.
      if (this.servers.get(config.id) !== entry) {
        closeClient(client)
        return
      }
      const listed = await client.listTools()
      entry.client = client
      entry.tools = listed.tools.map((tool) => ({
        exposedName: buildMcpToolName(config.name, tool.name),
        toolName: tool.name,
        definition: {
          name: buildMcpToolName(config.name, tool.name),
          description: `[MCP:${config.name}] ${tool.description ?? ''}`.slice(0, 800),
          parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }
        }
      }))
      entry.state = 'connected'
    } catch (error) {
      if (this.servers.get(config.id) !== entry) return
      entry.state = 'error'
      entry.error = error instanceof Error ? error.message : String(error)
    }
  }

  private async openClient(config: McpServerConfig): Promise<Client> {
    const sdk = await loadMcpSdk()
    if (config.transport === 'stdio') {
      const tokens = tokenizeCommand(config.command ?? '')
      if (!tokens.length) throw new Error('Command is empty')
      // Route through cmd on Windows so .cmd shims (npx, uvx, ...) resolve.
      const [command, args] =
        process.platform === 'win32' ? ['cmd.exe', ['/c', ...tokens]] : [tokens[0], tokens.slice(1)]
      const client = new sdk.Client({ name: 'aia-selection-assistant', version: '1.0.0' })
      await client.connect(
        new sdk.StdioClientTransport({
          command,
          args,
          env: { ...sdk.getDefaultEnvironment(), ...parseEnvBlock(config.env) },
          stderr: 'ignore'
        })
      )
      return client
    }
    const url = new URL(config.url ?? '')
    // Streamable HTTP is the current standard; fall back to legacy SSE.
    try {
      const client = new sdk.Client({ name: 'aia-selection-assistant', version: '1.0.0' })
      await client.connect(new sdk.StreamableHTTPClientTransport(url))
      return client
    } catch {
      const client = new sdk.Client({ name: 'aia-selection-assistant', version: '1.0.0' })
      await client.connect(new sdk.SSEClientTransport(url))
      return client
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = []
    for (const entry of this.servers.values()) {
      if (entry.state === 'connected') defs.push(...entry.tools.map((tool) => tool.definition))
    }
    return defs
  }

  ownsTool(exposedName: string): boolean {
    return this.route(exposedName) !== null
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
