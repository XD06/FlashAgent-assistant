import React from 'react'
import { Icon } from '../icons'

export type StatusChipTone = 'ok' | 'warn' | 'err' | 'accent' | 'neutral'

export interface StatusChipProps {
  tone?: StatusChipTone
  dot?: boolean
  pulse?: boolean
  icon?: string
  title?: string
  className?: string
  children: React.ReactNode
}

/** Compact pill status indicator aligned with FlClash's semantic surface pills. */
export function StatusChip({
  tone = 'neutral',
  dot = false,
  pulse = false,
  icon,
  title,
  className,
  children
}: StatusChipProps): React.JSX.Element {
  return (
    <span
      className={['ui-status-chip', `ui-status-chip--${tone}`, className ?? ''].filter(Boolean).join(' ')}
      title={title}>
      {dot && (
        <span
          className={pulse ? 'ui-status-chip__dot ui-status-chip__dot--pulse' : 'ui-status-chip__dot'}
          aria-hidden="true"
        />
      )}
      {icon && <Icon name={icon} size={11} />}
      <span className="ui-status-chip__text">{children}</span>
    </span>
  )
}
