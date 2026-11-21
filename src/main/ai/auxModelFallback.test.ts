import { describe, expect, it, vi } from 'vitest'
import type { ProviderSettings } from '@shared/types'
import type { streamChatMessages } from './OpenAICompatibleClient'
import {
  isImmediateFallbackError,
  resolveAuxModelCandidates,
  runWithModelFallback,
  summarizeWithFallback
} from './auxModelFallback'

const baseProvider: ProviderSettings = {
  apiType: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'test-key',
  model: 'gpt-4o',
  temperature: 1,
  reasoning: 'on'
}

const VALID_DOC = [
  '# 复工文档',
  '## 1. 原始任务',
  '优化压缩模型兜底',
  '## 2. 事实台账',
  '- 已确认需要快速降级',
  '## 3. 涉及文件与当前状态',
  '`src/main/index.ts` — 待修改',
  '## 4. 失败路径台账',
  '无',
  '## 5. 当前任务与下一步',
  '继续实现兜底逻辑'
].join('\n')

describe('resolveAuxModelCandidates', () => {
  it('trims, prioritizes compressModel before chatModel, and deduplicates identical names', () => {
    expect(resolveAuxModelCandidates(' gpt-4o-mini ', ' gpt-4o ', 'default-m')).toEqual([
      'gpt-4o-mini',
      'gpt-4o'
    ])
    expect(resolveAuxModelCandidates('gpt-4o', 'gpt-4o', 'default-m')).toEqual(['gpt-4o'])
    expect(resolveAuxModelCandidates('   ', 'claude-sonnet', 'default-m')).toEqual(['claude-sonnet'])
    expect(resolveAuxModelCandidates('', '', ' fallback-m ')).toEqual(['fallback-m'])
    expect(resolveAuxModelCandidates('', '', '')).toEqual([])
  })
})

describe('isImmediateFallbackError', () => {
  it('flags deterministic 4xx/model/auth/context-length errors for immediate fallback', () => {
    expect(isImmediateFallbackError(new Error('Provider request failed (400): unsupported parameter'))).toBe(true)
    expect(isImmediateFallbackError(new Error('Provider request failed (401): invalid api key'))).toBe(true)
    expect(isImmediateFallbackError(new Error('Provider request failed (403): forbidden'))).toBe(true)
    expect(isImmediateFallbackError(new Error('Provider request failed (404): model_not_found'))).toBe(true)
    expect(isImmediateFallbackError(new Error('Provider request failed (422): unprocessable'))).toBe(true)
    expect(isImmediateFallbackError(new Error('context_length_exceeded: maximum context length reached'))).toBe(true)
    expect(isImmediateFallbackError(new Error('prompt is too long for this model'))).toBe(true)
  })

  it('does not treat transient 5xx or network resets as immediate non-retryable errors', () => {
    expect(isImmediateFallbackError(new Error('Provider request failed (500): internal error'))).toBe(false)
    expect(isImmediateFallbackError(new Error('Provider request failed (502): bad gateway'))).toBe(false)
    expect(isImmediateFallbackError(new Error('Provider request failed (503): service unavailable'))).toBe(false)
    expect(isImmediateFallbackError(new Error('fetch failed: ECONNRESET'))).toBe(false)
  })
})

