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

  React.useEffect(() => {
    if (prevPending.current && !pending) {
      setCollapsed(true)
    }
    prevPending.current = pending
  }, [pending])

  return (
    <div className={`thinking-block${collapsed ? ' thinking-block--collapsed' : ''}`}>
      <button
        className="thinking-block__header"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? t('expandThinking') : t('collapseThinking')}
      >
        <Icon name="sparkles" size={13} />
        <span>{collapsed ? t('thinkingCollapsed') : t('thinking')}</span>
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
        <div className="thinking-block__content markdown-body">
          <MarkdownView pending={pending}>{text}</MarkdownView>
        </div>
      )}
    </div>
  )
}
