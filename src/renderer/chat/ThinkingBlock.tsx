import React from 'react'
import { MarkdownView } from '../Markdown'
import { Icon } from '../icons'

type Translator = (key: string) => string

function extractThinkingPreview(raw: string): string {
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return ''
  return firstLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/[*`~]/g, '')
    .replace(/(^|\s)_+|_+(\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** ThinkingBlock — flat dsh-style reasoning toggle with inline summary preview
 * and a subtle vertical guide line when expanded. Auto-collapses when settled. */
export function ThinkingBlock({
  text,
  pending,
  t
}: {
  text: string
  pending: boolean
  t: Translator
}) {
  const [collapsed, setCollapsed] = React.useState(!pending)
  const prevPending = React.useRef(pending)
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  const pinToBottomRef = React.useRef(true)

  React.useEffect(() => {
    if (prevPending.current && !pending) {
      setCollapsed(true)
    }
    if (!prevPending.current && pending) {
      pinToBottomRef.current = true
    }
    prevPending.current = pending
  }, [pending])

  const onScroll = React.useCallback(() => {
    const el = contentRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    pinToBottomRef.current = distance < 32
  }, [])

  // Auto-scroll thinking content to bottom as new reasoning tokens arrive
  React.useEffect(() => {
    if (!pending || collapsed || !pinToBottomRef.current) return
    const el = contentRef.current
    if (!el) return
    const raf = requestAnimationFrame(() => {
      if (pinToBottomRef.current && contentRef.current) {
        contentRef.current.scrollTop = contentRef.current.scrollHeight
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [text, pending, collapsed])

  const preview = React.useMemo(() => (collapsed ? extractThinkingPreview(text) : ''), [collapsed, text])

  return (
    <div className={`thinking-block${collapsed ? ' thinking-block--collapsed' : ''}${pending ? ' thinking-block--pending' : ''}`}>
      <button
        type="button"
        className="thinking-block__header"
        onClick={() => {
          setCollapsed((v) => {
            if (v) pinToBottomRef.current = true
            return !v
          })
        }}
        title={collapsed ? t('expandThinking') : t('collapseThinking')}
      >
        {pending ? (
          <span className="thinking-block__dot" />
        ) : (
          <span className="thinking-block__icon" aria-hidden="true">
            <Icon name="brain" size={12} />
          </span>
        )}
        <span className="thinking-block__label">{t('thinking')}</span>
        {preview && <span className="thinking-block__preview">· {preview}</span>}
        <svg
          className="thinking-block__chevron"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0)' }}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {!collapsed && (
        <div
          ref={contentRef}
          onScroll={onScroll}
          className="thinking-block__content markdown-body"
        >
          <MarkdownView pending={pending}>{text}</MarkdownView>
        </div>
      )}
    </div>
  )
}
