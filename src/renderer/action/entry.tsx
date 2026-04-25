import '../styles.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { interpolatePrompt } from '@shared/actions'
import type { ActionPayload, AiChunkPayload } from '@shared/types'
import { Icon } from '../icons'
import { useSettings } from '../useSettings'
import { useThemeMode } from '../useThemeMode'
import { getActionLabel, getTranslator } from '../i18n'

function ActionApp() {
  const { settings } = useSettings()
  const [payload, setPayload] = React.useState<ActionPayload | null>(null)
  const [result, setResult] = React.useState('')
  const [error, setError] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [pinned, setPinned] = React.useState(settings.autoPin)
  const activeRequestId = React.useRef<string | null>(null)
  const t = getTranslator(settings.language)
  useThemeMode(settings.theme)

  React.useEffect(() => {
    document.documentElement.classList.add('action-page-root')
    document.body.classList.add('action-page')
    return () => {
      document.documentElement.classList.remove('action-page-root')
      document.body.classList.remove('action-page')
    }
  }, [])

  React.useEffect(() => window.assistantLite.selection.onAction(setPayload), [])

  React.useEffect(() => {
    const off = window.assistantLite.ai.onChunk((chunk: AiChunkPayload) => {
      if (chunk.requestId !== activeRequestId.current) return
      if (chunk.type === 'delta') setResult((current) => current + (chunk.text ?? ''))
      if (chunk.type === 'done') setLoading(false)
      if (chunk.type === 'error') {
        setLoading(false)
        setError(chunk.error ?? t('unknownProviderError'))
      }
    })
    return off
  }, [])

  const runAction = React.useCallback(() => {
    if (!payload) return
    const requestId = crypto.randomUUID()
    activeRequestId.current = requestId
    setResult('')
    setError('')
    setLoading(true)
    const prompt = interpolatePrompt(payload.action.promptTemplate, payload.selectedText, {
      language: t('targetLanguageName')
    })
    void window.assistantLite.ai.stream({ requestId, prompt })
  }, [payload])

  React.useEffect(() => {
    if (payload) runAction()
  }, [payload, runAction])

  React.useEffect(() => {
    const onBlur = () => {
      if (settings.autoClose && !pinned) void window.assistantLite.windowControls.close()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [settings.autoClose, pinned])

  if (!payload) return null

  const stop = () => {
    if (activeRequestId.current) void window.assistantLite.ai.abort(activeRequestId.current)
    setLoading(false)
  }

  const togglePin = () => {
    const next = !pinned
    setPinned(next)
    void window.assistantLite.windowControls.pin(next)
  }

  return (
    <div className="action-window">
      <div className="titlebar">
        <Icon name={payload.action.icon} />
        <strong>{getActionLabel(payload.action, settings.language)}</strong>
        <button className="icon" title={pinned ? t('unpin') : t('pin')} onClick={togglePin}>
          <Icon name={pinned ? 'pin-off' : 'pin'} />
        </button>
        <button className="icon" title={t('minimize')} onClick={() => window.assistantLite.windowControls.minimize()}>
          <span>-</span>
        </button>
        <button className="icon" title={t('close')} onClick={() => window.assistantLite.windowControls.close()}>
          <Icon name="x" />
        </button>
      </div>
      <div className="content">
        {loading && !result && <div className="thinking-indicator">{t('preparing')}</div>}
        <div className="result markdown-body">
          <Markdown remarkPlugins={[remarkGfm]}>{result}</Markdown>
        </div>
        {error && <div className="error">{error}</div>}
      </div>
      <div className="footer">
        <button onClick={loading ? stop : () => window.assistantLite.windowControls.close()}>
          {loading ? t('stop') : t('close')}
        </button>
        <button onClick={runAction} disabled={loading}>
          {t('regenerate')}
        </button>
        <button onClick={() => navigator.clipboard.writeText(result)} disabled={loading || !result}>
          {t('copy')}
        </button>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ActionApp />
  </React.StrictMode>
)
