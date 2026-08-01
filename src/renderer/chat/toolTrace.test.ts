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
})
