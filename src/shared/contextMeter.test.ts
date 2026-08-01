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
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wlq6WAAAAAASUVORK5CYII=' } }
          ]
        }
      ]
    })

    expect(measurement.systemTokens).toBe(estimateTokensFromText('system rules'))
    expect(measurement.toolSchemaTokens).toBeGreaterThan(0)
    expect(measurement.messageTokens).toBeGreaterThan(estimateTokensFromText('inspect this secret-free image'))
    expect(measurement.messageTokens).toBe(
      measurement.textMessageTokens + measurement.toolCallTokens + measurement.toolResultTokens
    )
    expect(measurement.textMessageTokens).toBeGreaterThan(0)
    expect(measurement.toolCallTokens).toBe(0)
    expect(measurement.toolResultTokens).toBe(0)
    expect(measurement.imageTokens).toBe(IMAGE_INPUT_TOKEN_ESTIMATE)
    expect(measurement.imageCount).toBe(1)
    expect(measurement.imageBytes).toBeGreaterThan(0)
    expect(measurement.imagePixels).toBe(1)
    expect(measurement.imagesWithKnownDimensions).toBe(1)
    expect(measurement.messageCount).toBe(2)
    expect(measurement.toolCount).toBe(1)
    expect(Object.values(measurement).join(' ')).not.toContain('secret-free')
  })

  it('separates replayed tool-call arguments and tool results from ordinary text', () => {
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
    expect(measurement.textMessageTokens).toBe(0)
    expect(measurement.toolCallTokens).toBeGreaterThan(0)
    expect(measurement.toolResultTokens).toBeGreaterThan(0)
    expect(measurement.messageTokens).toBe(measurement.toolCallTokens + measurement.toolResultTokens)
    expect(measurement.estimatedPromptTokens).toBe(measurement.messageTokens)
  })

  it('measures Anthropic tool blocks and image metadata without retaining image data', () => {
    const toDataUrl = (mediaType: string, bytes: number[]): string =>
      `data:${mediaType};base64,${btoa(String.fromCharCode(...bytes))}`
    const onePixelGif = toDataUrl('image/gif', [
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00
    ])
    // Minimal JPEG with a 3×2 SOF0 frame. Dimension parsing does not depend
    // on a complete decodable image stream.
    const threeByTwoJpeg = toDataUrl('image/jpeg', [
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9
    ])
    const gifBase64 = onePixelGif.slice(onePixelGif.indexOf(',') + 1)
    const jpegBase64 = threeByTwoJpeg.slice(threeByTwoJpeg.indexOf(',') + 1)
    const measurement = measureContext({
      systemPrompt: '',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } }]
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'source text' },
            { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: gifBase64 } },
            { type: 'image_url', image_url: { url: threeByTwoJpeg } }
          ]
        }
      ]
    })

    expect(measurement.toolCallTokens).toBeGreaterThan(0)
    expect(measurement.toolResultTokens).toBeGreaterThan(0)
    expect(measurement.textMessageTokens).toBe(0)
    expect(measurement.imageCount).toBe(2)
    expect(measurement.imagesWithKnownDimensions).toBe(2)
    expect(measurement.imagePixels).toBe(7)
    expect(measurement.imageBytes).toBeGreaterThan(0)
    expect(Object.values(measurement).join(' ')).not.toContain(gifBase64)
    expect(Object.values(measurement).join(' ')).not.toContain(jpegBase64)
  })
})
