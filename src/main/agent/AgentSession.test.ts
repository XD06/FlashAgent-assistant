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

  it('settles a pending approval as rejected when the stream aborts', async () => {
    const controller = new AbortController()
    const pending = waitForApproval('c4', 'r4', controller.signal, 7)
    controller.abort()
    await expect(pending).resolves.toEqual({ approved: false, alwaysAllow: false })
    // The call must not become approvable after the stream is gone.
    expect(resolveApproval('c4', true, true, 7)).toBe(false)
  })

  it('unblocks sibling safe approvals in the same stream when alwaysAllow is chosen, leaving dangerous ones paused', async () => {
    const controller = new AbortController()
    const safe1 = waitForApproval('s1', 'r-batch', controller.signal, 7, { waivableOnAlwaysAllow: true })
    const safe2 = waitForApproval('s2', 'r-batch', controller.signal, 7, { waivableOnAlwaysAllow: true })
    const danger = waitForApproval('d1', 'r-batch', controller.signal, 7, { waivableOnAlwaysAllow: false })
    const otherStream = waitForApproval('s3', 'r-other', controller.signal, 7, { waivableOnAlwaysAllow: true })

    expect(resolveApproval('s1', true, true, 7)).toBe(true)
    await expect(safe1).resolves.toEqual({ approved: true, alwaysAllow: true })
    await expect(safe2).resolves.toEqual({ approved: true, alwaysAllow: true })

    // Dangerous call in the same stream and safe call in another stream must remain pending
    expect(resolveApproval('d1', true, false, 7)).toBe(true)
    await expect(danger).resolves.toEqual({ approved: true, alwaysAllow: false })
    expect(resolveApproval('s3', false, false, 7)).toBe(true)
    await expect(otherStream).resolves.toEqual({ approved: false, alwaysAllow: false })
  })
})
