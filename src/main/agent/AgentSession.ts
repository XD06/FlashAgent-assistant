// Pending tool-call approvals for agent mode. The AI stream pauses inside
// onToolCall until the renderer answers via IPC (AgentApproveTool) or the
// request is aborted.

interface PendingApproval {
  requestId: string
  resolve: (result: ApprovalResult) => void
}

export interface ApprovalResult {
  approved: boolean
  /** Skip further approvals for the rest of this stream request. */
  alwaysAllow: boolean
}

const pendingApprovals = new Map<string, PendingApproval>()

export function waitForApproval(callId: string, requestId: string, signal: AbortSignal): Promise<ApprovalResult> {
  return new Promise<ApprovalResult>((resolve) => {
    const settle = (result: ApprovalResult): void => {
      if (!pendingApprovals.delete(callId)) return
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = (): void => settle({ approved: false, alwaysAllow: false })
    if (signal.aborted) {
      resolve({ approved: false, alwaysAllow: false })
      return
    }
    pendingApprovals.set(callId, { requestId, resolve: settle })
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function resolveApproval(callId: string, approved: boolean, alwaysAllow: boolean): boolean {
  const pending = pendingApprovals.get(callId)
  if (!pending) return false
  pending.resolve({ approved: approved === true, alwaysAllow: alwaysAllow === true })
  return true
}

/** Reject anything still pending for a finished/aborted stream request. */
export function cancelApprovalsForRequest(requestId: string): void {
  for (const [, pending] of [...pendingApprovals]) {
    if (pending.requestId === requestId) pending.resolve({ approved: false, alwaysAllow: false })
  }
}
