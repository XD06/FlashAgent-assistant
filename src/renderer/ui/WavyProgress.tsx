import React from 'react'
import { buildWavyProgressGeometry } from './geometry'

export interface WavyProgressProps {
  /** Normalized progress in 0..1; null/undefined renders a gentle preparing wave. */
  value: number | null | undefined
  width?: number
  height?: number
  tone?: 'accent' | 'ok' | 'warn'
  ariaLabel?: string
  className?: string
}

/** Expressive M3 sine-wave progress indicator with trailing flat track & stop dot. */
export function WavyProgress({
  value,
  width = 128,
  height = 14,
  tone = 'ok',
  ariaLabel,
  className
}: WavyProgressProps): React.JSX.Element {
  const indeterminate = value == null || !Number.isFinite(value)
  const geometry = buildWavyProgressGeometry({
    value: indeterminate ? 0.36 : value,
    width,
    height
  })
  const strokeWidth = 3.5

  return (
    <svg
      className={[
        'ui-wavy-progress',
        `ui-wavy-progress--${tone}`,
        indeterminate ? 'ui-wavy-progress--indeterminate' : '',
        className ?? ''
      ]
        .filter(Boolean)
        .join(' ')}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(geometry.clampedValue * 100)}>
      {geometry.trackStartX !== null && geometry.trackEndX !== null && (
        <line
          className="ui-wavy-progress__track"
          x1={geometry.trackStartX}
          y1={geometry.midY}
          x2={geometry.trackEndX}
          y2={geometry.midY}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
      )}
      {geometry.stopCenter && (
        <circle
          className="ui-wavy-progress__stop"
          cx={geometry.stopCenter.x}
          cy={geometry.stopCenter.y}
          r={strokeWidth / 2}
        />
      )}
      {geometry.progressPath && (
        <path
          className="ui-wavy-progress__wave"
          d={geometry.progressPath}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  )
}
