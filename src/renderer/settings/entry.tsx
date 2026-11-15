import '../styles.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { useSettings } from '../useSettings'
import { Icon } from '../icons'
import { defaultActions, defaultPrimaryColor, defaultPrimaryColors } from '@shared/defaults'
import { hexToRgb, normalizeHexColor, rgbToTone } from '@shared/theme'
import { TRANSLATE_SERVICE_IDS } from '@shared/translate'
import { useSystemAccentColor, useThemeMode } from '../useThemeMode'
import { useAppearance } from '../useAppearance'
import { getActionLabel, getTranslator } from '../i18n'
import { ProviderNameInput } from './ProviderNameInput'
import { SettingInput, SettingTextarea } from './SettingInput'
import type {
  ActionItem,
  AppLanguage,
  AppSettings,
  ColorStyle,
  FilterMode,
  OcrEngineId,
  OcrEngineStatusPayload,
  ProviderTemplate,
  ReasoningMode,
  ShortcutSettings,
  ThemeMode,
  TranslateServiceId,
  TriggerMode,
  VocabEntry
} from '@shared/types'
import { version as APP_VERSION } from '../../../package.json'

const GITHUB_REPO_URL = 'https://github.com/XD06/FlashAgent-assistant'

type SettingsSectionId = 'api' | 'actions' | 'selection' | 'translate' | 'vocabulary' | 'window'

// The system OCR engine wraps Windows.Media.Ocr; it cannot exist elsewhere.
const isWindows = navigator.platform.toLowerCase().includes('win')

type SettingsSectionMeta = {
  id: SettingsSectionId
  label: string
  icon: string
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
  onChange,
  t
}: {
  sections: SettingsSectionMeta[]
  activeSection: SettingsSectionId
  onChange: (section: SettingsSectionId) => void
  t: (key: string) => string
}) {
  return (
    <aside className="settings-sidebar" aria-label="Settings sections">
      {sections.map((section) => (
        <button
          key={section.id}
          className={section.id === activeSection ? 'settings-nav-button active' : 'settings-nav-button'}
          onClick={() => onChange(section.id)}
          type="button">
          <Icon name={section.icon} size={14} />
          <span>{section.label}</span>
        </button>
      ))}
      <div className="settings-sidebar-footer">
        <button
          className="settings-github-link"
          type="button"
          title={t('githubRepoTooltip')}
          aria-label={t('githubRepoTooltip')}
          onClick={() => void window.assistantLite.app.openExternal(GITHUB_REPO_URL)}>
          <Icon name="github" size={14} />
          <span className="settings-version">v{APP_VERSION}</span>
        </button>
      </div>
    </aside>
  )
}

