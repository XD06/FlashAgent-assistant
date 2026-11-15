import { describe, expect, it } from 'vitest'
import { buildCookieShapePath, buildWavyProgressGeometry, clamp, resolveSegmentIndex } from './geometry'

describe('ui geometry helpers', () => {
  it('clamps non-finite and out-of-range values', () => {
    expect(clamp(Number.NaN, 0, 1)).toBe(0)
    expect(clamp(-0.5, 0, 1)).toBe(0)
    expect(clamp(1.75, 0, 1)).toBe(1)
    expect(clamp(0.42, 0, 1)).toBe(0.42)
  })

  it('builds wavy progress geometry across 0, mid, and 100%', () => {
    const empty = buildWavyProgressGeometry({ value: 0, width: 120, height: 14 })
    expect(empty.clampedValue).toBe(0)
    expect(empty.progressPath).toBe('')
    expect(empty.trackStartX).toBe(empty.minX)
    expect(empty.trackEndX).toBeCloseTo(empty.maxX, 2)
    expect(empty.stopCenter).toEqual({ x: Number(empty.maxX.toFixed(2)), y: 7 })

    const half = buildWavyProgressGeometry({ value: 0.5, width: 120, height: 14, gap: 6 })
    expect(half.progressPath.startsWith('M ')).toBe(true)
    expect(half.progressPath).toContain(' L ')
    expect(half.trackStartX).not.toBeNull()
    expect(half.trackStartX!).toBeGreaterThan(half.minX + (half.maxX - half.minX) * 0.5)
    expect(half.stopCenter).not.toBeNull()

    const full = buildWavyProgressGeometry({ value: 1.4, width: 120, height: 14 })
    expect(full.clampedValue).toBe(1)
    expect(full.progressPath.startsWith('M ')).toBe(true)
    expect(full.trackStartX).toBeNull()
    expect(full.trackEndX).toBeNull()
    expect(full.stopCenter).toBeNull()
  })

  it('handles degenerate tiny widths cleanly without throwing', () => {
    const tiny = buildWavyProgressGeometry({ value: 0.5, width: 2, height: 14, strokeWidth: 4 })
    expect(tiny.progressPath).toBe('')
    expect(tiny.trackStartX).toBeNull()
    expect(tiny.stopCenter).toBeNull()
  })

  it('generates a closed 12-lobe cookie SVG path within the viewbox bounds', () => {
    const path = buildCookieShapePath({ lobes: 12, size: 100, innerRadiusRatio: 0.8 })
    expect(path.startsWith('M ')).toBe(true)
    expect(path.endsWith('Z')).toBe(true)
    const quadCount = (path.match(/Q /g) ?? []).length
    expect(quadCount).toBe(24)

    const nums = path.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []
    expect(nums.length).toBeGreaterThan(24)
    for (const coord of nums) {
      expect(coord).toBeGreaterThanOrEqual(0)
      expect(coord).toBeLessThanOrEqual(100)
    }
  })

  it('resolves segment index safely including misses', () => {
    const opts = [{ value: 'auto' }, { value: 'light' }, { value: 'dark' }] as const
    expect(resolveSegmentIndex(opts, 'auto')).toBe(0)
    expect(resolveSegmentIndex(opts, 'dark')).toBe(2)
    expect(resolveSegmentIndex(opts, 'missing' as 'auto')).toBe(-1)
  })
})
