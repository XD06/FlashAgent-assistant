import { describe, expect, it } from 'vitest'
import { validateAgentToolArgs, validateToolArgs } from './validateToolArgs'
import type { ToolDefinition } from '../ai/OpenAICompatibleClient'

const sampleDef: ToolDefinition = {
  name: 'edit_file',
  description: 'test',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_text: { type: 'string' },
      new_text: { type: 'string' },
      replace_all: { type: 'boolean' }
    },
    required: ['path', 'old_text', 'new_text']
  }
}

describe('validateToolArgs', () => {
  it('passes valid arguments', () => {
    expect(
      validateToolArgs(sampleDef, { path: 'a.txt', old_text: 'x', new_text: 'y' })
    ).toBeNull()
    expect(
      validateToolArgs(sampleDef, { path: 'a.txt', old_text: 'x', new_text: 'y', replace_all: true })
    ).toBeNull()
  })

  it('reports missing required fields with name and type', () => {
    const error = validateToolArgs(sampleDef, { path: 'a.txt' })
    expect(error).toContain('"old_text" (string) is required but missing')
    expect(error).toContain('"new_text" (string) is required but missing')
    expect(error).toContain('edit_file')
  })

  it('treats null the same as missing for required fields', () => {
    const error = validateToolArgs(sampleDef, { path: null, old_text: 'x', new_text: 'y' })
    expect(error).toContain('"path" (string) is required but missing')
  })

  it('reports type mismatches with expected type and actual value', () => {
    const error = validateToolArgs(sampleDef, {
      path: 42,
      old_text: 'x',
      new_text: 'y',
      replace_all: 'true'
    })
    expect(error).toContain('"path" expected string, got number 42')
    expect(error).toContain('"replace_all" expected boolean, got string "true"')
  })

  it('includes the expected argument signature in the error', () => {
    const error = validateToolArgs(sampleDef, {})
    expect(error).toContain('{path: string, old_text: string, new_text: string, replace_all?: boolean}')
  })

  it('ignores unknown extra keys', () => {
    expect(
      validateToolArgs(sampleDef, { path: 'a.txt', old_text: 'x', new_text: 'y', bogus: 123 })
    ).toBeNull()
  })
})

describe('validateAgentToolArgs', () => {
  it('validates built-in tools by name', () => {
    expect(validateAgentToolArgs('read_file', { path: 'a.txt' })).toBeNull()
    expect(validateAgentToolArgs('read_file', {})).toContain('"path"')
    expect(validateAgentToolArgs('run_command', { command: 5 })).toContain('expected string, got number')
  })

  it('lets unknown tool names pass through', () => {
    expect(validateAgentToolArgs('mcp__whatever', {})).toBeNull()
  })
})
