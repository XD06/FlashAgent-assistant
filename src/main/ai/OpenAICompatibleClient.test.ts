import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  expandAnthropicHistory,
  expandOpenAIHistory,
  extractAnthropicBlocks,
  flattenToolTrace,
  listModels,
  normalizeBaseUrl,
  parseAnthropicStreamEvent,
  parseOpenAIStreamEvent,
  parseUsageEvent,
  streamChatMessages,
  testModel,
  type AnthropicStreamBlock
} from './OpenAICompatibleClient'
import type { AiMessageInput, ProviderSettings } from '@shared/types'

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

  it('parses OpenAI usage from the trailing stream chunk', () => {
    const event = 'data: {"choices":[],"usage":{"prompt_tokens":1234,"completion_tokens":56}}\n\n'
    expect(parseUsageEvent('openai', event)).toEqual({ promptTokens: 1234, completionTokens: 56 })
  })

  it('returns null usage for delta chunks and done events', () => {
    expect(parseUsageEvent('openai', 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')).toBeNull()
    expect(parseUsageEvent('openai', 'data: [DONE]\n\n')).toBeNull()
  })

  it('parses anthropic usage from message_start and message_delta events', () => {
    const start =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2000,"output_tokens":1}}}\n\n'
    expect(parseUsageEvent('anthropic', start)).toEqual({ promptTokens: 2000, completionTokens: 1 })
    const delta = 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n'
    expect(parseUsageEvent('anthropic', delta)).toEqual({ completionTokens: 42 })
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

  // ---- Transient-failure retry ----
  function rateLimitedResponse(retryAfterSeconds = 0): Response {
    return new Response('rate limited', { status: 429, headers: { 'retry-after': String(retryAfterSeconds) } })
  }

  it('retries transient failures and succeeds without surfacing an error', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rateLimitedResponse())
      .mockResolvedValueOnce(streamingTextResponse('OK'))
    const deltas: string[] = []
    const statuses: string[] = []

    await streamChatMessages(
      provider,
      [{ role: 'user', text: 'hi' }],
      'system',
      new AbortController().signal,
      (delta) => { if (delta.content) deltas.push(delta.content) },
      'off',
      { onStatus: (text) => statuses.push(text), retryNotice: 'retrying ({attempt}/{max})' }
    )

    expect(deltas).toEqual(['OK'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(statuses).toEqual(['retrying (1/3)'])
  })

  it('gives up after exhausting retries and throws the provider error', async () => {
    // Fresh Response per attempt — a body can only be read once.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => rateLimitedResponse())

    await expect(
      streamChatMessages(
        provider,
        [{ role: 'user', text: 'hi' }],
        'system',
        new AbortController().signal,
        () => {},
        'off'
      )
    ).rejects.toThrow('Provider request failed (429): rate limited')
    // 1 initial attempt + 3 retries
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('does not retry non-transient errors like 401', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('bad key', { status: 401 }))

    await expect(
      streamChatMessages(
        provider,
        [{ role: 'user', text: 'hi' }],
        'system',
        new AbortController().signal,
        () => {},
        'off'
      )
    ).rejects.toThrow('Provider request failed (401): bad key')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('aborting during a retry wait stops immediately', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(rateLimitedResponse(20))
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30)

    await expect(
      streamChatMessages(
        provider,
        [{ role: 'user', text: 'hi' }],
        'system',
        controller.signal,
        () => {},
        'off'
      )
    ).rejects.toThrow(/abort/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries network-level fetch failures', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(streamingTextResponse('OK'))
    const deltas: string[] = []

    await streamChatMessages(
      provider,
      [{ role: 'user', text: 'hi' }],
      'system',
      new AbortController().signal,
      (delta) => { if (delta.content) deltas.push(delta.content) },
      'off'
    )

    expect(deltas).toEqual(['OK'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  }, 10_000)

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

  // ---- Usage capture (P1-A) ----
  function streamingTextWithUsageResponse(text: string): Response {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`))
        controller.enqueue(
          encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":1234,"completion_tokens":56}}\n\n')
        )
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }
    })
    return new Response(body, { status: 200 })
  }

  it('requests include_usage and reports usage from the trailing chunk', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamingTextWithUsageResponse('OK'))
    const onUsage = vi.fn()
    const deltas: string[] = []

    await streamChatMessages(
      provider,
      [{ role: 'user', text: 'hi' }],
      'system',
      new AbortController().signal,
      (delta) => { if (delta.content) deltas.push(delta.content) },
      'off',
      { onUsage }
    )

    expect(deltas).toEqual(['OK'])
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 1234, completionTokens: 56 })
  })

  it('emits content-free context measurements before a simple provider request', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamingTextResponse('OK'))
    const onContextMeasured = vi.fn()

    await streamChatMessages(
      provider,
      [{ role: 'user', text: 'inspect a file' }],
      'system rules',
      new AbortController().signal,
      () => {},
      'off',
      { onContextMeasured }
    )

    expect(onContextMeasured).toHaveBeenCalledTimes(1)
    const measurement = onContextMeasured.mock.calls[0][0] as Record<string, unknown>
    expect(measurement.modelRequestIndex).toBe(0)
    expect(measurement.estimatedPromptTokens).toEqual(expect.any(Number))
    expect(Object.values(measurement).join(' ')).not.toContain('inspect a file')
  })

  it('does not request include_usage when no onUsage listener is set', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamingTextResponse('OK'))

    await streamChatMessages(
      provider,
      [{ role: 'user', text: 'hi' }],
      'system',
      new AbortController().signal,
      () => {},
      'off'
    )

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>
    expect('stream_options' in body).toBe(false)
  })

  it('drops stream_options and retries once when the server rejects it with 400', async () => {
    // Fresh Response per attempt — a body can only be read once.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response('unknown field stream_options', { status: 400 }))
      .mockImplementationOnce(async () => streamingTextResponse('OK'))
    const onUsage = vi.fn()
    const deltas: string[] = []

    await streamChatMessages(
      provider,
      [{ role: 'user', text: 'hi' }],
      'system',
      new AbortController().signal,
      (delta) => { if (delta.content) deltas.push(delta.content) },
      'off',
      { onUsage }
    )

    expect(deltas).toEqual(['OK'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as Record<string, unknown>
    expect(firstBody.stream_options).toEqual({ include_usage: true })
    expect('stream_options' in secondBody).toBe(false)
    // No usage chunk arrives without stream_options — nothing is reported.
    expect(onUsage).not.toHaveBeenCalled()
  })

  it('anthropic requests skip stream_options but still report usage', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2000,"output_tokens":1}}}\n\n'
          )
        )
        controller.enqueue(
          encoder.encode(
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n'
          )
        )
        controller.enqueue(
          encoder.encode('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n')
        )
        controller.close()
      }
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }))
    const onUsage = vi.fn()
    const deltas: string[] = []

    await streamChatMessages(
      anthropicProvider,
      [{ role: 'user', text: 'hi' }],
      'system',
      new AbortController().signal,
      (delta) => { if (delta.content) deltas.push(delta.content) },
      'off',
      { onUsage }
    )

    expect(deltas).toEqual(['hi'])
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>
    expect('stream_options' in requestBody).toBe(false)
    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 2000, completionTokens: 42 })
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
    // 25 rounds of tool calls, then a final plain-text reply. With a keep
    // window of 25 rounds, round 0's result is first aged out by the check
    // that runs just before the round-25 request goes out.
    for (let i = 0; i < 25; i++) fetchMock.mockResolvedValueOnce(toolCallResponse(`call_${i}`))
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
        maxToolRounds: 30
      }
    )

    const lastBody = JSON.parse(String(fetchMock.mock.calls[25][1]?.body)) as {
      messages: Array<{ role: string; content: string }>
    }
    const toolMsgs = lastBody.messages.filter((m) => m.role === 'tool')
    expect(toolMsgs.length).toBe(25)
    // Every result keeps its identity prefix; the oldest is stubbed while the
    // most recent stays verbatim after the prefix line.
    expect(toolMsgs[0].content.startsWith('[tool:')).toBe(true)
    expect(toolMsgs[0].content).toContain('trimmed')
    const newest = toolMsgs[toolMsgs.length - 1].content
    expect(newest.startsWith('[tool:')).toBe(true)
    expect(newest).toContain('y'.repeat(2_000))
  })

  it('returns an actionable error to the model when tool arguments are not valid JSON', async () => {
    const encoder = new TextEncoder()
    const badArgsBody = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bad","function":{"name":"read_file","arguments":"{broken"}}]}}]}\n\n'
          )
        )
        controller.close()
      }
    })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(badArgsBody, { status: 200 }))
      .mockResolvedValueOnce(streamingTextResponse('done'))
    const onToolCall = vi.fn(async () => 'never called')

    await streamChatMessages(
      provider,
      [{ role: 'user', text: 'read it' }],
      'system',
      new AbortController().signal,
      () => {},
      'off',
      { tools: [toolDef], onToolCall, maxToolRounds: 3 }
    )

    // The tool must not run with a silently-empty argument object.
    expect(onToolCall).not.toHaveBeenCalled()
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as {
      messages: Array<{ role: string; content: string; tool_call_id?: string }>
    }
    const toolMsg = secondBody.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.tool_call_id).toBe('call_bad')
    expect(toolMsg?.content).toContain('Invalid tool call')
    expect(toolMsg?.content).toContain('Re-issue the tool call with valid JSON arguments')
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

// ---- Cross-turn tool-trace replay ----

const tracedHistory: AiMessageInput[] = [
  { role: 'user', text: 'fix the bug' },
  {
    role: 'assistant',
    text: 'Fixed it.',
    toolTrace: [
      { id: 'c1', name: 'read_file', argsJson: '{"path":"a.ts"}', result: '[tool: read_file a.ts → ok]\ncontents' },
      { id: 'c2', name: 'edit_file', argsJson: '{"path":"a.ts"}', result: '[tool: edit_file a.ts → ok]\nedited' }
    ]
  },
  { role: 'user', text: 'now add a test' }
]

describe('expandOpenAIHistory', () => {
  it('expands a traced assistant turn into tool_calls + tool results + text', () => {
    const out = expandOpenAIHistory(tracedHistory) as Array<Record<string, unknown>>
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant', 'user'])
    const call = out[1] as { content: unknown; tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> }
    expect(call.content).toBe(null)
    expect(call.tool_calls[0]).toMatchObject({ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } })
    // Every tool message stays paired with its call id.
    expect(out[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1' })
    expect(out[3]).toMatchObject({ role: 'tool', tool_call_id: 'c2' })
    expect(out[4]).toMatchObject({ role: 'assistant', content: 'Fixed it.' })
  })

  it('passes untraced messages through unchanged', () => {
    const out = expandOpenAIHistory([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }])
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ])
  })

  it('omits the trailing text message when the turn had no text', () => {
    const out = expandOpenAIHistory([
      { role: 'assistant', text: '', toolTrace: [{ id: 'c1', name: 'run', argsJson: '{}', result: 'r' }] }
    ]) as Array<Record<string, unknown>>
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool'])
  })
})

describe('expandAnthropicHistory', () => {
  it('expands into tool_use + tool_result blocks with alternating roles', () => {
    const out = expandAnthropicHistory(tracedHistory) as Array<{ role: string; content: unknown }>
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    const uses = out[1].content as Array<Record<string, unknown>>
    expect(uses[0]).toMatchObject({ type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.ts' } })
    const results = out[2].content as Array<Record<string, unknown>>
    expect(results[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1' })
    expect(out[3].content).toEqual([{ type: 'text', text: 'Fixed it.' }])
  })

  it('merges the result block with a following real user turn (strict alternation)', () => {
    const out = expandAnthropicHistory([
      { role: 'assistant', text: '', toolTrace: [{ id: 'c1', name: 'run', argsJson: '{}', result: 'r' }] },
      { role: 'user', text: 'next question' }
    ]) as Array<{ role: string; content: unknown }>
    expect(out.map((m) => m.role)).toEqual(['assistant', 'user'])
    const blocks = out[1].content as Array<Record<string, unknown>>
    // tool_result blocks must lead the user message; the text follows.
    expect(blocks[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1' })
    expect(blocks[1]).toMatchObject({ type: 'text', text: 'next question' })
  })

  it('degrades unparseable argsJson to an empty input object', () => {
    const out = expandAnthropicHistory([
      { role: 'assistant', text: 'x', toolTrace: [{ id: 'c1', name: 'run', argsJson: 'not-json', result: 'r' }] }
    ]) as Array<{ role: string; content: unknown }>
    const uses = out[0].content as Array<Record<string, unknown>>
    expect(uses[0]).toMatchObject({ type: 'tool_use', input: {} })
  })
})

describe('flattenToolTrace', () => {
  it('folds the trace into text for tool-less requests', () => {
    const flat = flattenToolTrace(tracedHistory[1])
    expect(flat.toolTrace).toBeUndefined()
    expect(flat.text).toContain('Fixed it.')
    expect(flat.text).toContain('[tool: read_file a.ts → ok]')
  })

  it('returns untraced messages as-is', () => {
    const m: AiMessageInput = { role: 'user', text: 'hi' }
    expect(flattenToolTrace(m)).toBe(m)
  })
})
