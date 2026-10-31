import { describe, expect, it } from 'vitest'
import {
  assessMcpRisk,
  buildMcpToolName,
  dedupeMcpToolName,
  extractMcpCommandStrings,
  isMcpToolName,
  mcpConfigKey,
  parseEnvBlock,
  sanitizeMcpCommandTokens,
  tokenizeCommand
} from './mcpUtil'
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

describe('dedupeMcpToolName', () => {
  it('passes free names through untouched', () => {
    expect(dedupeMcpToolName('mcp__a__c', new Set(['mcp__x__y']))).toBe('mcp__a__c')
  })

  it('suffixes colliding names until unique', () => {
    const taken = new Set(['mcp__a_b__c'])
    expect(dedupeMcpToolName('mcp__a_b__c', taken)).toBe('mcp__a_b__c__2')
    // Sequential assignment: the second collision takes the next suffix.
    taken.add('mcp__a_b__c__2')
    expect(dedupeMcpToolName('mcp__a_b__c', taken)).toBe('mcp__a_b__c__3')
  })

  it('suffixes stay within the 64-char limit', () => {
    const long = buildMcpToolName('s'.repeat(60), 't'.repeat(60))
    expect(dedupeMcpToolName(long, new Set([long])).length).toBe(64)
  })
})

describe('mcpConfigKey', () => {
  const base: McpServerConfig = { id: '1', name: 'a', transport: 'stdio', command: 'npx x', enabled: true }

  it('changes when connection-relevant fields change', () => {
    expect(mcpConfigKey({ ...base, command: 'npx y' })).not.toBe(mcpConfigKey(base))
    expect(mcpConfigKey({ ...base, enabled: false })).not.toBe(mcpConfigKey(base))
  })

  it('ignores pure renames', () => {
    expect(mcpConfigKey({ ...base, name: 'renamed' })).toBe(mcpConfigKey(base))
  })
})

describe('extractMcpCommandStrings', () => {
  it('extracts command and script keys', () => {
    expect(extractMcpCommandStrings('mcp__server__cmd', { command: 'git status' })).toEqual(['git status'])
    expect(extractMcpCommandStrings('mcp__server__eval', { script: 'console.log(1)' })).toEqual(['console.log(1)'])
    expect(extractMcpCommandStrings('mcp__server__db', { sql: 'SELECT 1' })).toEqual(['SELECT 1'])
  })

  it('extracts input or args arrays for command-like tools', () => {
    expect(extractMcpCommandStrings('mcp__bash__run', { input: 'ls -la' })).toEqual(['ls -la'])
    expect(extractMcpCommandStrings('mcp__terminal__exec', { args: ['git', 'diff'] })).toEqual(['git diff'])
  })
})

