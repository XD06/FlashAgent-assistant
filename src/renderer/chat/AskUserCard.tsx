import React from 'react'
import { Icon } from '../icons'
import type { AgentToolState, AskUserAnswer, AskUserPrompt } from '../../shared/types'

export interface AskUserCardProps {
  callId: string
  prompt: AskUserPrompt
  answer?: AskUserAnswer
  state: AgentToolState
  live: boolean
  isZh: boolean
}

export const AskUserCard: React.FC<AskUserCardProps> = React.memo(function AskUserCard({
  callId,
  prompt,
  answer,
  state,
  live,
  isZh
}) {
  const [selected, setSelected] = React.useState<string[]>([])
  const [customText, setCustomText] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [submitError, setSubmitError] = React.useState<string | null>(null)

  const interactive = live && state === 'awaiting-input'
  const trimmedCustom = customText.trim()
  const canSubmit = selected.length > 0 || trimmedCustom.length > 0

  const toggleOption = React.useCallback(
    (label: string) => {
      if (!interactive || submitting) return
      setSubmitError(null)
      setSelected((prev) => {
        if (prompt.multiSelect) {
          return prev.includes(label) ? prev.filter((item) => item !== label) : [...prev, label]
        }
        return prev[0] === label ? [] : [label]
      })
    },
    [interactive, submitting, prompt.multiSelect]
  )

  const submitAnswer = React.useCallback(
    async (payload: AskUserAnswer) => {
      if (!interactive || submitting) return
      setSubmitting(true)
      setSubmitError(null)
      try {
        const ok = await window.assistantLite.agent.answerQuestion(callId, payload)
        if (!ok) {
          setSubmitError(isZh ? '会话已结束或问题已失效' : 'Question expired or session ended')
          setSubmitting(false)
        }
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : String(err))
        setSubmitting(false)
      }
    },
    [interactive, submitting, callId, isZh]
  )

  const handleConfirm = React.useCallback(() => {
    if (!canSubmit) return
    void submitAnswer({
      answered: true,
      selectedOptions: selected.length > 0 ? selected : undefined,
      customText: trimmedCustom || undefined
    })
  }, [canSubmit, selected, trimmedCustom, submitAnswer])

  const handleSkip = React.useCallback(() => {
    void submitAnswer({ answered: false })
  }, [submitAnswer])

  const handleInputKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.nativeEvent.isComposing && canSubmit) {
        e.preventDefault()
        e.stopPropagation()
        handleConfirm()
      }
    },
    [canSubmit, handleConfirm]
  )

  const settledSelectedSet = React.useMemo(
    () => new Set(answer?.selectedOptions ?? []),
    [answer?.selectedOptions]
  )

  return (
    <div className={`ask-user-card${interactive ? ' ask-user-card--live' : ' ask-user-card--settled'}`}>
      <div className="ask-user-question-row">
        <span className="ask-user-question">{prompt.question}</span>
        {prompt.options.length > 0 && (
          <span className="ask-user-mode-badge">
            {prompt.multiSelect ? (isZh ? '多选' : 'Multi') : isZh ? '单选' : 'Single'}
          </span>
        )}
      </div>

      {prompt.options.length > 0 && (
        <div
          className="ask-user-options"
          role={prompt.multiSelect ? 'group' : 'radiogroup'}
          aria-label={prompt.question}
        >
          {prompt.options.map((opt) => {
            const checked = interactive ? selected.includes(opt.label) : settledSelectedSet.has(opt.label)
            return (
              <button
                key={opt.label}
                type="button"
                role={prompt.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={checked}
                className={`ask-user-opt${checked ? ' is-selected' : ''}${prompt.multiSelect ? ' is-multi' : ''}`}
                disabled={!interactive || submitting}
                onClick={() => toggleOption(opt.label)}
              >
                <span className="ask-user-opt-indicator" aria-hidden="true">
                  {checked && <Icon name="check" size={11} />}
                </span>
                <span className="ask-user-opt-content">
                  <span className="ask-user-opt-label">{opt.label}</span>
                  {opt.description && <span className="ask-user-opt-desc">{opt.description}</span>}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {interactive ? (
        <>
          {prompt.allowCustom && (
            <input
              type="text"
              className="ask-user-input"
              value={customText}
              disabled={submitting}
              onChange={(e) => {
                setSubmitError(null)
                setCustomText(e.target.value)
              }}
              onKeyDown={handleInputKeyDown}
              placeholder={
                prompt.placeholder ||
                (prompt.options.length > 0
                  ? isZh
                    ? '或输入其他补充 / 自定义回答...'
                    : 'Or enter a custom answer...'
                  : isZh
                    ? '请输入回答，按 Enter 提交...'
                    : 'Type your answer, press Enter to submit...')
              }
            />
          )}

          {submitError && <div className="ask-user-error">{submitError}</div>}

          <div className="ask-user-actions">
            <button
              type="button"
              className="ask-user-btn ask-user-btn--skip"
              disabled={submitting}
              onClick={handleSkip}
            >
              {isZh ? '跳过' : 'Skip'}
            </button>
            <button
              type="button"
              className="ask-user-btn ask-user-btn--submit"
              disabled={!canSubmit || submitting}
              onClick={handleConfirm}
            >
              <Icon name="check" size={12} />
              <span>{submitting ? (isZh ? '提交中...' : 'Sending...') : isZh ? '提交回答' : 'Submit'}</span>
            </button>
          </div>
        </>
      ) : (
        <div className="ask-user-settled">
          {answer ? (
            answer.answered ? (
              <>
                <span className="ask-user-settled-label">{isZh ? '已选择：' : 'Answered: '}</span>
                <span className="ask-user-settled-value">
                  {[
                    ...(answer.selectedOptions ?? []),
                    ...(answer.customText?.trim() ? [answer.customText.trim()] : [])
                  ].join(' · ')}
                </span>
              </>
            ) : (
              <span className="ask-user-settled-skipped">{isZh ? '已跳过此问题' : 'Skipped'}</span>
            )
          ) : state === 'rejected' ? (
            <span className="ask-user-settled-skipped">{isZh ? '已跳过' : 'Skipped'}</span>
          ) : state === 'awaiting-input' ? (
            <span className="ask-user-settled-skipped">{isZh ? '等待输入已中断' : 'Input interrupted'}</span>
          ) : null}
        </div>
      )}
    </div>
  )
})
