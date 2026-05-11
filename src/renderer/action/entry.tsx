import '../styles.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { interpolatePrompt } from '@shared/actions'
import type { ActionPayload, AiChunkPayload, AiMessageInput } from '@shared/types'
import { Icon } from '../icons'
import { useSettings } from '../useSettings'
import { useThemeMode } from '../useThemeMode'
import { getActionLabel, getTranslator } from '../i18n'

interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
  pending?: boolean
  error?: string
  searchQuery?: string
}

const isMac = navigator.userAgent.includes('Mac OS X')

function ActionApp() {
  const { settings } = useSettings()
  const [payload, setPayload] = React.useState<ActionPayload | null>(null)
  const [chat, setChat] = React.useState<ChatTurn[]>([])
  const [pinned, setPinned] = React.useState(settings.autoPin)
  const [askOpen, setAskOpen] = React.useState(false)
  const [askText, setAskText] = React.useState('')
  const activeRequestId = React.useRef<string | null>(null)
  const askInputRef = React.useRef<HTMLInputElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const chatRef = React.useRef<ChatTurn[]>([])
  const stickToBottomRef = React.useRef(true)
  const t = getTranslator(settings.language)
  useThemeMode(settings.theme)
  const isZh = settings.language === 'zh-CN'

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
    return window.assistantLite.ai.onChunk((chunk: AiChunkPayload) => {
      if (chunk.requestId !== activeRequestId.current) return
      setChat((current) => {
        if (!current.length) return current
        const next = [...current]
        const last = { ...next[next.length - 1] }
        if (chunk.type === 'delta') {
          last.text += chunk.text ?? ''
          last.pending = true
        } else if (chunk.type === 'status') {
          last.searchQuery = chunk.text ?? ''
        } else if (chunk.type === 'done') {
          last.pending = false
        } else if (chunk.type === 'error') {
          last.pending = false
          last.error = chunk.error ?? t('unknownProviderError')
        }
        next[next.length - 1] = last
        return next
      })
      if (chunk.type === 'done' || chunk.type === 'error') {
        activeRequestId.current = null
      }
    })
  }, [t])

  React.useEffect(() => {
    chatRef.current = chat
  }, [chat])

  React.useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      stickToBottomRef.current = distance < 32
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  React.useEffect(() => {
    if (!stickToBottomRef.current) return
    const el = contentRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat])

  // Send a turn against the current chat history. We read history from a
  // ref to avoid running side-effects inside a setState updater (which
  // would double-fire under StrictMode and could issue duplicate streams).
  const sendTurn = React.useCallback((userText: string) => {
    const history = chatRef.current
    const messages: AiMessageInput[] = [
      ...history.map((turn) => ({ role: turn.role, text: turn.text })),
      { role: 'user', text: userText }
    ]
    const requestId = crypto.randomUUID()
    activeRequestId.current = requestId
    void window.assistantLite.ai.stream({ requestId, messages })
    stickToBottomRef.current = true
    setChat([
      ...history,
      { role: 'user', text: userText },
      { role: 'assistant', text: '', pending: true }
    ])
  }, [])

  const runInitialAction = React.useCallback(() => {
    if (!payload) return
    const prompt = interpolatePrompt(payload.action.promptTemplate, payload.selectedText, {
      language: t('targetLanguageName')
    })
    chatRef.current = []
    setChat([])
    setAskOpen(false)
    setAskText('')
    setTimeout(() => sendTurn(prompt), 0)
  }, [payload, t, sendTurn])

  React.useEffect(() => {
    if (payload) runInitialAction()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload])

  React.useEffect(() => {
    const onBlur = () => {
      if (settings.autoClose && !pinned) void window.assistantLite.windowControls.close()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [settings.autoClose, pinned])

  if (!payload) return null

  const lastTurn = chat[chat.length - 1]
  const loading = !!lastTurn?.pending
  const hasResult = chat.some((turn) => turn.role === 'assistant' && turn.text)

  const stop = () => {
    if (activeRequestId.current) void window.assistantLite.ai.abort(activeRequestId.current)
    activeRequestId.current = null
    setChat((current) => {
      if (!current.length) return current
      const next = [...current]
      const last = { ...next[next.length - 1] }
      last.pending = false
      next[next.length - 1] = last
      return next
    })
  }

  const togglePin = () => {
    const next = !pinned
    setPinned(next)
    void window.assistantLite.windowControls.pin(next)
  }

  const submitAsk = () => {
    const text = askText.trim()
    if (!text || activeRequestId.current) return
    setAskText('')
    setAskOpen(false)
    sendTurn(text)
  }

  const copyLast = () => {
    const last = [...chat].reverse().find((turn) => turn.role === 'assistant' && turn.text)
    if (last) void navigator.clipboard.writeText(last.text)
  }

  return (
    <div className="action-window action-window--flex">
      <div className="titlebar">
        <Icon name={payload.action.icon} />
        <strong>{getActionLabel(payload.action, settings.language)}</strong>
        <button className="icon" title={pinned ? t('unpin') : t('pin')} onClick={togglePin}>
          <Icon name={pinned ? 'pin-off' : 'pin'} />
        </button>
        {!isMac && (
          <>
            <button className="icon" title={t('minimize')} onClick={() => window.assistantLite.windowControls.minimize()}>
              <span>-</span>
            </button>
            <button className="icon" title={t('close')} onClick={() => window.assistantLite.windowControls.close()}>
              <Icon name="x" />
            </button>
          </>
        )}
      </div>

      <div className="content" ref={contentRef}>
        {chat.length === 0 && <div className="thinking-indicator">{t('preparing')}</div>}
        {chat.map((turn, index) => {
          if (turn.role === 'assistant') {
            return (
              <div key={index} className="result markdown-body">
                {turn.searchQuery && (
                  <div className="search-status">
                    {isZh ? `🔍 联网搜索：${turn.searchQuery}` : `🔍 Web search: ${turn.searchQuery}`}
                  </div>
                )}
                {turn.text ? (
                  <Markdown remarkPlugins={[remarkGfm]}>{turn.text}</Markdown>
                ) : turn.pending ? (
                  <span className="thinking-indicator">{t('preparing')}</span>
                ) : null}
                {turn.error && <div className="error">{turn.error}</div>}
              </div>
            )
          }
          // skip the initial prompt (built from the action template)
          if (index === 0) return null
          return (
            <div key={index} className="screenshot-preview__user-msg">
              {turn.text}
            </div>
          )
        })}
      </div>

      {askOpen && (
        <div className="screenshot-preview__ask">
          <input
            ref={askInputRef}
            type="text"
            value={askText}
            placeholder={isZh ? '继续追问…' : 'Ask a follow-up…'}
            onChange={(e) => setAskText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submitAsk()
              } else if (e.key === 'Escape') {
                setAskOpen(false)
                setAskText('')
              }
            }}
          />
          <button
            className="ask-send"
            onClick={submitAsk}
            disabled={!askText.trim() || loading}
            title={isZh ? '发送' : 'Send'}>
            <Icon name="arrow-up" size={18} />
          </button>
        </div>
      )}

      <div className="footer">
        <button onClick={loading ? stop : () => window.assistantLite.windowControls.close()}>
          {loading ? t('stop') : t('close')}
        </button>
        <button onClick={runInitialAction} disabled={loading}>
          {t('regenerate')}
        </button>
        <button
          onClick={() => {
            setAskOpen((v) => !v)
            setTimeout(() => askInputRef.current?.focus(), 0)
          }}
          disabled={loading}>
          {isZh ? '追问' : 'Ask'}
        </button>
        <button onClick={copyLast} disabled={loading || !hasResult}>
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
