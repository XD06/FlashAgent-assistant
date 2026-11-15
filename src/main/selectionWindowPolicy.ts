import type { ActionItem } from '@shared/types'

export interface WindowReuseCandidate<T> {
  win: T
  visible: boolean
  pinned: boolean
}

/**
 * Pick an existing sub-window to reuse when opening an action/translate view:
 * - `forceNew`: always create a brand new window.
 * - Prefer a hidden warm-cached window first (closed earlier -> instant reopen).
 * - Never hijack a visible window that the user explicitly pinned (`alwaysOnTop`).
 * - Reuse an unpinned visible window when no hidden window is available.
 */
export function pickReusableSubWindow<T>(
  candidates: readonly WindowReuseCandidate<T>[],
  forceNew = false
): T | null {
  if (forceNew) return null
  const hidden = candidates.find((candidate) => !candidate.visible)
  if (hidden) return hidden.win
  const unpinnedVisible = candidates.find((candidate) => candidate.visible && !candidate.pinned)
  if (unpinnedVisible) return unpinnedVisible.win
  return null
}

/** Resolve the latest ActionItem from live settings by ID, falling back gracefully
 * (e.g. for ephemeral screenshot vision actions). */
export function resolveLiveActionItem(actions: readonly ActionItem[], action: ActionItem): ActionItem {
  return actions.find((item) => item.id === action.id) ?? action
}

/** Cascade a newly spawned sibling window slightly away from existing open windows,
 * clamping cleanly inside the target display work area. */
export function cascadeWindowOrigin(
  baseX: number,
  baseY: number,
  width: number,
  height: number,
  area: { x: number; y: number; width: number; height: number },
  siblingCount: number
): { x: number; y: number } {
  const step = Math.min(siblingCount, 5) * 24
  const maxX = Math.max(area.x + 8, area.x + area.width - width - 8)
  const maxY = Math.max(area.y + 8, area.y + area.height - height - 8)
  return {
    x: Math.max(area.x + 8, Math.min(baseX + step, maxX)),
    y: Math.max(area.y + 8, Math.min(baseY + step, maxY))
  }
}

