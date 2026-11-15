export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export interface WavyProgressGeometryOptions {
  value: number
  width: number
  height: number
  strokeWidth?: number
  amplitude?: number
  wavelength?: number
  gap?: number
  phase?: number
}

export interface WavyProgressGeometry {
  clampedValue: number
  midY: number
  minX: number
  maxX: number
  progressPath: string
  trackStartX: number | null
  trackEndX: number | null
  stopCenter: { x: number; y: number } | null
}

/**
 * Pure geometry helper mirroring FlClash's `_WavyProgressPainter`:
 * sine wave for active progress, an air gap, then a flat track and terminal dot.
 */
export function buildWavyProgressGeometry(options: WavyProgressGeometryOptions): WavyProgressGeometry {
  const {
    value,
    width,
    height,
    strokeWidth = 3.5,
    amplitude = 2.6,
    wavelength = 12,
    gap = 6,
    phase = 0
  } = options

  const clampedValue = clamp(value, 0, 1)
  const midY = height / 2
  const minX = strokeWidth / 2
  const maxX = width - strokeWidth / 2

  if (maxX <= minX || height <= 0) {
    return {
      clampedValue,
      midY,
      minX,
      maxX,
      progressPath: '',
      trackStartX: null,
      trackEndX: null,
      stopCenter: null
    }
  }

  const safeAmp = Math.min(amplitude, Math.max(0, midY - strokeWidth / 2 - 0.5))
  const split = minX + (maxX - minX) * clampedValue

  let progressPath = ''
  if (clampedValue > 0.001 && split > minX) {
    const angularFreq = wavelength > 0 ? (Math.PI * 2) / wavelength : 0
    const step = 1.25
    const points: string[] = []
    for (let x = minX; x < split; x += step) {
      const y = midY + safeAmp * Math.sin((x - minX) * angularFreq + phase)
      points.push(`${points.length === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`)
    }
    const endY = midY + safeAmp * Math.sin((split - minX) * angularFreq + phase)
    points.push(`L ${split.toFixed(2)} ${endY.toFixed(2)}`)
    progressPath = points.join(' ')
  }

  const hasRemaining = clampedValue < 0.999
  const rawTrackStart = clampedValue <= 0.001 ? minX : split + gap
  const trackStartX = hasRemaining && rawTrackStart < maxX ? Number(rawTrackStart.toFixed(2)) : null
  const trackEndX = trackStartX !== null ? Number(maxX.toFixed(2)) : null
  const stopCenter = hasRemaining ? { x: Number(maxX.toFixed(2)), y: Number(midY.toFixed(2)) } : null

  return {
    clampedValue,
    midY,
    minX,
    maxX,
    progressPath,
    trackStartX,
    trackEndX,
    stopCenter
  }
}

export interface CookieShapePathOptions {
  lobes?: number
  size?: number
  innerRadiusRatio?: number
  roundness?: number
}

/**
 * Generates a normalized M3 Expressive scalloped polygon SVG path matching FlClash's
 * `MaterialShapes.cookie12Sided` (12 rounded crests with soft quadratic corners).
 */
export function buildCookieShapePath(options: CookieShapePathOptions = {}): string {
  const { lobes = 12, size = 100, innerRadiusRatio = 0.8, roundness = 0.48 } = options
  const count = Math.max(3, Math.round(lobes))
  const totalVertices = count * 2
  const cx = size / 2
  const cy = size / 2
  const outerR = size * 0.47
  const innerR = outerR * clamp(innerRadiusRatio, 0.35, 0.98)
  const blend = clamp(roundness, 0.05, 0.5)

  const vertices: Array<{ x: number; y: number }> = []
  for (let i = 0; i < totalVertices; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / count
    const radius = i % 2 === 0 ? outerR : innerR
    vertices.push({
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius
    })
  }

  const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t
  })

  const segments: string[] = []
  for (let i = 0; i < totalVertices; i++) {
    const prev = vertices[(i - 1 + totalVertices) % totalVertices]
    const curr = vertices[i]
    const next = vertices[(i + 1) % totalVertices]
    const entry = lerp(curr, prev, blend)
    const exit = lerp(curr, next, blend)
    if (i === 0) {
      segments.push(`M ${entry.x.toFixed(2)} ${entry.y.toFixed(2)}`)
    } else {
      segments.push(`L ${entry.x.toFixed(2)} ${entry.y.toFixed(2)}`)
    }
    segments.push(`Q ${curr.x.toFixed(2)} ${curr.y.toFixed(2)} ${exit.x.toFixed(2)} ${exit.y.toFixed(2)}`)
  }
  segments.push('Z')
  return segments.join(' ')
}

export function resolveSegmentIndex<T extends string>(options: readonly { value: T }[], value: T): number {
  return options.findIndex((item) => item.value === value)
}
