import React from 'react'
import { Icon } from '../icons'
import { MarkdownView } from '../Markdown'

type Translator = (key: string) => string

/** ThinkingBlock — collapsible reasoning content. Auto-collapses when done;
 * blocks restored from history (never pending) start collapsed. */
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

  return (
    <div className={`thinking-block${collapsed ? ' thinking-block--collapsed' : ''}`}>
      <button
        className="thinking-block__header"
        onClick={() => {
          setCollapsed((v) => {
            if (v) pinToBottomRef.current = true
            return !v
          })
        }}
        title={collapsed ? t('expandThinking') : t('collapseThinking')}
      >
        <Icon name="sparkles" size={13} />
        {/* Same label collapsed or expanded — the chevron already signals the
            state, a "(collapsed)" suffix is just noise. */}
        <span>{t('thinking')}</span>
        {pending && <span className="thinking-block__dot" />}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ marginLeft: 'auto', transition: 'transform 0.15s', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0)' }}
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
