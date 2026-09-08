import { describe, expect, it, vi } from 'vitest'
import { buildMimoDirectorPrompt, synthesizeMimoSpeech, synthesizeOpenAiSpeech, synthesizeSpeech } from './tts'
import type { TtsSettings } from '@shared/types'
import type { ProviderFetch } from '../ai/OpenAICompatibleClient'

describe('synthesizeSpeech', () => {
  const dummyOpenAiTts: TtsSettings = {
    service: 'openai',
    endpoint: 'https://tts.wangwangit.com/v1/audio/speech',
    voice: 'zh-CN-XiaoxiaoNeural',
    speed: 1,
    pitch: 0,
    mimoApiKey: '',
    mimoModel: 'mimo-v2.5-tts',
    mimoVoice: '冰糖'
  }

  const dummyMimoTts: TtsSettings = {
    service: 'mimo',
    endpoint: '',
    voice: '',
    speed: 1.2,
    pitch: 0,
    mimoApiKey: 'test-mimo-key',
    mimoModel: 'mimo-v2.5-tts',
    mimoVoice: '冰糖'
  }

  it('injects Origin, Referer, and User-Agent headers for OpenAI/Edge TTS', async () => {
    let capturedHeaders: Record<string, string> = {}
    let capturedBody = ''

    const fakeFetch: ProviderFetch = async (_url, init) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {}
      capturedBody = String(init?.body ?? '')
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
    }

    const dataUrl = await synthesizeSpeech('你好，世界', dummyOpenAiTts, fakeFetch, AbortSignal.timeout(5000))
    expect(capturedHeaders['Origin']).toBe('https://tts.wangwangit.com')
    expect(capturedHeaders['Referer']).toBe('https://tts.wangwangit.com/')
    expect(capturedHeaders['User-Agent']).toContain('Mozilla/5.0')
    expect(capturedHeaders['Content-Type']).toBe('application/json')
    expect(JSON.parse(capturedBody)).toMatchObject({
      input: '你好，世界',
      voice: 'zh-CN-XiaoxiaoNeural'
    })
    expect(dataUrl).toBe('data:audio/mpeg;base64,AQIDBA==')
  })

  it('synthesizes speech using Xiaomi MiMo TTS when service is mimo', async () => {
    let capturedUrl = ''
    let capturedHeaders: Record<string, string> = {}
    let capturedBody = ''

    const fakeFetch: ProviderFetch = async (url, init) => {
      capturedUrl = String(url)
      capturedHeaders = (init?.headers as Record<string, string>) ?? {}
      capturedBody = String(init?.body ?? '')
      const mockResponse = {
        choices: [
          {
            message: {
              audio: {
                data: Buffer.from([9, 8, 7]).toString('base64')
              }
            }
          }
        ]
      }
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const dataUrl = await synthesizeSpeech('如果我想让它移动呢？', dummyMimoTts, fakeFetch, AbortSignal.timeout(5000))
    expect(capturedUrl).toBe('https://api.xiaomimimo.com/v1/chat/completions')
    expect(capturedHeaders['Authorization']).toBe('Bearer test-mimo-key')
    expect(capturedHeaders['Content-Type']).toBe('application/json')

    const parsed = JSON.parse(capturedBody)
    expect(parsed.model).toBe('mimo-v2.5-tts')
    expect(parsed.audio).toEqual({ format: 'mp3', voice: '冰糖' })
    expect(parsed.messages[0].role).toBe('user')
    expect(parsed.messages[0].content).toContain('专业新闻播音员')
    expect(parsed.messages[0].content).toContain('字正腔圆')
    expect(parsed.messages[0].content).toContain('语速稍快')
    expect(parsed.messages[1].role).toBe('assistant')
    expect(parsed.messages[1].content).toBe('如果我想让它移动呢？')

    expect(dataUrl).toBe(`data:audio/mpeg;base64,${Buffer.from([9, 8, 7]).toString('base64')}`)
  })

  it('rejects when MiMo API key is missing', async () => {
    const fakeFetch: ProviderFetch = vi.fn()
    await expect(
      synthesizeMimoSpeech('test', { ...dummyMimoTts, mimoApiKey: '' }, fakeFetch, AbortSignal.timeout(5000))
    ).rejects.toThrow('请先在 设置 → 翻译 → 语音合成 中配置小米 MiMo API Key')
  })

  it('rejects on HTTP error status', async () => {
    const fakeFetch: ProviderFetch = async () => new Response('Forbidden', { status: 403 })
    await expect(synthesizeOpenAiSpeech('test', dummyOpenAiTts, fakeFetch, AbortSignal.timeout(5000))).rejects.toThrow('TTS 403')

    const fakeMimo401: ProviderFetch = async () => new Response('Unauthorized', { status: 401 })
    await expect(synthesizeMimoSpeech('test', dummyMimoTts, fakeMimo401, AbortSignal.timeout(5000))).rejects.toThrow('小米 MiMo API Key 无效（401）')
  })

  it('rejects on empty text or unconfigured endpoint', async () => {
    const fakeFetch: ProviderFetch = vi.fn()
    await expect(synthesizeSpeech('   ', dummyOpenAiTts, fakeFetch, AbortSignal.timeout(5000))).rejects.toThrow('TTS: empty text')
    await expect(
      synthesizeOpenAiSpeech('test', { ...dummyOpenAiTts, endpoint: '' }, fakeFetch, AbortSignal.timeout(5000))
    ).rejects.toThrow('TTS endpoint is not configured')
  })
})

describe('buildMimoDirectorPrompt', () => {
  it('generates standard news broadcaster prompt for Chinese text', () => {
    const prompt = buildMimoDirectorPrompt('北京今天晴空万里，气温适宜。', 1)
    expect(prompt).toContain('专业新闻播音员')
    expect(prompt).toContain('标准普通话规范朗读')
    expect(prompt).toContain('字正腔圆')
    expect(prompt).toContain('避免夸张的情绪起伏')
  })

  it('generates professional bilingual prompt for mixed text', () => {
    const prompt = buildMimoDirectorPrompt('这个 React 组件性能非常好。', 1)
    expect(prompt).toContain('专业双语播音员')
    expect(prompt).toContain('中英文衔接自然流畅')
  })

  it('generates professional news anchor prompt for pure English text', () => {
    const prompt = buildMimoDirectorPrompt('Good morning, here is the world news report.', 1)
    expect(prompt).toContain('professional news anchor')
    expect(prompt).toContain('steady, neutral, professional tone')
  })

  it('applies pacing modifiers based on speed', () => {
    const fast = buildMimoDirectorPrompt('你好', 1.2)
    expect(fast).toContain('语速稍快')

    const veryFast = buildMimoDirectorPrompt('你好', 1.5)
    expect(veryFast).toContain('语速较快')

    const slow = buildMimoDirectorPrompt('你好', 0.8)
    expect(slow).toContain('语速稍慢')

    const normal = buildMimoDirectorPrompt('你好', 1.0)
    expect(normal).not.toContain('语速稍快')
    expect(normal).not.toContain('语速较快')
    expect(normal).not.toContain('语速稍慢')
  })
})
