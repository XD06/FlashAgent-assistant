// Pending tool-call approvals for agent mode. The AI stream pauses inside
// onToolCall until the renderer answers via IPC (AgentApproveTool) or the
// request is aborted.

interface PendingApproval {
  requestId: string
  /** WebContents id of the window whose stream is paused on this approval. */
  senderId: number
  resolve: (result: ApprovalResult) => void
}

export interface ApprovalResult {
  approved: boolean
  /** Skip further approvals for the rest of this stream request. */
  alwaysAllow: boolean
}

const pendingApprovals = new Map<string, PendingApproval>()

export function waitForApproval(
  callId: string,
  requestId: string,
  signal: AbortSignal,
  senderId: number
): Promise<ApprovalResult> {
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
    pendingApprovals.set(callId, { requestId, senderId, resolve: settle })
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function resolveApproval(callId: string, approved: boolean, alwaysAllow: boolean, senderId: number): boolean {
  const pending = pendingApprovals.get(callId)
  // Every window shares the same preload bridge, so knowing a callId is not
  // authorization: only the window whose stream is paused (the one showing the
  // approval card) may resolve it.
  if (!pending || pending.senderId !== senderId) return false
  pending.resolve({ approved: approved === true, alwaysAllow: alwaysAllow === true })
  return true
}

/** Reject anything still pending for a finished/aborted stream request. */
export function cancelApprovalsForRequest(requestId: string): void {
  for (const [, pending] of [...pendingApprovals]) {
    if (pending.requestId === requestId) pending.resolve({ approved: false, alwaysAllow: false })
  }
}
