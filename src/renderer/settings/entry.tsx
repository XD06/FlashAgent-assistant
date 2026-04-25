import '../styles.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { useSettings } from '../useSettings'
import { Icon } from '../icons'
import { defaultActions } from '@shared/defaults'
import { useThemeMode } from '../useThemeMode'
import { getActionLabel, getTranslator } from '../i18n'
import type {
  ActionItem,
  AppLanguage,
  FilterMode,
  ProviderTemplate,
  ShortcutSettings,
  ThemeMode,
  TriggerMode
} from '@shared/types'

type SettingsSectionId = 'api' | 'selection' | 'window' | 'actions'

type SettingsSectionMeta = {
  id: SettingsSectionId
  label: string
}

type SettingRowProps = {
  title: string
  description?: string
  className?: string
  children: React.ReactNode
}

function SettingsNav({
  sections,
  activeSection,
  onChange
}: {
  sections: SettingsSectionMeta[]
  activeSection: SettingsSectionId
  onChange: (section: SettingsSectionId) => void
}) {
  return (
    <aside className="settings-sidebar" aria-label="Settings sections">
      {sections.map((section) => (
        <button
          key={section.id}
          className={section.id === activeSection ? 'settings-nav-button active' : 'settings-nav-button'}
          onClick={() => onChange(section.id)}
          type="button">
          <span>{section.label}</span>
        </button>
      ))}
    </aside>
  )
}

function SettingSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="setting-section">
      <h3>{title}</h3>
      <div className="setting-section-body">{children}</div>
    </section>
  )
}

