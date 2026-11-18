import { describe, expect, it } from 'vitest'
import {
  cancelUserQuestionsForRequest,
  resolveUserAnswer,
  waitForUserAnswer
} from './AgentSession'
import { validateAgentToolArgs } from './validateToolArgs'
import { buildAgentSystemPrompt } from './AgentPrompt'

describe('ask_user session gate', () => {
  it('resolves answer only for the authorized WebContents sender and sanitizes inputs', async () => {
    const ac = new AbortController()
    const promise = waitForUserAnswer('ask-call-1', 'req-1', ac.signal, 42)

    // Wrong sender is rejected without settling the promise
    expect(resolveUserAnswer('ask-call-1', { answered: true, selectedOptions: ['A'] }, 99)).toBe(false)

    // Empty answered:true payload is rejected
    expect(resolveUserAnswer('ask-call-1', { answered: true, selectedOptions: ['  '], customText: '  ' }, 42)).toBe(
      false
    )

    // Valid answer from authorized sender resolves and deduplicates options
    expect(
      resolveUserAnswer(
        'ask-call-1',
        { answered: true, selectedOptions: [' A ', 'B', 'A'], customText: '  extra note  ' },
        42
      )
    ).toBe(true)

    await expect(promise).resolves.toEqual({
      answered: true,
      selectedOptions: ['A', 'B'],
      customText: 'extra note'
    })
  })

  it('cancels pending ask_user prompts on request cleanup and resolves with answered: false', async () => {
    const ac1 = new AbortController()
    const ac2 = new AbortController()
    const p1 = waitForUserAnswer('ask-call-abort-1', 'req-abort', ac1.signal, 7)
    const p2 = waitForUserAnswer('ask-call-other', 'req-other', ac2.signal, 7)

    cancelUserQuestionsForRequest('req-abort')

    await expect(p1).resolves.toEqual({ answered: false })
    // Unrelated request remains open until explicitly answered
    expect(resolveUserAnswer('ask-call-other', { answered: false }, 7)).toBe(true)
    await expect(p2).resolves.toEqual({ answered: false })
  })

  it('settles immediately with answered: false when AbortSignal fires', async () => {
    const ac = new AbortController()
    const promise = waitForUserAnswer('ask-call-sig', 'req-sig', ac.signal, 7)
    ac.abort()
    await expect(promise).resolves.toEqual({ answered: false })
    expect(resolveUserAnswer('ask-call-sig', { answered: true, customText: 'late' }, 7)).toBe(false)
  })
})

describe('validateAgentToolArgs (ask_user)', () => {
  it('requires a non-empty question string', () => {
    expect(validateAgentToolArgs('ask_user', {})).toMatch(/question/)
    expect(validateAgentToolArgs('ask_user', { question: '   ' })).toMatch(/non-empty/)
    expect(
      validateAgentToolArgs('ask_user', { question: 'Which environment?', options: ['Staging', 'Prod'] })
    ).toBeNull()
  })
})

describe('buildAgentSystemPrompt (ask_user)', () => {
  it('documents ask_user tool usage for genuinely blocking ambiguities', () => {
    const prompt = buildAgentSystemPrompt({
      baseSystemPrompt: 'Base prompt.',
      workingDir: '/workspace',
      shellLabel: 'Git Bash'
    })
    expect(prompt).toContain('ask_user')
  })
})
