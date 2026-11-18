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
  diff: DiffStats | null
  label: string
}

const UNSAFE_TO_FOLD_STATES = new Set<AgentToolEvent['state']>([
  'streaming',
  'pending-approval',
  'awaiting-input',
  'running',
  'error',
  'rejected'
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
 * errored, awaiting approval, or small enough that individual block auto-collapse
 * already keeps the UI compact.
 */
export function getTurnProcessFold(
  blocks: readonly TurnBlock[],
  pending: boolean,
  hasTurnError: boolean
): TurnProcessFold | null {
  if (pending || hasTurnError || blocks.length < 2) return null

  let lastTextIndex = -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block.kind === 'text' && block.text.trim().length > 0) {
      lastTextIndex = i
      break
    }
  }
  if (lastTextIndex <= 0) return null

  const prefix = blocks.slice(0, lastTextIndex)
  let toolGroupCount = 0
  for (const block of prefix) {
    if (block.kind === 'injected') return null
    if (block.kind === 'tools') {
      toolGroupCount++
      for (const ev of block.events) {
        if (UNSAFE_TO_FOLD_STATES.has(ev.state)) return null
      }
    }
  }

  if (prefix.length < 3 && toolGroupCount < 2) return null

  return {
    prefix,
    tail: blocks.slice(lastTextIndex)
  }
}

/** Summarize folded intermediate steps (actions, thoughts, net diff lines). */
export function summarizeProcessFold(prefix: readonly TurnBlock[], isZh: boolean): ProcessFoldSummary {
  const toolEvents: AgentToolEvent[] = []
  let thinkingCount = 0

  for (const block of prefix) {
    if (block.kind === 'tools') {
      for (const ev of block.events) toolEvents.push(ev)
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

  return {
    toolCount,
    thinkingCount,
    diff: aggregateEventDiffStats(toolEvents),
    label: isZh ? `已完成 · ${parts.join(' · ')}` : `Done · ${parts.join(' · ')}`
  }
}
