import type { McpTransport } from './types'

export interface ParsedMcpServer {
  name: string
  transport: McpTransport
  command?: string
  env?: string
  url?: string
}

function quoteArg(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg
}

/** Parse MCP server JSON configs (Claude/Cursor style) into our server
 * configs. Tolerant of wrapper keys (`mcpServers`, `mcpServer`, `servers`,
 * none at all) by recursively looking for objects carrying `command` or
 * `url`; the key of the matching object becomes the server name. Throws on
 * invalid JSON. */
export function parseMcpJson(text: string): ParsedMcpServer[] {
  const root = JSON.parse(text) as unknown
  const out: ParsedMcpServer[] = []
  collectServers(root, 'server', out, 0)
  return out
}

function collectServers(node: unknown, name: string, out: ParsedMcpServer[], depth: number): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return
  const cfg = node as Record<string, unknown>
  if (typeof cfg.url === 'string' && cfg.url) {
    out.push({ name, transport: 'http', url: cfg.url })
    return
  }
  if (typeof cfg.command === 'string' && cfg.command) {
    const args = Array.isArray(cfg.args) ? cfg.args.map(String) : []
    // With args present, a spaced command is a path and needs quoting; with
    // no args, treat the string as a full command line pasted by the user.
    const command = args.length > 0 ? [quoteArg(cfg.command), ...args.map(quoteArg)].join(' ') : cfg.command
    const env =
      cfg.env && typeof cfg.env === 'object'
        ? Object.entries(cfg.env as Record<string, unknown>)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join('\n')
        : undefined
    out.push({ name, transport: 'stdio', command, env })
    return
  }
  // Descend into wrapper objects (mcpServers / mcpServer / name→config maps).
  if (depth >= 3) return
  for (const [key, value] of Object.entries(cfg)) {
    collectServers(value, key, out, depth + 1)
  }
}
