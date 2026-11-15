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

export interface ScreenPoint {
  x: number
  y: number
}

// selection-hook emits -99999 (INVALID_COORDINATE) when native UIA bounds are unavailable.
const INVALID_COORDINATE_THRESHOLD = -9000

export function isValidSelectionPoint(point: ScreenPoint): boolean {
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x > INVALID_COORDINATE_THRESHOLD &&
    point.y > INVALID_COORDINATE_THRESHOLD
  )
}

/** Reject sentinel (-99999) or degenerate all-zero UIA selection bounds when the cursor
 * itself is nowhere near (0, 0), so the toolbar doesn't jump to the primary corner. */
export function hasUsableSelectionRect(selection: {
  startTop: ScreenPoint
  startBottom: ScreenPoint
  endTop: ScreenPoint
  endBottom: ScreenPoint
  mousePosEnd: ScreenPoint
}): boolean {
  const corners = [selection.startTop, selection.startBottom, selection.endTop, selection.endBottom]
  if (!corners.every(isValidSelectionPoint)) return false
  const allZero = corners.every((pt) => pt.x === 0 && pt.y === 0)
  if (!allZero) return true
  const cursorValid = isValidSelectionPoint(selection.mousePosEnd)
  const cursorNearOrigin = cursorValid && Math.abs(selection.mousePosEnd.x) <= 64 && Math.abs(selection.mousePosEnd.y) <= 64
  return cursorNearOrigin
}

/** Check whether a mouse-down DIP coordinate lands inside the visible toolbar pill
 * with small DPI-rounding slop, staying well inside the surrounding shadow padding. */
export function isPointInsideToolbarHitbox(
  point: ScreenPoint,
  bounds: { x: number; y: number; width: number },
  toolbarWidth: number,
  shadowPadding: number,
  toolbarHeight: number,
  hitSlop = 4
): boolean {
  const pillWidth = Math.max(toolbarWidth, bounds.width - shadowPadding * 2)
  return (
    point.x >= bounds.x + shadowPadding - hitSlop &&
    point.x <= bounds.x + shadowPadding + pillWidth + hitSlop &&
    point.y >= bounds.y + shadowPadding - hitSlop &&
    point.y <= bounds.y + shadowPadding + toolbarHeight + hitSlop
  )
}
