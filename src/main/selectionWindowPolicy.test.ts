import { describe, expect, it } from 'vitest'
import type { ActionItem } from '@shared/types'
import {
  cascadeWindowOrigin,
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

})
