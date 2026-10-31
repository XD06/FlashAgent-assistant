import type { McpServerConfig } from '@shared/types'

/** stdio command + env of a config entry, or null when the entry would not
 * spawn anything (http transport, or no command). */
function spawnSignature(server: Partial<McpServerConfig> | undefined): string | null {
  if (!server || server.transport === 'http') return null
  const command = typeof server.command === 'string' ? server.command.trim() : ''
  if (!command) return null
  return `${command}\n${typeof server.env === 'string' ? server.env : ''}`
}

export interface PendingSpawn {
  id: string
  name: string
  command: string
}

/** Servers in a settings patch that would run a NEW or CHANGED command —
 * exactly the moment an MCP server gains the right to execute code. Toggling
 * enabled or renaming keeps the signature and stays dialog-free. The patch
 * entries are inspected defensively: they come from a renderer and have not
 * been through normalizeMcpServers yet. */
export function findPendingMcpSpawns(prev: McpServerConfig[], patchServers: unknown): PendingSpawn[] {
  if (!Array.isArray(patchServers)) return []
  const prevById = new Map(prev.map((server) => [server.id, server]))
  const pending: PendingSpawn[] = []
  for (const raw of patchServers) {
    if (!raw || typeof raw !== 'object') continue
    const server = raw as Partial<McpServerConfig>
    if (typeof server.id !== 'string' || !server.id) continue
    const signature = spawnSignature(server)
    if (!signature || spawnSignature(prevById.get(server.id)) === signature) continue
    pending.push({
      id: server.id,
      name: typeof server.name === 'string' ? server.name : server.id,
      command: signature.split('\n')[0]
    })
  }
  return pending
}

/** Remove declined servers from the patch, keeping their previous config (if
 * any) so a rejected edit reverts instead of deleting the server. Untouched
 * entries pass through unnormalized — mergeSettings sanitizes them anyway. */
export function withoutDeclinedSpawns(
  patchServers: unknown,
  prev: McpServerConfig[],
  declinedIds: ReadonlySet<string>
): McpServerConfig[] {
  const prevById = new Map(prev.map((server) => [server.id, server]))
  const result: McpServerConfig[] = []
  if (!Array.isArray(patchServers)) return result
  for (const raw of patchServers) {
    if (!raw || typeof raw !== 'object') continue
    const server = raw as Partial<McpServerConfig>
    if (typeof server.id !== 'string') continue
    if (declinedIds.has(server.id)) {
      const before = prevById.get(server.id)
      if (before) result.push(before)
      continue
    }
    result.push(server as McpServerConfig)
  }
  return result
}
