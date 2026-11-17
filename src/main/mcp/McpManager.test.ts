import { describe, expect, it, vi } from 'vitest'
import { McpManager } from './McpManager'
import type { McpServerConfig } from '@shared/types'

function addConnectedServer(manager: McpManager, id: string): void {
  const internals = manager as unknown as {
    servers: Map<string, unknown>
  }
  internals.servers.set(id, {
    config: { id, name: id, transport: 'stdio', command: 'npx test', enabled: true },
    configKey: id,
    client: null,
    state: 'connected',
    tools: [
      {
        exposedName: `mcp__${id}__read`,
        toolName: 'read',
        definition: { name: `mcp__${id}__read`, description: 'read', parameters: { type: 'object' } }
      }
    ]
  })
}

describe('McpManager tool availability', () => {
  it('exposes schemas only for selected connected servers', () => {
    const manager = new McpManager()
    addConnectedServer(manager, 'selected')
    addConnectedServer(manager, 'connected-only')

    expect(manager.getToolDefinitions(new Set())).toEqual([])
    expect(manager.getToolDefinitions(new Set(['selected'])).map((tool) => tool.name)).toEqual(['mcp__selected__read'])
  })
})

describe('McpManager failed connection cleanup', () => {
  it('closes the client when listTools fails instead of leaking its process', async () => {
    const manager = new McpManager()
    const close = vi.fn().mockResolvedValue(undefined)
    const listTools = vi.fn().mockRejectedValue(new Error('listTools failed'))
    const internals = manager as unknown as {
      openClient: () => Promise<unknown>
      connect: (config: McpServerConfig) => Promise<void>
    }
    internals.openClient = vi.fn().mockResolvedValue({ listTools, close, transport: null })
    const config: McpServerConfig = {
      id: 'broken',
      name: 'broken',
      transport: 'stdio',
      command: 'npx broken',
      enabled: true
    }

    await internals.connect(config)

    expect(close).toHaveBeenCalledTimes(1)
    expect(manager.getStatuses([config])[0]).toMatchObject({ state: 'error' })
  })
})
