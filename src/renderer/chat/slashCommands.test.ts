import { describe, it, expect } from 'vitest'
import {
  buildSlashCommands,
  extractSlashQuery,
  filterSlashCommands
} from './slashCommands'
import type { McpServerStatus, SkillInfo } from '@shared/types'

describe('extractSlashQuery', () => {
  it('returns empty string for bare slash and trimmed leading whitespace', () => {
    expect(extractSlashQuery('/')).toBe('')
    expect(extractSlashQuery('  /')).toBe('')
  })

  it('returns query prefix while typing a single command token', () => {
    expect(extractSlashQuery('/comp')).toBe('comp')
    expect(extractSlashQuery('/ebook-extractor')).toBe('ebook-extractor')
  })

  it('returns null when slash is not leading, contains spaces, or has another slash', () => {
    expect(extractSlashQuery('')).toBeNull()
    expect(extractSlashQuery('hello /compact')).toBeNull()
    expect(extractSlashQuery('/compact now')).toBeNull()
    expect(extractSlashQuery('/Users/alice/docs')).toBeNull()
    expect(extractSlashQuery('/\nsecond line')).toBeNull()
  })
})

describe('buildSlashCommands & filterSlashCommands', () => {
  const skills: SkillInfo[] = [
    {
      id: 'sk-1',
      name: 'ebook-chapter-extractor',
      description: 'Extract book chapters quickly',
      file: '/tmp/skills/ebook/SKILL.md',
      enabled: true
    },
    {
      id: 'sk-disabled',
      name: 'hidden-skill',
      description: 'Should not appear when disabled',
      file: '/tmp/skills/hidden/SKILL.md',
      enabled: false
    }
  ]

  const mcpServers: McpServerStatus[] = [
    { id: 'm1', name: 'fs', state: 'connected', toolNames: ['read'] },
    { id: 'm2', name: 'db', state: 'error', error: 'down', toolNames: [] }
  ]

  it('builds core wired commands and includes only enabled skills', () => {
    const items = buildSlashCommands({
      isZh: true,
      agentEnabled: true,
      workingDir: 'C:\\repo\\FlashAgent-assistant',
      searchEnabled: false,
      temporaryChat: false,
      skills,
      mcpServers
    })

    const cmds = items.map((i) => i.command)
    expect(cmds).toContain('compact')
    expect(cmds).toContain('skills')
    expect(cmds).toContain('mcp')
    expect(cmds).toContain('memory')
    expect(cmds).toContain('agent')
    expect(cmds).toContain('workspace')
    expect(cmds).toContain('search')
    expect(cmds).toContain('new')
    expect(cmds).toContain('temp')
    expect(cmds).toContain('history')
    expect(cmds).toContain('ebook-chapter-extractor')
    expect(cmds).not.toContain('hidden-skill')

    expect(items.find((i) => i.command === 'skills')?.badge).toBe('1 已启用')
    expect(items.find((i) => i.command === 'mcp')?.badge).toBe('1/2')
    expect(items.find((i) => i.command === 'workspace')?.badge).toBe('FlashAgent-assistant')
  })

  it('ranks prefix matches before alias and description substring matches', () => {
    const items = buildSlashCommands({
      isZh: false,
      agentEnabled: false,
      workingDir: null,
      searchEnabled: true,
      temporaryChat: false,
      skills,
      mcpServers
    })

    expect(filterSlashCommands(items, '')).toHaveLength(items.length)
    expect(filterSlashCommands(items, 'sk').map((i) => i.command)[0]).toBe('skills')
    expect(filterSlashCommands(items, 'mcp').map((i) => i.command)[0]).toBe('mcp')
    expect(filterSlashCommands(items, 'compress').map((i) => i.command)).toContain('compact')
    expect(filterSlashCommands(items, 'ebook').map((i) => i.command)).toEqual(['ebook-chapter-extractor'])
    expect(filterSlashCommands(items, 'nonexistent-xyz')).toEqual([])
  })
})
