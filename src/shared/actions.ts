import { defaultProviderTemplate, defaultSettings } from './defaults'
import type {
  ActionItem,
  AppLanguage,
  AppSettings,
  ProviderApiType,
  ProviderSettings,
  ProviderTemplate,
  SettingsPatch,
  ThemeMode,
  TriggerMode
} from './types'

export function getResponseLanguageName(language: AppLanguage): string {
  return language === 'zh-CN' ? 'Simplified Chinese' : 'English'
}

export function buildAssistantSystemPrompt(settings: Pick<AppSettings, 'language'>): string {
  const language = getResponseLanguageName(settings.language)
  return `Always answer in ${language}. Match this response language even if the selected text or action prompt uses another language.`
}

export function interpolatePrompt(
  template: string | undefined,
  selectedText: string,
  options: { language?: string } = {}
): string {
  const text = selectedText.trim()
  if (!template?.trim()) return text
  const preparedTemplate = template
    .replaceAll('{{language}}', options.language ?? 'the user interface language')
    .replaceAll('the user interface language', options.language ?? 'the user interface language')
  if (preparedTemplate.includes('{{text}}')) return preparedTemplate.replaceAll('{{text}}', text)
  return `${preparedTemplate.trim()}\n\n${text}`
}

export function buildSearchUrl(action: ActionItem, selectedText: string): string {
  const text = selectedText.trim()
  if (!text) return ''
  if (isUriOrFilePath(text)) return text

  const template = action.searchUrlTemplate || 'https://www.google.com/search?q={{query}}'
  return template.replaceAll('{{query}}', encodeURIComponent(text)).replaceAll('{{text}}', encodeURIComponent(text))
}

export function isUriOrFilePath(value: string): boolean {
  const text = value.trim()
  if (!text || /\s/.test(text)) return false
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) || /^[a-zA-Z]:[/\\]/.test(text) || /^\/[^/]/.test(text)
}

export function mergeSettings(current: AppSettings, patch: SettingsPatch): AppSettings {
  const {
    provider,
    providerTemplates,
    activeProviderTemplateId,
    shortcuts,
    actions,
    assistantPrompt: _removedAssistantPrompt,
    actionWindowOpacity: _removedActionWindowOpacity,
  ...rest
  } = patch as SettingsPatch & {
    assistantPrompt?: unknown
    actionWindowOpacity?: unknown
  }
  let nextProviderTemplates = normalizeProviderTemplates(providerTemplates ?? current.providerTemplates, current.provider)
  const nextActiveProviderTemplateId = normalizeActiveProviderTemplateId(
    activeProviderTemplateId ?? current.activeProviderTemplateId,
    nextProviderTemplates
  )

  if (provider && providerTemplates === undefined && activeProviderTemplateId === undefined) {
    const activeTemplate = nextProviderTemplates.find((template) => template.id === nextActiveProviderTemplateId)
    const mergedProvider = normalizeProviderSettings({
      ...(activeTemplate?.provider ?? current.provider),
      ...provider
    })
    nextProviderTemplates = nextProviderTemplates.map((template) =>
      template.id === nextActiveProviderTemplateId ? { ...template, provider: mergedProvider } : template
    )
  }

  const selectedProviderTemplate =
    nextProviderTemplates.find((template) => template.id === nextActiveProviderTemplateId) ?? nextProviderTemplates[0]
  const nextProvider = normalizeProviderSettings(selectedProviderTemplate?.provider ?? current.provider)
  return {
    ...current,
    ...rest,
    theme: normalizeThemeMode(rest.theme ?? current.theme),
    triggerMode: normalizeTriggerMode(rest.triggerMode ?? current.triggerMode),
    provider: nextProvider,
    providerTemplates: nextProviderTemplates,
    activeProviderTemplateId: selectedProviderTemplate?.id ?? defaultProviderTemplate.id,
    shortcuts: {
      ...current.shortcuts,
      ...(shortcuts ?? {})
    },
    actions: normalizeActionItems(actions ?? current.actions)
  }
}

export function normalizeSettings(value: unknown): AppSettings {
  const partial = value && typeof value === 'object' ? (value as Partial<AppSettings>) : {}
  return mergeSettings(defaultSettings, partial)
}

function normalizeTriggerMode(mode: unknown): TriggerMode {
  return mode === 'shortcut' ? 'shortcut' : 'selected'
}

function normalizeThemeMode(mode: unknown): ThemeMode {
  if (mode === 'light' || mode === 'dark') return mode
  return 'system'
}

function normalizeProviderApiType(type: unknown): ProviderApiType {
  return type === 'anthropic' ? 'anthropic' : 'openai'
}

function normalizeProviderSettings(provider: Partial<ProviderSettings> | ProviderSettings): ProviderSettings {
  return {
    ...defaultProviderTemplate.provider,
    ...provider,
    apiType: normalizeProviderApiType(provider.apiType),
    temperature: 1
  }
}

function normalizeProviderTemplates(
  templates: unknown,
  fallbackProvider: ProviderSettings = defaultProviderTemplate.provider
): ProviderTemplate[] {
  if (!Array.isArray(templates) || templates.length === 0) {
    return [
      {
        ...defaultProviderTemplate,
        provider: normalizeProviderSettings(fallbackProvider)
      }
    ]
  }

  return templates.map((template, index) => {
    const candidate = template && typeof template === 'object' ? (template as Partial<ProviderTemplate>) : {}
    return {
      id: typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id : `provider-template-${index + 1}`,
      name:
        typeof candidate.name === 'string' && candidate.name.trim()
          ? candidate.name.trim()
          : `Template ${index + 1}`,
      provider: normalizeProviderSettings(candidate.provider ?? fallbackProvider)
    }
  })
}

function normalizeActiveProviderTemplateId(activeId: unknown, templates: ProviderTemplate[]): string {
  if (typeof activeId === 'string' && templates.some((template) => template.id === activeId)) return activeId
  return templates[0]?.id ?? defaultProviderTemplate.id
}

function getFixedActionType(action: Pick<ActionItem, 'id'>): ActionItem['type'] {
  if (action.id === 'copy') return 'copy'
  if (action.id === 'search') return 'search'
  return 'prompt'
}

function normalizeActionItems(actions: ActionItem[]): ActionItem[] {
  const defaultById = new Map(defaultSettings.actions.map((action) => [action.id, action]))
  const actionsById = new Map(actions.map((action) => [action.id, action]))
  const normalizedDefaults = defaultSettings.actions.map((defaultAction) => {
    const action = actionsById.get(defaultAction.id)
    if (!action) return defaultAction
    return {
      ...defaultAction,
      ...action,
      type: getFixedActionType(defaultAction),
      promptTemplate: action.promptTemplate ?? defaultAction.promptTemplate,
      searchUrlTemplate: action.searchUrlTemplate ?? defaultAction.searchUrlTemplate
    }
  })
  const customActions = actions.filter((action) => !defaultById.has(action.id)).map((action) => ({
    ...action,
    type: getFixedActionType(action)
  }))
  return [...normalizedDefaults, ...customActions]
}
