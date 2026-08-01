import { describe, expect, it } from 'vitest'
import { buildAgentSystemPrompt } from './AgentPrompt'

const options = {
  baseSystemPrompt: 'Base system rule.',
  workingDir: 'C:\\workspace',
  shellLabel: 'PowerShell 7 (pwsh)'
}

describe('buildAgentSystemPrompt', () => {
  it('preserves the previous grounding prompt as an explicit baseline', () => {
    const prompt = buildAgentSystemPrompt(options, 'baseline')

    expect(prompt).toContain('IMPORTANT: You MUST use tool calls to perform actions.')
    expect(prompt).toContain('Working directory: C:\\workspace.')
    expect(prompt).toContain('Never claim you created, edited, or verified anything without the matching tool result.')
    expect(prompt).toContain('do not repeat substantially equivalent searches')
    expect(prompt).toContain('do not label unrelated failures as pre-existing without a baseline')
    expect(prompt).toContain('before broad, structural, or batch edits, inspect git status --short and git diff --stat')
    expect(prompt).toContain('never overwrite unrelated work')
    expect(prompt).toContain('do not commit, amend, switch branches, merge, rebase, reset, clean, or push without an explicit user request')
    expect(prompt).toContain('run git diff --check')
    expect(prompt).toContain('use a Conventional Commit type')
    expect(prompt).not.toContain('Focused execution policy:')
  })

  it('adds focused execution guidance without weakening the grounding rules', () => {
    const prompt = buildAgentSystemPrompt(options, 'focused')

    expect(prompt).toContain('Prefer targeted evidence: read named files directly')
    expect(prompt).toContain('reuse successful results in this task')
    expect(prompt).toContain('inspect, make the smallest justified edit, then verify')
    expect(prompt).toContain('Prefer tools over progress narration')
    expect(prompt).toContain('NEVER fabricate tool results')
  })
})
