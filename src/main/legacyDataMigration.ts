import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeSettings } from '@shared/actions'
import { defaultSettings } from '@shared/defaults'
import type { ActionItem, AppSettings, McpServerConfig, ProviderSettings, ProviderTemplate } from '@shared/types'

export const LEGACY_MIGRATION_MARKER = '.flashagent-legacy-migration-v1.json'
const SETTINGS_BACKUP = 'settings.before-legacy-migration.json'
const COPIED_PATHS = ['memory.md', 'skills', 'tool-snapshots', 'tool-outputs'] as const

export interface LegacyDataMigrationResult {
  migrated: boolean
  alreadyMigrated: boolean
  settingsMigrated: boolean
  copiedPaths: string[]
  error?: string
}

interface StoredSettings {
  settings?: unknown
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function inheritLegacy<T>(current: T, legacy: T, fallback: T): T {
  return sameValue(current, fallback) && !sameValue(legacy, fallback) ? legacy : current
}

function mergeProvider(current: ProviderSettings, legacy: ProviderSettings, fallback: ProviderSettings): ProviderSettings {
  return {
    apiType: inheritLegacy(current.apiType, legacy.apiType, fallback.apiType),
    baseUrl: inheritLegacy(current.baseUrl, legacy.baseUrl, fallback.baseUrl),
    apiKey: inheritLegacy(current.apiKey, legacy.apiKey, fallback.apiKey),
    model: inheritLegacy(current.model, legacy.model, fallback.model),
    temperature: inheritLegacy(current.temperature, legacy.temperature, fallback.temperature),
    reasoning: inheritLegacy(current.reasoning, legacy.reasoning, fallback.reasoning)
  }
}

function mergeProviderTemplates(current: ProviderTemplate[], legacy: ProviderTemplate[]): ProviderTemplate[] {
  const currentById = new Map(current.map((template) => [template.id, template]))
  const defaultsById = new Map(defaultSettings.providerTemplates.map((template) => [template.id, template]))
  const merged: ProviderTemplate[] = legacy.map((legacyTemplate) => {
    const currentTemplate = currentById.get(legacyTemplate.id)
    if (!currentTemplate) return legacyTemplate
    const fallback = defaultsById.get(legacyTemplate.id) ?? defaultSettings.providerTemplates[0]
    return {
      id: legacyTemplate.id,
      name: inheritLegacy(currentTemplate.name, legacyTemplate.name, fallback.name),
      provider: mergeProvider(currentTemplate.provider, legacyTemplate.provider, fallback.provider)
    }
  })
  for (const template of current) {
    if (!legacy.some((legacyTemplate) => legacyTemplate.id === template.id)) merged.push(template)
  }
  return merged
}

function mergeActions(current: ActionItem[], legacy: ActionItem[]): ActionItem[] {
  const currentById = new Map(current.map((action) => [action.id, action]))
  const defaultsById = new Map(defaultSettings.actions.map((action) => [action.id, action]))
  const merged = legacy.map((legacyAction) => {
    const currentAction = currentById.get(legacyAction.id)
    if (!currentAction) return legacyAction
    const fallback = defaultsById.get(legacyAction.id)
    return fallback && sameValue(currentAction, fallback) && !sameValue(legacyAction, fallback) ? legacyAction : currentAction
  })
  for (const action of current) {
    if (!legacy.some((legacyAction) => legacyAction.id === action.id)) merged.push(action)
  }
  return merged
}

function mergeById<T extends { id: string }>(legacy: T[], current: T[]): T[] {
  const result = [...legacy]
  const positions = new Map(result.map((value, index) => [value.id, index]))
  for (const value of current) {
    const position = positions.get(value.id)
    if (position === undefined) {
      positions.set(value.id, result.length)
      result.push(value)
    } else {
      result[position] = value
    }
  }
  return result
}

function mergeStrings(legacy: string[], current: string[]): string[] {
  return [...new Set([...legacy, ...current])]
}

/**
 * Import legacy preferences without replacing a setting that the user has
 * explicitly changed in the new app. Values still at their shipped default
 * inherit the old non-default value; collection settings are merged.
 */
export function mergeLegacySettings(current: AppSettings, legacy: AppSettings): AppSettings {
  const result = { ...current } as AppSettings
  const scalarKeys: Array<keyof AppSettings> = [
    'language',
    'theme',
    'enabled',
    'triggerMode',
    'compactToolbar',
    'showToolbarAppIcon',
    'followToolbar',
    'rememberWindowSize',
    'autoPin',
    'actionWindowWidth',
    'actionWindowHeight',
    'chatWindowWidth',
    'chatWindowHeight',
    'fontFamily',
    'fontSize',
    'autoLaunch',
    'filterMode',
    'filterList',
    'webSearchEnabled',
    'proxyUrl',
    'compressModel',
    'contextWindowTokens',
    'visionModel',
    'agentFullAccess',
    'commandShell'
  ]
  const currentRecord = current as unknown as Record<string, unknown>
  const legacyRecord = legacy as unknown as Record<string, unknown>
  const defaultsRecord = defaultSettings as unknown as Record<string, unknown>
  const resultRecord = result as unknown as Record<string, unknown>
  for (const key of scalarKeys) {
    resultRecord[key] = inheritLegacy(currentRecord[key], legacyRecord[key], defaultsRecord[key])
  }
  result.shortcuts = {
    toggleAssistant: inheritLegacy(current.shortcuts.toggleAssistant, legacy.shortcuts.toggleAssistant, defaultSettings.shortcuts.toggleAssistant),
    processSelection: inheritLegacy(current.shortcuts.processSelection, legacy.shortcuts.processSelection, defaultSettings.shortcuts.processSelection),
    captureScreen: inheritLegacy(current.shortcuts.captureScreen, legacy.shortcuts.captureScreen, defaultSettings.shortcuts.captureScreen),
    chat: inheritLegacy(current.shortcuts.chat, legacy.shortcuts.chat, defaultSettings.shortcuts.chat)
  }
  result.providerTemplates = mergeProviderTemplates(current.providerTemplates, legacy.providerTemplates)
  const activeProvider = inheritLegacy(
    current.activeProviderTemplateId,
    legacy.activeProviderTemplateId,
    defaultSettings.activeProviderTemplateId
  )
  result.activeProviderTemplateId = result.providerTemplates.some((template) => template.id === activeProvider)
    ? activeProvider
    : result.providerTemplates[0]?.id ?? defaultSettings.activeProviderTemplateId
  result.provider =
    result.providerTemplates.find((template) => template.id === result.activeProviderTemplateId)?.provider ?? current.provider
  result.actions = mergeActions(current.actions, legacy.actions)
  result.mcpServers = mergeById<McpServerConfig>(legacy.mcpServers, current.mcpServers)
  result.disabledSkills = mergeStrings(legacy.disabledSkills, current.disabledSkills)
  result.linkedSkillDirs = mergeStrings(legacy.linkedSkillDirs, current.linkedSkillDirs)
  return normalizeSettings(result)
}

function readSettings(filePath: string): AppSettings | null {
  try {
    const stored = JSON.parse(readFileSync(filePath, 'utf8')) as StoredSettings
    return normalizeSettings(stored.settings)
  } catch {
    return null
  }
}

function copyMissing(source: string, target: string): void {
  const stat = statSync(source)
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(source)) copyMissing(join(source, entry), join(target, entry))
    return
  }
  if (!existsSync(target)) {
    mkdirSync(join(target, '..'), { recursive: true })
    copyFileSync(source, target)
  }
}

