import type { ProviderFetch } from '../ai/OpenAICompatibleClient'
import { deeplxLanguageCode } from '@shared/translate'

/** DeepLX-compatible endpoint (LibreTranslate format): POST {base}/v1/translate
 * with { q, source, target } → { translatedText }. */
export async function translateDeeplx(
  text: string,
  from: string,
  to: string,
  endpoint: string,
  fetchImpl: ProviderFetch,
  signal: AbortSignal
): Promise<string> {
  const base = endpoint.trim().replace(/\/+$/, '')
  if (!base) throw new Error('DeepLX endpoint is not configured')
  const res = await fetchImpl(`${base}/v1/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, source: deeplxLanguageCode(from) || 'auto', target: deeplxLanguageCode(to) }),
    signal
  })
  if (!res.ok) {
    // 5xx from a DeepLX instance usually means its upstream (DeepL) is down —
    // the worker itself is alive but cannot translate right now.
    const hint = res.status >= 500 ? ' — service unavailable (upstream down?), retry later or change the endpoint' : ''
    throw new Error(`DeepLX ${res.status}${hint}`)
  }
  const json = (await res.json()) as { translatedText?: unknown; error?: unknown }
  if (typeof json.translatedText !== 'string') {
    throw new Error(typeof json.error === 'string' ? json.error : 'DeepLX: no translatedText in response')
  }
  return json.translatedText
}