function SettingRow({ title, description, className, children }: SettingRowProps) {
  return (
    <div className={className ? `setting-row ${className}` : 'setting-row'}>
      <div className="setting-info">
        <span className="setting-title">{title}</span>
        {description && <span className="setting-desc">{description}</span>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={checked ? 'toggle checked' : 'toggle'}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button">
      <span />
    </button>
  )
}

function formatShortcut(value: string): string[] {
  if (!value) return []
  const isMac = navigator.platform.toLowerCase().includes('mac')
  return value
    .replaceAll('CommandOrControl', isMac ? 'Command' : 'Ctrl')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
}

function normalizeShortcutKey(event: React.KeyboardEvent<HTMLButtonElement>): string {
  const keyMap: Record<string, string> = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Esc: 'Escape'
  }
  const rawKey = keyMap[event.key] ?? event.key
  const key = rawKey.length === 1 ? rawKey.toUpperCase() : rawKey
  const modifierKeys = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift'])
  if (modifierKeys.has(key)) return ''

  const parts: string[] = []
  if (event.metaKey || event.ctrlKey) parts.push('CommandOrControl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  parts.push(key)
  if (parts.length === 1 && !/^F\d{1,2}$/.test(key)) return ''
  return parts.join('+')
}

function ShortcutRecorder({
  value,
  label,
  onChange,
  t
}: {
  value: string
  label: string
  onChange: (value: string) => void
  t: (key: string) => string
}) {
  const [recording, setRecording] = React.useState(false)
  const parts = formatShortcut(value)

  return (
    <div className="shortcut-recorder">
      <button
        className={recording ? 'shortcut-button recording' : 'shortcut-button'}
        type="button"
        aria-label={label}
        onBlur={() => setRecording(false)}
        onClick={() => setRecording(true)}
        onKeyDown={(event) => {
          if (!recording) return
          event.preventDefault()
          event.stopPropagation()

          if (event.key === 'Escape') {
            setRecording(false)
            return
          }

          if (event.key === 'Backspace' || event.key === 'Delete') {
            onChange('')
            setRecording(false)
            return
          }

          const shortcut = normalizeShortcutKey(event)
          if (!shortcut) return
          onChange(shortcut)
          setRecording(false)
        }}>
        {recording ? (
          <span className="shortcut-recording-text">{t('shortcutRecording')}</span>
        ) : parts.length ? (
          parts.map((part) => (
            <span className="keycap" key={part}>
              {part}
            </span>
          ))
        ) : (
          <span className="shortcut-empty">{t('shortcutUnset')}</span>
        )}
      </button>
      {value && (
        <button className="shortcut-clear" type="button" onClick={() => onChange('')} title={t('shortcutClear')}>
          {t('shortcutClear')}
        </button>
      )}
    </div>
  )
}

function ActionConfigRow({
  action,
  defaultAction,
  language,
  onChange,
  t
}: {
  action: ActionItem
  defaultAction?: ActionItem
  language: AppLanguage
  onChange: (patch: Partial<ActionItem>) => void
  t: (key: string) => string
}) {
  const [expanded, setExpanded] = React.useState(false)
  const isPromptAction = action.type === 'prompt'
  const defaultPrompt = defaultAction?.promptTemplate ?? ''

  return (
    <div className="action-config-item">
      <div className="action-config-row">
        <span className="action-name">
          <Icon name={action.icon} />
          <span>{getActionLabel(action, language)}</span>
        </span>
        {isPromptAction ? (
          <button className="prompt-edit-button" type="button" onClick={() => setExpanded((value) => !value)}>
            {expanded ? t('hidePrompt') : t('editPrompt')}
          </button>
        ) : (
          <span className="action-row-spacer" />
        )}
        <Toggle checked={action.enabled} label={getActionLabel(action, language)} onChange={(enabled) => onChange({ enabled })} />
      </div>
      {isPromptAction && expanded && (
        <div className="prompt-template-editor">
          <textarea
            value={action.promptTemplate ?? ''}
            placeholder={t('promptTemplatePlaceholder')}
            onChange={(event) => onChange({ promptTemplate: event.target.value })}
          />
          <button type="button" onClick={() => onChange({ promptTemplate: defaultPrompt })} disabled={!defaultPrompt}>
            {t('restoreDefaultPrompt')}
          </button>
        </div>
      )}
    </div>
  )
}

function SettingsApp() {
  const { settings, loaded, update } = useSettings()
  const [accessibilityTrusted, setAccessibilityTrusted] = React.useState(true)
  const [activeSection, setActiveSection] = React.useState<SettingsSectionId>('api')
  const [models, setModels] = React.useState<string[]>([])
  const [modelStatus, setModelStatus] = React.useState('')
  const [modelBusy, setModelBusy] = React.useState<'list' | 'test' | null>(null)
  const t = getTranslator(settings.language)
  const selectableModels = models.filter((model) => model !== settings.provider.model)
  useThemeMode(settings.theme)

  React.useEffect(() => {
    document.documentElement.classList.add('settings-page-root')
    document.body.classList.add('settings-body')
    return () => {
      document.documentElement.classList.remove('settings-page-root')
      document.body.classList.remove('settings-body')
    }
  }, [])

  React.useEffect(() => {
    void window.assistantLite.selection.getAccessibility().then(setAccessibilityTrusted)
  }, [settings.enabled])

  React.useEffect(() => {
    document.documentElement.lang = settings.language
    document.title = t('appTitle')
  }, [settings.language])

  if (!loaded) return <main className="page">{t('loading')}</main>

  const updateProvider = (field: string, value: string | number) => {
    void update({ provider: { [field]: value } })
  }

  const listProviderModels = async () => {
    setModelBusy('list')
    setModelStatus(t('modelListLoading'))
    try {
      const nextModels = await window.assistantLite.ai.listModels()
      setModels(nextModels)
      setModelStatus(nextModels.length ? t('modelListSuccess').replace('{{count}}', String(nextModels.length)) : t('modelListEmpty'))
    } catch (error) {
      setModelStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setModelBusy(null)
    }
  }

  const testProviderModel = async () => {
    setModelBusy('test')
    setModelStatus(t('modelTestLoading'))
    try {
      await window.assistantLite.ai.testModel()
      setModelStatus(t('modelTestSuccess'))
    } catch (error) {
      setModelStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setModelBusy(null)
    }
  }

  const updateAction = (id: string, patch: Partial<ActionItem>) => {
    void update({
      actions: settings.actions.map((action) => (action.id === id ? { ...action, ...patch } : action))
    })
  }

  const updateShortcut = (field: keyof ShortcutSettings, value: string) => {
    void update({ shortcuts: { [field]: value } })
  }

  const sections: SettingsSectionMeta[] = [
    { id: 'api', label: t('sectionApi') },
    { id: 'selection', label: t('sectionSelection') },
    { id: 'window', label: t('sectionWindow') },
    { id: 'actions', label: t('sectionActions') }
  ]
  const defaultActionById = new Map(defaultActions.map((action) => [action.id, action]))
  const filterText = settings.filterList.join('\n')
  const activeProviderTemplate =
    settings.providerTemplates.find((template) => template.id === settings.activeProviderTemplateId) ?? settings.providerTemplates[0]
  const toggleAssistantEnabled = async () => {
    if (!settings.enabled) {
      const trusted = await window.assistantLite.selection.getAccessibility()
      setAccessibilityTrusted(trusted)
      if (!trusted) {
        await window.assistantLite.selection.requestAccessibility()
        return
      }
    }
    void update({ enabled: !settings.enabled })
  }

  const cycleTheme = () => {
    const nextTheme: Record<ThemeMode, ThemeMode> = {
      system: 'light',
      light: 'dark',
      dark: 'system'
    }
    void update({ theme: nextTheme[settings.theme] })
  }

  const themeIconName: Record<ThemeMode, string> = {
    system: 'laptop',
    light: 'sun',
    dark: 'moon'
  }

  const renderSection = () => {
    if (activeSection === 'api') {
      const createProviderTemplate = () => {
        const nextTemplate: ProviderTemplate = {
          id: crypto.randomUUID(),
          name: `${t('providerTemplateDefaultName')} ${settings.providerTemplates.length + 1}`,
          provider: settings.provider
        }
        void update({
          providerTemplates: [...settings.providerTemplates, nextTemplate],
          activeProviderTemplateId: nextTemplate.id
        })
      }

      const handleProviderTemplateSelect = (value: string) => {
        if (value === '__new__') {
          createProviderTemplate()
          return
        }
        void update({ activeProviderTemplateId: value })
      }

      const deleteActiveProviderTemplate = () => {
        if (!activeProviderTemplate || settings.providerTemplates.length <= 1) return
        const remainingTemplates = settings.providerTemplates.filter((template) => template.id !== activeProviderTemplate.id)
        void update({
          providerTemplates: remainingTemplates,
          activeProviderTemplateId: remainingTemplates[0]?.id
        })
      }

      return (
        <div className="settings-stack">
          <SettingSection title={t('providerTitle')}>
            <div className="form-grid">
              <label className="field">
                <span>{t('providerTemplate')}</span>
                <select
                  value={settings.activeProviderTemplateId}
                  onChange={(event) => handleProviderTemplateSelect(event.target.value)}>
                  {settings.providerTemplates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                  <option value="__new__">{t('providerTemplateNew')}</option>
                </select>
              </label>
              <label className="field">
                <span>{t('providerTemplateName')}</span>
                <input
                  value={activeProviderTemplate?.name ?? ''}
                  onChange={(event) =>
                    update({
                      providerTemplates: settings.providerTemplates.map((template) =>
                        template.id === settings.activeProviderTemplateId ? { ...template, name: event.target.value } : template
                      )
                    })
                  }
                />
              </label>
              <label className="field">
                <span>{t('apiType')}</span>
                <select value={settings.provider.apiType} onChange={(event) => updateProvider('apiType', event.target.value)}>
                  <option value="openai">{t('apiTypeOpenAI')}</option>
                  <option value="anthropic">{t('apiTypeAnthropic')}</option>
                </select>
              </label>
              <label className="field">
                <span>{t('baseUrl')}</span>
                <input value={settings.provider.baseUrl} onChange={(event) => updateProvider('baseUrl', event.target.value)} />
              </label>
              {settings.provider.apiType === 'anthropic' && <div className="model-status">{t('baseUrlAnthropicHint')}</div>}
              <label className="field">
                <div className="field-header">
                  <span>{t('model')}</span>
                  <div className="inline-actions">
                    <button className="inline-action-button" type="button" onClick={listProviderModels} disabled={modelBusy !== null}>
                      {modelBusy === 'list' ? t('modelListLoading') : t('fetchModels')}
                    </button>
                    <button
                      className="inline-icon-button"
                      type="button"
                      title={modelBusy === 'test' ? t('modelTestLoading') : t('testModel')}
                      aria-label={modelBusy === 'test' ? t('modelTestLoading') : t('testModel')}
                      onClick={testProviderModel}
                      disabled={modelBusy !== null}>
                      <Icon name="flask-conical" size={14} />
                    </button>
                    <button
                      className="inline-icon-button danger"
                      type="button"
                      title={t('providerTemplateDelete')}
                      aria-label={t('providerTemplateDelete')}
                      onClick={deleteActiveProviderTemplate}
                      disabled={settings.providerTemplates.length <= 1 || !activeProviderTemplate}>
                      <Icon name="trash-2" size={14} />
                    </button>
                  </div>
                </div>
                <input value={settings.provider.model} onChange={(event) => updateProvider('model', event.target.value)} />
              </label>
              {models.length > 0 && (
                <label className="field">
                  <span>{t('modelList')}</span>
                  <select value={settings.provider.model} onChange={(event) => updateProvider('model', event.target.value)}>
                    <option value={settings.provider.model}>{settings.provider.model || t('modelSelectPlaceholder')}</option>
                    {selectableModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="field">
                <span>{t('apiKey')}</span>
                <input
                  type="password"
                  value={settings.provider.apiKey}
                  onChange={(event) => updateProvider('apiKey', event.target.value)}
                />
              </label>
              {modelStatus && <div className="model-status">{modelStatus}</div>}
            </div>
          </SettingSection>
        </div>
      )
    }

    if (activeSection === 'selection') {
      return (
        <div className="settings-stack">
          <SettingSection title={t('selectionTriggerGroup')}>
            <SettingRow title={t('triggerMode')}>
              <select value={settings.triggerMode} onChange={(event) => update({ triggerMode: event.target.value as TriggerMode })}>
                <option value="selected">{t('triggerSelected')}</option>
                <option value="shortcut">{t('triggerShortcut')}</option>
              </select>
            </SettingRow>
          </SettingSection>

          <SettingSection title={t('selectionShortcutGroup')}>
            <SettingRow title={t('shortcutToggleAssistant')} description={t('shortcutRecordHint')} className="shortcut-row">
              <ShortcutRecorder
                value={settings.shortcuts.toggleAssistant}
                label={t('shortcutToggleAssistant')}
                onChange={(value) => updateShortcut('toggleAssistant', value)}
                t={t}
              />
            </SettingRow>
            <SettingRow
              title={t('shortcutProcessSelection')}
              description={t('shortcutProcessSelectionDesc')}
              className="shortcut-row">
              <ShortcutRecorder
                value={settings.shortcuts.processSelection}
                label={t('shortcutProcessSelection')}
                onChange={(value) => updateShortcut('processSelection', value)}
                t={t}
              />
            </SettingRow>
          </SettingSection>

          <SettingSection title={t('selectionToolbarGroup')}>
            <SettingRow title={t('compactToolbar')} description={t('compactToolbarDesc')}>
              <Toggle
                checked={settings.compactToolbar}
                label={t('compactToolbar')}
                onChange={(compactToolbar) => update({ compactToolbar })}
              />
            </SettingRow>
            <SettingRow title={t('showToolbarAppIcon')} description={t('showToolbarAppIconDesc')}>
              <Toggle
                checked={settings.showToolbarAppIcon}
                label={t('showToolbarAppIcon')}
                onChange={(showToolbarAppIcon) => update({ showToolbarAppIcon })}
              />
            </SettingRow>
          </SettingSection>

          <SettingSection title={t('selectionFilterGroup')}>
            <SettingRow title={t('filterMode')}>
              <select value={settings.filterMode} onChange={(event) => update({ filterMode: event.target.value as FilterMode })}>
                <option value="default">{t('filterDefault')}</option>
                <option value="whitelist">{t('filterWhitelist')}</option>
                <option value="blacklist">{t('filterBlacklist')}</option>
              </select>
            </SettingRow>
            <SettingRow title={t('filterList')} description={t('filterListPlaceholder')} className="tall">
              <textarea
                value={filterText}
                placeholder={t('filterListPlaceholder')}
                onChange={(event) =>
                  update({
                    filterList: event.target.value
                      .split('\n')
                      .map((item) => item.trim().toLowerCase())
                      .filter(Boolean)
                  })
                }
              />
            </SettingRow>
          </SettingSection>
        </div>
      )
    }

    if (activeSection === 'window') {
      return (
        <div className="settings-stack">
          <SettingSection title={t('actionWindowTitle')}>
            <SettingRow title={t('followToolbar')}>
              <Toggle checked={settings.followToolbar} label={t('followToolbar')} onChange={(followToolbar) => update({ followToolbar })} />
            </SettingRow>
            <SettingRow title={t('rememberWindowSize')}>
              <Toggle
                checked={settings.rememberWindowSize}
                label={t('rememberWindowSize')}
                onChange={(rememberWindowSize) => update({ rememberWindowSize })}
              />
            </SettingRow>
            <SettingRow title={t('autoClose')}>
              <Toggle checked={settings.autoClose} label={t('autoClose')} onChange={(autoClose) => update({ autoClose })} />
            </SettingRow>
            <SettingRow title={t('autoPin')}>
              <Toggle checked={settings.autoPin} label={t('autoPin')} onChange={(autoPin) => update({ autoPin })} />
            </SettingRow>
          </SettingSection>
        </div>
      )
    }

    return (
      <div className="settings-stack">
        <SettingSection title={t('actions')}>
          <div className="action-list">
            {settings.actions.map((action) => (
              <ActionConfigRow
                key={action.id}
                action={action}
                defaultAction={defaultActionById.get(action.id)}
                language={settings.language}
                onChange={(patch) => updateAction(action.id, patch)}
                t={t}
              />
            ))}
          </div>
        </SettingSection>
      </div>
    )
  }

  return (
    <main className="page settings-page">
      <div className="settings-shell">
        <header className="settings-header">
          <div className="settings-toolbar">
            <div className="language-segment" role="group" aria-label={t('language')}>
              <button
                type="button"
                className={settings.language === 'zh-CN' ? 'language-segment-button active' : 'language-segment-button'}
                aria-pressed={settings.language === 'zh-CN'}
                onClick={() => update({ language: 'zh-CN' as AppLanguage })}>
                CN
              </button>
              <button
                type="button"
                className={settings.language === 'en' ? 'language-segment-button active' : 'language-segment-button'}
                aria-pressed={settings.language === 'en'}
                onClick={() => update({ language: 'en' as AppLanguage })}>
                EN
              </button>
            </div>
            <div className="status-control">
              <button
                type="button"
                className="theme-toggle"
                title={t(`theme_${settings.theme}`)}
                aria-label={t(`theme_${settings.theme}`)}
                onClick={cycleTheme}>
                <Icon name={themeIconName[settings.theme]} size={14} />
              </button>
              <span className={settings.enabled ? 'status-label enabled' : 'status-label'}>
                {settings.enabled ? t('statusEnabled') : t('statusDisabled')}
              </span>
              <Toggle checked={settings.enabled} label={t('shortcutToggleAssistant')} onChange={() => void toggleAssistantEnabled()} />
            </div>
          </div>
        </header>

        {!accessibilityTrusted && (
          <section className="accessibility-panel">
            <div>
              <h2>{t('accessibilityTitle')}</h2>
              <p>{t('accessibilityBody')}</p>
            </div>
            <button className="primary" onClick={() => window.assistantLite.selection.requestAccessibility()}>
              {t('accessibilityButton')}
            </button>
          </section>
        )}

        <div className="settings-layout">
          <SettingsNav sections={sections} activeSection={activeSection} onChange={setActiveSection} />

          <section className="settings-content">
            {renderSection()}
          </section>
        </div>
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>
)
