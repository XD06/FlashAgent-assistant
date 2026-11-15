import React from 'react'
import { buildCookieShapePath } from './geometry'

const COOKIE_12_PATH = buildCookieShapePath({
  lobes: 12,
  size: 100,
  innerRadiusRatio: 0.8,
  roundness: 0.48
})

export interface ShapeBadgeProps {
  size?: number
  active?: boolean
  tone?: 'accent' | 'soft' | 'surface'
  children?: React.ReactNode
  className?: string
}

/**
 * Scalloped 12-lobed badge inspired by FlClash's `ShapeBadge(MaterialShapes.cookie12Sided)`.
 * Rotates the outer cookie shape cleanly with a spring curve while keeping `children` upright.
 */
export function ShapeBadge({
  size = 28,
  active = false,
  tone = 'soft',
  children,
  className
}: ShapeBadgeProps): React.JSX.Element {
  return (
    <span
      className={[
        'ui-shape-badge',
        `ui-shape-badge--${tone}`,
        active ? 'ui-shape-badge--active' : '',
        className ?? ''
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ width: size, height: size }}>
      <svg className="ui-shape-badge__shape" viewBox="0 0 100 100" aria-hidden="true">
        <path d={COOKIE_12_PATH} />
      </svg>
      {children != null && <span className="ui-shape-badge__content">{children}</span>}
    </span>
  )
}
