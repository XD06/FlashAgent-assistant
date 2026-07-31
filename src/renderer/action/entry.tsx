import '../styles.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { buildSearchUrl, interpolatePrompt } from '@shared/actions'
import type { ActionItem, ActionPayload, AiChunkPayload, AppSettings } from '@shared/types'
import { MarkdownView } from '../Markdown'
import { Icon } from '../icons'
import { useSettings } from '../useSettings'
import { useThemeMode } from '../useThemeMode'
import { useAppearance } from '../useAppearance'
import { getActionLabel, getTranslator } from '../i18n'
import { ThinkingBlock } from '../chat/ThinkingBlock'

// ChatMode pulls in Agent UI, extensions, topic history (~1.2k lines + panel).
// Keep it out of the selection-result bundle: only the chat window path loads it.
const ChatMode = React.lazy(async () => {
  const mod = await import('../chat/ChatMode')
  return { default: mod.ChatMode }
})

interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
  reasoning?: string
  display?: string
  hidden?: boolean
  /** Optional image thumbnails shown on user turns (vision). */
  images?: string[]
  pending?: boolean
  error?: string
  searchQuery?: string
}

type Translator = (key: string) => string

interface ResultProps {
  payload: ActionPayload
  settings: AppSettings
  /** False until electron-store settings have been fetched (vision model override). */
  settingsLoaded: boolean
  t: Translator
  pinned: boolean
  togglePin: () => void
}

const isMac = navigator.userAgent.includes('Mac OS X')

function Titlebar({
  icon,
  title,
  pinned,
  togglePin,
  t,
  extra
}: {
  icon: string
  title: string
  pinned: boolean
  togglePin: () => void
  t: Translator
  extra?: React.ReactNode
}) {
  return (
    <div className="titlebar titlebar--left">
      <Icon name={icon} />
      <strong>{title}</strong>
      {extra}
      <button className="icon" title={pinned ? t('unpin') : t('pin')} onClick={togglePin}>
        <Icon name={pinned ? 'pin-off' : 'pin'} />
      </button>
      {!isMac && (
        <>
          <button className="icon" title={t('minimize')} onClick={() => window.assistantLite.windowControls.minimize()}>
            <Icon name="minus" size={15} />
          </button>
          <button className="icon icon--close" title={t('close')} onClick={() => window.assistantLite.windowControls.close()}>
            <Icon name="x" size={15} />
          </button>
        </>
      )}
    </div>
  )
}

