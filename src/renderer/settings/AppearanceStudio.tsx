import React from 'react'
import { deriveThemeCssVars, type ResolvedThemeMode } from '@shared/theme'
import type { AppSettings, ColorStyle, ThemeMode } from '@shared/types'
import { Icon } from '../icons'

type PreviewScene = 'chat' | 'dict' | 'toolbar'

function buildFontStack(fontFamily: string): string | undefined {
  const trimmed = fontFamily.trim()
  return trimmed ? `${trimmed}, ui-sans-serif, system-ui, sans-serif` : undefined
}

function resolveMode(mode: ThemeMode): ResolvedThemeMode {
  if (mode === 'light' || mode === 'dark') return mode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * Interactive FlClash-inspired theme showcase reacting live to mode, pureBlack,
 * seed color, color style, font family, and font size.
 */
export function ThemeLivePreview({
  settings,
  systemAccent,
  fontSize,
  t
}: {
  settings: AppSettings
  systemAccent: string
  fontSize: number
  t: (key: string) => string
}) {
  const [scene, setScene] = React.useState<PreviewScene>('chat')
  const [systemDark, setSystemDark] = React.useState<boolean>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )

  React.useEffect(() => {
    if (settings.theme !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = () => setSystemDark(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [settings.theme])

  const resolvedMode: ResolvedThemeMode =
    settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : resolveMode(settings.theme)
  const modeLabel =
    resolvedMode === 'dark'
      ? settings.pureBlack
        ? `${t('themeModeDark')} · OLED`
        : t('themeModeDark')
      : t('themeModeLight')
  const activeHex = (settings.primaryColor ?? systemAccent).toUpperCase()
  const previewStack = buildFontStack(settings.fontFamily)
  // Scale preview typography visibly across 10px..28px while keeping mini frame compact.
  const scaledPreviewPx = Math.round(Math.max(10, Math.min(16, fontSize * 0.78)))

  const scenes: Array<{ id: PreviewScene; label: string; icon: string }> = [
    { id: 'chat', label: t('themePreviewChat'), icon: 'sparkles' },
    { id: 'dict', label: t('themePreviewDict'), icon: 'book-open' },
    { id: 'toolbar', label: t('themePreviewToolbar'), icon: 'mouse-pointer' }
  ]

  return (
    <div className="theme-preview-stage" aria-label={t('themePreviewTitle')}>
      <div className="theme-preview-meta">
        <span className="theme-preview-meta__title">{t('themePreviewTitle')}</span>
        <div className="theme-preview-meta__chips">
          <span className="theme-preview-chip">
            <span className="theme-preview-chip__dot" style={{ background: 'var(--accent)' }} />
            <span>{activeHex}</span>
          </span>
          <span className="theme-preview-chip">
            <span>{modeLabel}</span>
            <span>·</span>
            <span>{t(`colorStyle_${settings.colorStyle}`)}</span>
          </span>
          <span className="theme-preview-chip theme-preview-chip--num">{fontSize}px</span>
        </div>
      </div>

      <div
        className="theme-preview-frame"
        style={
          {
            '--preview-font': previewStack ?? 'inherit',
            '--preview-font-size': `${scaledPreviewPx}px`
          } as React.CSSProperties
        }>
        <div className="theme-preview-rail" role="tablist" aria-label={t('themePreviewTitle')}>
          {scenes.map((item) => {
            const active = item.id === scene
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={active ? 'theme-preview-nav active' : 'theme-preview-nav'}
                onClick={() => setScene(item.id)}>
                <Icon name={item.icon} size={11} filled={active} />
                <span>{item.label}</span>
              </button>
            )
          })}
        </div>

        <div className="theme-preview-canvas">
          {scene === 'chat' && (
            <div className="theme-preview-card">
              <div className="theme-preview-prompt">{t('themePreviewChatPrompt')}</div>
              <div className="theme-preview-reply">
                <span className="theme-preview-reply__bar" />
                <span className="theme-preview-reply__text">{t('themePreviewChatReply')}</span>
              </div>
              <div className="theme-preview-foot">
                <span className="theme-preview-pill theme-preview-pill--accent">{t('themePreviewReady')}</span>
                <span className="theme-preview-switch" aria-hidden="true">
                  <span />
                </span>
              </div>
            </div>
          )}

          {scene === 'dict' && (
            <div className="theme-preview-card">
              <div className="theme-preview-dict-head">
                <strong className="theme-preview-dict-word">{t('themePreviewDictWord')}</strong>
                <span className="theme-preview-phonetic">/ˈɔːrbɪt/</span>
                <span className="theme-preview-badge-ok">{t('themePreviewReady')}</span>
              </div>
              <div className="theme-preview-dict-gloss">{t('themePreviewDictGloss')}</div>
            </div>
          )}

          {scene === 'toolbar' && (
            <div className="theme-preview-toolbar-scene">
              <div className="theme-preview-selection-mark">{t('themePreviewChatPrompt')}</div>
              <div className="theme-preview-toolbar">
                <span className="theme-preview-tb-item active">
                  <Icon name="sparkles" size={11} filled />
                  <span>{t('themePreviewChat')}</span>
                </span>
                <span className="theme-preview-tb-item">
                  <Icon name="languages" size={11} />
                  <span>{t('themePreviewDict')}</span>
                </span>
                <span className="theme-preview-tb-item">
                  <Icon name="copy" size={11} />
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function MiniThemeSketch({
  vars,
  className
}: {
  vars: Record<string, string>
  className?: string
}) {
  return (
    <div
      className={className ? `theme-thumb-sketch ${className}` : 'theme-thumb-sketch'}
      aria-hidden="true"
      style={
        {
          '--thumb-chrome': vars['--surface-chrome'],
          '--thumb-page': vars['--surface-page'],
          '--thumb-card': vars['--surface-card'],
          '--thumb-block': vars['--surface-block'],
          '--thumb-accent': vars['--accent'],
          '--thumb-text': vars['--text'],
          '--thumb-line': vars['--divider-hairline'] ?? 'rgba(128,128,128,0.16)'
        } as React.CSSProperties
      }>
      <div className="theme-thumb-sketch__rail">
        <span className="theme-thumb-sketch__nav active" />
        <span className="theme-thumb-sketch__nav" />
        <span className="theme-thumb-sketch__nav" />
      </div>
      <div className="theme-thumb-sketch__body">
        <div className="theme-thumb-sketch__card">
          <span className="theme-thumb-sketch__line theme-thumb-sketch__line--title" />
          <span className="theme-thumb-sketch__line" />
          <span className="theme-thumb-sketch__pill" />
        </div>
      </div>
    </div>
  )
}

/**
 * FlClash-style visual thumbnail radio cards for Auto (split light/dark),
 * Light, and Dark modes, rendered using the user's live seed palette.
 */
export function ThemeModeCards({
  value,
  pureBlack,
  primaryColor,
  colorStyle,
  systemAccent,
  options,
  ariaLabel,
  onChange
}: {
  value: ThemeMode
  pureBlack: boolean
  primaryColor: string | null
  colorStyle: ColorStyle
  systemAccent: string
  options: Array<{ value: ThemeMode; label: string }>
  ariaLabel: string
  onChange: (mode: ThemeMode) => void
}) {
  const lightVars = React.useMemo(
    () => deriveThemeCssVars({ pureBlack, primaryColor, colorStyle }, 'light', systemAccent),
    [pureBlack, primaryColor, colorStyle, systemAccent]
  )
  const darkVars = React.useMemo(
    () => deriveThemeCssVars({ pureBlack, primaryColor, colorStyle }, 'dark', systemAccent),
    [pureBlack, primaryColor, colorStyle, systemAccent]
  )

  return (
    <div className="theme-mode-cards" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={selected ? 'theme-mode-card active' : 'theme-mode-card'}
            onClick={() => onChange(option.value)}>
            <div className="theme-mode-card__thumb">
              {option.value === 'light' && <MiniThemeSketch vars={lightVars} />}
              {option.value === 'dark' && <MiniThemeSketch vars={darkVars} />}
              {option.value === 'system' && (
                <div className="theme-thumb-split">
                  <MiniThemeSketch vars={lightVars} />
                  <MiniThemeSketch vars={darkVars} className="theme-thumb-sketch--split-dark" />
                </div>
              )}
            </div>
            <div className="theme-mode-card__foot">
              <span className="theme-mode-card__label">{option.label}</span>
              <span className={selected ? 'theme-mode-card__check active' : 'theme-mode-card__check'} aria-hidden="true">
                {selected && <Icon name="check" size={10} />}
              </span>
            </div>
          </button>
        )
      })}
    </div>
  )
}

/**
 * Interactive font scale preview and slider matching FlClash's TextScaleFactor widget.
 * Holds transient draft state while dragging so preview animates smoothly before IPC commit.
 */
export function FontPreviewSlider({
  fontFamily,
  value,
  draftValue,
  min = 10,
  max = 28,
  defaultSize = 14,
  onDraftChange,
  onCommit,
  t
}: {
  fontFamily: string
  value: number
  draftValue: number | null
  min?: number
  max?: number
  defaultSize?: number
  onDraftChange: (draft: number | null) => void
  onCommit: (size: number) => void
  t: (key: string) => string
}) {
  const effectiveSize = draftValue ?? value
  const draggingRef = React.useRef(false)
  const latestRef = React.useRef(effectiveSize)
  latestRef.current = effectiveSize

  const fontStack = buildFontStack(fontFamily)
  const familyLabel = fontFamily.trim() || t('fontDefaultSystem')
  const percent = ((effectiveSize - min) / (max - min)) * 100

  const flushDrag = () => {
    if (!draggingRef.current) return
    draggingRef.current = false
    const finalSize = latestRef.current
    onDraftChange(null)
    if (finalSize !== value) onCommit(finalSize)
  }

  return (
    <div className="font-studio-block">
      <div className="font-studio-preview">
        <div className="font-studio-preview__top">
          <span className="font-studio-preview__family" title={familyLabel}>
            {familyLabel}
          </span>
          <div className="font-studio-preview__actions">
            {effectiveSize !== defaultSize && (
              <button
                type="button"
                className="theme-reset-btn"
                onClick={() => {
                  draggingRef.current = false
                  onDraftChange(null)
                  onCommit(defaultSize)
                }}>
                <Icon name="refresh-cw" size={11} />
                <span>{t('resetFont')}</span>
              </button>
            )}
            <span className="font-studio-size-badge">{effectiveSize} px</span>
          </div>
        </div>

        <div
          className="font-studio-preview__sample"
          style={{
            fontFamily: fontStack,
            fontSize: `${effectiveSize}px`
          }}>
          <span className="font-studio-preview__glyph" aria-hidden="true">
            Aa
          </span>
          <span className="font-studio-preview__text">{t('fontPreviewSample')}</span>
        </div>
      </div>

      <div className="font-studio-slider-row">
        <span className="font-studio-edge font-studio-edge--sm" aria-hidden="true">
          A
        </span>
        <input
          type="range"
          className="font-scale-slider"
          aria-label={t('fontSize')}
          min={min}
          max={max}
          step={1}
          value={effectiveSize}
          style={{ '--slider-progress': `${percent}%` } as React.CSSProperties}
          onPointerDown={() => {
            draggingRef.current = true
          }}
          onPointerUp={flushDrag}
          onPointerCancel={flushDrag}
          onBlur={flushDrag}
          onChange={(event) => {
            const next = Number(event.target.value)
            latestRef.current = next
            if (draggingRef.current) {
              onDraftChange(next)
            } else {
              onDraftChange(null)
              if (next !== value) onCommit(next)
            }
          }}
        />
        <span className="font-studio-edge font-studio-edge--lg" aria-hidden="true">
          A
        </span>
      </div>
    </div>
  )
}
