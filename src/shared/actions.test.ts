import { describe, expect, it } from 'vitest'
import {
  buildAssistantSystemPrompt,
  buildSearchUrl,
  interpolatePrompt,
  isUriOrFilePath,
  mergeSettings,
  normalizeSettings
} from './actions'
import { defaultSettings } from './defaults'

describe('selection actions', () => {
  it('interpolates selected text into prompt templates', () => {
    expect(interpolatePrompt('Explain: {{text}}', ' hello ')).toBe('Explain: hello')
  })

  it('interpolates target language into prompt templates', () => {
    expect(interpolatePrompt('Translate into {{language}}: {{text}}', 'hello', { language: 'Simplified Chinese' })).toBe(
      'Translate into Simplified Chinese: hello'
    )
  })

  it('appends text when a prompt has no placeholder', () => {
    expect(interpolatePrompt('Explain this', 'hello')).toBe('Explain this\n\nhello')
  })

  it('builds search URLs with encoded query text', () => {
    expect(
      buildSearchUrl(
        {
          id: 'search',
          name: 'Search',
          enabled: true,
          icon: 'search',
          type: 'search',
          searchUrlTemplate: 'https://example.com?q={{query}}'
        },
        'hello world'
      )
    ).toBe('https://example.com?q=hello%20world')
  })

  it('passes direct URLs and file paths through for search actions', () => {
    expect(isUriOrFilePath('https://example.com')).toBe(true)
    expect(isUriOrFilePath('/Users/me/file.txt')).toBe(true)
    expect(isUriOrFilePath('hello world')).toBe(false)
  })

  it('merges provider settings without dropping defaults', () => {
    const merged = mergeSettings(defaultSettings, { provider: { model: 'custom-model' } })
    expect(merged.provider.model).toBe('custom-model')
    expect(merged.provider.baseUrl).toBe(defaultSettings.provider.baseUrl)
    expect(merged.provider.temperature).toBe(1)
  })

  it('merges shortcut settings without dropping the other shortcut', () => {
    const merged = mergeSettings(defaultSettings, { shortcuts: { processSelection: 'CommandOrControl+Alt+S' } })
    expect(merged.shortcuts.processSelection).toBe('CommandOrControl+Alt+S')
    expect(merged.shortcuts.toggleAssistant).toBe(defaultSettings.shortcuts.toggleAssistant)
  })

  it('normalizes old settings by adding default shortcuts', () => {
    const { shortcuts: _shortcuts, ...oldSettings } = defaultSettings
    const normalized = normalizeSettings(oldSettings)
    expect(normalized.shortcuts).toEqual(defaultSettings.shortcuts)
  })

  it('defaults theme to system during normalization', () => {
    const { theme: _theme, ...oldSettings } = defaultSettings
    const normalized = normalizeSettings(oldSettings)
    expect(normalized.theme).toBe('system')
  })

  it('defaults showToolbarAppIcon to true during normalization', () => {
    const { showToolbarAppIcon: _showToolbarAppIcon, ...oldSettings } = defaultSettings
    const normalized = normalizeSettings(oldSettings)
    expect(normalized.showToolbarAppIcon).toBe(true)
  })

  it('defaults provider api type to openai during normalization', () => {
    const normalized = normalizeSettings({
      ...defaultSettings,
      provider: {
        ...defaultSettings.provider,
        apiType: undefined
      }
    })
    expect(normalized.provider.apiType).toBe('openai')
  })

  it('creates a default provider template when old settings have no templates', () => {
    const normalized = normalizeSettings({
      ...defaultSettings,
      providerTemplates: undefined,
      activeProviderTemplateId: undefined
    })
    expect(normalized.providerTemplates).toHaveLength(1)
    expect(normalized.activeProviderTemplateId).toBe(normalized.providerTemplates[0]?.id)
  })

  it('updates the active provider template when provider fields change', () => {
    const merged = mergeSettings(defaultSettings, { provider: { model: 'claude-3-5-sonnet-latest' } })
    expect(merged.provider.model).toBe('claude-3-5-sonnet-latest')
    expect(merged.providerTemplates[0]?.provider.model).toBe('claude-3-5-sonnet-latest')
  })

  it('switches current provider when active provider template changes', () => {
    const merged = normalizeSettings({
      ...defaultSettings,
      providerTemplates: [
        {
          id: 'template-openai',
          name: 'OpenAI',
          provider: { ...defaultSettings.provider, model: 'gpt-4o-mini' }
        },
        {
          id: 'template-anthropic',
          name: 'Anthropic',
          provider: {
            ...defaultSettings.provider,
            apiType: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            model: 'claude-3-5-sonnet-latest'
          }
        }
      ],
      activeProviderTemplateId: 'template-anthropic'
    })
    expect(merged.provider.apiType).toBe('anthropic')
    expect(merged.provider.model).toBe('claude-3-5-sonnet-latest')
  })

  it('forces provider temperature to 1 during normalization', () => {
    const normalized = normalizeSettings({
      ...defaultSettings,
      provider: {
        ...defaultSettings.provider,
        temperature: 0.2
      }
    })
    expect(normalized.provider.temperature).toBe(1)
  })

  it('maps removed ctrlkey trigger mode back to selected', () => {
    const normalized = normalizeSettings({
      ...defaultSettings,
      triggerMode: 'ctrlkey'
    })
    expect(normalized.triggerMode).toBe('selected')
  })

  it('drops removed actionWindowOpacity settings during normalization', () => {
    const normalized = normalizeSettings({
      ...defaultSettings,
      actionWindowOpacity: 40
    })
    expect('actionWindowOpacity' in (normalized as object)).toBe(false)
  })

  it('keeps a cleared prompt template instead of restoring defaults (actions are user-owned)', () => {
    const oldSettings = {
      ...defaultSettings,
      actions: defaultSettings.actions.map((action) => (action.id === 'translate' ? { ...action, promptTemplate: undefined } : action))
    }
    const normalized = normalizeSettings(oldSettings)
    expect(normalized.actions.find((action) => action.id === 'translate')?.promptTemplate).toBeUndefined()
  })

  it('preserves valid action types and drops unsupported ones', () => {
    const normalized = normalizeSettings({
      ...defaultSettings,
      actions: [
        { id: 'a', name: 'A', enabled: true, icon: 'sparkles', type: 'prompt' },
        { id: 'b', name: 'B', enabled: true, icon: 'copy', type: 'copy' },
        { id: 'c', name: 'C', enabled: true, icon: 'book-open', type: 'dictionary' }
      ]
    })
    const ids = normalized.actions.map((action) => action.id)
    expect(ids).toContain('a')
    expect(ids).toContain('b')
    expect(ids).not.toContain('c')
    expect(normalized.actions.find((action) => action.id === 'a')?.type).toBe('prompt')
    expect(normalized.actions.find((action) => action.id === 'b')?.type).toBe('copy')
  })

  it('keeps user-added actions with shortcut and reasoning', () => {
    const custom = {
      id: 'my-action',
      name: 'My Action',
      enabled: true,
      icon: 'sparkles',
      type: 'prompt' as const,
      promptTemplate: 'Do: {{text}}',
      providerTemplateId: 'tpl-2',
      reasoning: 'off' as const,
      shortcut: 'CommandOrControl+Alt+M'
    }
    const normalized = normalizeSettings({ ...defaultSettings, actions: [custom] })
    expect(normalized.actions).toHaveLength(1)
    expect(normalized.actions[0]).toMatchObject({
      id: 'my-action',
      providerTemplateId: 'tpl-2',
      reasoning: 'off',
      shortcut: 'CommandOrControl+Alt+M'
    })
  })

  it('builds a fixed language system prompt without custom prompt content', () => {
    expect(
      buildAssistantSystemPrompt({
        language: 'zh-CN'
      })
    ).toContain('Always answer in Simplified Chinese')
    expect(
      buildAssistantSystemPrompt({
        language: 'en'
      })
    ).toContain('Always answer in English. Match this response language even if the selected text or action prompt uses another language.')
  })

  it('merges an action prompt update without changing other actions', () => {
    const nextActions = defaultSettings.actions.map((action) =>
      action.id === 'explain' ? { ...action, promptTemplate: 'Custom explain: {{text}}' } : action
    )
    const merged = mergeSettings(defaultSettings, { actions: nextActions })
    expect(merged.actions.find((action) => action.id === 'explain')?.promptTemplate).toBe('Custom explain: {{text}}')
    expect(merged.actions.find((action) => action.id === 'translate')?.promptTemplate).toBe(
      defaultSettings.actions.find((action) => action.id === 'translate')?.promptTemplate
    )
  })
})
