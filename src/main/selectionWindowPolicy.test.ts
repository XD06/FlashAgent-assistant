import { describe, expect, it } from 'vitest'
import type { ActionItem } from '@shared/types'
import {
  cascadeWindowOrigin,
  hasUsableSelectionRect,
  isPointInsideToolbarHitbox,
  isValidSelectionPoint,
  pickReusableSubWindow,
  resolveLiveActionItem
} from './selectionWindowPolicy'

describe('selectionWindowPolicy', () => {
  it('prefers hidden warm windows first, then unpinned visible, never pinned visible', () => {
    const pinnedVisible = { id: 'p', win: 'pinned', visible: true, pinned: true }
    const hidden = { id: 'h', win: 'hidden', visible: false, pinned: true }
    const unpinnedVisible = { id: 'u', win: 'unpinned', visible: true, pinned: false }

    expect(pickReusableSubWindow([pinnedVisible, hidden, unpinnedVisible])).toBe('hidden')
    expect(pickReusableSubWindow([pinnedVisible, unpinnedVisible])).toBe('unpinned')
    expect(pickReusableSubWindow([pinnedVisible])).toBeNull()
    expect(pickReusableSubWindow([hidden, unpinnedVisible], true)).toBeNull()
  })

  it('resolves latest edited action settings by id and keeps ephemeral vision fallback', () => {
    const liveExplain: ActionItem = {
      id: 'explain',
      name: '深度解释',
      enabled: true,
      icon: 'circle-help',
      type: 'prompt',
      promptTemplate: 'updated prompt {{text}}',
      model: 'claude-3-7-sonnet'
    }
    const staleExplain: ActionItem = { ...liveExplain, promptTemplate: 'old prompt' }
    const visionAction: ActionItem = {
      id: 'screenshot-explain-1234',
      name: 'AI 识图',
      enabled: true,
      icon: 'scan',
      type: 'prompt'
    }

    expect(resolveLiveActionItem([liveExplain], staleExplain)).toBe(liveExplain)
    expect(resolveLiveActionItem([liveExplain], visionAction)).toBe(visionAction)
  })

  it('cascades new sibling windows and clamps inside display work area', () => {
    const area = { x: 0, y: 0, width: 1200, height: 800 }
    expect(cascadeWindowOrigin(300, 200, 500, 420, area, 0)).toEqual({ x: 300, y: 200 })
    expect(cascadeWindowOrigin(300, 200, 500, 420, area, 2)).toEqual({ x: 348, y: 248 })
    expect(cascadeWindowOrigin(1000, 600, 500, 420, area, 3)).toEqual({ x: 692, y: 372 })
  })

  it('filters out selection-hook sentinel (-99999) and bogus all-zero UIA selection bounds', () => {
    expect(isValidSelectionPoint({ x: 420, y: 310 })).toBe(true)
    expect(isValidSelectionPoint({ x: -99999, y: -99999 })).toBe(false)
    expect(isValidSelectionPoint({ x: Number.NaN, y: 10 })).toBe(false)

    const zeroCorner = { x: 0, y: 0 }
    expect(
      hasUsableSelectionRect({
        startTop: zeroCorner,
        startBottom: zeroCorner,
        endTop: zeroCorner,
        endBottom: zeroCorner,
        mousePosEnd: { x: 1400, y: 600 }
      })
    ).toBe(false)

    expect(
      hasUsableSelectionRect({
        startTop: { x: 120, y: 220 },
        startBottom: { x: 120, y: 240 },
        endTop: { x: 300, y: 220 },
        endBottom: { x: 300, y: 240 },
        mousePosEnd: zeroCorner
      })
    ).toBe(true)
  })

  it('accepts DPI-rounded clicks near toolbar edges while rejecting clicks outside the pill', () => {
    const bounds = { x: 500, y: 300, width: 422 }
    expect(isPointInsideToolbarHitbox({ x: 516, y: 316 }, bounds, 390, 16, 36)).toBe(true)
    expect(isPointInsideToolbarHitbox({ x: 514, y: 314 }, bounds, 390, 16, 36)).toBe(true)
    expect(isPointInsideToolbarHitbox({ x: 908, y: 353 }, bounds, 390, 16, 36)).toBe(true)
    expect(isPointInsideToolbarHitbox({ x: 495, y: 330 }, bounds, 390, 16, 36)).toBe(false)
    expect(isPointInsideToolbarHitbox({ x: 700, y: 360 }, bounds, 390, 16, 36)).toBe(false)
  })
})
