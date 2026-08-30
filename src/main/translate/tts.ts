import type { ProviderFetch } from '../ai/OpenAICompatibleClient'
import type { TtsSettings } from '@shared/types'

/** Synthesize speech via an OpenAI-compatible /v1/audio/speech endpoint and
 * return an audio data URL the renderer can feed to an <audio> element.
 * Runs in the main process so it follows the app's proxy chain. */
export async function synthesizeSpeech(
  text: string,
  tts: TtsSettings,
  fetchImpl: ProviderFetch,
  signal: AbortSignal
): Promise<string> {
  const endpoint = tts.endpoint.trim()
  if (!endpoint) throw new Error('TTS endpoint is not configured')
  if (!text.trim()) throw new Error('TTS: empty text')
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
