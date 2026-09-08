import type { ProviderFetch } from '../ai/OpenAICompatibleClient'
import type { TtsSettings } from '@shared/types'

/** Synthesize speech via an OpenAI-compatible /v1/audio/speech endpoint and
 * return an audio data URL the renderer can feed to an <audio> element.
 * Runs in the main process so it follows the app's proxy chain. */
const MIMO_API_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions'

/** Construct director instructions for MiMo-V2.5-TTS.
 * LLM-based TTS models are highly sensitive to emotional and stylistic cues.
 * Using a standard news anchor/broadcaster persona with disciplined pacing
 * produces stable, articulate, standard enunciation without exaggerated drama
 * or theatrical mood swings. */
export function buildMimoDirectorPrompt(text: string, speed: number): string {
  const hasChinese = /[\u4e00-\u9fff]/.test(text)
  const hasEnglish = /[a-zA-Z]{2,}/.test(text)

  let base: string
  if (hasChinese && hasEnglish) {
    base =
      '你是一位专业双语播音员。请用标准普通话与纯正规范的英语端正朗读，字正腔圆，吐字清晰干脆，中英文衔接自然流畅，语调平稳沉稳，节奏均匀，避免夸张的情绪起伏与戏感。'
  } else if (hasChinese) {
    base =
      '你是一位专业新闻播音员。请用标准普通话规范朗读以下文本，字正腔圆，吐字清晰干脆，发音标准规范，语调平稳端正，从容中正，节奏均匀，停顿严谨得当，避免夸张的情绪起伏、叹气与戏剧性戏感。'
  } else {
    base =
      'You are a professional news anchor. Please deliver the speech with standard pronunciation, clear enunciation, and a steady, neutral, professional tone. Maintain an even, disciplined pace without exaggerated emotion or theatrical affectation.'
  }

  if (hasChinese || !hasEnglish) {
    if (speed >= 1.35) return `${base} 语速较快，节奏紧凑干脆。`
    if (speed >= 1.15) return `${base} 语速稍快，节奏明快利落。`
    if (speed <= 0.85) return `${base} 语速稍慢，从容平稳。`
  } else {
    if (speed >= 1.35) return `${base} Deliver at a brisk pace with crisp rhythm.`
    if (speed >= 1.15) return `${base} Deliver at a slightly faster, clear pace.`
    if (speed <= 0.85) return `${base} Deliver at a calm, deliberate pace.`
  }
  return base
}

export async function synthesizeMimoSpeech(
  text: string,
  tts: TtsSettings,
  fetchImpl: ProviderFetch,
  signal: AbortSignal
): Promise<string> {
  const apiKey = tts.mimoApiKey?.trim()
  if (!apiKey) {
    throw new Error('请先在 设置 → 翻译 → 语音合成 中配置小米 MiMo API Key')
  }

  const model = tts.mimoModel?.trim() || 'mimo-v2.5-tts'
  const voice = tts.mimoVoice?.trim() || '冰糖'
  const speed = Math.min(2, Math.max(0.5, tts.speed || 1))
  const director = buildMimoDirectorPrompt(text, speed)

  const payload = {
    model,
    messages: [
      { role: 'user', content: director },
      { role: 'assistant', content: text.slice(0, 2000) }
    ],
    audio: {
      format: 'mp3',
      voice
    }
  }

  const res = await fetchImpl(MIMO_API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload),
    signal
  })

  if (res.status === 401) {
    throw new Error('小米 MiMo API Key 无效（401）')
  }
  if (res.status === 429) {
    throw new Error('小米 MiMo 请求限流或超频（429）')
  }
  if (!res.ok) {
    throw new Error(`小米 MiMo TTS ${res.status}`)
  }

  interface MimoResponse {
    choices?: Array<{
      message?: {
        audio?: {
          data?: string
        }
      }
    }>
  }

  const data = (await res.json()) as MimoResponse
  const b64 = data?.choices?.[0]?.message?.audio?.data
  if (typeof b64 !== 'string' || !b64) {
    throw new Error('小米 MiMo TTS: 未能获取音频数据')
  }

  return `data:audio/mpeg;base64,${b64}`
}

export async function synthesizeOpenAiSpeech(
  text: string,
  tts: TtsSettings,
  fetchImpl: ProviderFetch,
  signal: AbortSignal
): Promise<string> {
  const endpoint = tts.endpoint.trim()
  if (!endpoint) throw new Error('TTS endpoint is not configured')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
  try {
    const url = new URL(endpoint)
    headers['Origin'] = url.origin
    headers['Referer'] = `${url.origin}/`
  } catch {
    // Custom/relative endpoints fall through with standard headers
  }

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers,
    // pitch must be a string per the edge-tts bridge protocol; speed is a number.
    body: JSON.stringify({
      input: text.slice(0, 2000),
      voice: tts.voice || 'zh-CN-XiaoxiaoNeural',
      speed: Math.min(2, Math.max(0.5, tts.speed || 1)),
      pitch: String(Math.round(tts.pitch || 0)),
      style: 'general'
    }),
    signal
  })
  if (!res.ok) throw new Error(`TTS ${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  if (!buffer.length) throw new Error('TTS: empty audio response')
  return `data:audio/mpeg;base64,${buffer.toString('base64')}`
}

/** Synthesize speech via configured TTS provider (OpenAI-compatible / Xiaomi MiMo)
 * and return an audio data URL the renderer can feed to an <audio> element.
 * Runs in the main process so it follows the app's proxy chain. */
export async function synthesizeSpeech(
  text: string,
  tts: TtsSettings,
  fetchImpl: ProviderFetch,
  signal: AbortSignal
): Promise<string> {
  if (!text.trim()) throw new Error('TTS: empty text')
  if (tts.service === 'mimo') {
    return synthesizeMimoSpeech(text, tts, fetchImpl, signal)
  }
  return synthesizeOpenAiSpeech(text, tts, fetchImpl, signal)
}
