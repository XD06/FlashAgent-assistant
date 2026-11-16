import React, { useEffect, useRef, useState } from 'react'
import type { TodoItem } from '@shared/types'

export interface TodoListPillProps {
  tasks: TodoItem[]
  isZh: boolean
}

/** Floating task pill anchored centered just above .chat-input so it adds
 * zero full-width row height between messages and composer. Clicking pops
 * the checklist card cleanly above the pill without shifting chat layout. */
export const TodoListPill: React.FC<TodoListPillProps> = ({ tasks, isZh }) => {
  const [expanded, setExpanded] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!expanded) return
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setExpanded(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setExpanded(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [expanded])

  if (!tasks || tasks.length === 0) return null

  const completed = tasks.filter((t) => t.status === 'completed').length
  const total = tasks.length
  const inProgress = tasks.find((t) => t.status === 'in_progress')
  const isAllDone = completed === total

  const ratio = total > 0 ? completed / total : 0
  const hasInProgress = tasks.some((t) => t.status === 'in_progress')
  const ringRadius = 4.8
  const ringCircumference = 2 * Math.PI * ringRadius
  const ringOffset = ringCircumference * (1 - ratio)

  const barLabel = isAllDone
    ? isZh
      ? '步骤已全部完成'
      : 'All steps completed'
    : inProgress
      ? inProgress.text
      : isZh
        ? '待执行任务'
        : 'Pending tasks'

  return (
    <div
      ref={wrapRef}
      className={`todo-dock${expanded ? ' todo-dock--expanded' : ''}${isAllDone ? ' todo-dock--done' : hasInProgress ? ' todo-dock--active' : ''}`}
    >
      {expanded && (
        <div className="todo-dock__list">
          {tasks.map((task, idx) => (
            <div key={task.id || idx} className={`todo-item todo-item--${task.status}`}>
              <div className="todo-item__icon-wrapper">
                {task.status === 'completed' && (
                  <svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" className="todo-item__svg--completed">
                    <circle cx="12" cy="12" r="9.2" fill="var(--status-ok-soft)" stroke="var(--status-ok)" strokeWidth="1.8" />
                    <polyline points="8.5 12.2 11 14.8 15.8 9.2" stroke="var(--status-ok)" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                {task.status === 'in_progress' && (
                  <svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" className="todo-item__svg--progress">
                    <circle cx="12" cy="12" r="9" stroke="color-mix(in srgb, var(--accent) 26%, transparent)" strokeWidth="2.1" />
                    <circle cx="12" cy="12" r="9" stroke="var(--accent)" strokeWidth="2.2" strokeDasharray="20" strokeDashoffset="8" strokeLinecap="round" />
                  </svg>
                )}
                {task.status === 'pending' && (
                  <svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" className="todo-item__svg--pending">
                    <circle cx="12" cy="12" r="8.5" stroke="var(--muted-soft)" strokeWidth="1.6" strokeDasharray="3 3" />
                  </svg>
                )}
              </div>
              <div className="todo-item__content">
                <span className="todo-item__text">{task.text}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        className="todo-dock__bar"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        title={isZh ? '点击展开/收起任务清单' : 'Toggle task checklist'}
      >
        <span
          className={`todo-dock__ring${isAllDone ? ' todo-dock__ring--done' : hasInProgress ? ' todo-dock__ring--spin' : ''}`}
          aria-hidden="true"
        >
          {isAllDone ? (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6.3" fill="currentColor" fillOpacity="0.16" stroke="currentColor" strokeWidth="1.5" />
              <path d="M5.2 8.2l1.8 1.8 3.8-3.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r={ringRadius} stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.8" />
              <circle
                cx="8"
                cy="8"
                r={ringRadius}
                stroke="currentColor"
                strokeWidth="1.9"
                strokeDasharray={ringCircumference.toFixed(2)}
                strokeDashoffset={ringOffset.toFixed(2)}
                strokeLinecap="round"
                transform="rotate(-90 8 8)"
              />
            </svg>
          )}
        </span>
        <span className="todo-dock__label">{barLabel}</span>
        <span className="todo-dock__meta">
          <span className={`todo-dock__badge${isAllDone ? ' todo-dock__badge--done' : ''}`}>
            {completed}/{total}
          </span>
          <svg
            className={`todo-dock__chevron${expanded ? ' todo-dock__chevron--open' : ''}`}
            width="10.5"
            height="10.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </span>
      </button>
    </div>
  )
}
