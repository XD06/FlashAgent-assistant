import { describe, expect, it, vi } from 'vitest'
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

  it('caches image dimensions across rounds and evicts beyond the bounded size', () => {
    const atobSpy = vi.spyOn(globalThis, 'atob')
    // An 11th byte makes each payload unique without changing the parsed size.
    const freshGif = (id: number): string =>
      `data:image/gif;base64,${btoa(String.fromCharCode(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x02, 0x00, id))}`
    const measure = (url: string): number =>
      measureContext({
        systemPrompt: '',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }]
      }).imagePixels

    const url = freshGif(9)
    const callsAfterFirst = atobSpy.mock.calls.length
    expect(measure(url)).toBe(2)
    const decodeCount = atobSpy.mock.calls.length - callsAfterFirst
    measure(url) // same history re-measured on the next tool round
    expect(atobSpy.mock.calls.length - callsAfterFirst).toBe(decodeCount)

    for (let id = 20; id < 37; id++) measure(freshGif(id)) // push past the 16-entry limit
    const before = atobSpy.mock.calls.length
    expect(measure(url)).toBe(2) // evicted — decoded again, still correct
    expect(atobSpy.mock.calls.length).toBe(before + 1)
    atobSpy.mockRestore()
  })

  it('reads JPEG dimensions past a large APP segment and progressive SOF', () => {
    const appPayload = new Array<number>(4096).fill(0x41)
    const bytes = [
      0xff, 0xd8,
      // APP1 with a 4098-byte segment (2 length bytes + 4096 payload)
      0xff, 0xe1, 0x10, 0x02, ...appPayload,
      // Progressive SOF2: 10×20
      0xff, 0xc2, 0x00, 0x0b, 0x08, 0x00, 0x14, 0x00, 0x0a, 0x01, 0x01, 0x11, 0x00,
      0xff, 0xd9
    ]
    const dataUrl = `data:image/jpeg;base64,${btoa(String.fromCharCode(...bytes))}`
    const measurement = measureContext({
      systemPrompt: '',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }] }]
    })
    expect(measurement.imagesWithKnownDimensions).toBe(1)
    expect(measurement.imagePixels).toBe(200)
  })

  it('tolerates whitespace in the base64 payload', () => {
    const raw = btoa(String.fromCharCode(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x03, 0x00, 0x04, 0x00))
    const wrapped = raw.replace(/(.{4})/g, '$1\n')
    const measurement = measureContext({
      systemPrompt: '',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/gif;base64,${wrapped}` } }] }]
    })
    expect(measurement.imagesWithKnownDimensions).toBe(1)
    expect(measurement.imagePixels).toBe(12)
  })

  it('decodes only a small window for a huge payload', () => {
    // 12 bytes so the header itself has no padding; appending raw base64
    // characters keeps the payload valid enough for the header parser.
    const header = btoa(
      String.fromCharCode(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00)
    )
    const huge = `${header}${'A'.repeat(1_000_000)}`
    const atobSpy = vi.spyOn(globalThis, 'atob')
    const measurement = measureContext({
      systemPrompt: '',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/gif;base64,${huge}` } }] }]
    })
    expect(measurement.imagePixels).toBe(1)
    const longestAtobInput = Math.max(...atobSpy.mock.calls.map((call) => String(call[0]).length))
    expect(longestAtobInput).toBeLessThan(64)
    atobSpy.mockRestore()
  })
})
