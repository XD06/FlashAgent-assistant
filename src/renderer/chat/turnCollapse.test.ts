import { describe, expect, it } from 'vitest'
import type { AgentToolEvent } from '@shared/types'
import {
  aggregateEventDiffStats,
  getTurnProcessFold,
  summarizeProcessFold,
  type TurnBlock
} from './turnCollapse'

function makeTool(overrides: Partial<AgentToolEvent> = {}): AgentToolEvent {
  return {
    callId: overrides.callId ?? 'call-1',
    toolName: overrides.toolName ?? 'run_command',
    summary: overrides.summary ?? 'echo hi',
    state: overrides.state ?? 'done',
    ...overrides
  }
}

describe('getTurnProcessFold', () => {
  it('folds a multi-step settled agent turn while keeping the final conclusion visible', () => {
    const blocks: TurnBlock[] = [
      { kind: 'tools', events: [makeTool({ callId: 'c1' })] },
      { kind: 'thinking', text: 'Check port first.' },
      { kind: 'text', text: '端口空闲，启动服务。' },
      { kind: 'tools', events: [makeTool({ callId: 'c2' }), makeTool({ callId: 'c3' })] },
      { kind: 'thinking', text: 'Inspect logs.' },
      { kind: 'text', text: '结论：本地代码已是最新。' }
    ]

    const fold = getTurnProcessFold(blocks, false, false)
    expect(fold).not.toBeNull()
    expect(fold?.prefix).toHaveLength(5)
    expect(fold?.tail).toEqual([{ kind: 'text', text: '结论：本地代码已是最新。' }])

    const zh = summarizeProcessFold(fold!.prefix, true)
    expect(zh.toolCount).toBe(3)
    expect(zh.thinkingCount).toBe(2)
    expect(zh.label).toBe('已完成 · 3 项操作 · 2 轮思考')

    const en = summarizeProcessFold(fold!.prefix, false)
    expect(en.label).toBe('Done · 3 actions · 2 thoughts')
  })

  it('folds two sequential tool groups before the final answer', () => {
    const blocks: TurnBlock[] = [
      { kind: 'tools', events: [makeTool({ callId: 'c1', toolName: 'read_file' })] },
      {
        kind: 'tools',
        events: [makeTool({ callId: 'c2', toolName: 'edit_file', oldText: 'a\nb', newText: 'a\nc\nd' })]
      },
      { kind: 'text', text: 'Done updating file.' }
    ]

    const fold = getTurnProcessFold(blocks, false, false)
    expect(fold).not.toBeNull()
    expect(fold?.prefix).toHaveLength(2)

    const summary = summarizeProcessFold(fold!.prefix, false)
    expect(summary.toolCount).toBe(2)
    expect(summary.diff).toEqual({ added: 2, removed: 1 })
  })

  it('does not fold while pending, errored, or on simple 1-step turns', () => {
    const multi: TurnBlock[] = [
      { kind: 'tools', events: [makeTool({ callId: 'c1' })] },
      { kind: 'tools', events: [makeTool({ callId: 'c2' })] },
      { kind: 'text', text: 'Final answer' }
    ]
    expect(getTurnProcessFold(multi, true, false)).toBeNull()
    expect(getTurnProcessFold(multi, false, true)).toBeNull()

    const singleStep: TurnBlock[] = [
      { kind: 'thinking', text: 'Think once.' },
      { kind: 'tools', events: [makeTool()] },
      { kind: 'text', text: 'Done.' }
    ]
    expect(getTurnProcessFold(singleStep, false, false)).toBeNull()
  })

  it('does not fold turns containing errors, rejections, approvals, injected notes, or no final text', () => {
    const withError: TurnBlock[] = [
      { kind: 'tools', events: [makeTool({ callId: 'c1' })] },
      { kind: 'tools', events: [makeTool({ callId: 'c2', state: 'error', result: 'boom' })] },
      { kind: 'text', text: 'Sorry, command failed.' }
    ]
    expect(getTurnProcessFold(withError, false, false)).toBeNull()

    const withRejected: TurnBlock[] = [
      { kind: 'tools', events: [makeTool({ callId: 'c1' })] },
      { kind: 'tools', events: [makeTool({ callId: 'c2', state: 'rejected' })] },
      { kind: 'text', text: 'Aborted.' }
    ]
    expect(getTurnProcessFold(withRejected, false, false)).toBeNull()

    const withAwaitingInput: TurnBlock[] = [
      { kind: 'tools', events: [makeTool({ callId: 'c1' })] },
      { kind: 'tools', events: [makeTool({ callId: 'c2', toolName: 'ask_user', state: 'awaiting-input' })] },
      { kind: 'text', text: 'Waiting for answer.' }
    ]
    expect(getTurnProcessFold(withAwaitingInput, false, false)).toBeNull()

    const withQueued: TurnBlock[] = [
      { kind: 'tools', events: [makeTool({ callId: 'c1' })] },
      { kind: 'tools', events: [makeTool({ callId: 'c2', state: 'queued' })] },
      { kind: 'text', text: 'Queued.' }
    ]
    expect(getTurnProcessFold(withQueued, false, false)).toBeNull()

    const withInjected: TurnBlock[] = [
      { kind: 'tools', events: [makeTool({ callId: 'c1' })] },
      { kind: 'injected', text: 'stop and check foo' },
      { kind: 'tools', events: [makeTool({ callId: 'c2' })] },
      { kind: 'text', text: 'Checked foo.' }
    ]
    expect(getTurnProcessFold(withInjected, false, false)).toBeNull()

    const toolsOnly: TurnBlock[] = [
      { kind: 'tools', events: [makeTool({ callId: 'c1' })] },
      { kind: 'tools', events: [makeTool({ callId: 'c2' })] }
    ]
    expect(getTurnProcessFold(toolsOnly, false, false)).toBeNull()
  })
})

describe('aggregateEventDiffStats', () => {
  it('sums diff lines across edits and ignores error/reverted/unchanged calls', () => {
    const events: AgentToolEvent[] = [
      makeTool({ toolName: 'edit_file', state: 'done', oldText: 'one\ntwo', newText: 'one\ntwo\nthree' }),
      makeTool({ toolName: 'edit_file', state: 'reverted', oldText: 'a', newText: 'b\nc' }),
      makeTool({ toolName: 'edit_file', state: 'error', oldText: 'x', newText: 'y' }),
      makeTool({ toolName: 'read_file', state: 'done' })
    ]
    expect(aggregateEventDiffStats(events)).toEqual({ added: 1, removed: 0 })
    expect(aggregateEventDiffStats([makeTool({ toolName: 'read_file' })])).toBeNull()
  })
})
