import { describe, expect, it } from 'vitest'
import { buildMcpToolName, isMcpToolName, mcpConfigKey, parseEnvBlock, tokenizeCommand } from './mcpUtil'
import type { McpServerConfig } from '@shared/types'

describe('tokenizeCommand', () => {
  it('splits on whitespace', () => {
    expect(tokenizeCommand('npx -y @modelcontextprotocol/server-everything')).toEqual([
      'npx',
      '-y',
      '@modelcontextprotocol/server-everything'
    ])
  })

  it('honors quoted segments', () => {
    expect(tokenizeCommand('node "C:\\My Tools\\server.js" --flag \'a b\'')).toEqual([
      'node',
      'C:\\My Tools\\server.js',
      '--flag',
      'a b'
    ])
  })

  it('returns empty for blank input', () => {
    expect(tokenizeCommand('   ')).toEqual([])
  })
})

describe('parseEnvBlock', () => {
  it('parses KEY=VALUE lines and skips comments/blanks', () => {
    expect(parseEnvBlock('API_KEY=abc123\n\n# comment\nBASE_URL=https://x.y/z?a=1')).toEqual({
      API_KEY: 'abc123',
      BASE_URL: 'https://x.y/z?a=1'
    })
  })

  it('returns empty for undefined', () => {
    expect(parseEnvBlock(undefined)).toEqual({})
  })
})

describe('buildMcpToolName', () => {
  it('prefixes and sanitizes names', () => {
    expect(buildMcpToolName('My Server!', 'read.file')).toBe('mcp__My_Server___read_file')
  })

  it('caps at 64 chars (OpenAI function-name limit)', () => {
    expect(buildMcpToolName('s'.repeat(60), 't'.repeat(60)).length).toBe(64)
  })

  it('round-trips with isMcpToolName', () => {
    expect(isMcpToolName(buildMcpToolName('a', 'b'))).toBe(true)
    expect(isMcpToolName('read_file')).toBe(false)
  })
})

describe('mcpConfigKey', () => {
  const base: McpServerConfig = { id: '1', name: 'a', transport: 'stdio', command: 'npx x', inject: true, enabled: true }

  it('changes when connection-relevant fields change', () => {
    expect(mcpConfigKey({ ...base, command: 'npx y' })).not.toBe(mcpConfigKey(base))
    expect(mcpConfigKey({ ...base, enabled: false })).not.toBe(mcpConfigKey(base))
  })

  it('ignores pure renames', () => {
    expect(mcpConfigKey({ ...base, name: 'renamed' })).toBe(mcpConfigKey(base))
  })
})
