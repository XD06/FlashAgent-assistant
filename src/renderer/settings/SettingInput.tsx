import React from 'react'

export interface SettingInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: string
  onChange: (value: string) => void
  debounceMs?: number
}

export const SettingInput = React.forwardRef<HTMLInputElement, SettingInputProps>(
  function SettingInput(
    { value, onChange, debounceMs = 400, onCompositionStart, onCompositionEnd, onFocus, onBlur, onKeyDown, ...props },
    forwardedRef
  ) {
    const [text, setText] = React.useState(value ?? '')
    const composingRef = React.useRef(false)
    const focusedRef = React.useRef(false)
    const timerRef = React.useRef<NodeJS.Timeout | null>(null)
    const lastCommittedRef = React.useRef(value ?? '')
    const latestTextRef = React.useRef(text)
    latestTextRef.current = text

    const commit = React.useCallback(
      (valToCommit?: string) => {
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        const val = valToCommit !== undefined ? valToCommit : latestTextRef.current
        if (val !== lastCommittedRef.current) {
          lastCommittedRef.current = val
          onChange(val)
        }
      },
      [onChange]
    )

    // Sync from outside if value changed externally (e.g. switching template or resetting),
    // but never disrupt the user while they are actively composing or focused.
    React.useEffect(() => {
      if (composingRef.current || focusedRef.current) return
      setText(value ?? '')
      lastCommittedRef.current = value ?? ''
    }, [value])

    const scheduleCommit = (nextVal: string) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        commit(nextVal)
      }, debounceMs)
    }

    // Flush on unmount if any change was pending
    React.useEffect(() => {
      return () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
          if (latestTextRef.current !== lastCommittedRef.current) {
            onChange(latestTextRef.current)
          }
        }
      }
    }, [onChange])

    return (
      <input
        {...props}
        ref={forwardedRef}
        value={text}
        onFocus={(e) => {
          focusedRef.current = true
          onFocus?.(e)
        }}
        onBlur={(e) => {
          focusedRef.current = false
          if (latestTextRef.current !== lastCommittedRef.current) {
            commit()
          } else if (text !== (value ?? '')) {
            setText(value ?? '')
            lastCommittedRef.current = value ?? ''
          }
          onBlur?.(e)
        }}
        onCompositionStart={(e) => {
          composingRef.current = true
          if (timerRef.current) {
            clearTimeout(timerRef.current)
            timerRef.current = null
          }
          onCompositionStart?.(e)
        }}
        onCompositionEnd={(e) => {
          composingRef.current = false
          const nextVal = e.currentTarget.value
          setText(nextVal)
          onCompositionEnd?.(e)
          scheduleCommit(nextVal)
        }}
        onChange={(e) => {
          const nextVal = e.target.value
          setText(nextVal)
          if (!composingRef.current) {
            scheduleCommit(nextVal)
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !composingRef.current) {
            commit()
          }
          onKeyDown?.(e)
        }}
      />
    )
  }
)

export interface SettingTextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  value: string
  onChange: (value: string) => void
  debounceMs?: number
}

export const SettingTextarea = React.forwardRef<HTMLTextAreaElement, SettingTextareaProps>(
  function SettingTextarea(
    { value, onChange, debounceMs = 400, onCompositionStart, onCompositionEnd, onFocus, onBlur, ...props },
    forwardedRef
  ) {
    const [text, setText] = React.useState(value ?? '')
    const composingRef = React.useRef(false)
    const focusedRef = React.useRef(false)
    const timerRef = React.useRef<NodeJS.Timeout | null>(null)
    const lastCommittedRef = React.useRef(value ?? '')
    const latestTextRef = React.useRef(text)
    latestTextRef.current = text

    const commit = React.useCallback(
      (valToCommit?: string) => {
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        const val = valToCommit !== undefined ? valToCommit : latestTextRef.current
        if (val !== lastCommittedRef.current) {
          lastCommittedRef.current = val
          onChange(val)
        }
      },
      [onChange]
    )

    React.useEffect(() => {
      if (composingRef.current || focusedRef.current) return
      setText(value ?? '')
      lastCommittedRef.current = value ?? ''
    }, [value])

    const scheduleCommit = (nextVal: string) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        commit(nextVal)
      }, debounceMs)
    }

    React.useEffect(() => {
      return () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
          if (latestTextRef.current !== lastCommittedRef.current) {
            onChange(latestTextRef.current)
          }
        }
      }
    }, [onChange])

    return (
      <textarea
        {...props}
        ref={forwardedRef}
        value={text}
        onFocus={(e) => {
          focusedRef.current = true
          onFocus?.(e)
        }}
        onBlur={(e) => {
          focusedRef.current = false
          if (latestTextRef.current !== lastCommittedRef.current) {
            commit()
          } else if (text !== (value ?? '')) {
            setText(value ?? '')
            lastCommittedRef.current = value ?? ''
          }
          onBlur?.(e)
        }}
        onCompositionStart={(e) => {
          composingRef.current = true
          if (timerRef.current) {
            clearTimeout(timerRef.current)
            timerRef.current = null
          }
          onCompositionStart?.(e)
        }}
        onCompositionEnd={(e) => {
          composingRef.current = false
          const nextVal = e.currentTarget.value
          setText(nextVal)
          onCompositionEnd?.(e)
          scheduleCommit(nextVal)
        }}
        onChange={(e) => {
          const nextVal = e.target.value
          setText(nextVal)
          if (!composingRef.current) {
            scheduleCommit(nextVal)
          }
        }}
      />
    )
  }
)
