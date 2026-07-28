import type { McpServerConfig } from '@shared/types'

// Pure helpers for the MCP manager, kept SDK-free so they are unit-testable.

/** Split a command line into tokens, honoring single/double quotes. */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3])
  }
  return tokens
}

/** Parse a "KEY=VALUE per line" block into an env record. */
export function parseEnvBlock(env?: string): Record<string, string> {
  const result: Record<string, string> = {}
  if (!env) return result
  for (const line of env.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return result
}

/** OpenAI-compatible function names only allow [a-zA-Z0-9_-]. */
function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_') || 'x'
}

/** Prefixed tool name exposed to the model: mcp__<server>__<tool>. */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeSegment(serverName)}__${sanitizeSegment(toolName)}`.slice(0, 64)
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp__')
}

/** Key covering every connection-relevant field; a change forces a reconnect. */
export function mcpConfigKey(config: McpServerConfig): string {
  return JSON.stringify([config.transport, config.command ?? '', config.env ?? '', config.url ?? '', config.enabled])
}
