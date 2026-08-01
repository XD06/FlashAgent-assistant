import { describe, expect, it } from 'vitest'
import { McpManager } from './McpManager'

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