// Shared streaming state for a single action's result window. Each request
// carries the action's chosen provider and reasoning mode. Hidden user turns
// (the interpolated prompt) feed the model but are not rendered.
function useActionStream(action: ActionItem, t: Translator) {
  const [chat, setChat] = React.useState<ChatTurn[]>([])
  const chatRef = React.useRef<ChatTurn[]>([])
  const activeRequestId = React.useRef<string | null>(null)

  React.useEffect(() => {
    chatRef.current = chat
  }, [chat])

  // Abort any in-flight stream when the window closes/reloads, otherwise the
  // main process keeps streaming (and paying for) tokens nobody will see.
  React.useEffect(() => {
    const onBeforeUnload = () => {
      if (activeRequestId.current) {
        void window.assistantLite.ai.abort(activeRequestId.current)
        activeRequestId.current = null
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // Streaming arrives token-by-token; buffer deltas and flush at ~20fps so we
  // don't re-render (and re-parse markdown) on every single token.
  const pendingDeltaRef = React.useRef('')
  const pendingReasoningRef = React.useRef('')
  const flushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(() => {
    const applyBuffered = (text: string, reasoning: string) => {
      if (!text && !reasoning) return
      setChat((current) => {
        if (!current.length) return current
        const next = [...current]
        const last = { ...next[next.length - 1] }
        if (text) last.text += text
        if (reasoning) last.reasoning = (last.reasoning ?? '') + reasoning
        last.pending = true
        next[next.length - 1] = last
        return next
      })
    }
    const flush = () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      const text = pendingDeltaRef.current
      const reasoning = pendingReasoningRef.current
      pendingDeltaRef.current = ''
      pendingReasoningRef.current = ''
      applyBuffered(text, reasoning)
    }
    const unsubscribe = window.assistantLite.ai.onChunk((chunk: AiChunkPayload) => {
      if (chunk.requestId !== activeRequestId.current) return
      if (chunk.type === 'delta' || chunk.type === 'reasoning') {
        if (chunk.type === 'delta') pendingDeltaRef.current += chunk.text ?? ''
        else pendingReasoningRef.current += chunk.reasoning ?? ''
        if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flush, 50)
        return
      }
      // Status/terminal events must land after any buffered text.
      flush()
      setChat((current) => {
        if (!current.length) return current
        const next = [...current]
        const last = { ...next[next.length - 1] }
        if (chunk.type === 'status') {
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
    return () => {
      unsubscribe()
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
    }
  }, [t])

  // Send a turn against the current (or reset) history. We read history from a
  // ref to avoid running side-effects inside a setState updater (which would
  // double-fire under StrictMode and could issue duplicate streams).
  // `images` only attach to this user turn (typically the first vision request);
  // follow-ups reuse text-only history so the model still sees prior context.
  const send = React.useCallback(
    (
      opts: {
        sendText: string
        display?: string
        hidden?: boolean
        reset?: boolean
        images?: string[]
        model?: string
      }
    ) => {
      const history = opts.reset ? [] : chatRef.current
      const images = opts.images?.filter(Boolean)
      const messages = [
        ...history.map((turn) => ({
          role: turn.role,
          text: turn.text,
          ...(turn.images?.length ? { images: turn.images } : {})
        })),
        { role: 'user' as const, text: opts.sendText, ...(images?.length ? { images } : {}) }
      ]
      const requestId = crypto.randomUUID()
      activeRequestId.current = requestId
      void window.assistantLite.ai.stream({
        requestId,
        messages,
        providerTemplateId: action.providerTemplateId,
        model: opts.model?.trim() || action.model?.trim() || undefined,
        reasoning: action.reasoning,
        forceSearch: action.webSearch === true ? true : action.webSearch === false ? false : undefined
      })
      setChat([
        ...history,
        {
          role: 'user',
          text: opts.sendText,
          display: opts.display,
          hidden: opts.hidden,
          ...(images?.length ? { images } : {})
        },
        { role: 'assistant', text: '', pending: true }
      ])
    },
    [action]
  )

  const stop = React.useCallback(() => {
    if (activeRequestId.current) void window.assistantLite.ai.abort(activeRequestId.current)
    activeRequestId.current = null
    setChat((current) => {
      if (!current.length) return current
      const next = [...current]
      next[next.length - 1] = { ...next[next.length - 1], pending: false }
      return next
    })
  }, [])

  const loading = !!chat[chat.length - 1]?.pending
  const hasResult = chat.some((turn) => turn.role === 'assistant' && turn.text)
  return { chat, setChat, send, stop, loading, hasResult, activeRequestId }
}

function useAutoScroll(ref: React.RefObject<HTMLDivElement>, dep: unknown) {
  const stick = React.useRef(true)
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [ref])
  React.useEffect(() => {
    if (!stick.current) return
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [ref, dep])
  return stick
}

function ChatTurns({
  chat,
  t,
  isZh,
  showThinking
}: {
  chat: ChatTurn[]
  t: Translator
  isZh: boolean
  showThinking: boolean
}) {
  const [expandedImage, setExpandedImage] = React.useState<string | null>(null)
  const closeExpandedImage = React.useCallback(() => setExpandedImage(null), [])
  const imageAlt = isZh ? '发送的图片' : 'Sent image'
  const viewImageLabel = isZh ? '放大查看原图' : 'View full image'
  const closeImageLabel = isZh ? '关闭原图预览' : 'Close image preview'

  React.useEffect(() => {
    if (!expandedImage) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeExpandedImage()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [expandedImage, closeExpandedImage])

  const renderImages = (images: string[]) =>
    images.map((src, imageIndex) => (
      <button
        key={imageIndex}
        type="button"
        className="screenshot-preview__image-button"
        title={viewImageLabel}
        aria-label={viewImageLabel}
        onClick={() => setExpandedImage(src)}
      >
        <img className="screenshot-preview__inline-img" src={src} alt={imageAlt} />
      </button>
    ))

  return (
    <>
      {chat.map((turn, index) => {
        if (turn.role === 'assistant') {
          return (
            <div key={index} className="result markdown-body">
              {turn.searchQuery && (
                <div className={`search-tool-status${turn.searchQuery.startsWith('⚠️') ? ' search-tool-status--error' : ''}`}>
                  <Icon name="search" size={13} />
                  <span>{turn.searchQuery.startsWith('⚠️')
                    ? turn.searchQuery
                    : (isZh ? `联网搜索：${turn.searchQuery}` : `Web search: ${turn.searchQuery}`)}</span>
                </div>
              )}
              {turn.reasoning && (
                <ThinkingBlock text={turn.reasoning} pending={turn.pending ?? false} t={t} />
              )}
              {turn.text ? (
                <MarkdownView pending={!!turn.pending}>{turn.text}</MarkdownView>
              ) : turn.pending && showThinking ? (
                <span className="thinking-indicator">{t('preparing')}</span>
              ) : null}
              {turn.error && <div className="error">{turn.error}</div>}
            </div>
          )
        }
        if (turn.hidden) {
          // Vision turns hide the auto prompt but still show the source image when toggled.
          if (!turn.images?.length) return null
          return (
            <div key={index} className="screenshot-preview__user-msg screenshot-preview__user-msg--image-only">
              {renderImages(turn.images)}
            </div>
          )
        }
        return (
          <div key={index} className="screenshot-preview__user-msg">
            {turn.images?.length ? renderImages(turn.images) : null}
            {turn.display ?? turn.text}
          </div>
        )
      })}
      {expandedImage && (
        <div
          className="screenshot-preview__lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={viewImageLabel}
          onClick={closeExpandedImage}
        >
          <div className="screenshot-preview__lightbox-content" onClick={(event) => event.stopPropagation()}>
            <img src={expandedImage} alt={imageAlt} />
            <button
              type="button"
              className="screenshot-preview__lightbox-close"
              title={closeImageLabel}
              aria-label={closeImageLabel}
              autoFocus
              onClick={closeExpandedImage}
            >
              <Icon name="x" />
            </button>
          </div>
        </div>
      )}
    </>
  )
}

function copyLastResult(chat: ChatTurn[]): void {
  const last = [...chat].reverse().find((turn) => turn.role === 'assistant' && turn.text)
  if (last) void navigator.clipboard.writeText(last.text)
}

// Selection mode: run the action on the selected text immediately, then allow
// follow-up questions in the same window. Also hosts screenshot vision when
// `payload.images` is present (replaces the old dedicated preview window).
function SelectionResult({ payload, settings, settingsLoaded, t, pinned, togglePin }: ResultProps) {
  const isZh = settings.language === 'zh-CN'
  const isVision = !!payload.images?.length
  // With reasoning off the answer streams back almost immediately, so the
  // "Thinking…" placeholder is just a flash of noise — only show it when on.
  const showThinking = (payload.action.reasoning ?? 'on') !== 'off'
  const { chat, send, stop, loading, hasResult } = useActionStream(payload.action, t)
  const [askOpen, setAskOpen] = React.useState(false)
  const [askText, setAskText] = React.useState('')
  const [showImage, setShowImage] = React.useState(false)
  const askInputRef = React.useRef<HTMLInputElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const stick = useAutoScroll(contentRef, chat)
  // settings.visionModel can load after first paint; keep a ref so the initial
  // vision request always uses the configured override (same fix as old preview).
  const visionModelRef = React.useRef(settings.visionModel ?? '')
  React.useEffect(() => {
    visionModelRef.current = settings.visionModel ?? ''
  }, [settings.visionModel])

  const runInitialAction = React.useCallback(() => {
    const prompt = isVision
      ? (payload.action.promptTemplate?.trim() ||
        (isZh
          ? '直接用简洁易懂的话解释这张图片。抓住重点，不要废话，不要逐一描述画面元素，也不要堆砌冗长段落；只有在真正有帮助时再补一句简短总结。'
          : 'Explain this image directly in plain, easy-to-understand language. Be concise, stay focused on the key point, avoid listing every visual element, and skip filler. Add a brief summary only when it is genuinely helpful.'))
      : interpolatePrompt(payload.action.promptTemplate, payload.selectedText, {
          language: t('targetLanguageName')
        })
    setAskOpen(false)
    setAskText('')
    setShowImage(false)
    stick.current = true
    setTimeout(
      () =>
        send({
          sendText: prompt,
          hidden: true,
          reset: true,
          images: isVision ? payload.images : undefined,
          model: isVision ? visionModelRef.current.trim() || undefined : undefined
        }),
      0
    )
  }, [payload, t, send, stick, isVision, isZh])

  React.useEffect(() => {
    // Vision must wait for stored settings so the dedicated vision model is applied.
    if (isVision && !settingsLoaded) return
    runInitialAction()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, isVision, settingsLoaded])

  const submitAsk = () => {
    const text = askText.trim()
    if (!text || loading) return
    setAskText('')
    setAskOpen(false)
    stick.current = true
    // Follow-ups are text-only; the first vision turn already carried the image
    // in history via turn.images on the hidden user message.
    send({
      sendText: text,
      display: text,
      model: isVision ? visionModelRef.current.trim() || undefined : undefined
    })
  }

  const title = isVision
    ? (isZh ? 'AI 识图' : 'AI Vision')
    : getActionLabel(payload.action, settings.language)

  // For vision, only render image thumbs when the user toggles "show image".
  const turnsForView = React.useMemo(() => {
    if (!isVision || showImage) return chat
    return chat.map((turn) => (turn.images?.length ? { ...turn, images: undefined } : turn))
  }, [chat, isVision, showImage])

  return (
    <div className="action-window action-window--flex">
      <Titlebar
        icon={payload.action.icon}
        title={title}
        pinned={pinned}
        togglePin={togglePin}
        t={t}
        extra={
          isVision ? (
            <button
              className="icon"
              title={showImage ? (isZh ? '隐藏原图' : 'Hide image') : (isZh ? '显示原图' : 'Show image')}
              onClick={() => setShowImage((v) => !v)}
            >
              <Icon name="square" />
            </button>
          ) : null
        }
      />

      <div className="content" ref={contentRef}>
        {chat.length === 0 && showThinking && <div className="thinking-indicator">{t('preparing')}</div>}
        <ChatTurns chat={turnsForView} t={t} isZh={isZh} showThinking={showThinking} />
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
                // Esc here closes the follow-up box only — keep it from bubbling
                // up to the window-level handler that would close the window.
                e.stopPropagation()
                setAskOpen(false)
                setAskText('')
              }
            }}
          />
          <button className="ask-send" onClick={submitAsk} disabled={!askText.trim() || loading} title={isZh ? '发送' : 'Send'}>
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
        <button onClick={() => copyLastResult(chat)} disabled={loading || !hasResult}>
          {t('copy')}
        </button>
      </div>
    </div>
  )
}

// Input mode: open with a type-in box, run the action on the typed text, and
// show a one-shot result. Re-running replaces the result (no follow-up chat).
function InputResult({ payload, settings, t, pinned, togglePin }: ResultProps) {
  const isZh = settings.language === 'zh-CN'
  const showThinking = (payload.action.reasoning ?? 'on') !== 'off'
  const { chat, setChat, send, stop, loading, hasResult } = useActionStream(payload.action, t)
  const [input, setInput] = React.useState('')
  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const stick = useAutoScroll(contentRef, chat)

  React.useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  React.useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(140, el.scrollHeight)}px`
  }, [input])

  const run = React.useCallback(
    (text: string) => {
      const value = text.trim()
      if (!value || loading) return
      const prompt = interpolatePrompt(payload.action.promptTemplate, value, { language: t('targetLanguageName') })
      stick.current = true
      send({ sendText: prompt, hidden: true, reset: true })
    },
    [payload, t, send, loading, stick]
  )

  const lastInputRef = React.useRef('')
  const submit = () => {
    const value = input.trim()
    if (!value || loading) return
    if (payload.action.type === 'search') {
      const url = buildSearchUrl(payload.action, value)
      if (url) void window.assistantLite.app.openExternal(url)
      void window.assistantLite.windowControls.close()
      return
    }
    if (payload.action.type === 'copy') {
      void navigator.clipboard.writeText(value)
      void window.assistantLite.windowControls.close()
      return
    }
    if (payload.action.type === 'speak') {
      void window.assistantLite.speech.speak(value)
      void window.assistantLite.windowControls.close()
      return
    }
    lastInputRef.current = input
    run(input)
  }

  return (
    <div className="action-window action-window--flex">
      <Titlebar
        icon={payload.action.icon}
        title={getActionLabel(payload.action, settings.language)}
        pinned={pinned}
        togglePin={togglePin}
        t={t}
      />

      <div className="action-input">
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          placeholder={isZh ? '输入文本，回车运行…' : 'Type text, Enter to run…'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (loading) stop()
              else submit()
            }
          }}
        />
        <button
          className="action-input__btn"
          onClick={loading ? stop : submit}
          disabled={!loading && !input.trim()}
          title={loading ? t('stop') : isZh ? '运行' : 'Run'}>
          <Icon name={loading ? 'square' : 'arrow-up'} size={18} />
        </button>
      </div>

      {chat.length > 0 && (
        <div className="content" ref={contentRef}>
          <ChatTurns chat={chat} t={t} isZh={isZh} showThinking={showThinking} />
        </div>
      )}

      <div className="footer">
        <button onClick={() => window.assistantLite.windowControls.close()}>{t('close')}</button>
        <button onClick={() => run(lastInputRef.current)} disabled={loading || !lastInputRef.current.trim()}>
          {t('regenerate')}
        </button>
        <button
          onClick={() => {
            setChat([])
            setInput('')
            setTimeout(() => inputRef.current?.focus(), 0)
          }}
          disabled={loading || (!hasResult && !input)}>
          {isZh ? '清空' : 'Clear'}
        </button>
        <button onClick={() => copyLastResult(chat)} disabled={loading || !hasResult}>
          {t('copy')}
        </button>
      </div>
    </div>
  )
}

function ActionApp() {
  const { settings, loaded: settingsLoaded } = useSettings()
  // Seed from the payload the window was opened with so the very first render
  // already has content; the main process shows the window on its first paint.
  // Later opens that reuse this window arrive via onAction below.
  const [payload, setPayload] = React.useState<ActionPayload | null>(
    () => window.assistantLite.selection.getInitialAction()
  )
  const [pinned, setPinned] = React.useState(settings.autoPin)
  const t = getTranslator(settings.language)
  useThemeMode(settings.theme)
  useAppearance(settings)

  // Esc closes the action window (both selection-result and type-in modes).
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void window.assistantLite.windowControls.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
    const onBlur = () => {
      if (payload && settings.autoClose && !pinned) void window.assistantLite.windowControls.close()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [settings.autoClose, pinned, payload])

  const togglePin = () => {
    const next = !pinned
    setPinned(next)
    void window.assistantLite.windowControls.pin(next)
  }

  // No initial payload ⇒ independent chat window. Suspense only wraps this
  // branch so selection/input paths never wait on (or download) ChatMode.
  if (!payload) {
    return (
      <React.Suspense fallback={<ChatModeFallback t={t} />}>
        <ChatMode settings={settings} />
      </React.Suspense>
    )
  }

  const shared: ResultProps = { payload, settings, settingsLoaded, t, pinned, togglePin }
  // Keyed by action so reusing the window for a different action remounts with
  // fresh state; re-running the same action re-uses the instance. Vision opens
  // use a unique action.id per capture (see main onExplainImage).
  const resultKey = payload.mode === 'input'
    ? `input:${payload.action.id}`
    : `selection:${payload.action.id}`
  return payload.mode === 'input' ? (
    <InputResult key={resultKey} {...shared} />
  ) : (
    <SelectionResult key={resultKey} {...shared} />
  )
}

/** Minimal shell while the chat chunk loads — same outer chrome as ChatMode. */
function ChatModeFallback({ t }: { t: Translator }) {
  return (
    <div className="action-window action-window--flex">
      <div className="titlebar titlebar--left titlebar--chat">
        <Icon name="sparkles" />
        <div className="titlebar__spacer" />
        {!isMac && (
          <button className="icon" title={t('close')} onClick={() => window.assistantLite.windowControls.close()}>
            <Icon name="x" />
          </button>
        )}
      </div>
      <div className="chat-content">
        <div className="chat-empty">
          <div className="chat-empty__hint">{t('loading')}</div>
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<ActionApp />)
