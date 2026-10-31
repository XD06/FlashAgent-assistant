import { describe, expect, it } from 'vitest'
import { cancelApprovalsForRequest, resolveApproval, waitForApproval } from './AgentSession'

describe('AgentSession approvals', () => {
  it('resolves only from the window that owns the paused stream', async () => {
    const controller = new AbortController()
    const pending = waitForApproval('c1', 'r1', controller.signal, 7)
    // Every window shares the preload bridge; a different sender must not be
    // able to approve (or always-allow) someone else's tool call.
    expect(resolveApproval('c1', true, true, 42)).toBe(false)
    expect(resolveApproval('c1', true, true, 7)).toBe(true)
    await expect(pending).resolves.toEqual({ approved: true, alwaysAllow: true })
  })

  it('rejects a pending approval when its request ends', async () => {
    const controller = new AbortController()
    const pending = waitForApproval('c2', 'r2', controller.signal, 7)
    cancelApprovalsForRequest('r2')
    await expect(pending).resolves.toEqual({ approved: false, alwaysAllow: false })
  })

  it('settles immediately when the stream was already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(waitForApproval('c3', 'r3', controller.signal, 7)).resolves.toEqual({
      approved: false,
      alwaysAllow: false
    })
    expect(resolveApproval('c3', true, false, 7)).toBe(false)
  })
})
