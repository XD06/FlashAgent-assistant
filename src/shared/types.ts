export type TriggerMode = 'selected' | 'shortcut'
export type FilterMode = 'default' | 'whitelist' | 'blacklist'
export type ActionType = 'copy' | 'search' | 'prompt'
export type AppLanguage = 'zh-CN' | 'en'
export type ThemeMode = 'system' | 'light' | 'dark'
export type ProviderApiType = 'openai' | 'anthropic'

export interface ProviderSettings {
  apiType: ProviderApiType
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
}

export interface ProviderTemplate {
  id: string
  name: string
  provider: ProviderSettings
}

export interface ShortcutSettings {
  toggleAssistant: string
  processSelection: string
}

export interface ActionItem {
  id: string
  name: string
  enabled: boolean
  icon: string
  type: ActionType
  promptTemplate?: string
  searchUrlTemplate?: string
}

export interface AppSettings {
  language: AppLanguage
  theme: ThemeMode
  enabled: boolean
  triggerMode: TriggerMode
  compactToolbar: boolean
  showToolbarAppIcon: boolean
  followToolbar: boolean
  rememberWindowSize: boolean
  autoClose: boolean
  autoPin: boolean
  filterMode: FilterMode
  filterList: string[]
  provider: ProviderSettings
  providerTemplates: ProviderTemplate[]
  activeProviderTemplateId: string
  shortcuts: ShortcutSettings
  actions: ActionItem[]
}

export interface SelectedTextPayload {
  text: string
  programName?: string
  isFullscreen?: boolean
}

export interface ActionPayload {
  action: ActionItem
  selectedText: string
  isFullscreen?: boolean
}

export interface AiStreamRequest {
  requestId: string
  prompt: string
}

export interface AiChunkPayload {
  requestId: string
  type: 'delta' | 'done' | 'error'
  text?: string
  error?: string
}

export type SettingsPatch = Partial<Omit<AppSettings, 'provider' | 'shortcuts'>> & {
  provider?: Partial<ProviderSettings>
  shortcuts?: Partial<ShortcutSettings>
}
