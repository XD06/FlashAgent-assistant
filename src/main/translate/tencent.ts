import type { ProviderFetch } from '../ai/OpenAICompatibleClient'
import { tencentLanguageCode } from '@shared/translate'

const TM_URL = 'https://transmart.qq.com/api/imt'

/**
 * Shared hardcoded client_key, validated server-side (from the 2023 web
 * client, still active — see PORTING_GUIDE_TS_YANDEX_TRANSMART.md §4.3).
 * Server rotations take every user of this key down at once, so it is
 * overridable via settings (translate.tencentClientKey) without a rebuild.
 */
export const DEFAULT_TM_CLIENT_KEY =
  'browser-chrome-110.0.0-Mac OS-df4bd4c5-a65d-44b2-a40f-42f34f3535f2-1677486696487'

interface TmResponse {
  header?: { ret_code?: string }
  auto_translation?: unknown
  src_lang?: unknown
}

/** Map the ret_code to a readable error; HTTP is always 200 here. */
export function tencentError(retCode: string): string {
  switch (retCode) {
    case 'Auth-Failed':
    case 'reject':
      return `Tencent auth failed (${retCode}) — the shared client_key may have been rotated; set a new one in settings`
    case 'outOfLimit':
      return 'Tencent: text exceeds the length limit (~6500 chars)'
    case 'Unsupported-Language':
    case 'error':
      return `Tencent: unsupported language pair`
    default:
      return `Tencent: unexpected ret_code ${retCode}`
  }
}

export function parseTencentResponse(json: TmResponse): { text: string; detected?: string } {
  const ret = json?.header?.ret_code
  if (ret !== 'succ') throw new Error(tencentError(ret ?? '(missing)'))
  const translated = json.auto_translation
  if (typeof translated !== 'string' || !translated) throw new Error('Tencent: empty translation')
  return {
    text: translated,
    detected: typeof json.src_lang === 'string' && json.src_lang ? json.src_lang : undefined
  }
}

export async function translateTencent(
  text: string,
  from: string,
  to: string,
  clientKey: string,
  fetchImpl: ProviderFetch,
  signal: AbortSignal
): Promise<{ text: string; detected?: string }> {
  const res = await fetchImpl(TM_URL, {
    method: 'POST',
    // Only Content-Type: the endpoint's CORS/preflight allows nothing else,
    // and extra headers can break the request through some proxies.
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      header: { fn: 'auto_translation_block', client_key: clientKey.trim() || DEFAULT_TM_CLIENT_KEY },
      type: 'plain',
      model_category: 'normal',
      source: { lang: tencentLanguageCode(from), text_block: text },
      target: { lang: tencentLanguageCode(to) }
    }),
    signal
  })
  if (!res.ok) throw new Error(`Tencent ${res.status}`)
  return parseTencentResponse((await res.json()) as TmResponse)
}