function SettingSection({ title, className, children }: { title: string; className?: string; children: React.ReactNode }) {
  return (
    <section className={className ? `setting-section ${className}` : 'setting-section'}>
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

function NumberField({
  value,
  min,
  max,
  step,
  onCommit
}: {
  value: number
  min: number
  max?: number
  step?: number
  onCommit: (value: number) => void
}) {
  const [text, setText] = React.useState(String(value))
  const focusedRef = React.useRef(false)
  React.useEffect(() => {
    if (!focusedRef.current) setText(String(value))
  }, [value])
  const commit = () => {
    const parsed = parseInt(text, 10)
    if (Number.isFinite(parsed)) {
      const clampedMin = Math.max(min, parsed)
      const clamped = max !== undefined ? Math.min(max, clampedMin) : clampedMin
      setText(String(clamped))
      onCommit(clamped)
    } else {
      setText(String(value))
    }
  }
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={text}
      onFocus={() => {
        focusedRef.current = true
      }}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        focusedRef.current = false
        commit()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
      }}
    />
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

/** Curated Edge TTS voices for speech synthesis; a stored custom voice is
 * appended to the list so the select can always display it. */
const TTS_VOICE_CHOICES: Array<{ value: string; labelKey: string }> = [
  { value: 'zh-CN-XiaoxiaoNeural', labelKey: 'ttsVoiceXiaoxiao' },
  { value: 'zh-CN-XiaoyiNeural', labelKey: 'ttsVoiceXiaoyi' },
  { value: 'zh-CN-YunxiNeural', labelKey: 'ttsVoiceYunxi' },
  { value: 'zh-CN-YunjianNeural', labelKey: 'ttsVoiceYunjian' },
  { value: 'zh-CN-YunyangNeural', labelKey: 'ttsVoiceYunyang' },
  { value: 'zh-HK-HiuMaanNeural', labelKey: 'ttsVoiceHkHiuMaan' },
  { value: 'zh-TW-HsiaoChenNeural', labelKey: 'ttsVoiceTwHsiaoChen' },
  { value: 'en-US-JennyNeural', labelKey: 'ttsVoiceJenny' },
  { value: 'en-US-GuyNeural', labelKey: 'ttsVoiceGuy' },
  { value: 'en-US-ChristopherNeural', labelKey: 'ttsVoiceChristopher' },
  { value: 'en-GB-SoniaNeural', labelKey: 'ttsVoiceSonia' },
  { value: 'ja-JP-NanamiNeural', labelKey: 'ttsVoiceNanami' },
  { value: 'ko-KR-SunHiNeural', labelKey: 'ttsVoiceSunHi' }
]

const MIMO_VOICE_CHOICES: Array<{ value: string; labelKey: string }> = [
  { value: '冰糖', labelKey: 'ttsMimoVoiceBingtang' },
  { value: '茉莉', labelKey: 'ttsMimoVoiceMoli' },
  { value: '苏打', labelKey: 'ttsMimoVoiceSuda' },
  { value: '白桦', labelKey: 'ttsMimoVoiceBaihua' },
  { value: 'Mia', labelKey: 'ttsMimoVoiceMia' },
  { value: 'Chloe', labelKey: 'ttsMimoVoiceChloe' },
  { value: 'Milo', labelKey: 'ttsMimoVoiceMilo' },
  { value: 'Dean', labelKey: 'ttsMimoVoiceDean' }
]

const ACTION_ICON_CHOICES = [
  'sparkles',
  'languages',
  'circle-help',
  'scan-text',
  'search',
  'copy',
  'volume-2',
  'book-open',
  'pencil',
  'flask-conical',
  'mouse-pointer',
  'download',
  'arrow-up-right'
]

function IconPicker({ value, onChange }: { value: string; onChange: (icon: string) => void }) {
  return (
    <div className="icon-picker">
      {ACTION_ICON_CHOICES.map((name) => (
        <button
          key={name}
          type="button"
          className={name === value ? 'icon-choice active' : 'icon-choice'}
          onClick={() => onChange(name)}
          aria-label={name}>
          <Icon name={name} size={19} />
        </button>
      ))}
    </div>
  )
}

function ActionEditor({
  action,
  defaultAction,
  language,
  providerTemplates,
  index,
  count,
  onChange,
  onDelete,
  onMove,
  t
}: {
  action: ActionItem
  defaultAction?: ActionItem
  language: AppLanguage
  providerTemplates: ProviderTemplate[]
  index: number
  count: number
  onChange: (patch: Partial<ActionItem>) => void
  onDelete: () => void
  onMove: (dir: -1 | 1) => void
  t: (key: string) => string
}) {
  const [expanded, setExpanded] = React.useState(false)
  const isPrompt = action.type === 'prompt'
  const isSearch = action.type === 'search'
  const isCustom = !defaultAction
  const defaultPrompt = defaultAction?.promptTemplate ?? ''


  return (
    <div className="action-config-item">
      <div className="action-config-row">
        <span className="action-name">
          <Icon name={action.icon} size={18} />
          <span>{getActionLabel(action, language)}</span>
        </span>
        <div className="action-row-tools">
          <button className="inline-icon-button" type="button" title={t('moveUp')} onClick={() => onMove(-1)} disabled={index === 0}>
            <Icon name="arrow-up" size={13} />
          </button>
          <button
            className="inline-icon-button"
            type="button"
            title={t('moveDown')}
            onClick={() => onMove(1)}
            disabled={index === count - 1}>
            <Icon name="arrow-down" size={13} />
          </button>
          <button className="prompt-edit-button" type="button" onClick={() => setExpanded((value) => !value)}>
            {expanded ? t('hidePrompt') : t('editPrompt')}
          </button>
        </div>
        <Toggle checked={action.enabled} label={getActionLabel(action, language)} onChange={(enabled) => onChange({ enabled })} />
      </div>
      {expanded && (
        <div className="prompt-template-editor">
          <div className="action-meta">
            <label className="field">
              <span>{t('actionName')}</span>
              <SettingInput
                value={action.name}
                placeholder={getActionLabel(action, language)}
                onChange={(name) => onChange({ name })}
              />
            </label>
            <label className="field">
              <span>{t('actionIcon')}</span>
              <IconPicker value={action.icon} onChange={(icon) => onChange({ icon })} />
            </label>
          </div>

          {isPrompt && (
            <SettingTextarea
              value={action.promptTemplate ?? ''}
              placeholder={t('promptTemplatePlaceholder')}
              onChange={(promptTemplate) => onChange({ promptTemplate })}
            />
          )}

          {isSearch && (
            <label className="field">
              <span>{t('searchUrlLabel')}</span>
              <SettingInput
                value={action.searchUrlTemplate ?? ''}
                placeholder="https://www.google.com/search?q={{query}}"
                onChange={(searchUrlTemplate) => onChange({ searchUrlTemplate })}
              />
            </label>
          )}

          {isPrompt && (
            <div className="action-ai-options">
              <label className="field">
                <span>{t('actionProvider')}</span>
                <select
                  value={action.providerTemplateId ?? ''}
                  onChange={(event) => onChange({ providerTemplateId: event.target.value || undefined })}>
                  <option value="">{t('actionProviderDefault')}</option>
                  {providerTemplates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('actionModel')}</span>
                <SettingInput
                  value={action.model ?? ''}
                  placeholder={t('actionModelPlaceholder')}
                  onChange={(val) => onChange({ model: val.trim() || undefined })}
                />
              </label>
              <label className="field">
                <span>{t('actionReasoning')}</span>
                <select
                  value={action.reasoning ?? 'on'}
                  onChange={(event) => onChange({ reasoning: event.target.value as ReasoningMode })}>
                  <option value="on">{t('reasoningOn')}</option>
                  <option value="off">{t('reasoningOff')}</option>
                  <option value="low">{t('reasoningLow')}</option>
                  <option value="medium">{t('reasoningMedium')}</option>
                  <option value="high">{t('reasoningHigh')}</option>
                </select>
              </label>
              <label className="field">
                <span>{t('actionWebSearch')}</span>
                <select
                  value={action.webSearch === undefined ? 'inherit' : action.webSearch ? 'on' : 'off'}
                  onChange={(event) => {
                    const val = event.target.value
                    onChange({ webSearch: val === 'inherit' ? undefined : val === 'on' })
                  }}>
                  <option value="inherit">{t('actionWebSearchInherit')}</option>
                  <option value="on">{t('actionWebSearchOn')}</option>
                  <option value="off">{t('actionWebSearchOff')}</option>
                </select>
              </label>
            </div>
          )}

          {((isPrompt && defaultPrompt) || isCustom) && (
            <div className="action-editor-footer">
              {isPrompt && defaultPrompt && (
                <button
                  type="button"
                  onClick={() => {
                    onChange({ promptTemplate: defaultPrompt })
                  }}>
                  {t('restoreDefaultPrompt')}
                </button>
              )}
              {isCustom && (
                <button type="button" className="danger-text" onClick={onDelete}>
                  {t('deleteAction')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Compact one-line meanings for a grid chip: "n.闪耀 v.使闪光". */
function chipMeanings(entry: VocabEntry): string {
  return entry.meanings
    .slice(0, 3)
    .map((meaning) => `${meaning.partOfSpeech ?? ''}${meaning.means[0] ?? ''}`)
    .join(' ')
    .trim()
}

function VocabularySection({ t }: { t: (key: string) => string }) {
  const [entries, setEntries] = React.useState<VocabEntry[] | null>(null)
  const [search, setSearch] = React.useState('')
  const [detail, setDetail] = React.useState<VocabEntry | null>(null)
  const [confirmingClear, setConfirmingClear] = React.useState(false)
  const clearTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = React.useCallback(async () => {
    setEntries(await window.assistantLite.vocabulary.list())
  }, [])

  React.useEffect(() => {
    void refresh()
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    }
  }, [refresh])

  // Escape closes the detail modal.
  React.useEffect(() => {
    if (!detail) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDetail(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detail])

  const removeWord = async (word: string) => {
    await window.assistantLite.vocabulary.remove(word)
    setDetail(null)
    void refresh()
  }

  const clearAll = async () => {
    if (!confirmingClear) {
      setConfirmingClear(true)
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
      clearTimerRef.current = setTimeout(() => setConfirmingClear(false), 3000)
      return
    }
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    setConfirmingClear(false)
    await window.assistantLite.vocabulary.clear()
    setDetail(null)
    void refresh()
  }

  const exportAll = async () => {
    await window.assistantLite.vocabulary.exportFile()
  }

  const filtered = (entries ?? []).filter((entry) =>
    entry.word.toLowerCase().includes(search.trim().toLowerCase())
  )

  return (
    <div className="settings-stack settings-stack--vocabulary">
      <SettingSection title={t('sectionVocabulary')}>
        <div className="vocab-toolbar">
          <SettingInput
            className="vocab-search"
            value={search}
            placeholder={t('vocabSearch')}
            debounceMs={150}
            onChange={setSearch}
          />
          <span className="vocab-count">{t('vocabCount').replace('{{count}}', String(filtered.length))}</span>
          <button type="button" className="pill" onClick={() => void exportAll()} disabled={!entries?.length}>
            {t('vocabExport')}
          </button>
          <button
            type="button"
            className={confirmingClear ? 'pill danger-pill' : 'pill'}
            onClick={() => void clearAll()}
            disabled={!entries?.length}>
            {confirmingClear ? t('vocabClearConfirm') : t('vocabClear')}
          </button>
        </div>

        {entries?.length === 0 ? (
          <div className="vocab-empty">{t('vocabEmpty')}</div>
        ) : (
          <div className="vocab-grid">
            {filtered.map((entry) => (
              <button type="button" className="vocab-chip" key={entry.word} onClick={() => setDetail(entry)}>
                <span className="vocab-chip__word">{entry.word}</span>
                <span className="vocab-chip__mean">{chipMeanings(entry)}</span>
              </button>
            ))}
          </div>
        )}
      </SettingSection>

      {detail && (
        <div className="vocab-modal-backdrop" onClick={() => setDetail(null)}>
          <div className="vocab-modal" onClick={(event) => event.stopPropagation()}>
            <div className="vocab-modal__head">
              <strong>{detail.word}</strong>
              <button type="button" className="inline-icon-button" onClick={() => setDetail(null)} aria-label="close">
                <Icon name="x" size={14} />
              </button>
            </div>
            <div className="vocab-modal__body">
              {detail.phonetics.length > 0 && (
                <div className="tr-dict__phonetics">
                  {detail.phonetics.map((phonetic) => (
                    <span className="tr-dict__phonetic" key={phonetic.label}>
                      <span className={`tr-dict__phonetic-tag tr-dict__phonetic-tag--${phonetic.label}`}>{phonetic.label}</span>
                      <span className="tr-dict__phonetic-text">/{phonetic.phonetic}/</span>
                      {phonetic.audioUrl && (
                        <button
                          type="button"
                          className="tr-tool-button"
                          onClick={() => {
                            const audio = new Audio(phonetic.audioUrl)
                            void audio.play().catch(() => {})
                          }}>
                          <Icon name="volume-2" size={13} />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}
              <div className="tr-dict__meanings">
                {detail.meanings.map((meaning, index) => (
                  <div className="tr-dict__meaning" key={index}>
                    {meaning.partOfSpeech && <span className="tr-dict__pos">{meaning.partOfSpeech}</span>}
                    <span className="tr-dict__means">{meaning.means.join('；')}</span>
                  </div>
                ))}
              </div>
              <ExchangeLines exchange={detail.exchange} t={t} />
            </div>
            <div className="vocab-modal__foot">
              <button type="button" className="danger-text" onClick={() => void removeWord(detail.word)}>
                {t('vocabDelete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Word-form lines (plural, past tense…) shared by dict-like views. */
function ExchangeLines({ exchange, t }: { exchange: VocabEntry['exchange']; t: (key: string) => string }) {
  const labels: Array<[keyof VocabEntry['exchange'], string]> = [
    ['plurals', 'dictPlurals'],
    ['pastTense', 'dictPastTense'],
    ['pastParticiple', 'dictPastParticiple'],
    ['presentParticiple', 'dictPresentParticiple'],
    ['thirdPersonSingular', 'dictThirdPerson'],
    ['comparative', 'dictComparative'],
    ['superlative', 'dictSuperlative']
  ]
  const rows = labels.filter(([key]) => exchange[key]?.length)
  if (!rows.length) return null
  return (
    <div className="tr-dict__exchange">
      {rows.map(([key, labelKey]) => (
        <span className="tr-dict__exchange-item" key={key}>
          {t(labelKey)}：{exchange[key]!.join('、')}
        </span>
      ))}
    </div>
  )
}

function ThemeAppearanceSection({
  settings,
  onUpdate,
  t
}: {
  settings: AppSettings
  onUpdate: (patch: Partial<AppSettings>) => void
  t: (key: string) => string
}) {
  const systemAccent = useSystemAccentColor()
  const sessionAddedRef = React.useRef<string | null>(null)
  const themeModes: Array<{ value: ThemeMode; label: string; icon: string }> = [
    { value: 'system', label: t('themeModeSystem'), icon: 'laptop' },
    { value: 'light', label: t('themeModeLight'), icon: 'sun' },
    { value: 'dark', label: t('themeModeDark'), icon: 'moon' }
  ]
  const colorStyles: Array<{ value: ColorStyle; label: string }> = [
    { value: 'vivid', label: t('colorStyle_vivid') },
    { value: 'tinted', label: t('colorStyle_tinted') },
    { value: 'soft', label: t('colorStyle_soft') },
    { value: 'monochrome', label: t('colorStyle_monochrome') }
  ]

  const isDefaultColors =
    settings.primaryColor === defaultPrimaryColor &&
    settings.colorStyle === 'vivid' &&
    settings.primaryColors.length === defaultPrimaryColors.length &&
    settings.primaryColors.every((color, idx) => color === defaultPrimaryColors[idx])

  const swatchCheckInk = (hex: string) => (rgbToTone(hexToRgb(hex)) <= 60 ? '#ffffff' : '#141418')

  const handleResetColors = () => {
    sessionAddedRef.current = null
    onUpdate({
      primaryColor: defaultPrimaryColor,
      primaryColors: [...defaultPrimaryColors],
      colorStyle: 'vivid'
    })
  }

  const handleRemoveColor = (color: string) => {
    const nextColors = settings.primaryColors.filter((item) => item !== color)
    let nextPrimary = settings.primaryColor
    if (nextPrimary === color) {
      nextPrimary = nextColors.includes(defaultPrimaryColor) ? defaultPrimaryColor : (nextColors[0] ?? null)
    }
    onUpdate({ primaryColors: nextColors, primaryColor: nextPrimary })
  }

  const handlePickCustomColor = (rawValue: string) => {
    const hex = normalizeHexColor(rawValue)
    if (!hex) return
    const prevAdded = sessionAddedRef.current
    const withoutSession = prevAdded ? settings.primaryColors.filter((c) => c !== prevAdded) : settings.primaryColors
    const alreadyExists = withoutSession.includes(hex)
    const nextColors = alreadyExists ? withoutSession : [...withoutSession, hex]
    sessionAddedRef.current = alreadyExists ? null : hex
    onUpdate({ primaryColors: nextColors, primaryColor: hex })
  }

  const pickerValue = normalizeHexColor(settings.primaryColor) ?? normalizeHexColor(systemAccent) ?? defaultPrimaryColor

  return (
    <SettingSection title={t('appearanceThemeGroup')} className="theme-appearance-section">
      <div className="theme-appearance-stack">
        <SettingRow title={t('themeMode')}>
          <div className="theme-segmented" role="group" aria-label={t('themeMode')}>
            {themeModes.map((item) => {
              const active = settings.theme === item.value
              return (
                <button
                  key={item.value}
                  type="button"
                  className={active ? 'theme-segmented-btn active' : 'theme-segmented-btn'}
                  aria-pressed={active}
                  onClick={() => onUpdate({ theme: item.value })}>
                  <Icon name={item.icon} size={13} />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>
        </SettingRow>

        <SettingRow title={t('pureBlack')} description={t('pureBlackDesc')}>
          <Toggle
            checked={settings.pureBlack}
            label={t('pureBlack')}
            onChange={(pureBlack) => onUpdate({ pureBlack })}
          />
        </SettingRow>

        <div className="theme-color-block">
          <div className="theme-color-header">
            <span className="setting-title">{t('primaryColor')}</span>
            {!isDefaultColors && (
              <button type="button" className="theme-reset-btn" onClick={handleResetColors}>
                <Icon name="refresh-cw" size={11} />
                <span>{t('resetThemeColors')}</span>
              </button>
            )}
          </div>

          <div className="theme-swatches-box" role="radiogroup" aria-label={t('primaryColor')}>
            <div className="theme-swatch-item">
              <button
                type="button"
                role="radio"
                aria-checked={settings.primaryColor === null}
                aria-label={`${t('followSystemColor')} (${systemAccent})`}
                title={`${t('followSystemColor')} (${systemAccent})`}
                className={settings.primaryColor === null ? 'theme-swatch-btn active' : 'theme-swatch-btn'}
                onClick={() => onUpdate({ primaryColor: null })}>
                <span className="theme-swatch-dot" style={{ background: systemAccent }}>
                  {settings.primaryColor === null && (
                    <span style={{ color: swatchCheckInk(systemAccent), display: 'inline-flex' }}>
                      <Icon name="check" size={14} />
                    </span>
                  )}
                </span>
              </button>
              <span className="theme-swatch-system-badge" aria-hidden="true">
                <Icon name="laptop" size={9} />
              </span>
            </div>

            <span className="theme-swatch-divider" aria-hidden="true" />

            {settings.primaryColors.map((color) => {
              const selected = settings.primaryColor === color
              return (
                <div className="theme-swatch-item" key={color}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={color}
                    title={color}
                    className={selected ? 'theme-swatch-btn active' : 'theme-swatch-btn'}
                    onClick={() => onUpdate({ primaryColor: color })}>
                    <span className="theme-swatch-dot" style={{ background: color }}>
                      {selected && (
                        <span style={{ color: swatchCheckInk(color), display: 'inline-flex' }}>
                          <Icon name="check" size={14} />
                        </span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="theme-swatch-remove"
                    aria-label={`${t('removeColor')} ${color}`}
                    title={t('removeColor')}
                    onClick={() => handleRemoveColor(color)}>
                    <Icon name="x" size={9} />
                  </button>
                </div>
              )
            })}

            <label className="theme-swatch-add" title={t('addCustomColor')} aria-label={t('addCustomColor')}>
              <Icon name="plus" size={14} />
              <input
                type="color"
                className="theme-swatch-picker-input"
                aria-label={t('addCustomColor')}
                value={pickerValue}
                onFocus={() => {
                  sessionAddedRef.current = null
                }}
                onChange={(event) => handlePickCustomColor(event.target.value)}
                onBlur={() => {
                  sessionAddedRef.current = null
                }}
              />
            </label>
          </div>
        </div>

        <SettingRow title={t('colorStyle')}>
          <div className="theme-segmented" role="group" aria-label={t('colorStyle')}>
            {colorStyles.map((item) => {
              const active = settings.colorStyle === item.value
              return (
                <button
                  key={item.value}
                  type="button"
                  className={
                    active
                      ? 'theme-segmented-btn theme-style-btn active'
                      : 'theme-segmented-btn theme-style-btn'
                  }
                  aria-pressed={active}
                  onClick={() => onUpdate({ colorStyle: item.value })}>
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>
        </SettingRow>
      </div>
    </SettingSection>
  )
}

function SettingsApp() {
  const { settings, loaded, update } = useSettings()
  const [accessibilityTrusted, setAccessibilityTrusted] = React.useState(true)
  const [activeSection, setActiveSection] = React.useState<SettingsSectionId>('api')
  const [modelsByTemplate, setModelsByTemplate] = React.useState<Record<string, string[]>>({})
  const [statusByTemplate, setStatusByTemplate] = React.useState<Record<string, string>>({})
  const [visibleApiKeys, setVisibleApiKeys] = React.useState<Record<string, boolean>>({})
  const [busyTemplate, setBusyTemplate] = React.useState<{ id: string; kind: 'list' | 'test' } | null>(null)
  const [proxyTesting, setProxyTesting] = React.useState(false)
  const [proxyStatus, setProxyStatus] = React.useState<string | null>(null)
  const [ocrEngine, setOcrEngine] = React.useState<OcrEngineStatusPayload | null>(null)
  const [ocrEngineError, setOcrEngineError] = React.useState<string | null>(null)
  const t = getTranslator(settings.language)
  useThemeMode(settings)
  useAppearance(settings)

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

  const refreshOcrEngine = React.useCallback(() => {
    window.assistantLite.ocr
      .engineStatus()
      .then(setOcrEngine)
      .catch(() => setOcrEngine(null))
  }, [])

  React.useEffect(() => {
    refreshOcrEngine()
    const offProgress = window.assistantLite.ocr.onEngineProgress((progress) => {
      setOcrEngine((prev) => (prev ? { ...prev, downloading: true, progress } : prev))
    })
    const offChanged = window.assistantLite.ocr.onEngineChanged(() => {
      setOcrEngineError(null)
      refreshOcrEngine()
    })
    return () => {
      offProgress()
      offChanged()
    }
  }, [refreshOcrEngine])

  const downloadOcrEnginePack = async () => {
    setOcrEngineError(null)
    try {
      await window.assistantLite.ocr.downloadEngine()
    } catch (error) {
      setOcrEngineError(error instanceof Error ? error.message : String(error))
      refreshOcrEngine()
    }
  }

  const cancelOcrEnginePack = () => {
    void window.assistantLite.ocr.cancelEngineDownload()
  }

  const deleteOcrEnginePack = async () => {
    await window.assistantLite.ocr.deleteEngine()
  }

  const ocrEnginePackPercent = (() => {
    const progress = ocrEngine?.progress
    if (!progress) return null
    if (progress.phase !== 'download') return Math.round(((progress.index + 1) / progress.count) * 100)
    if (!progress.totalBytes) return null
    const within = Math.min(1, progress.receivedBytes / progress.totalBytes)
    return Math.round(((progress.index + within) / progress.count) * 100)
  })()

  const ocrEnginePackDescription = (() => {
    if (ocrEngineError) return `${t('ocrEngineFailed')}: ${ocrEngineError}`
    if (ocrEngine?.paddle.installed) {
      const mb = ocrEngine.paddle.bytes ? ` · ${Math.round(ocrEngine.paddle.bytes / 1_048_576)} MB` : ''
      return `${t('ocrEngineInstalledDesc')}${mb}`
    }
    return null
  })()

  if (!loaded) return <main className="page">{t('loading')}</main>

  const updateTemplate = (id: string, patch: Partial<ProviderTemplate>) => {
    void update({
      providerTemplates: settings.providerTemplates.map((template) =>
        template.id === id ? { ...template, ...patch } : template
      )
    })
  }

  const updateTemplateProvider = (id: string, field: string, value: string) => {
    void update({
      providerTemplates: settings.providerTemplates.map((template) =>
        template.id === id ? { ...template, provider: { ...template.provider, [field]: value } } : template
      )
    })
  }

  const addProviderTemplate = () => {
    const nextTemplate: ProviderTemplate = {
      id: crypto.randomUUID(),
      name: `${t('providerTemplateDefaultName')} ${settings.providerTemplates.length + 1}`,
      provider: { ...settings.provider }
    }
    void update({ providerTemplates: [...settings.providerTemplates, nextTemplate] })
  }

  const deleteProviderTemplate = (id: string) => {
    if (settings.providerTemplates.length <= 1) return
    const remaining = settings.providerTemplates.filter((template) => template.id !== id)
    const nextActive = settings.activeProviderTemplateId === id ? remaining[0]?.id : settings.activeProviderTemplateId
    void update({ providerTemplates: remaining, activeProviderTemplateId: nextActive })
  }

  const fetchModelsFor = async (id: string) => {
    setBusyTemplate({ id, kind: 'list' })
    setStatusByTemplate((current) => ({ ...current, [id]: t('modelListLoading') }))
    try {
      const models = await window.assistantLite.ai.listModels(id)
      setModelsByTemplate((current) => ({ ...current, [id]: models }))
      setStatusByTemplate((current) => ({
        ...current,
        [id]: models.length ? t('modelListSuccess').replace('{{count}}', String(models.length)) : t('modelListEmpty')
      }))
    } catch (error) {
      setStatusByTemplate((current) => ({ ...current, [id]: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusyTemplate(null)
    }
  }

  const testProxyNow = async () => {
    setProxyTesting(true)
    setProxyStatus(null)
    try {
      const result = await window.assistantLite.network.testProxy(settings?.proxyUrl ?? '')
      const via = t(result.via === 'manual' ? 'proxyViaManual' : result.via === 'system' ? 'proxyViaSystem' : 'proxyViaDirect')
      setProxyStatus(result.ok ? `✅ ${via} · ${result.latencyMs}ms` : `❌ ${via} · ${result.error ?? ''}`)
    } catch (error) {
      setProxyStatus(`❌ ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setProxyTesting(false)
    }
  }

  const testModelFor = async (id: string) => {
    setBusyTemplate({ id, kind: 'test' })
    setStatusByTemplate((current) => ({ ...current, [id]: t('modelTestLoading') }))
    try {
      await window.assistantLite.ai.testModel(id)
      setStatusByTemplate((current) => ({ ...current, [id]: t('modelTestSuccess') }))
    } catch (error) {
      setStatusByTemplate((current) => ({ ...current, [id]: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusyTemplate(null)
    }
  }

  const updateAction = (id: string, patch: Partial<ActionItem>) => {
    void update({
      actions: settings.actions.map((action) => (action.id === id ? { ...action, ...patch } : action))
    })
  }

  const addAction = () => {
    const next: ActionItem = {
      id: crypto.randomUUID(),
      name: t('newActionName'),
      enabled: true,
      icon: 'sparkles',
      type: 'prompt',
      promptTemplate: '',
      reasoning: 'on'
    }
    void update({ actions: [...settings.actions, next] })
  }

  const deleteAction = (id: string) => {
    // Built-in default actions can be disabled or edited, but not removed.
    if (defaultActions.some((action) => action.id === id)) return
    void update({ actions: settings.actions.filter((action) => action.id !== id) })
  }

  const moveAction = (id: string, dir: -1 | 1) => {
    const actions = [...settings.actions]
    const i = actions.findIndex((action) => action.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= actions.length) return
    ;[actions[i], actions[j]] = [actions[j], actions[i]]
    void update({ actions })
  }

  const updateShortcut = (field: keyof ShortcutSettings, value: string) => {
    void update({ shortcuts: { [field]: value } })
  }

  const updateTranslate = (patch: Partial<AppSettings['translate']>) => {
    void update({ translate: { ...settings.translate, ...patch } })
  }

  const updateTts = (patch: Partial<AppSettings['tts']>) => {
    void update({ tts: { ...settings.tts, ...patch } })
  }

  const toggleTranslateService = (id: TranslateServiceId, enabled: boolean) => {
    updateTranslate({
      services: settings.translate.services.map((service) => (service.id === id ? { ...service, enabled } : service))
    })
  }

  const moveTranslateService = (id: TranslateServiceId, dir: -1 | 1) => {
    const services = [...settings.translate.services]
    const i = services.findIndex((service) => service.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= services.length) return
    ;[services[i], services[j]] = [services[j], services[i]]
    updateTranslate({ services })
  }

  const removeTranslateService = (id: TranslateServiceId) => {
    updateTranslate({ services: settings.translate.services.filter((service) => service.id !== id) })
  }

  const addTranslateService = (id: TranslateServiceId) => {
    if (settings.translate.services.some((service) => service.id === id)) return
    updateTranslate({ services: [...settings.translate.services, { id, enabled: true }] })
  }

  const sections: SettingsSectionMeta[] = [
    { id: 'api', label: t('sectionApi'), icon: 'link' },
    { id: 'actions', label: t('sectionActions'), icon: 'mouse-pointer' },
    { id: 'selection', label: t('sectionSelection'), icon: 'scan-text' },
    { id: 'translate', label: t('sectionTranslate'), icon: 'languages' },
    { id: 'vocabulary', label: t('sectionVocabulary'), icon: 'book-open' },
    { id: 'window', label: t('sectionWindow'), icon: 'laptop' }
  ]
  const defaultActionById = new Map(defaultActions.map((action) => [action.id, action]))
  const filterText = settings.filterList.join('\n')

  const renderSection = () => {
    if (activeSection === 'api') {
      return (
        <div className="settings-stack settings-stack--api">
          <SettingSection title={t('providerTitle')} className="provider-section">
            <div className="provider-list">
              {settings.providerTemplates.map((template) => {
                const isDefault = template.id === settings.activeProviderTemplateId
                const models = modelsByTemplate[template.id] ?? []
                const status = statusByTemplate[template.id]
                const listing = busyTemplate?.id === template.id && busyTemplate.kind === 'list'
                return (
                  <div className="provider-card" key={template.id}>
                    <div className="provider-card__head">
                      <ProviderNameInput
                        value={template.name}
                        placeholder={t('providerTemplateName')}
                        onChange={(name) => updateTemplate(template.id, { name })}
                      />
                      <button
                        type="button"
                        className={isDefault ? 'pill active' : 'pill'}
                        onClick={() => update({ activeProviderTemplateId: template.id })}
                        disabled={isDefault}
                        title={t('setDefault')}>
                        {isDefault ? t('providerDefault') : t('setDefault')}
                      </button>
                      <button
                        type="button"
                        className="inline-icon-button danger"
                        title={t('providerTemplateDelete')}
                        aria-label={t('providerTemplateDelete')}
                        onClick={() => deleteProviderTemplate(template.id)}
                        disabled={settings.providerTemplates.length <= 1}>
                        <Icon name="trash-2" size={14} />
                      </button>
                    </div>
                    <div className="form-grid">
                      <label className="field">
                        <span>{t('apiType')}</span>
                        <select
                          value={template.provider.apiType}
                          onChange={(event) => updateTemplateProvider(template.id, 'apiType', event.target.value)}>
                          <option value="openai">{t('apiTypeOpenAI')}</option>
                          <option value="anthropic">{t('apiTypeAnthropic')}</option>
                        </select>
                      </label>
                      <label className="field">
                        <span>{t('baseUrl')}</span>
                        <SettingInput
                          value={template.provider.baseUrl}
                          onChange={(val) => updateTemplateProvider(template.id, 'baseUrl', val.trim())}
                        />
                      </label>
                      {template.provider.apiType === 'anthropic' && (
                        <div className="model-status">{t('baseUrlAnthropicHint')}</div>
                      )}
                      <label className="field field--wide field--model">
                        <div className="field-header">
                          <span>{t('model')}</span>
                          <div className="inline-actions">
                            <button
                              className="inline-action-button"
                              type="button"
                              onClick={() => fetchModelsFor(template.id)}
                              disabled={busyTemplate !== null}>
                              {listing ? t('modelListLoading') : t('fetchModels')}
                            </button>
                            <button
                              className="inline-icon-button"
                              type="button"
                              title={t('testModel')}
                              aria-label={t('testModel')}
                              onClick={() => testModelFor(template.id)}
                              disabled={busyTemplate !== null}>
                              <Icon name="flask-conical" size={14} />
                            </button>
                          </div>
                        </div>
                        <SettingInput
                          value={template.provider.model}
                          onChange={(val) => updateTemplateProvider(template.id, 'model', val.trim())}
                        />
                      </label>
                      <div className="field field--wide field--api-key">
                        <span>{t('apiKey')}</span>
                        <div className="secret-field">
                          <SettingInput
                            aria-label={t('apiKey')}
                            autoComplete="off"
                            spellCheck={false}
                            type={visibleApiKeys[template.id] ? 'text' : 'password'}
                            value={template.provider.apiKey}
                            onChange={(val) => updateTemplateProvider(template.id, 'apiKey', val.trim())}
                          />
                          <button
                            aria-label={visibleApiKeys[template.id] ? t('hideApiKey') : t('showApiKey')}
                            aria-pressed={visibleApiKeys[template.id] ?? false}
                            className="secret-field__toggle"
                            title={visibleApiKeys[template.id] ? t('hideApiKey') : t('showApiKey')}
                            type="button"
                            onClick={() =>
                              setVisibleApiKeys((current) => ({ ...current, [template.id]: !current[template.id] }))
                            }>
                            <Icon name={visibleApiKeys[template.id] ? 'eye-off' : 'eye'} size={15} />
                          </button>
                        </div>
                      </div>
                      {models.length > 0 && (
                        <label className="field field--wide">
                          <span>{t('modelList')}</span>
                          <select
                            value={template.provider.model}
                            onChange={(event) => updateTemplateProvider(template.id, 'model', event.target.value)}>
                            <option value={template.provider.model}>
                              {template.provider.model || t('modelSelectPlaceholder')}
                            </option>
                            {models
                              .filter((model) => model !== template.provider.model)
                              .map((model) => (
                                <option key={model} value={model}>
                                  {model}
                                </option>
                              ))}
                          </select>
                        </label>
                      )}
                      {status && <div className="model-status">{status}</div>}
                    </div>
                  </div>
                )
              })}
              <button type="button" className="add-row-button" onClick={addProviderTemplate}>
                <Icon name="plus" size={14} />
                {t('addProvider')}
              </button>
            </div>
          </SettingSection>

          <SettingSection title={t('webSearchGroup')}>
            <SettingRow title={t('webSearchEnabled')} description={t('webSearchEnabledDesc')}>
              <Toggle
                checked={settings.webSearchEnabled}
                label={t('webSearchEnabled')}
                onChange={(webSearchEnabled) => update({ webSearchEnabled })}
              />
            </SettingRow>
          </SettingSection>

          <SettingSection title={t('featureModelGroup')}>
            <SettingRow title={t('visionModel')} description={t('visionModelDesc')}>
              <SettingInput
                value={settings.visionModel}
                placeholder="gpt-4o"
                onChange={(visionModel) => update({ visionModel: visionModel.trim() })}
              />
            </SettingRow>
            <SettingRow
              title={t('ocrEngine')}
              description={
                ocrEngine?.systemLanguages.length
                  ? `${t('ocrEngineDesc')} · ${t('ocrEngineSystemLangs')}: ${ocrEngine.systemLanguages.join(', ')}`
                  : t('ocrEngineDesc')
              }
            >
              <select
                value={settings.ocrEngine}
                onChange={(event) => update({ ocrEngine: event.target.value as OcrEngineId })}
              >
                <option value="system" disabled={!isWindows}>
                  {t('ocrEngineSystem')}
                </option>
                <option value="paddle">{t('ocrEnginePaddle')}</option>
              </select>
            </SettingRow>
            <SettingRow
              title={t('ocrEnginePack')}
              description={ocrEnginePackDescription ?? t('ocrEnginePackDesc')}
            >
              <div className="ocr-engine-actions">
                {ocrEngine?.downloading ? (
                  <>
                    <div className="ocr-engine-progress" aria-hidden={!ocrEnginePackPercent}>
                      <div style={{ width: `${ocrEnginePackPercent ?? 0}%` }} />
                    </div>
                    <span className="ocr-engine-progress-label">
                      {ocrEnginePackPercent != null ? `${ocrEnginePackPercent}%` : t('ocrEnginePreparing')}
                    </span>
                    <button type="button" className="pill" onClick={() => void cancelOcrEnginePack()}>
                      {t('ocrEngineCancel')}
                    </button>
                  </>
                ) : ocrEngine?.paddle.installed ? (
                  <>
                    <span className="ocr-engine-state ok">{t('ocrEngineInstalled')}</span>
                    <button type="button" className="pill" onClick={() => void deleteOcrEnginePack()}>
                      {t('ocrEngineDelete')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="pill"
                    onClick={() => void downloadOcrEnginePack()}
                    disabled={ocrEngine?.systemAvailable === false && !isWindows}
                  >
                    {t('ocrEngineDownload')}
                  </button>
                )}
              </div>
            </SettingRow>
            <SettingRow title={t('compressModel')} description={t('compressModelDesc')}>
              <SettingInput
                value={settings.compressModel}
                placeholder="gpt-4o-mini"
                onChange={(compressModel) => update({ compressModel: compressModel.trim() })}
              />
            </SettingRow>
            <SettingRow title={t('contextWindow')} description={t('contextWindowDesc')}>
              <NumberField
                value={settings.contextWindowTokens}
                min={4000}
                step={10000}
                onCommit={(contextWindowTokens) => update({ contextWindowTokens })}
              />
            </SettingRow>
          </SettingSection>

          <SettingSection title={t('proxyGroup')}>
            <SettingRow title={t('proxyUrl')} description={proxyStatus ?? t('proxyUrlDesc')}>
              <div className="proxy-field">
                <SettingInput
                  value={settings.proxyUrl}
                  placeholder="http://127.0.0.1:7890"
                  onChange={(proxyUrl) => update({ proxyUrl: proxyUrl.trim() })}
                />
                <button type="button" className="pill" onClick={() => void testProxyNow()} disabled={proxyTesting}>
                  {proxyTesting ? t('proxyTestLoading') : t('proxyTest')}
                </button>
              </div>
            </SettingRow>
          </SettingSection>
        </div>
      )
    }

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

    if (activeSection === 'selection') {
      return (
        <div className="settings-stack settings-stack--selection">
          <SettingSection title={t('selectionMasterGroup')}>
            <SettingRow title={t('selectionEnable')} description={t('selectionEnableDesc')}>
              <Toggle
                checked={settings.enabled}
                label={t('selectionEnable')}
                onChange={() => void toggleAssistantEnabled()}
              />
            </SettingRow>
          </SettingSection>

          <SettingSection title={t('selectionTriggerGroup')}>
            <SettingRow title={t('triggerMode')}>
              <select value={settings.triggerMode} onChange={(event) => update({ triggerMode: event.target.value as TriggerMode })}>
                <option value="selected">{t('triggerSelected')}</option>
                <option value="shortcut">{t('triggerShortcut')}</option>
              </select>
            </SettingRow>
          </SettingSection>

          <SettingSection title={t('selectionShortcutGroup')}>
            <SettingRow
              title={t('shortcutToggleAssistant')}
              description={t('shortcutToggleAssistantDesc')}
              className="shortcut-row">
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
            <SettingRow
              title={t('shortcutCaptureScreen')}
              description={t('shortcutCaptureScreenDesc')}
              className="shortcut-row">
              <ShortcutRecorder
                value={settings.shortcuts.captureScreen}
                label={t('shortcutCaptureScreen')}
                onChange={(value) => updateShortcut('captureScreen', value)}
                t={t}
              />
            </SettingRow>
            <SettingRow
              title={t('shortcutChat')}
              description={t('shortcutChatDesc')}
              className="shortcut-row">
              <ShortcutRecorder
                value={settings.shortcuts.chat}
                label={t('shortcutChat')}
                onChange={(value) => updateShortcut('chat', value)}
                t={t}
              />
            </SettingRow>
          </SettingSection>

          <SettingSection title={t('actionShortcutsGroup')}>
            <div className="group-hint">{t('actionShortcutsHint')}</div>
            {settings.actions.map((action) => (
              <SettingRow
                key={action.id}
                title={getActionLabel(action, settings.language)}
                className="shortcut-row action-shortcut-setting-row">
                <ShortcutRecorder
                  value={action.shortcut ?? ''}
                  label={getActionLabel(action, settings.language)}
                  onChange={(value) => updateAction(action.id, { shortcut: value || undefined })}
                  t={t}
                />
              </SettingRow>
            ))}
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
              <SettingTextarea
                value={filterText}
                placeholder={t('filterListPlaceholder')}
                onChange={(val) =>
                  update({
                    filterList: val
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

    if (activeSection === 'translate') {
      const translateServiceName = (id: TranslateServiceId): string => {
        switch (id) {
          case 'microsoft':
            return t('serviceMicrosoft')
          case 'iciba':
            return t('serviceIciba')
          case 'icibaDict':
            return t('serviceIcibaDict')
    case 'youdaoDict':
      return t('serviceYoudaoDict')
          case 'tencent':
            return t('serviceTencent')
          case 'yandex':
            return t('serviceYandex')
          case 'deeplx':
            return t('serviceDeeplx')
        }
      }
      const voiceChoices = TTS_VOICE_CHOICES.some((choice) => choice.value === settings.tts.voice)
        ? TTS_VOICE_CHOICES
        : [{ value: settings.tts.voice, labelKey: '' }, ...TTS_VOICE_CHOICES]
      const mimoVoiceChoices = MIMO_VOICE_CHOICES.some((choice) => choice.value === settings.tts.mimoVoice)
        ? MIMO_VOICE_CHOICES
        : [{ value: settings.tts.mimoVoice, labelKey: '' }, ...MIMO_VOICE_CHOICES]

      return (
        <div className="settings-stack settings-stack--translate">
          <SettingSection title={t('translateGroup')}>
            <div className="group-hint">{t('translateServicesHint')}</div>
            <div className="translate-service-list">
              {settings.translate.services.map((service, index) => (
                <div className="translate-service-row" key={service.id}>
                  <span className="setting-title">{translateServiceName(service.id)}</span>
                  <div className="translate-service-row-tools">
                    <button
                      className="inline-icon-button"
                      type="button"
                      title={t('moveUp')}
                      onClick={() => moveTranslateService(service.id, -1)}
                      disabled={index === 0}>
                      <Icon name="arrow-up" size={13} />
                    </button>
                    <button
                      className="inline-icon-button"
                      type="button"
                      title={t('moveDown')}
                      onClick={() => moveTranslateService(service.id, 1)}
                      disabled={index === settings.translate.services.length - 1}>
                      <Icon name="arrow-down" size={13} />
                    </button>
                    <button
                      className="inline-icon-button danger"
                      type="button"
                      title={t('removeService')}
                      aria-label={t('removeService')}
                      onClick={() => removeTranslateService(service.id)}>
                      <Icon name="trash-2" size={14} />
                    </button>
                    <Toggle
                      checked={service.enabled}
                      label={translateServiceName(service.id)}
                      onChange={(enabled) => toggleTranslateService(service.id, enabled)}
                    />
                  </div>
                </div>
              ))}
            </div>
            <SettingRow title={t('deeplxEndpoint')} description={t('deeplxEndpointDesc')}>
              <SettingInput
                value={settings.translate.deeplxEndpoint}
                placeholder="https://your-deeplx.example.com"
                onChange={(deeplxEndpoint) => updateTranslate({ deeplxEndpoint: deeplxEndpoint.trim() })}
              />
            </SettingRow>
            <SettingRow title={t('tencentClientKey')} description={t('tencentClientKeyDesc')}>
              <SettingInput
                value={settings.translate.tencentClientKey}
                placeholder={t('tencentClientKeyPlaceholder')}
                onChange={(tencentClientKey) => updateTranslate({ tencentClientKey: tencentClientKey.trim() })}
              />
            </SettingRow>
            <SettingRow title={t('vocabAutoRecord')} description={t('vocabAutoRecordDesc')}>
              <Toggle
                checked={settings.vocabulary.autoRecord}
                label={t('vocabAutoRecord')}
                onChange={(autoRecord) => update({ vocabulary: { autoRecord } })}
              />
            </SettingRow>
          </SettingSection>

          {(() => {
            const addedIds = new Set(settings.translate.services.map((service) => service.id))
            const optional = TRANSLATE_SERVICE_IDS.filter((id) => !addedIds.has(id))
            if (!optional.length) return null
            return (
              <SettingSection title={t('optionalServicesGroup')}>
                <div className="group-hint">{t('optionalServicesHint')}</div>
                <div className="translate-service-list">
                  {optional.map((id) => (
                    <div className="translate-service-row translate-service-row--optional" key={id}>
                      <span className="setting-title">{translateServiceName(id)}</span>
                      <div className="translate-service-row-tools">
                        <button
                          type="button"
                          className="inline-icon-button"
                          title={t('addService')}
                          aria-label={`${t('addService')} ${translateServiceName(id)}`}
                          onClick={() => addTranslateService(id)}>
                          <Icon name="plus" size={15} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </SettingSection>
            )
          })()}

          <SettingSection title={t('ttsGroup')}>
            <SettingRow title={t('ttsService')} description={t('ttsServiceDesc')}>
              <select
                value={settings.tts.service || 'openai'}
                onChange={(event) => updateTts({ service: event.target.value as 'openai' | 'mimo' })}>
                <option value="openai">{t('ttsServiceOpenAi')}</option>
                <option value="mimo">{t('ttsServiceMimo')}</option>
              </select>
            </SettingRow>

            {settings.tts.service === 'mimo' ? (
              <>
                <SettingRow title={t('ttsMimoApiKey')} description={t('ttsMimoApiKeyDesc')}>
                  <SettingInput
                    type="password"
                    value={settings.tts.mimoApiKey}
                    placeholder="sk-..."
                    onChange={(mimoApiKey) => updateTts({ mimoApiKey: mimoApiKey.trim() })}
                  />
                </SettingRow>
                <SettingRow title={t('ttsMimoModel')} description={t('ttsMimoModelDesc')}>
                  <SettingInput
                    value={settings.tts.mimoModel}
                    placeholder="mimo-v2.5-tts"
                    onChange={(mimoModel) => updateTts({ mimoModel: mimoModel.trim() })}
                  />
                </SettingRow>
                <SettingRow title={t('ttsMimoVoice')}>
                  <select
                    value={settings.tts.mimoVoice}
                    onChange={(event) => updateTts({ mimoVoice: event.target.value })}>
                    {mimoVoiceChoices.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.labelKey ? t(choice.labelKey) : choice.value}
                      </option>
                    ))}
                  </select>
                </SettingRow>
                <SettingRow title={t('ttsSpeed')} description={t('ttsSpeedDesc')}>
                  <select
                    value={String(settings.tts.speed)}
                    onChange={(event) => updateTts({ speed: Number(event.target.value) })}>
                    {['0.5', '0.75', '1', '1.25', '1.5', '2'].map((value) => (
                      <option key={value} value={value}>
                        {value}×
                      </option>
                    ))}
                  </select>
                </SettingRow>
              </>
            ) : (
              <>
                <SettingRow title={t('ttsEndpoint')} description={t('ttsEndpointDesc')}>
                  <SettingInput
                    value={settings.tts.endpoint}
                    placeholder="https://tts.example.com/v1/audio/speech"
                    onChange={(endpoint) => updateTts({ endpoint: endpoint.trim() })}
                  />
                </SettingRow>
                <SettingRow title={t('ttsVoice')}>
                  <select value={settings.tts.voice} onChange={(event) => updateTts({ voice: event.target.value })}>
                    {voiceChoices.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.labelKey ? t(choice.labelKey) : choice.value}
                      </option>
                    ))}
                  </select>
                </SettingRow>
                <SettingRow title={t('ttsSpeed')} description={t('ttsSpeedDesc')}>
                  <select
                    value={String(settings.tts.speed)}
                    onChange={(event) => updateTts({ speed: Number(event.target.value) })}>
                    {['0.5', '0.75', '1', '1.25', '1.5', '2'].map((value) => (
                      <option key={value} value={value}>
                        {value}×
                      </option>
                    ))}
                  </select>
                </SettingRow>
                <SettingRow title={t('ttsPitch')} description={t('ttsPitchDesc')}>
                  <NumberField
                    value={settings.tts.pitch}
                    min={-50}
                    max={50}
                    onCommit={(pitch) => updateTts({ pitch })}
                  />
                </SettingRow>
              </>
            )}
          </SettingSection>

          <SettingSection title={t('translateShortcut')}>
            <SettingRow
              title={t('translateShortcut')}
              description={t('translateShortcutDesc')}
              className="shortcut-row">
              <ShortcutRecorder
                value={settings.shortcuts.translate}
                label={t('translateShortcut')}
                onChange={(value) => updateShortcut('translate', value)}
                t={t}
              />
            </SettingRow>
          </SettingSection>
        </div>
      )
    }

    if (activeSection === 'vocabulary') {
      return <VocabularySection t={t} />
    }

    if (activeSection === 'window') {
      return (
        <div className="settings-stack">
          <ThemeAppearanceSection settings={settings} onUpdate={(patch) => void update(patch)} t={t} />

          <SettingSection title={t('actionWindowTitle')} className="window-behavior-section">
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

          <SettingSection title={t('appearanceSizeGroup')} className="window-size-section">
            <SettingRow title={t('defaultWindowWidth')}>
              <NumberField
                value={settings.actionWindowWidth}
                min={320}
                max={1600}
                onCommit={(actionWindowWidth) => update({ actionWindowWidth })}
              />
            </SettingRow>
            <SettingRow title={t('defaultWindowHeight')}>
              <NumberField
                value={settings.actionWindowHeight}
                min={240}
                max={1200}
                onCommit={(actionWindowHeight) => update({ actionWindowHeight })}
              />
            </SettingRow>
          </SettingSection>

          <SettingSection title={t('appearanceFontGroup')}>
            <SettingRow title={t('fontFamily')} description={t('fontFamilyDesc')} className="tall">
              <SettingInput
                value={settings.fontFamily}
                placeholder={t('fontFamilyPlaceholder')}
                onChange={(fontFamily) => update({ fontFamily })}
              />
            </SettingRow>
            <SettingRow title={t('fontSize')}>
              <NumberField value={settings.fontSize} min={10} max={28} onCommit={(fontSize) => update({ fontSize })} />
            </SettingRow>
          </SettingSection>

          <SettingSection title={t('appPreferences')}>
            <SettingRow title={t('language')}>
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
            </SettingRow>
            <SettingRow title={t('autoLaunch')}>
              <Toggle checked={settings.autoLaunch} label={t('autoLaunch')} onChange={(autoLaunch) => update({ autoLaunch })} />
            </SettingRow>
          </SettingSection>
        </div>
      )
    }

    return (
      <div className="settings-stack">
        <SettingSection title={t('actions')}>
          <div className="action-list">
            {settings.actions.map((action, index) => (
              <ActionEditor
                key={action.id}
                action={action}
                defaultAction={defaultActionById.get(action.id)}
                language={settings.language}
                providerTemplates={settings.providerTemplates}
                index={index}
                count={settings.actions.length}
                onChange={(patch) => updateAction(action.id, patch)}
                onDelete={() => deleteAction(action.id)}
                onMove={(dir) => moveAction(action.id, dir)}
                t={t}
              />
            ))}
          </div>
          <button type="button" className="add-row-button" onClick={addAction}>
            <Icon name="plus" size={14} />
            {t('addAction')}
          </button>
        </SettingSection>
      </div>
    )
  }

  return (
    <main className="page settings-page">
      <div className="settings-shell">
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
          <SettingsNav sections={sections} activeSection={activeSection} onChange={setActiveSection} t={t} />

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
