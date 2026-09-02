import { randomUUID } from 'node:crypto'
import type { ProviderFetch } from '../ai/OpenAICompatibleClient'
import { yandexLanguageCode } from '@shared/translate'

const YD_URL = 'https://translate.yandex.net/api/v1/tr.json/translate'
const YD_UA = 'ru.yandex.translate/3.20.2024'

// The endpoint rejects requests without a ucid outright (HTTP 410); a random
// 32-hex id cached for a few minutes is enough.
let cachedUcid: { value: string; expiresAt: number } | null = null

function getUcid(): string {
  if (!cachedUcid || Date.now() >= cachedUcid.expiresAt) {
    cachedUcid = { value: randomUUID().replaceAll('-', ''), expiresAt: Date.now() + 360_000 }
  }
  return cachedUcid.value
}

export function resetUcidCache(): void {
  cachedUcid = null
}

export function parseYandexResponse(json: { code?: unknown; text?: unknown }): { text: string } {
  if (json?.code !== 200) throw new Error(`Yandex: business code ${String(json?.code)}`)
  const translated = Array.isArray(json.text) ? json.text[0] : undefined
  if (typeof translated !== 'string' || !translated) throw new Error('Yandex: empty translation')
  return { text: translated }
}

export async function translateYandex(
  text: string,
  from: string,
  to: string,
  fetchImpl: ProviderFetch,
  signal: AbortSignal
): Promise<{ text: string; detected?: string }> {
  // lang is "from-to"; the source part is omitted entirely for auto-detect.
  const source = yandexLanguageCode(from)
  const target = yandexLanguageCode(to)
  const lang = !source || source === 'auto' ? target : `${source}-${target}`
  const res = await fetchImpl(`${YD_URL}?ucid=${getUcid()}&srv=android&format=text`, {
    method: 'POST',
    headers: {
      'User-Agent': YD_UA,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ text, lang }),
    signal
  })
  if (res.status === 410) throw new Error('Yandex 410: ucid rejected')
  if (res.status === 413) throw new Error('Yandex: text exceeds the length limit (~10000 chars)')
  if (res.status === 429) throw new Error('Yandex 429: rate limited')
  if (!res.ok) throw new Error(`Yandex ${res.status}`)
  const parsed = parseYandexResponse((await res.json()) as { code?: unknown; text?: unknown })
  return parsed
}
