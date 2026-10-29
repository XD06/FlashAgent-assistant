/**
 * AI streams still running, counted per owning WebContents.
 *
 * The idle-destroy timers park hidden windows for instant reopen, but
 * destroying a renderer mid-stream aborts the request (AiStream aborts on
 * 'destroyed') — which silently kills a running agent task. Windows with live
 * work must therefore survive the idle timer.
 */
const active = new Map<number, number>()

export function beginStream(senderId: number): void {
  active.set(senderId, (active.get(senderId) ?? 0) + 1)
}

export function endStream(senderId: number): void {
  const next = (active.get(senderId) ?? 0) - 1
  if (next > 0) active.set(senderId, next)
  else active.delete(senderId)
}

export function hasActiveStream(senderId: number): boolean {
  return (active.get(senderId) ?? 0) > 0
}
