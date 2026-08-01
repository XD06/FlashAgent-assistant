import type { AgentToolEvent, ToolTraceEntry } from '@shared/types'

/** Per-result ceiling mirrors the in-loop tool-result cap. There is no
 * per-turn call-count cutoff: recent task rounds keep every settled result. */
export const TOOL_TRACE_OUTPUT_PER_CALL = 12_000

/** Build the native replay records for one completed assistant turn. */
export function buildToolTrace(events: AgentToolEvent[], isZh: boolean, withOutput: boolean): ToolTraceEntry[] {
  return events
    .filter((event) => event.state === 'done' || event.state === 'error' || event.state === 'rejected' || event.state === 'reverted')
    .map((event) => {
      const mark = event.state === 'done' ? 'ok' : event.state
      let result = `[tool: ${event.toolName} ${event.summary} → ${mark}]\n[output_id: ${event.callId}]`
      if (event.state === 'done' || event.state === 'error') {
        if (withOutput && event.result) {
          const body = event.result.slice(0, TOOL_TRACE_OUTPUT_PER_CALL)
          const truncated = body.length < event.result.length ? (isZh ? '\n（输出已截断）' : '\n(output truncated)') : ''
          result += `\n${body}${truncated}`
        } else {
          result += isZh
            ? `\n（较早轮次，输出已省略。可用 read_tool_output 读取 call_id=${JSON.stringify(event.callId)} 的已保存输出。）`
            : `\n(older turn — output omitted. Use read_tool_output with call_id=${JSON.stringify(event.callId)} to read saved output.)`
        }
      }
      return {
        id: event.callId,
        name: event.toolName,
        argsJson: event.argsJson ?? JSON.stringify({ summary: event.summary }),
        result
      }
    })
}