describe('runWithModelFallback', () => {
  it('runs preferred compressModel once with maxRetries=0 and returns fellBack=false when it succeeds', async () => {
    const calls: Array<{ model: string; isPreferred: boolean; maxRetries: number; attempt: number }> = []
    const result = await runWithModelFallback({
      candidates: ['gpt-4o-mini', 'gpt-4o'],
      run: async (ctx) => {
        calls.push({
          model: ctx.model,
          isPreferred: ctx.isPreferred,
          maxRetries: ctx.maxRetries,
          attempt: ctx.attempt
        })
        return 'ok'
      }
    })

    expect(result).toEqual({ value: 'ok', usedModel: 'gpt-4o-mini', fellBack: false })
    expect(calls).toEqual([{ model: 'gpt-4o-mini', isPreferred: true, maxRetries: 0, attempt: 0 }])
  })

  it.each([
    'Provider request failed (404): model_not_found',
    'Provider request failed (400): unsupported chat_template_kwargs',
    'Provider request failed (429): rate limit reached',
    'Provider request failed (503): upstream overloaded',
    'context_length_exceeded: input too long'
  ])('fails fast after 1 attempt on preferred model error (%s) and falls back to chatModel', async (errMsg) => {
    const visited: string[] = []
    const result = await runWithModelFallback({
      candidates: ['compress-fast', 'chat-main'],
      run: async ({ model, maxRetries }) => {
        visited.push(`${model}:${maxRetries}`)
        if (model === 'compress-fast') throw new Error(errMsg)
        return 'recovered'
      }
    })

    expect(visited).toEqual(['compress-fast:0', 'chat-main:1'])
    expect(result).toEqual({
      value: 'recovered',
      usedModel: 'chat-main',
      fellBack: true,
      fallbackReason: errMsg
    })
  })

  it('falls back to chatModel when preferred model exceeds preferredTimeoutMs', async () => {
    const visited: string[] = []
    const result = await runWithModelFallback({
      candidates: ['slow-mini', 'chat-main'],
      preferredTimeoutMs: 25,
      fallbackTimeoutMs: 1000,
      run: async ({ model, signal }) => {
        visited.push(model)
        if (model === 'slow-mini') {
          return await new Promise<string>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
          })
        }
        return 'done-on-fallback'
      }
    })

    expect(visited).toEqual(['slow-mini', 'chat-main'])
    expect(result.value).toBe('done-on-fallback')
    expect(result.usedModel).toBe('chat-main')
    expect(result.fellBack).toBe(true)
    expect(result.fallbackReason).toContain('timed out')
  })

  it('retries transient failure on final chatModel and skips retries on immediate non-retryable error', async () => {
    const attempts: number[] = []
    const recovered = await runWithModelFallback({
      candidates: ['chat-main'],
      fallbackAttempts: 2,
      run: async ({ attempt }) => {
        attempts.push(attempt)
        if (attempt === 0) throw new Error('Provider request failed (503): temporary')
        return 'ok-on-retry'
      }
    })
    expect(attempts).toEqual([0, 1])
    expect(recovered).toEqual({ value: 'ok-on-retry', usedModel: 'chat-main', fellBack: false })

    const authAttempts: number[] = []
    await expect(
      runWithModelFallback({
        candidates: ['chat-main'],
        fallbackAttempts: 2,
        run: async ({ attempt }) => {
          authAttempts.push(attempt)
          throw new Error('Provider request failed (401): invalid api key')
        }
      })
    ).rejects.toThrow('(401)')
    expect(authAttempts).toEqual([0])
  })

  it('aborts immediately on caller AbortSignal without falling back to chatModel', async () => {
    const controller = new AbortController()
    const visited: string[] = []

    const promise = runWithModelFallback({
      candidates: ['compress-fast', 'chat-main'],
      signal: controller.signal,
      run: async ({ model, signal }) => {
        visited.push(model)
        controller.abort()
        if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
        return 'unexpected'
      }
    })

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(visited).toEqual(['compress-fast'])
  })
})

describe('summarizeWithFallback', () => {
  it('falls back to chatModel when compressModel returns empty or malformed output', async () => {
    const calledModels: string[] = []
    const streamFn = vi.fn(async (provider, _msgs, _sys, _signal, onDelta) => {
      calledModels.push(provider.model)
      if (provider.model === 'bad-mini') {
        onDelta({ content: '这里没有固定标题，只是随口总结一下' })
        return
      }
      onDelta({ content: VALID_DOC })
    }) as unknown as typeof streamChatMessages

    const res = await summarizeWithFallback({
      baseProvider,
      candidates: ['bad-mini', 'gpt-4o'],
      text: '<conversation>test</conversation>',
      streamFn
    })

    expect(calledModels).toEqual(['bad-mini', 'gpt-4o'])
    expect(res.fellBack).toBe(true)
    expect(res.usedModel).toBe('gpt-4o')
    expect(res.fallbackReason).toContain('Malformed summary')
    expect(res.doc).toContain('# 复工文档')
  })

  it('auto-repairs loose markdown headers from compressModel without falling back', async () => {
    const calledModels: string[] = []
    const looseDoc = [
      '### 1、原始任务',
      '实现自动降级',
      '### 2、事实台账',
      '- 新增测试',
      '### 3、涉及文件与当前状态',
      '`a.ts` — 已改',
      '### 5、当前任务与下一步',
      '完成提交'
    ].join('\n')

    const streamFn = vi.fn(async (provider, _msgs, _sys, _signal, onDelta) => {
      calledModels.push(provider.model)
      onDelta({ content: looseDoc })
    }) as unknown as typeof streamChatMessages

    const res = await summarizeWithFallback({
      baseProvider,
      candidates: ['good-mini', 'gpt-4o'],
      text: '<conversation>test</conversation>',
      streamFn
    })

    expect(calledModels).toEqual(['good-mini'])
    expect(res.fellBack).toBe(false)
    expect(res.usedModel).toBe('good-mini')
    expect(res.doc).toContain('## 4. 失败路径台账')
  })

  it('throws a descriptive error when all candidate models fail', async () => {
    const streamFn = vi.fn(async (provider) => {
      throw new Error(`Provider request failed (503): ${provider.model} down`)
    }) as unknown as typeof streamChatMessages

    await expect(
      summarizeWithFallback({
        baseProvider,
        candidates: ['mini-a', 'gpt-4o'],
        text: '<conversation>test</conversation>',
        streamFn
      })
    ).rejects.toThrow('gpt-4o down')
    expect(streamFn).toHaveBeenCalledTimes(3)
  })
})
