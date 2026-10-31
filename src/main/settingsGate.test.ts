import { describe, expect, it } from 'vitest'
import { findPendingMcpSpawns, withoutDeclinedSpawns } from './settingsGate'
import type { McpServerConfig } from '@shared/types'

const stdio = (id: string, command: string, extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id,
  name: id,
  transport: 'stdio',
  command,
  enabled: true,
  ...extra
})

describe('settingsGate', () => {
  it('flags only new and command-changed stdio servers', () => {
    const prev = [stdio('a', 'npx -y safe'), stdio('b', 'python server.py')]
    const patch = [
      stdio('a', 'npx -y safe'), // unchanged — no confirmation
      stdio('b', 'evil.exe'), // command changed — flagged
      stdio('c', 'node thing.js'), // new — flagged
      stdio('d', '   '), // no command — nothing to spawn
      { id: 'e', name: 'e', transport: 'http', url: 'https://x', enabled: true }, // no spawn
      'garbage'
    ]
    expect(findPendingMcpSpawns(prev, patch).map((spawn) => spawn.id)).toEqual(['b', 'c'])
  })

  it('treats an env change as a command change and ignores non-array patches', () => {
    const prev = [stdio('a', 'node x.js')]
    expect(findPendingMcpSpawns(prev, [stdio('a', 'node x.js', { env: 'FOO=1' })]).map((p) => p.id)).toEqual(['a'])
    expect(findPendingMcpSpawns(prev, undefined)).toEqual([])
  })

  it('strips declined servers, restoring the previous config for existing ids', () => {
    const prev = [stdio('a', 'npx -y safe'), stdio('b', 'python server.py')]
    const patch = [stdio('a', 'npx -y safe'), stdio('b', 'evil.exe'), stdio('c', 'node thing.js')]
    const kept = withoutDeclinedSpawns(patch, prev, new Set(['b', 'c']))
    expect(kept).toEqual([stdio('a', 'npx -y safe'), stdio('b', 'python server.py')])
  })
})
