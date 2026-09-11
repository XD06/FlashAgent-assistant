import { describe, expect, it } from 'vitest'
import type { AgentToolEvent } from '@shared/types'
import { buildToolTrace } from './toolTrace'

function toolEvent(index: number): AgentToolEvent {
  return {
    callId: `call-${index}`,
    toolName: 'read_file',
    summary: `file-${index}.ts`,
    argsJson: JSON.stringify({ path: `file-${index}.ts` }),
    state: 'done',
    result: `result-${index}`
  }
}

describe('buildToolTrace', () => {
  it('keeps every result from a recent task round instead of cutting off after 20 calls', () => {
    const trace = buildToolTrace(Array.from({ length: 23 }, (_, index) => toolEvent(index + 1)), true, true)

    expect(trace).toHaveLength(23)
    expect(trace[20].result).toContain('result-21')
    expect(trace[22].result).toContain('result-23')
    expect(trace[22].result).not.toContain('输出已省略')
    expect(trace[22].result).toContain('output_id: call-23')
  })

  it('leaves an actionable retrieval reference when an older output is omitted', () => {
    const trace = buildToolTrace([toolEvent(1)], true, false)

    expect(trace[0].result).toContain('read_tool_output')
    expect(trace[0].result).toContain('call-1')
  })

  it('never omits todo_list checklist results even when withOutput is false', () => {
    const todoEvent: AgentToolEvent = {
      callId: 'call-todo',
      toolName: 'todo_list',
      summary: 'Update checklist (1/3 done)',
      argsJson: '{"tasks":[{"id":"1","text":"step 1","status":"completed"}]}',
      state: 'done',
      result: 'Task checklist updated (1/3 completed):\n[x] 1. step 1'
    }
    const trace = buildToolTrace([todoEvent], true, false)
    expect(trace[0].result).toContain('Task checklist updated')
    expect(trace[0].result).toContain('[x] 1. step 1')
    expect(trace[0].result).not.toContain('输出已省略')
  })
})
