import type { AgentToolEvent } from '@shared/types'
import { computeDiffStats, type DiffStats } from './diffStats'

/** Ordered content of an assistant turn: text, thinking and tool runs
 * interleaved in the order they actually happened. */
export type TurnBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; pending?: boolean }
  | { kind: 'tools'; events: AgentToolEvent[] }
  /** User note delivered mid-request — rendered at the exact point in the
   * stream where the tool loop picked it up, not above the whole reply. */
  | { kind: 'injected'; text: string }

export interface TurnProcessFold {
  prefix: TurnBlock[]
  tail: TurnBlock[]
}

export interface ProcessFoldSummary {
  toolCount: number
  thinkingCount: number
  failedCount: number
  diff: DiffStats | null
  label: string
}

// Keep turns expanded while any tool call is still live or blocked on user
// input/approval; intermediate errors or rejections that the model recovered
// from fold once the turn settles cleanly with a final answer.
const LIVE_OR_BLOCKED_STATES = new Set<AgentToolEvent['state']>([
  'streaming',
  'queued',
  'pending-approval',
  'awaiting-input',
  'running'
])

/** Sum non-empty line diff stats across completed/active edit events. */
export function aggregateEventDiffStats(events: readonly AgentToolEvent[]): DiffStats | null {
  let added = 0
  let removed = 0
  let hasDiff = false
  for (const ev of events) {
    if (ev.state === 'error' || ev.state === 'rejected' || ev.state === 'reverted') continue
    if (ev.oldText === undefined && ev.newText === undefined) continue
    const stats = computeDiffStats(ev.oldText, ev.newText)
    if (!stats) continue
    added += stats.added
    removed += stats.removed
    hasDiff = true
  }
  return hasDiff && (added > 0 || removed > 0) ? { added, removed } : null
}

/**
 * Partition a settled assistant turn into a collapsible process prefix and a
 * directly visible final tail. Returns null while the turn is still streaming,
 * errored at turn level, awaiting input/approval, or small enough that
 * individual block auto-collapse already keeps the UI compact.
 */
export function getTurnProcessFold(
  blocks: readonly TurnBlock[],
  pending: boolean,
  hasTurnError: boolean,
  normalizeText?: (text: string) => string
): TurnProcessFold | null {
  if (pending || hasTurnError || blocks.length < 2) return null

  let lastTextIndex = -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block.kind === 'text') {
      const visible = normalizeText ? normalizeText(block.text) : block.text
      if (visible.trim().length > 0) {
        lastTextIndex = i
        break
      }
    }
  }
  if (lastTextIndex <= 0) return null

  const prefix = blocks.slice(0, lastTextIndex)
  let toolGroupCount = 0
  let toolCount = 0
  for (const block of prefix) {
    if (block.kind === 'injected') return null
    if (block.kind === 'tools') {
      toolGroupCount++
      toolCount += block.events.length
      for (const ev of block.events) {
        if (LIVE_OR_BLOCKED_STATES.has(ev.state)) return null
      }
    }
  }

  // Keep a single compact block unwrapped (or a trivial 1-thinking + 1-tool step);
  // fold multi-step prefixes, multiple tool groups, or thinking/prose + multiple calls.
  if (prefix.length < 3 && toolGroupCount < 2 && !(prefix.length >= 2 && toolCount >= 2)) {
    return null
  }

  return {
    prefix,
    tail: blocks.slice(lastTextIndex)
  }
}

/** Summarize folded intermediate steps (actions, thoughts, failures, net diff lines). */
export function summarizeProcessFold(prefix: readonly TurnBlock[], isZh: boolean): ProcessFoldSummary {
  const toolEvents: AgentToolEvent[] = []
  let thinkingCount = 0
  let failedCount = 0

  for (const block of prefix) {
    if (block.kind === 'tools') {
      for (const ev of block.events) {
        toolEvents.push(ev)
        if (ev.state === 'error' || ev.state === 'rejected') failedCount++
      }
    } else if (block.kind === 'thinking' && block.text.trim().length > 0) {
      thinkingCount++
    }
  }

  const toolCount = toolEvents.length
  const parts: string[] = []
  if (toolCount > 0) {
    parts.push(isZh ? `${toolCount} 项操作` : `${toolCount} ${toolCount === 1 ? 'action' : 'actions'}`)
  }
  if (thinkingCount > 0) {
    parts.push(isZh ? `${thinkingCount} 轮思考` : `${thinkingCount} ${thinkingCount === 1 ? 'thought' : 'thoughts'}`)
  }
  if (parts.length === 0) {
    parts.push(isZh ? `${prefix.length} 步过程` : `${prefix.length} steps`)
  }
  if (failedCount > 0) {
    parts.push(isZh ? `${failedCount} 失败` : `${failedCount} failed`)
  }

  return {
    toolCount,
    thinkingCount,
    failedCount,
    diff: aggregateEventDiffStats(toolEvents),
    label: isZh ? `已完成 · ${parts.join(' · ')}` : `Done · ${parts.join(' · ')}`
  }
}
