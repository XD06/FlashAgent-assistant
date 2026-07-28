import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extractAnthropicBlocks,
  listModels,
  normalizeBaseUrl,
  parseAnthropicStreamEvent,
  parseOpenAIStreamEvent,
  streamChatMessages,
  testModel,
  type AnthropicStreamBlock
} from './OpenAICompatibleClient'
import type { ProviderSettings } from '@shared/types'

const provider: ProviderSettings = {
  apiType: 'openai',
  baseUrl: 'https://api.example.com/v1/',
  apiKey: 'test-key',
  model: 'gpt-test',
  temperature: 1
}

const anthropicProvider: ProviderSettings = {
  apiType: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'anthropic-key',
  model: 'claude-3-5-sonnet-latest',
  temperature: 1
}

afterEach(() => {
  vi.restoreAllMocks()
})

function streamingTextResponse(text: string): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`))
      controller.close()
    }
  })
  return new Response(body, { status: 200 })
}

describe('OpenAI-compatible stream parser', () => {
  it('normalizes trailing slashes from base URLs', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1///')).toBe('https://api.example.com/v1')
  })

  it('normalizes full OpenAI-compatible endpoint URLs back to the API root', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1')
    expect(normalizeBaseUrl('https://api.example.com/v1/models/')).toBe('https://api.example.com/v1')
  })

  it('parses text deltas from SSE events', () => {
    const event = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
    expect(parseOpenAIStreamEvent(event)).toEqual({ content: 'hello' })
  })

  it('parses reasoning_content from SSE events', () => {
    const event = 'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n'
    expect(parseOpenAIStreamEvent(event)).toEqual({ reasoning: 'thinking...' })
  })

  it('parses both content and reasoning from SSE events', () => {
    const event = 'data: {"choices":[{"delta":{"content":"hi","reasoning_content":"thought"}}]}\n\n'
    expect(parseOpenAIStreamEvent(event)).toEqual({ content: 'hi', reasoning: 'thought' })
  })

  it('returns null for done events', () => {
    expect(parseOpenAIStreamEvent('data: [DONE]\n\n')).toBeNull()
  })

  it('parses anthropic text deltas from SSE events', () => {
    const event = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n'
    expect(parseAnthropicStreamEvent(event)).toEqual({ content: 'hello' })
  })

  it('parses anthropic thinking deltas from SSE events', () => {
    const event = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"reasoning..."}}\n\n'
    expect(parseAnthropicStreamEvent(event)).toEqual({ reasoning: 'reasoning...' })
  })

  it('lists sorted model ids and filters invalid model entries', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'z-model' }, { id: '' }, { id: 123 }, { id: 'a-model' }]
        }),
        { status: 200 }
      )
    )

    await expect(listModels(provider)).resolves.toEqual(['a-model', 'z-model'])
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1/models', {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-key'
      }
    })
  })

  it('uses an injected fetcher for provider requests', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('global fetch failed'))
    const providerFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'custom-fetch-model' }]
        }),
        { status: 200 }
      )
    )

    await expect(listModels(provider, { fetcher: providerFetch })).resolves.toEqual(['custom-fetch-model'])
    expect(globalFetch).not.toHaveBeenCalled()
    expect(providerFetch).toHaveBeenCalledWith('https://api.example.com/v1/models', {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-key'
      }
    })
  })

  it('tests a model with a lightweight non-streaming chat request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 })
    )

    await expect(testModel(provider)).resolves.toBeUndefined()
    const [, init] = fetchMock.mock.calls[0]
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/chat/completions')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'gpt-test',
      stream: false,
      max_completion_tokens: 8
    })
  })

  it('sends explicit OpenAI-compatible reasoning effort for selected intensity', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamingTextResponse('OK'))
    const deltas: string[] = []

    await streamChatMessages(
      provider,
      [{ role: 'user', text: 'explain this' }],
      'system',
      new AbortController().signal,
      (delta) => { if (delta.content) deltas.push(delta.content) },
      'high'
    )

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(String(init?.body))).toMatchObject({
      reasoning_effort: 'high'
    })
    expect(deltas).toEqual(['OK'])
  })

  it('lists anthropic models using the v1/models endpoint and anthropic headers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'claude-3-5-haiku-latest' }] }), { status: 200 })
    )

    await expect(listModels(anthropicProvider)).resolves.toEqual(['claude-3-5-haiku-latest'])
    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'anthropic-key',
        'anthropic-version': '2023-06-01'
      }
    })
  })

  it('tests an anthropic model using the v1/messages endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }), { status: 200 })
    )

    await expect(testModel(anthropicProvider)).resolves.toBeUndefined()
    const [, init] = fetchMock.mock.calls[0]
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages')
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'anthropic-key',
      'anthropic-version': '2023-06-01'
    })
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'claude-3-5-sonnet-latest',
      stream: false,
      max_tokens: 8,
      system: 'Reply with OK only.'
    })
  })

  it('returns readable provider errors when model testing fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad key', { status: 401, statusText: 'Unauthorized' }))

    await expect(testModel(provider)).rejects.toThrow('Provider request failed (401): bad key')
  })

  it('parses SSE events separated by CRLF blank lines', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"foo"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"bar"}}]}\r\n\r\n'
          )
        )
        controller.close()
      }
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }))
    const deltas: string[] = []

    await streamChatMessages(
      provider,
      [{ role: 'user', text: 'hi' }],
      'system',
      new AbortController().signal,
      (delta) => { if (delta.content) deltas.push(delta.content) },
      'off'
    )

    expect(deltas).toEqual(['foo', 'bar'])
  })

  // ---- Tool-loop context control ----
  const toolDef = { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } }
  function toolCallResponse(callId: string): Response {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"${callId}","function":{"name":"read_file","arguments":"{}"}}]}}]}\n\n`
          )
        )
        controller.close()
      }
    })
    return new Response(body, { status: 200 })
  }

  it('caps oversized tool results before sending them back to the model', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(toolCallResponse('call_1'))
      .mockResolvedValueOnce(streamingTextResponse('done'))

    await streamChatMessages(
      provider,
      [{ role: 'user', text: 'read it' }],
      'system',
      new AbortController().signal,
      () => {},
      'off',
      {
        tools: [toolDef],
        onToolCall: async () => 'x'.repeat(30_000),
        maxToolRounds: 3
      }
    )

    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as {
      messages: Array<{ role: string; content: string }>
    }
    const toolMsg = secondBody.messages.find((m) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg!.content.length).toBeLessThan(15_000)
    expect(toolMsg!.content).toContain('chars truncated')
  })

  it('stubs out tool results older than the recent-rounds window', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    // 7 rounds of tool calls, then a final plain-text reply. Round 0's
    // result should be aged out by the time round 6 sends its request.
    for (let i = 0; i < 7; i++) fetchMock.mockResolvedValueOnce(toolCallResponse(`call_${i}`))
    fetchMock.mockResolvedValueOnce(streamingTextResponse('done'))

    await streamChatMessages(
      provider,
      [{ role: 'user', text: 'work' }],
      'system',
      new AbortController().signal,
      () => {},
      'off',
      {
        tools: [toolDef],
        onToolCall: async () => 'y'.repeat(2_000),
        maxToolRounds: 10
      }
    )

    const lastBody = JSON.parse(String(fetchMock.mock.calls[7][1]?.body)) as {
      messages: Array<{ role: string; content: string }>
    }
    const toolMsgs = lastBody.messages.filter((m) => m.role === 'tool')
    expect(toolMsgs.length).toBe(7)
    // Oldest results are stubbed, the most recent ones stay verbatim.
    expect(toolMsgs[0].content).toContain('trimmed to save context')
    expect(toolMsgs[toolMsgs.length - 1].content).toBe('y'.repeat(2_000))
  })
})

