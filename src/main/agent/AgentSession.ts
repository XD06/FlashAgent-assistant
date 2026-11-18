import type { AskUserAnswer } from '@shared/types'

// Pending human-in-the-loop pauses for agent mode (tool approvals and ask_user
// questions). The AI stream pauses inside onToolCall until the renderer answers
// via IPC or the request is aborted.

interface PendingEntry<T> {
  requestId: string
  /** WebContents id of the window whose stream is paused on this prompt. */
  senderId: number
  resolve: (result: T) => void
}

export interface ApprovalResult {
  approved: boolean
  /** Skip further approvals for the rest of this stream request. */
  alwaysAllow: boolean
}

function createPendingGate<T>(fallback: () => T) {
  const pending = new Map<string, PendingEntry<T>>()
  return {
    wait(callId: string, requestId: string, signal: AbortSignal, senderId: number): Promise<T> {
      return new Promise<T>((resolve) => {
        const settle = (result: T): void => {
          if (!pending.delete(callId)) return
          signal.removeEventListener('abort', onAbort)
          resolve(result)
        }
        const onAbort = (): void => settle(fallback())
        if (signal.aborted) {
          resolve(fallback())
          return
        }
        pending.set(callId, { requestId, senderId, resolve: settle })
        signal.addEventListener('abort', onAbort, { once: true })
      })
    },
    resolve(callId: string, senderId: number, value: T): boolean {
      const entry = pending.get(callId)
      // Every window shares the same preload bridge, so knowing a callId is not
      // authorization: only the window whose stream is paused (the one showing the
      // card) may resolve it.
      if (!entry || entry.senderId !== senderId) return false
      entry.resolve(value)
      return true
    },
    cancelForRequest(requestId: string): void {
      for (const [, entry] of [...pending]) {
        if (entry.requestId === requestId) entry.resolve(fallback())
      }
    }
  }
}

const approvalGate = createPendingGate<ApprovalResult>(() => ({ approved: false, alwaysAllow: false }))
const questionGate = createPendingGate<AskUserAnswer>(() => ({ answered: false }))

export function waitForApproval(
  callId: string,
  requestId: string,
  signal: AbortSignal,
  senderId: number
): Promise<ApprovalResult> {
  return approvalGate.wait(callId, requestId, signal, senderId)
}

export function resolveApproval(callId: string, approved: boolean, alwaysAllow: boolean, senderId: number): boolean {
  return approvalGate.resolve(callId, senderId, {
    approved: approved === true,
    alwaysAllow: alwaysAllow === true
  })
}

/** Reject anything still pending for a finished/aborted stream request. */
export function cancelApprovalsForRequest(requestId: string): void {
  approvalGate.cancelForRequest(requestId)
}

export function waitForUserAnswer(
  callId: string,
  requestId: string,
  signal: AbortSignal,
  senderId: number
): Promise<AskUserAnswer> {
  return questionGate.wait(callId, requestId, signal, senderId)
}

export function resolveUserAnswer(callId: string, answer: AskUserAnswer, senderId: number): boolean {
  if (!answer || typeof answer !== 'object') return false
  if (answer.answered !== true) {
    return questionGate.resolve(callId, senderId, { answered: false })
  }
  const selectedOptions = Array.isArray(answer.selectedOptions)
    ? Array.from(
        new Set(
          answer.selectedOptions
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
        )
      )
    : []
  const customText = typeof answer.customText === 'string' ? answer.customText.trim() : ''
  if (selectedOptions.length === 0 && !customText) return false
  return questionGate.resolve(callId, senderId, {
    answered: true,
    ...(selectedOptions.length ? { selectedOptions } : {}),
    ...(customText ? { customText } : {})
  })
}

/** Dismiss any open ask_user prompts when the stream request ends or aborts. */
export function cancelUserQuestionsForRequest(requestId: string): void {
  questionGate.cancelForRequest(requestId)
}
