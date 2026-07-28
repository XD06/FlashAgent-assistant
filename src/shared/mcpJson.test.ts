import { describe, expect, it } from 'vitest'
import { parseMcpJson } from './mcpJson'

describe('parseMcpJson', () => {
  it('parses the wrapped mcpServers format with args and env', () => {
    const json = JSON.stringify({
      mcpServers: {
        everything: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-everything'],
          env: { API_KEY: 'abc' }
        }
      }
    })
    expect(parseMcpJson(json)).toEqual([
      {
        name: 'everything',
        transport: 'stdio',
        command: 'npx -y @modelcontextprotocol/server-everything',
        env: 'API_KEY=abc'
      }
    ])
  })

  it('parses a bare name→config map and url servers', () => {
    const json = JSON.stringify({
      local: { command: 'node', args: ['C:\\My Tools\\server.js'] },
      remote: { url: 'https://example.com/mcp' }
    })
    expect(parseMcpJson(json)).toEqual([
      // Args with spaces get quoted so tokenizeCommand round-trips them.
      { name: 'local', transport: 'stdio', command: 'node "C:\\My Tools\\server.js"', env: undefined },
      { name: 'remote', transport: 'http', url: 'https://example.com/mcp' }
    ])
  })

  it('treats a spaced command without args as a full command line', () => {
    expect(parseMcpJson('{"command": "npx -y server"}')).toEqual([
      { name: 'server', transport: 'stdio', command: 'npx -y server', env: undefined }
    ])
  })

  it('tolerates misspelled wrapper keys like mcpServer', () => {
    const json = JSON.stringify({
      mcpServer: {
        'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'] }
      }
    })
    expect(parseMcpJson(json)).toEqual([
      {
        name: 'chrome-devtools',
        transport: 'stdio',
        command: 'npx -y chrome-devtools-mcp@latest --autoConnect',
        env: undefined
      }
    ])
  })

  it('ignores entries without command or url', () => {
    expect(parseMcpJson('{"broken": {"note": "nothing here"}}')).toEqual([])
  })

  it('throws on invalid JSON', () => {
    expect(() => parseMcpJson('not json')).toThrow()
  })
})
