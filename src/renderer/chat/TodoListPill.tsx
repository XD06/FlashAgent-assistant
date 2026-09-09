import React, { useEffect, useRef, useState } from 'react'
import type { TodoItem } from '@shared/types'

export interface TodoListPillProps {
  tasks: TodoItem[]
  isZh: boolean
}

export const TodoListPill: React.FC<TodoListPillProps> = ({ tasks, isZh }) => {
  const [expanded, setExpanded] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!expanded) return
    const handleOutsideClick = (e: MouseEvent | PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setExpanded(false)
      }
    }
    document.addEventListener('pointerdown', handleOutsideClick)
    return () => {
      document.removeEventListener('pointerdown', handleOutsideClick)
    }
  }, [expanded])

  if (!tasks || tasks.length === 0) return null

  const completed = tasks.filter((t) => t.status === 'completed').length
  const total = tasks.length
  const inProgress = tasks.find((t) => t.status === 'in_progress')
  const isAllDone = completed === total

  let pillLabel = ''
  if (isAllDone) {
    pillLabel = isZh ? '步骤已全部完成' : 'All completed'
  } else if (inProgress) {
    pillLabel = inProgress.text
  } else {
    pillLabel = isZh ? '待执行' : 'Pending'
  }

  return (
    <div ref={containerRef} className="todo-pill-wrapper">
      {expanded && (
        <div className="todo-card">
          <div className="todo-card__header">
            <div className="todo-card__title">
              <span className="todo-card__heading">{isZh ? '进程' : 'Progress'}</span>
              <span className={`todo-card__count ${isAllDone ? 'todo-card__count--done' : ''}`}>
                {completed}/{total}
              </span>
            </div>
            <button
              type="button"
              className="todo-card__collapse-btn"
              title={isZh ? '收起清单' : 'Collapse checklist'}
              onClick={() => setExpanded(false)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="10" y1="14" x2="3" y2="21" />
              </svg>
            </button>
          </div>

          <div className="todo-card__list">
            {tasks.map((task, idx) => (
              <div key={task.id || idx} className={`todo-item todo-item--${task.status}`}>
                <div className="todo-item__icon-wrapper">
                  {task.status === 'completed' && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="todo-item__svg--completed">
                      <circle cx="12" cy="12" r="9.5" stroke="#16a34a" strokeWidth="1.8" />
                      <polyline points="8 12 11 15 16 9" stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                  {task.status === 'in_progress' && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="todo-item__svg--progress">
                      <circle cx="12" cy="12" r="9.5" stroke="var(--border-soft)" strokeWidth="1.8" />
                      <circle cx="12" cy="12" r="9.5" stroke="var(--accent)" strokeWidth="2" strokeDasharray="24" strokeDashoffset="10" strokeLinecap="round" />
                    </svg>
                  )}
                  {task.status === 'pending' && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="todo-item__svg--pending">
                      <circle cx="12" cy="12" r="9.5" stroke="var(--muted)" strokeWidth="1.5" strokeOpacity="0.6" />
                    </svg>
                  )}
                </div>
                <div className="todo-item__content">
                  <span className="todo-item__text">{task.text}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        className={`todo-pill ${expanded ? 'todo-pill--expanded' : ''} ${isAllDone ? 'todo-pill--all-done' : ''}`}
        onClick={() => setExpanded((prev) => !prev)}
        title={isZh ? '点击展开/收起任务清单' : 'Click to toggle checklist'}
      >
        <div className="todo-pill__badge">
          {isAllDone ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <span>{completed}/{total}</span>
          )}
        </div>
        <span className="todo-pill__label" title={pillLabel}>
          {pillLabel}
        </span>
        <svg
          className={`todo-pill__arrow ${expanded ? 'todo-pill__arrow--expanded' : ''}`}
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
    </div>
  )
}
