import type { McpServerConfig } from '@shared/types'
import { assessCommandRisk, isForbiddenCommand, type CommandRisk } from '../agent/AgentTools'

// Pure helpers for the MCP manager, kept SDK-free so they are unit-testable.

/** Destructive MCP tool names that are considered dangerous (e.g. file deletions, dropping databases, killing processes). */
const DANGEROUS_MCP_TOOL_PATTERNS: RegExp[] = [
  /(?:^|[_-])(?:delete|remove|unlink)[-_]?(?:file|dir|directory|path|folder)s?(?:[_-]|$)/i,
  /(?:^|[_-])(?:drop|truncate)[-_]?(?:table|database|db|schema|collection)s?(?:[_-]|$)/i,
  /(?:^|[_-])(?:kill|terminate|stop)[-_]?(?:process|job|task)s?(?:[_-]|$)/i,
  /(?:^|[_-])(?:rmdir|purge[-_]?directory)(?:[_-]|$)/i
]

/** Catastrophic MCP tool names that are blocked outright. */
const FORBIDDEN_MCP_TOOL_PATTERNS: RegExp[] = [
  /(?:^|[_-])(?:format|wipe)[-_]?(?:disk|drive|partition)s?(?:[_-]|$)/i,
  /(?:^|[_-])mkfs(?:[_-]|$)/i
]

function collectStringValues(obj: unknown, maxDepth = 3): string[] {
  if (maxDepth < 0 || obj === null || obj === undefined) return []
  if (typeof obj === 'string') return [obj]
  if (Array.isArray(obj)) {
    return obj.flatMap((item) => collectStringValues(item, maxDepth - 1))
  }
  if (typeof obj === 'object') {
    return Object.values(obj).flatMap((val) => collectStringValues(val, maxDepth - 1))
  }
  return []
}

/** Extract command-like string arguments from an MCP tool call payload. */
export function extractMcpCommandStrings(toolName: string, args: Record<string, unknown>): string[] {
  const commands: string[] = []
  const isCommandTool = /(?:^|[_-])(?:run|exec|execute|bash|sh|shell|terminal|cmd|powershell)(?:[_-]|$)/i.test(toolName)

  const scan = (record: Record<string, unknown>, depth: number): void => {
    if (depth > 2) return
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string') {
        if (
          /^(?:command|cmd|script|exec|shell|code|sql|query)$/i.test(key) ||
          /(?:command|script)$/i.test(key) ||
          (isCommandTool && /^(?:input|args|line)$/i.test(key))
        ) {
          commands.push(value)
        }
      } else if (Array.isArray(value) && isCommandTool && /^(?:args|command)$/i.test(key)) {
        const joined = value.filter((item): item is string => typeof item === 'string').join(' ')
        if (joined) commands.push(joined)
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        scan(value as Record<string, unknown>, depth + 1)
      }
    }
  }

  scan(args, 0)
  return commands
}

/** Assess the risk level of an MCP tool call.
 * - 'forbidden': Destructive/catastrophic commands or tool names (e.g. format c:, rm -rf /) -> blocked outright.
 * - 'dangerous': Risky operations (e.g. file deletions, rm, git reset --hard, kill, drop table) -> pauses for approval even in full access mode.
 * - 'safe': Normal operations (e.g. search, read, write/edit, status queries) -> runs automatically in full access mode.
 */
export function assessMcpRisk(toolName: string, args: Record<string, unknown>): CommandRisk {
  // Check if tool name itself is forbidden
  if (FORBIDDEN_MCP_TOOL_PATTERNS.some((pattern) => pattern.test(toolName))) {
    return 'forbidden'
  }

  // Check if any string argument contains an outright forbidden command
  const allStrings = collectStringValues(args)
  for (const value of allStrings) {
    if (isForbiddenCommand(value)) {
      return 'forbidden'
    }
  }

  // Extract command strings and evaluate command risk
  const commands = extractMcpCommandStrings(toolName, args)
  for (const cmd of commands) {
    const risk = assessCommandRisk(cmd)
    if (risk !== 'safe') return risk
  }

  // Check if tool name itself is dangerous
  if (DANGEROUS_MCP_TOOL_PATTERNS.some((pattern) => pattern.test(toolName))) {
    return 'dangerous'
  }

  return 'safe'
}

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

/** Sanitize command tokens for MCP stdio execution.
 * - Strips redundant wrapping `cmd /c` or `cmd.exe /c` (avoids nested cmd.exe).
 * - Ensures non-interactive flags (e.g. `-y` for `npx`, `bunx`, `uvx`) so stdio doesn't hang waiting for stdin confirmation.
 * - On Windows, wraps with `cmd.exe /c` so `.cmd` shims (npx, uvx, etc.) execute properly.
 */
export function sanitizeMcpCommandTokens(rawTokens: string[]): { command: string; args: string[] } {
  const tokens = [...rawTokens]
  if (!tokens.length) throw new Error('Command is empty')

  // Strip leading cmd / cmd.exe /c /k wrapper if already present to prevent cmd.exe /c cmd /c nesting
  while (tokens.length >= 2 && /^cmd(?:\.exe)?$/i.test(tokens[0]) && /^\/[ck]$/i.test(tokens[1])) {
    tokens.splice(0, 2)
  }
  if (!tokens.length) throw new Error('Command is empty')

  // If the command is npx/bunx/uvx, ensure -y or --yes is present so it never blocks on stdin
  const baseBin = tokens[0].toLowerCase().replace(/\.(?:cmd|exe|bat)$/i, '')
  if ((baseBin === 'npx' || baseBin === 'bunx' || baseBin === 'uvx') && !tokens.some((t) => t === '-y' || t === '--yes')) {
    tokens.splice(1, 0, '-y')
  }

  if (process.platform === 'win32') {
    return {
      command: process.env.COMSPEC || 'cmd.exe',
      args: ['/c', ...tokens]
    }
  }
  return {
    command: tokens[0],
    args: tokens.slice(1)
  }
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

/** Two server names can sanitize identically ("a b" vs "a_b"), producing the
 * same prefixed tool name — calls would then silently route to whichever
 * server registered first. Suffix until unique against the names already in
 * use, keeping the result within the 64-char limit. */
export function dedupeMcpToolName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `__${n}`
    const candidate = base.slice(0, 64 - suffix.length) + suffix
    if (!taken.has(candidate)) return candidate
  }
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp__')
}

/** Key covering every connection-relevant field; a change forces a reconnect. */
export function mcpConfigKey(config: McpServerConfig): string {
  return JSON.stringify([config.transport, config.command ?? '', config.env ?? '', config.url ?? '', config.enabled])
}
