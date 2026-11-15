import React from 'react'
import { Icon } from '../icons'
import { resolveSegmentIndex } from './geometry'

export interface SegmentedOption<T extends string> {
  value: T
  label: React.ReactNode
  icon?: string
  disabled?: boolean
  title?: string
}

export interface SegmentedControlProps<T extends string> {
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  tone?: 'surface' | 'accent'
  size?: 'sm' | 'md'
  fill?: boolean
  className?: string
}

/**
 * Equal-width segmented pill selector with a GPU-translated capsule thumb,
 * matching FlClash's `prism_ui` `SegmentedControl`.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  tone = 'surface',
  size = 'md',
  fill = false,
  className
}: SegmentedControlProps<T>): React.JSX.Element {
  const activeIndex = resolveSegmentIndex(options, value)
  const count = Math.max(1, options.length)

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (options.length === 0) return
    let step = 0
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') step = 1
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') step = -1
    else if (event.key === 'Home') step = -options.length
    else if (event.key === 'End') step = options.length
    else return

    event.preventDefault()
    if (event.key === 'Home') {
      const first = options.find((opt) => !opt.disabled)
      if (first) onChange(first.value)
      return
    }
    if (event.key === 'End') {
      const last = [...options].reverse().find((opt) => !opt.disabled)
      if (last) onChange(last.value)
      return
    }

    const start = activeIndex >= 0 ? activeIndex : 0
    for (let offset = 1; offset <= options.length; offset++) {
      const idx = (start + step * offset + options.length) % options.length
      const candidate = options[idx]
      if (!candidate.disabled) {
        onChange(candidate.value)
        return
      }
    }
  }

  const rootStyle = {
    '--seg-count': String(count),
    '--seg-index': String(activeIndex >= 0 ? activeIndex : 0)
  } as React.CSSProperties

  return (
    <div
      className={[
        'ui-segmented',
        `ui-segmented--${tone}`,
        `ui-segmented--${size}`,
        fill ? 'ui-segmented--fill' : '',
        className ?? ''
      ]
        .filter(Boolean)
        .join(' ')}
      role="radiogroup"
      aria-label={ariaLabel}
      style={rootStyle}
      onKeyDown={handleKeyDown}>
      {activeIndex >= 0 && <span className="ui-segmented__thumb" aria-hidden="true" />}
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active || (activeIndex < 0 && options[0]?.value === option.value) ? 0 : -1}
            disabled={option.disabled}
            title={option.title}
            className={active ? 'ui-segmented__option active' : 'ui-segmented__option'}
            onClick={() => {
              if (!option.disabled && option.value !== value) {
                onChange(option.value)
              }
            }}>
            {option.icon && <Icon name={option.icon} size={size === 'sm' ? 12 : 13} />}
            <span className="ui-segmented__label">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
