import { describe, expect, it } from 'vitest'
import {
  IMAGE_INPUT_TOKEN_ESTIMATE,
  estimateTokensFromText,
  measureContext
} from './contextMeter'

describe('measureContext', () => {
  it('separates system, schema, native message, and image estimates without returning prompt content', () => {
    const measurement = measureContext({
      systemPrompt: 'system rules',
      tools: [{ type: 'function', function: { name: 'read_file', description: 'read source', parameters: {} } }],
      messages: [
        { role: 'system', content: 'system rules' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect this secret-free image' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
          ]
        }
      ]
    })

    expect(measurement.systemTokens).toBe(estimateTokensFromText('system rules'))
    expect(measurement.toolSchemaTokens).toBeGreaterThan(0)
    expect(measurement.messageTokens).toBeGreaterThan(estimateTokensFromText('inspect this secret-free image'))
    expect(measurement.imageTokens).toBe(IMAGE_INPUT_TOKEN_ESTIMATE)
    expect(measurement.imageCount).toBe(1)
    expect(measurement.messageCount).toBe(2)
    expect(measurement.toolCount).toBe(1)
    expect(Object.values(measurement).join(' ')).not.toContain('secret-free')
  })

  it('charges replayed tool-call arguments and tool results as message material', () => {
    const base = measureContext({ systemPrompt: '', messages: [] })
    const measurement = measureContext({
      systemPrompt: '',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { type: 'function', function: { name: 'read_file', arguments: '{"path":"src/main.ts"}' } }
          ]
        },
        { role: 'tool', tool_call_id: 'call_1', content: '1 -> export const answer = 42' }
      ]
    })

    expect(measurement.messageTokens).toBeGreaterThan(base.messageTokens)
    expect(measurement.estimatedPromptTokens).toBe(measurement.messageTokens)
  })
})