describe('extractAnthropicBlocks', () => {
  it('accumulates tool_use arguments streamed as input_json_delta', () => {
    const map = new Map<number, AnthropicStreamBlock>()
    extractAnthropicBlocks(
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"web_search"}}\n',
      map
    )
    extractAnthropicBlocks(
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":"}}\n',
      map
    )
    extractAnthropicBlocks(
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"news\\"}"}}\n',
      map
    )

    const block = map.get(1)
    expect(block?.type).toBe('tool_use')
    expect(block?.id).toBe('toolu_1')
    expect(block?.name).toBe('web_search')
    expect(JSON.parse(block?.json ?? '')).toEqual({ query: 'news' })
  })

  it('accumulates thinking and signature deltas on the same block', () => {
    const map = new Map<number, AnthropicStreamBlock>()
    extractAnthropicBlocks(
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n',
      map
    )
    extractAnthropicBlocks(
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step one"}}\n',
      map
    )
    extractAnthropicBlocks(
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig123"}}\n',
      map
    )

    expect(map.get(0)).toMatchObject({ type: 'thinking', thinking: 'step one', signature: 'sig123' })
  })

  it('tracks text blocks by index alongside tool blocks', () => {
    const map = new Map<number, AnthropicStreamBlock>()
    extractAnthropicBlocks(
      [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me search."}}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"web_search"}}'
      ].join('\n'),
      map
    )

    expect(map.get(0)).toMatchObject({ type: 'text', text: 'Let me search.' })
    expect(map.get(1)).toMatchObject({ type: 'tool_use', id: 't1' })
  })
})
