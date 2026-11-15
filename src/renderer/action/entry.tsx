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
  reasoningPending?: boolean
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
  onNewWindow,
  extra
}: {
  icon: string
  title: string
  pinned: boolean
  togglePin: () => void
  t: Translator
  onNewWindow?: () => void
  extra?: React.ReactNode
}) {
  return (
    <div className="titlebar titlebar--left">
      <Icon name={icon} />
      <strong>{title}</strong>
      {extra}
      {onNewWindow && (
        <button className="icon" title={t('openNewWindow')} onClick={onNewWindow}>
          <Icon name="plus" size={14} />
        </button>
      )}
      <button className={pinned ? 'icon icon--active' : 'icon'} title={pinned ? t('unpin') : t('pin')} onClick={togglePin}>
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

  // Abort any in-flight stream when the window closes/reloads OR unmounts (e.g.
  // pooled window reset on hide), otherwise main keeps streaming unseen tokens.
  React.useEffect(() => {
    const abortActive = () => {
      if (activeRequestId.current) {
        void window.assistantLite.ai.abort(activeRequestId.current)
        activeRequestId.current = null
      }
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
    }
    window.addEventListener('beforeunload', abortActive)
    return () => {
      window.removeEventListener('beforeunload', abortActive)
      abortActive()
    }
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
        if (reasoning) {
          last.reasoning = (last.reasoning ?? '') + reasoning
          last.reasoningPending = true
        }
        if (text) {
          last.text += text
          last.reasoningPending = false
        }
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
          last.reasoningPending = false
        } else if (chunk.type === 'error') {
          last.pending = false
          last.reasoningPending = false
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
        history?: ChatTurn[]
        images?: string[]
        model?: string
      }
    ) => {
      const history = opts.history ?? (opts.reset ? [] : chatRef.current)
      const images = opts.images?.filter(Boolean)
      const messages = [
        ...history.map((turn) => ({
          role: turn.role,
          text: turn.text,
          ...(turn.images?.length ? { images: turn.images } : {})
        })),
        { role: 'user' as const, text: opts.sendText, ...(images?.length ? { images } : {}) }
      ]
      if (activeRequestId.current) {
        void window.assistantLite.ai.abort(activeRequestId.current)
      }
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
      const nextChat: ChatTurn[] = [
        ...history,
        {
          role: 'user',
          text: opts.sendText,
          display: opts.display,
          hidden: opts.hidden,
          ...(images?.length ? { images } : {})
        },
        { role: 'assistant', text: '', pending: true }
      ]
      chatRef.current = nextChat
      setChat(nextChat)
    },
    [action]
  )

  const stop = React.useCallback(() => {
    if (activeRequestId.current) void window.assistantLite.ai.abort(activeRequestId.current)
    activeRequestId.current = null
    setChat((current) => {
      if (!current.length) return current
      const next = [...current]
      next[next.length - 1] = { ...next[next.length - 1], pending: false, reasoningPending: false }
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
      if (event.key === 'Escape') {
        event.preventDefault()
        closeExpandedImage()
      }
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
                <ThinkingBlock text={turn.reasoning} pending={!!turn.reasoningPending} t={t} />
              )}
              {turn.text ? (
                <MarkdownView pending={!!turn.pending}>{turn.text}</MarkdownView>
              ) : turn.pending && showThinking && !turn.reasoning ? (
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

function getLastAssistantText(chat: ChatTurn[]): string {
  const last = [...chat].reverse().find((turn) => turn.role === 'assistant' && turn.text)
  return last?.text ?? ''
}

function ResultUtilityBar({
  text,
  loading,
  speaking,
  copied,
  onCopy,
  onToggleSpeak,
  onRegenerate,
  extra,
  t
}: {
  text: string
  loading: boolean
  speaking: boolean
  copied: boolean
  onCopy: () => void
  onToggleSpeak: () => void
  onRegenerate?: () => void
  extra?: React.ReactNode
  t: Translator
}) {
  return (
    <div className="action-utility-bar">
      <button
        type="button"
        className={`action-util-btn${copied ? ' action-util-btn--ok' : ''}`}
        disabled={loading || !text}
        onClick={onCopy}
        title={copied ? t('copied') : t('copy')}>
        <Icon name={copied ? 'check' : 'copy'} size={13} />
        <span>{copied ? t('copied') : t('copy')}</span>
      </button>
      <button
        type="button"
        className={`action-util-btn${speaking ? ' action-util-btn--active' : ''}`}
        disabled={loading || !text}
        onClick={onToggleSpeak}
        title={speaking ? t('stop') : t('speak')}>
        <Icon name={speaking ? 'square' : 'volume-2'} size={13} />
        <span>{speaking ? t('stop') : t('speak')}</span>
      </button>
      {onRegenerate && (
        <button
          type="button"
          className="action-util-btn"
          disabled={loading}
          onClick={onRegenerate}
          title={t('regenerate')}>
          <Icon name="refresh-cw" size={13} />
          <span>{t('regenerate')}</span>
        </button>
      )}
      {extra}
    </div>
  )
}

/** Unified docked composer shared between SelectionResult and InputResult. */
function ActionFooterComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  loading,
  placeholder,
  isZh,
  t,
  inputRef,
  chips,
  onChipClick,
  autoFocus
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onStop: () => void
  loading: boolean
  placeholder: string
  isZh: boolean
  t: Translator
  inputRef?: React.RefObject<HTMLTextAreaElement>
  chips?: readonly { label: string; prompt: string }[]
  onChipClick?: (prompt: string) => void
  autoFocus?: boolean
}) {
  const localRef = React.useRef<HTMLTextAreaElement>(null)
  const taRef = inputRef ?? localRef

  React.useEffect(() => {
    if (!autoFocus) return
    const timer = setTimeout(() => taRef.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [autoFocus, taRef])

  React.useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(112, el.scrollHeight)}px`
  }, [value, taRef])

  return (
    <div className="action-composer">
      {!!chips?.length && (
        <div className="action-chips">
          {chips.map((chip) => (
            <button
              key={chip.label}
              type="button"
              className="action-chip"
              onClick={() => onChipClick?.(chip.prompt)}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}
      <div className="action-composer__box">
        <textarea
          ref={taRef}
          rows={1}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (loading) onStop()
              else onSubmit()
            } else if (e.key === 'Escape' && value) {
              e.preventDefault()
              e.stopPropagation()
              onChange('')
            }
          }}
        />
        <button
          type="button"
          className={`action-composer__send${loading ? ' action-composer__send--stop' : ''}`}
          onClick={loading ? onStop : onSubmit}
          disabled={!loading && !value.trim()}
          title={loading ? t('stop') : isZh ? '发送' : 'Send'}
        >
          <Icon name={loading ? 'square' : 'arrow-up'} size={15} />
        </button>
      </div>
    </div>
  )
}

// Selection mode: run the action on the selected text immediately, then allow
// follow-up questions in the same window. Also hosts screenshot vision when
// `payload.images` is present (replaces the old dedicated preview window).
function SelectionResult({ payload, settings, settingsLoaded, t, pinned, togglePin }: ResultProps) {
  const isZh = settings.language === 'zh-CN'
  const isVision = !!payload.images?.length
  const liveAction = React.useMemo(
    () => settings.actions.find((a) => a.id === payload.action.id) ?? payload.action,
    [settings.actions, payload.action]
  )
  // With reasoning off the answer streams back almost immediately, so the
  // "Thinking…" placeholder is just a flash of noise — only show it when on.
  const showThinking = (liveAction.reasoning ?? 'on') !== 'off'
  const { chat, send, stop, loading, hasResult } = useActionStream(liveAction, t)
  const [askText, setAskText] = React.useState('')
  const [showImage, setShowImage] = React.useState(false)
  const [quoteExpanded, setQuoteExpanded] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [speaking, setSpeaking] = React.useState(false)
  const askInputRef = React.useRef<HTMLTextAreaElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const copiedTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const stick = useAutoScroll(contentRef, chat)
  // settings.visionModel can load after first paint; keep a ref so the initial
  // vision request always uses the configured override (same fix as old preview).
  const visionModelRef = React.useRef(settings.visionModel ?? '')
  React.useEffect(() => {
    visionModelRef.current = settings.visionModel ?? ''
  }, [settings.visionModel])

  React.useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    }
  }, [])

  const runInitialAction = React.useCallback(() => {
    const prompt = isVision
      ? (liveAction.promptTemplate?.trim() ||
        (isZh
          ? '直接用简洁易懂的话解释这张图片。抓住重点，不要废话，不要逐一描述画面元素，也不要堆砌冗长段落；只有在真正有帮助时再补一句简短总结。'
          : 'Explain this image directly in plain, easy-to-understand language. Be concise, stay focused on the key point, avoid listing every visual element, and skip filler. Add a brief summary only when it is genuinely helpful.'))
      : interpolatePrompt(liveAction.promptTemplate, payload.selectedText, {
          language: t('targetLanguageName')
        })
    setAskText('')
    setShowImage(false)
    setSpeaking(false)
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
  }, [payload, liveAction, t, send, stick, isVision, isZh])

  const startedPayloadRef = React.useRef<ActionPayload | null>(null)
  React.useEffect(() => {
    if (!settingsLoaded) return
    if (startedPayloadRef.current === payload) return
    startedPayloadRef.current = payload
    runInitialAction()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, isVision, settingsLoaded])

  const sendFollowUp = (rawText: string) => {
    const text = rawText.trim()
    if (!text || loading) return
    setAskText('')
    setSpeaking(false)
    stick.current = true
    // Follow-ups are text-only; the first vision turn already carried the image
    // in history via turn.images on the hidden user message.
    send({
      sendText: text,
      display: text,
      model: isVision ? visionModelRef.current.trim() || undefined : undefined
    })
  }

  const lastReplyText = React.useMemo(() => getLastAssistantText(chat), [chat])

  const handleCopy = () => {
    if (!lastReplyText) return
    void navigator.clipboard.writeText(lastReplyText)
    setCopied(true)
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1400)
  }

  const handleToggleSpeak = () => {
    if (speaking) {
      setSpeaking(false)
      void window.assistantLite.tts.stopPlayback()
      return
    }
    if (!lastReplyText) return
    setSpeaking(true)
    void window.assistantLite.tts.play(lastReplyText).finally(() => setSpeaking(false))
  }

  const title = isVision
    ? (isZh ? 'AI 识图' : 'AI Vision')
    : getActionLabel(liveAction, settings.language)

  // For vision, only render image thumbs when the user toggles "show image".
  const turnsForView = React.useMemo(() => {
    if (!isVision || showImage) return chat
    return chat.map((turn) => (turn.images?.length ? { ...turn, images: undefined } : turn))
  }, [chat, isVision, showImage])

  const sourcePreview = payload.selectedText.trim()
  const quickChips = React.useMemo(
    () => [
      { label: t('quickChipSimpler'), prompt: t('quickChipSimplerPrompt') },
      { label: t('quickChipExample'), prompt: t('quickChipExamplePrompt') },
      { label: t('quickChipSummary'), prompt: t('quickChipSummaryPrompt') }
    ],
    [t]
  )

  return (
    <div className="action-window action-window--flex action-window--sub">
      <Titlebar
        icon={liveAction.icon}
        title={title}
        pinned={pinned}
        togglePin={togglePin}
        t={t}
        onNewWindow={() => void window.assistantLite.windowControls.openNew({ mode: 'action', action: liveAction })}
        extra={
          isVision ? (
            <button
              className={`icon${showImage ? ' icon--active' : ''}`}
              title={showImage ? t('hideScreenshot') : t('showScreenshot')}
              onClick={() => setShowImage((v) => !v)}
            >
              <Icon name="eye" size={14} />
            </button>
          ) : null
        }
      />

      <div className="content" ref={contentRef}>
        {sourcePreview && !isVision && (
          <div className={`action-source${quoteExpanded ? ' action-source--open' : ''}`}>
            <button
              type="button"
              className="action-source__toggle"
              onClick={() => setQuoteExpanded((v) => !v)}
              aria-expanded={quoteExpanded}>
              <Icon name={quoteExpanded ? 'chevron-down' : 'chevron-right'} size={12} />
              <span className="action-source__label">{t('sourceText')}</span>
              {!quoteExpanded && <span className="action-source__preview">{sourcePreview}</span>}
            </button>
            {quoteExpanded && <div className="action-source__full">{sourcePreview}</div>}
          </div>
        )}
        {chat.length === 0 && showThinking && <div className="thinking-indicator">{t('preparing')}</div>}
        <ChatTurns chat={turnsForView} t={t} isZh={isZh} showThinking={showThinking} />
        {(hasResult || loading) && (
          <ResultUtilityBar
            text={lastReplyText}
            loading={loading}
            speaking={speaking}
            copied={copied}
            onCopy={handleCopy}
            onToggleSpeak={handleToggleSpeak}
            onRegenerate={runInitialAction}
            t={t}
          />
        )}
      </div>

      <ActionFooterComposer
        value={askText}
        onChange={setAskText}
        onSubmit={() => sendFollowUp(askText)}
        onStop={stop}
        loading={loading}
        placeholder={t('followUpPlaceholder')}
        isZh={isZh}
        t={t}
        inputRef={askInputRef}
        chips={hasResult && !loading ? quickChips : undefined}
        onChipClick={sendFollowUp}
      />
    </div>
  )
}

// Input mode: opens clean with a unified bottom composer, runs the action template
// on the first turn while showing only the user's text, then supports continuous
// multi-turn follow-up conversation in place.
function InputResult({ payload, settings, t, pinned, togglePin }: ResultProps) {
  const isZh = settings.language === 'zh-CN'
  const liveAction = React.useMemo(
    () => settings.actions.find((a) => a.id === payload.action.id) ?? payload.action,
    [settings.actions, payload.action]
  )
  const showThinking = (liveAction.reasoning ?? 'on') !== 'off'
  const { chat, setChat, send, stop, loading, hasResult } = useActionStream(liveAction, t)
  const [input, setInput] = React.useState('')
  const [copied, setCopied] = React.useState(false)
  const [speaking, setSpeaking] = React.useState(false)
  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const copiedTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const stick = useAutoScroll(contentRef, chat)

  React.useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    }
  }, [])

  const submit = () => {
    const value = input.trim()
    if (!value || loading) return
    if (liveAction.type === 'search') {
      const url = buildSearchUrl(liveAction, value)
      if (url) void window.assistantLite.app.openExternal(url)
      void window.assistantLite.windowControls.close()
      return
    }
    if (liveAction.type === 'copy') {
      void navigator.clipboard.writeText(value)
      void window.assistantLite.windowControls.close()
      return
    }
    if (liveAction.type === 'speak') {
      void window.assistantLite.tts.play(value)
      void window.assistantLite.windowControls.close()
      return
    }
    const isFirstTurn = chat.length === 0
    const sendText = isFirstTurn
      ? interpolatePrompt(liveAction.promptTemplate, value, { language: t('targetLanguageName') })
      : value
    setSpeaking(false)
    stick.current = true
    setInput('')
    send({ sendText, display: value, reset: false })
  }

  const lastReplyText = React.useMemo(() => getLastAssistantText(chat), [chat])

  const handleRegenerate = React.useCallback(() => {
    if (loading) return
    let lastUserIdx = -1
    for (let i = chat.length - 1; i >= 0; i--) {
      if (chat[i].role === 'user') {
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx < 0) return
    const targetTurn = chat[lastUserIdx]
    setSpeaking(false)
    stick.current = true
    send({
      sendText: targetTurn.text,
      display: targetTurn.display,
      hidden: targetTurn.hidden,
      history: chat.slice(0, lastUserIdx)
    })
  }, [chat, loading, send, stick])

  const handleCopy = () => {
    if (!lastReplyText) return
    void navigator.clipboard.writeText(lastReplyText)
    setCopied(true)
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1400)
  }

  const handleToggleSpeak = () => {
    if (speaking) {
      setSpeaking(false)
      void window.assistantLite.tts.stopPlayback()
      return
    }
    if (!lastReplyText) return
    setSpeaking(true)
    void window.assistantLite.tts.play(lastReplyText).finally(() => setSpeaking(false))
  }

  const handleClear = () => {
    if (loading) stop()
    setSpeaking(false)
    setChat([])
    setInput('')
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  return (
    <div className="action-window action-window--flex action-window--sub">
      <Titlebar
        icon={liveAction.icon}
        title={getActionLabel(liveAction, settings.language)}
        pinned={pinned}
        togglePin={togglePin}
        t={t}
        onNewWindow={() => void window.assistantLite.windowControls.openNew({ mode: 'action', action: liveAction })}
      />

      <div className="content" ref={contentRef}>
        {chat.length === 0 ? (
          <div className="action-input-empty">
            <div className="action-input-empty__orb">
              <Icon name={liveAction.icon} size={18} />
            </div>
            <div className="action-input-empty__title">
              {getActionLabel(liveAction, settings.language)}
            </div>
            <div className="action-input-empty__hint">
              {liveAction.type === 'prompt'
                ? (isZh ? '在下方输入内容即可开始，支持连续多轮追问' : 'Type below to start — ask follow-ups continuously')
                : (isZh ? '输入内容后按 Enter 执行操作' : 'Type text below and press Enter to run')}
            </div>
          </div>
        ) : (
          <>
            <ChatTurns chat={chat} t={t} isZh={isZh} showThinking={showThinking} />
            {(hasResult || loading) && (
              <ResultUtilityBar
                text={lastReplyText}
                loading={loading}
                speaking={speaking}
                copied={copied}
                onCopy={handleCopy}
                onToggleSpeak={handleToggleSpeak}
                onRegenerate={handleRegenerate}
                extra={
                  <button
                    type="button"
                    className="action-util-btn"
                    disabled={loading}
                    onClick={handleClear}
                    title={isZh ? '清空' : 'Clear'}>
                    <Icon name="trash-2" size={13} />
                    <span>{isZh ? '清空' : 'Clear'}</span>
                  </button>
                }
                t={t}
              />
            )}
          </>
        )}
      </div>

      <ActionFooterComposer
        value={input}
        onChange={setInput}
        onSubmit={submit}
        onStop={stop}
        loading={loading}
        placeholder={chat.length > 0 && liveAction.type === 'prompt' ? t('followUpPlaceholder') : t('inputPlaceholder')}
        isZh={isZh}
        t={t}
        inputRef={inputRef}
        autoFocus
      />
    </div>
  )
}

type ActionViewState =
  | { kind: 'chat' }
  | { kind: 'cleared' }
  | { kind: 'action'; payload: ActionPayload }

function ActionApp() {
  const { settings, loaded: settingsLoaded } = useSettings()
  // Seed from the payload the window was opened with so the very first render
  // already has content; the main process shows the window on its first paint.
  // Later opens arrive via onAction, and hide-on-close triggers onReset so a
  // pooled window unmounts its stale session before next open.
  const [viewState, setViewState] = React.useState<ActionViewState>(() => {
    const initial = window.assistantLite.selection.getInitialAction()
    return initial ? { kind: 'action', payload: initial } : { kind: 'chat' }
  })
  const [pinned, setPinned] = React.useState(settings.autoPin)
  const t = getTranslator(settings.language)
  useThemeMode(settings)
  useAppearance(settings)

  const payload = viewState.kind === 'action' ? viewState.payload : null

  const prevAutoPinRef = React.useRef<boolean | null>(null)
  const prevSessionIdRef = React.useRef<string | undefined>(undefined)
  React.useEffect(() => {
    if (!settingsLoaded) return
    const firstLoad = prevAutoPinRef.current === null
    const autoPinChanged = prevAutoPinRef.current !== settings.autoPin
    const newSession = !!payload?.sessionId && prevSessionIdRef.current !== payload.sessionId
    if (firstLoad || autoPinChanged || newSession) {
      prevAutoPinRef.current = settings.autoPin
      prevSessionIdRef.current = payload?.sessionId
      setPinned(settings.autoPin)
      if (payload) void window.assistantLite.windowControls.pin(settings.autoPin)
    }
  }, [settingsLoaded, settings.autoPin, payload])

  // Esc closes the action window (unless already consumed by lightbox or draft clear).
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        void window.assistantLite.windowControls.close()
      }
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

  React.useEffect(() => window.assistantLite.selection.onAction((next) => setViewState({ kind: 'action', payload: next })), [])
  React.useEffect(
    () => window.assistantLite.selection.onReset(() => setViewState((prev) => (prev.kind === 'chat' ? prev : { kind: 'cleared' }))),
    []
  )

  const sessionOpenedAtRef = React.useRef(0)
  React.useEffect(() => {
    sessionOpenedAtRef.current = payload ? Date.now() : 0
  }, [payload])

  React.useEffect(() => {
    const onBlur = () => {
      if (!payload || !settings.autoClose || pinned) return
      // Ignore transient focus/Z-order handoff blur immediately after showing a warm reused window.
      if (Date.now() - sessionOpenedAtRef.current < 300) return
      void window.assistantLite.windowControls.close()
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
  if (viewState.kind === 'chat') {
    return (
      <React.Suspense fallback={<ChatModeFallback t={t} />}>
        <ChatMode settings={settings} />
      </React.Suspense>
    )
  }

  if (viewState.kind === 'cleared') {
    return <div className="action-window action-window--flex" />
  }

  const shared: ResultProps = { payload: viewState.payload, settings, settingsLoaded, t, pinned, togglePin }
  const resultKey = `${viewState.payload.mode}:${viewState.payload.action.id}:${viewState.payload.sessionId ?? 'init'}`
  return viewState.payload.mode === 'input' ? (
    <InputResult key={resultKey} {...shared} />
  ) : (
    <SelectionResult key={resultKey} {...shared} />
  )
}

/** Minimal shell while the chat chunk loads — same outer chrome as ChatMode. */
function ChatModeFallback({ t }: { t: Translator }) {
  const isTemporary = React.useMemo(() => {
    try {
      return localStorage.getItem('aia-chat-temporary-mode') === 'true'
    } catch {
      return false
    }
  }, [])
  return (
    <div className="action-window action-window--flex">
      <div className="titlebar titlebar--left titlebar--chat">
        <Icon name={isTemporary ? 'incognito' : 'sparkles'} />
        <div className="titlebar__spacer" />
        {!isMac && (
          <button className="icon" title={t('close')} onClick={() => window.assistantLite.windowControls.close()}>
            <Icon name="x" />
          </button>
        )}
      </div>
      <div className="chat-content">
        <div className={`chat-empty${isTemporary ? ' chat-empty--temporary' : ''}`}>
          <div className="chat-empty__hint">{t('loading')}</div>
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<ActionApp />)