describe('assessMcpRisk', () => {
  it('marks safe MCP tool calls as safe', () => {
    expect(assessMcpRisk('mcp__fs__read_file', { path: 'foo.txt' })).toBe('safe')
    expect(assessMcpRisk('mcp__fs__write_file', { path: 'foo.txt', content: 'hello' })).toBe('safe')
    expect(assessMcpRisk('mcp__search__web', { query: 'vitest tutorial' })).toBe('safe')
    expect(assessMcpRisk('mcp__terminal__run_command', { command: 'git status' })).toBe('safe')
    expect(assessMcpRisk('mcp__terminal__run_command', { command: 'pnpm test' })).toBe('safe')
    expect(assessMcpRisk('mcp__sqlite__query', { query: 'SELECT * FROM users' })).toBe('safe')
  })

  it('marks destructive commands as dangerous', () => {
    expect(assessMcpRisk('mcp__terminal__run_command', { command: 'rm file.txt' })).toBe('dangerous')
    expect(assessMcpRisk('mcp__terminal__run_command', { command: 'git reset --hard' })).toBe('dangerous')
    expect(assessMcpRisk('mcp__terminal__run_command', { command: 'git push -f' })).toBe('dangerous')
    expect(assessMcpRisk('mcp__terminal__run_command', { command: 'taskkill /im node.exe' })).toBe('dangerous')
    expect(assessMcpRisk('mcp__sqlite__query', { sql: 'DROP TABLE users' })).toBe('dangerous')
    expect(assessMcpRisk('mcp__bash__exec', { input: 'del /s old.log' })).toBe('dangerous')
  })

  it('marks destructive tool names as dangerous', () => {
    expect(assessMcpRisk('mcp__filesystem__delete_file', { path: 'a.txt' })).toBe('dangerous')
    expect(assessMcpRisk('mcp__filesystem__remove_directory', { path: 'dir' })).toBe('dangerous')
    expect(assessMcpRisk('mcp__fs__rmdir', { path: 'dir' })).toBe('dangerous')
    expect(assessMcpRisk('mcp__process__kill_process', { pid: 1234 })).toBe('dangerous')
    expect(assessMcpRisk('mcp__db__drop_database', { name: 'prod' })).toBe('dangerous')
  })

  it('marks catastrophic tools and commands as forbidden', () => {
    expect(assessMcpRisk('mcp__terminal__run_command', { command: 'rm -rf /' })).toBe('forbidden')
    expect(assessMcpRisk('mcp__terminal__run_command', { command: 'format c:' })).toBe('forbidden')
    expect(assessMcpRisk('mcp__terminal__run_command', { command: 'shutdown /s /t 0' })).toBe('forbidden')
    expect(assessMcpRisk('mcp__sys__format_disk', {})).toBe('forbidden')
    expect(assessMcpRisk('mcp__sys__mkfs', {})).toBe('forbidden')
    expect(assessMcpRisk('mcp__os__wipe_drive', {})).toBe('forbidden')
    expect(assessMcpRisk('mcp__custom__tool', { nested: { cmd: ':(){ :|:& };:' } })).toBe('forbidden')
  })
})

describe('sanitizeMcpCommandTokens', () => {
  it('strips redundant cmd /c prefix', () => {
    const res = sanitizeMcpCommandTokens(['cmd', '/c', 'npx', '-y', 'tavily-mcp'])
    if (process.platform === 'win32') {
      expect(res.command).toMatch(/cmd(?:\.exe)?$/i)
      expect(res.args).toEqual(['/c', 'npx', '-y', 'tavily-mcp'])
    } else {
      expect(res.command).toBe('npx')
      expect(res.args).toEqual(['-y', 'tavily-mcp'])
    }
  })

  it('automatically adds -y to npx commands if missing', () => {
    const res = sanitizeMcpCommandTokens(['npx', 'chrome-devtools-mcp@latest', '--autoConnect'])
    if (process.platform === 'win32') {
      expect(res.args).toEqual(['/c', 'npx', '-y', 'chrome-devtools-mcp@latest', '--autoConnect'])
    } else {
      expect(res.command).toBe('npx')
      expect(res.args).toEqual(['-y', 'chrome-devtools-mcp@latest', '--autoConnect'])
    }
  })

  it('keeps existing -y or --yes for npx', () => {
    const res = sanitizeMcpCommandTokens(['npx', '-y', 'my-pkg'])
    if (process.platform === 'win32') {
      expect(res.args).toEqual(['/c', 'npx', '-y', 'my-pkg'])
    } else {
      expect(res.command).toBe('npx')
      expect(res.args).toEqual(['-y', 'my-pkg'])
    }
  })

  it('preserves non-npx commands without adding -y', () => {
    const res = sanitizeMcpCommandTokens(['python', '-m', 'myserver'])
    if (process.platform === 'win32') {
      expect(res.args).toEqual(['/c', 'python', '-m', 'myserver'])
    } else {
      expect(res.command).toBe('python')
      expect(res.args).toEqual(['-m', 'myserver'])
    }
  })

  it('throws on empty tokens', () => {
    expect(() => sanitizeMcpCommandTokens([])).toThrow('Command is empty')
  })
})

