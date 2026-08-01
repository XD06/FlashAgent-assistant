import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeSettings } from '@shared/actions'
import { defaultSettings } from '@shared/defaults'
import { LEGACY_MIGRATION_MARKER, migrateLegacyUserData } from './legacyDataMigration'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'flashagent-migration-'))
  dirs.push(dir)
  return dir
}

async function saveSettings(dir: string, settings: unknown): Promise<void> {
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ settings }), 'utf8')
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('legacy user-data migration', () => {
  it('imports legacy-only Agent settings and files even when the new profile already exists', async () => {
    const root = await tempDir()
    const legacyDir = join(root, 'selection-assistant-lite')
    const currentDir = join(root, 'flashagent-assistant')
    await mkdir(legacyDir, { recursive: true })
    await mkdir(currentDir, { recursive: true })

    const legacyProvider = { ...defaultSettings.provider, baseUrl: 'https://legacy.example/v1', apiKey: 'legacy-key', model: 'legacy-model' }
    const legacy = normalizeSettings({
      ...defaultSettings,
      compactToolbar: true,
      fontSize: 13,
      proxyUrl: 'http://127.0.0.1:10808',
      commandShell: 'pwsh',
      provider: legacyProvider,
      providerTemplates: [{ ...defaultSettings.providerTemplates[0], provider: legacyProvider }],
      mcpServers: [{ id: 'legacy-mcp', name: 'Legacy MCP', transport: 'stdio', command: 'npx legacy', enabled: true }],
      linkedSkillDirs: ['C:\\legacy-skill'],
      disabledSkills: ['legacy-skill']
    })
    const current = normalizeSettings({
      ...defaultSettings,
      fontSize: 16,
      mcpServers: [{ id: 'current-mcp', name: 'Current MCP', transport: 'http', url: 'https://current.example', enabled: true }]
    })
    await saveSettings(legacyDir, legacy)
    await saveSettings(currentDir, current)
    await mkdir(join(legacyDir, 'skills', 'legacy-skill'), { recursive: true })
    await writeFile(join(legacyDir, 'skills', 'legacy-skill', 'SKILL.md'), '---\nname: Legacy\n---\n')
    await writeFile(join(legacyDir, 'memory.md'), 'legacy memory')
    await mkdir(join(legacyDir, 'tool-snapshots'), { recursive: true })
    await writeFile(join(legacyDir, 'tool-snapshots', 'old.json'), '{}')
    await mkdir(join(legacyDir, 'Local Storage', 'leveldb'), { recursive: true })
    await writeFile(join(legacyDir, 'Local Storage', 'leveldb', 'legacy.ldb'), 'legacy chat')
    await mkdir(join(currentDir, 'Local Storage', 'leveldb'), { recursive: true })
    await writeFile(join(currentDir, 'Local Storage', 'leveldb', 'current.ldb'), 'current chat')

    const result = migrateLegacyUserData(legacyDir, currentDir)
    const migrated = normalizeSettings(JSON.parse(await readFile(join(currentDir, 'settings.json'), 'utf8')).settings)

    expect(result.migrated).toBe(true)
    expect(result.settingsMigrated).toBe(true)
    expect(migrated.compactToolbar).toBe(true)
    expect(migrated.fontSize).toBe(16)
    expect(migrated.proxyUrl).toBe('http://127.0.0.1:10808')
    expect(migrated.commandShell).toBe('pwsh')
    expect(migrated.provider.apiKey).toBe('legacy-key')
    expect(migrated.mcpServers.map((server) => server.id)).toEqual(['legacy-mcp', 'current-mcp'])
    expect(migrated.linkedSkillDirs).toContain('C:\\legacy-skill')
    expect(migrated.disabledSkills).toContain('legacy-skill')
    await expect(readFile(join(currentDir, 'memory.md'), 'utf8')).resolves.toBe('legacy memory')
    expect(existsSync(join(currentDir, 'skills', 'legacy-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(currentDir, 'tool-snapshots', 'old.json'))).toBe(true)
    expect(existsSync(join(currentDir, 'Local Storage', 'leveldb', 'legacy.ldb'))).toBe(false)
    expect(existsSync(join(currentDir, 'Local Storage', 'leveldb', 'current.ldb'))).toBe(true)
    expect(existsSync(join(currentDir, 'settings.before-legacy-migration.json'))).toBe(true)
    expect(existsSync(join(currentDir, LEGACY_MIGRATION_MARKER))).toBe(true)
  })

  it('does not reapply an already completed migration', async () => {
    const root = await tempDir()
    const legacyDir = join(root, 'selection-assistant-lite')
    const currentDir = join(root, 'flashagent-assistant')
    await mkdir(legacyDir, { recursive: true })
    await mkdir(currentDir, { recursive: true })
    await saveSettings(legacyDir, normalizeSettings({ ...defaultSettings, compactToolbar: true }))
    await saveSettings(currentDir, normalizeSettings(defaultSettings))

    const first = migrateLegacyUserData(legacyDir, currentDir)
    await saveSettings(legacyDir, normalizeSettings({ ...defaultSettings, compactToolbar: true, fontSize: 12 }))
    const second = migrateLegacyUserData(legacyDir, currentDir)
    const migrated = normalizeSettings(JSON.parse(await readFile(join(currentDir, 'settings.json'), 'utf8')).settings)

    expect(first.migrated).toBe(true)
    expect(second.alreadyMigrated).toBe(true)
    expect(migrated.compactToolbar).toBe(true)
    expect(migrated.fontSize).toBe(defaultSettings.fontSize)
  })
})