/**
 * One-time, additive migration from the app name used before the FlashAgent
 * rebrand. Chromium's cache and Local Storage are intentionally excluded:
 * they are live databases and copying them into an existing profile can
 * corrupt or overwrite newer chat history. User settings, memory, skills and
 * reversible Agent snapshots are handled separately and safely.
 */
export function migrateLegacyUserData(legacyDir: string, userDataDir: string): LegacyDataMigrationResult {
  const empty: LegacyDataMigrationResult = {
    migrated: false,
    alreadyMigrated: false,
    settingsMigrated: false,
    copiedPaths: []
  }
  if (legacyDir === userDataDir || !existsSync(legacyDir)) return empty
  try {
    mkdirSync(userDataDir, { recursive: true })
    if (existsSync(join(userDataDir, LEGACY_MIGRATION_MARKER))) {
      return { ...empty, alreadyMigrated: true }
    }

    const legacySettingsPath = join(legacyDir, 'settings.json')
    const currentSettingsPath = join(userDataDir, 'settings.json')
    const legacySettings = readSettings(legacySettingsPath)
    const currentSettings = readSettings(currentSettingsPath)
    let settingsMigrated = false
    if (legacySettings) {
      if (existsSync(currentSettingsPath)) {
        const backup = join(userDataDir, SETTINGS_BACKUP)
        if (!existsSync(backup)) copyFileSync(currentSettingsPath, backup)
      }
      const merged = currentSettings ? mergeLegacySettings(currentSettings, legacySettings) : legacySettings
      writeFileSync(currentSettingsPath, `${JSON.stringify({ settings: merged }, null, 2)}\n`, 'utf8')
      settingsMigrated = true
    }

    const copiedPaths: string[] = []
    for (const relativePath of COPIED_PATHS) {
      const source = join(legacyDir, relativePath)
      if (!existsSync(source)) continue
      copyMissing(source, join(userDataDir, relativePath))
      copiedPaths.push(relativePath)
    }
    writeFileSync(
      join(userDataDir, LEGACY_MIGRATION_MARKER),
      JSON.stringify({ source: legacyDir, migratedAt: new Date().toISOString(), settingsMigrated, copiedPaths }, null, 2),
      'utf8'
    )
    return { migrated: settingsMigrated || copiedPaths.length > 0, alreadyMigrated: false, settingsMigrated, copiedPaths }
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) }
  }
}
