import { createHmac, randomUUID } from 'node:crypto'
import type { ProviderFetch } from '../ai/OpenAICompatibleClient'
import { microsoftLanguageCode } from '@shared/translate'

const EDGE_AUTH_URL = 'https://edge.microsoft.com/translate/auth'
const EDGE_API_URL = 'https://api-edge.cognitive.microsofttranslator.com/translate'
const LEGACY_API_URL = 'https://api.cognitive.microsofttranslator.com/translate'
const API_VERSION = '3.0'
const TOKEN_REFRESH_SKEW_MS = 60_000
const TOKEN_FALLBACK_TTL_MS = 5 * 60_000
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'

// Shared secret for the legacy Android-app signature flow (public knowledge,
// see STranslate / GTranslate).
const LEGACY_PRIVATE_KEY = Buffer.from([
  0xa2, 0x29, 0x3a, 0x3d, 0xd0, 0xdd, 0x32, 0x73, 0x97, 0x7a, 0x64, 0xdb, 0xc2, 0xf3, 0x27, 0xf5, 0xd7, 0xbf, 0x87,
  0xd9, 0x45, 0x9d, 0xf0, 0x5a, 0x09, 0x66, 0xc6, 0x30, 0xc6, 0x6a, 0xaa, 0x84, 0x9a, 0x41, 0xaa, 0x94, 0x3a, 0xa8,
  0xd5, 0x1a, 0x6e, 0x4d, 0xaa, 0xc9, 0xa3, 0x70, 0x12, 0x35, 0xc7, 0xeb, 0x12, 0xf6, 0xe8, 0x23, 0x07, 0x9e, 0x47,
  0x10, 0x95, 0x91, 0x88, 0x55, 0xd8, 0x17
])

let cachedToken: string | null = null
let cachedTokenExpiresAt = 0
let tokenFetch: Promise<string> | null = null
// When the edge auth host is unreachable (404 through some proxies), skip it
// for a while instead of paying the failed round-trip on every translation.
let edgeAuthFailedUntil = 0
const EDGE_AUTH_BACKOFF_MS = 10 * 60_000

function parseJwtExpiresAt(token: string): number {
  try {
    const payload = token.split('.')[1]
    if (!payload) return 0
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return typeof json.exp === 'number' ? json.exp * 1000 : 0
  } catch {
    return 0
  }
}

// The Edge auth endpoint hands out a free JWT for the edge translator API —
// no key. Cached and refreshed ~1 min before expiry so mid-flight requests
// stay valid.
async function getEdgeToken(fetchImpl: ProviderFetch, signal: AbortSignal | undefined): Promise<string> {
  if (Date.now() < edgeAuthFailedUntil) throw new Error('Microsoft edge auth skipped (recently failed)')
  if (cachedToken && Date.now() < cachedTokenExpiresAt - TOKEN_REFRESH_SKEW_MS) return cachedToken
  if (!tokenFetch) {
    tokenFetch = (async () => {
      const res = await fetchImpl(EDGE_AUTH_URL, { headers: { 'User-Agent': UA }, signal })
      if (!res.ok) throw new Error(`Microsoft auth ${res.status}`)
      const token = (await res.text()).trim().replace(/^"|"$/g, '')
      if (!token) throw new Error('Microsoft auth returned an empty token')
      cachedToken = token
      cachedTokenExpiresAt = parseJwtExpiresAt(token) || Date.now() + TOKEN_FALLBACK_TTL_MS
      return token
    })()
    try {
      return await tokenFetch
    } catch (error) {
      edgeAuthFailedUntil = Date.now() + EDGE_AUTH_BACKOFF_MS
      throw error
    } finally {
      tokenFetch = null
    }
  }
  return tokenFetch
}

const MS_DATE_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MS_DATE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** RFC1123-style UTC timestamp the signature flow expects, e.g.
 * "Sat, 30 Aug 2026 14:23:45GMT" (literal GMT suffix, no space). */
export function microsoftSignatureDate(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${MS_DATE_DAYS[now.getUTCDay()]}, ${pad(now.getUTCDate())} ${MS_DATE_MONTHS[now.getUTCMonth()]} ` +
    `${now.getUTCFullYear()} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}GMT`
  )
}

/** X-MT-Signature for the legacy api.cognitive.microsofttranslator.com flow. */
export function microsoftLegacySignature(url: string, now: Date, guid: string): string {
  const escapedUrl = encodeURIComponent(url)
  const dateTime = microsoftSignatureDate(now)
  const digest = createHmac('sha256', LEGACY_PRIVATE_KEY)
    .update(`MSTranslatorAndroidApp${escapedUrl}${dateTime}${guid}`.toLowerCase(), 'utf8')
    .digest('base64')
  return `MSTranslatorAndroidApp::${digest}::${dateTime}::${guid}`
}

function buildRequestUrl(base: string, source: string, target: string): string {
  let url = `${base}?api-version=${API_VERSION}&to=${encodeURIComponent(target)}`
  if (source && source !== 'auto') url += `&from=${encodeURIComponent(source)}`
  return url
}

async function callTranslateApi(
  url: string,
  headers: Record<string, string>,
  body: string,
  fetchImpl: ProviderFetch,
  signal: AbortSignal
): Promise<{ text: string; detected?: string }> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, ...headers },
    body,
    signal
  })
  if (!res.ok) throw new Error(`Microsoft ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = (await res.json()) as Array<{
    detectedLanguage?: { language?: string }
    translations?: Array<{ text?: string }>
  }>
  const first = json?.[0]
  const translated = first?.translations?.[0]?.text
  if (typeof translated !== 'string') throw new Error('Microsoft: no translation in response')
  return { text: translated, detected: first?.detectedLanguage?.language }
}

export interface MicrosoftTranslateResult {
  text: string
  /** BCP-47-ish code reported by the service when source was auto ('en', 'zh-Hans'…). */
  detected?: string
}

export async function translateMicrosoft(
  text: string,
  from: string,
  to: string,
  fetchImpl: ProviderFetch,
  signal: AbortSignal
): Promise<MicrosoftTranslateResult> {
  const source = microsoftLanguageCode(from)
  const target = microsoftLanguageCode(to)
  const body = JSON.stringify([{ Text: text }])

  // Primary: legacy HMAC signature — self-contained (no auth round-trip) and
  // the mode that works on networks where the edge auth host 404s. Fallback:
  // Edge Bearer token, with a backoff after auth failures.
  let legacyError: unknown = null
  try {
    const requestUrl = buildRequestUrl(LEGACY_API_URL, source, target)
    // The signature covers the request path WITHOUT the scheme — that is what
    // the Android-app flow signs (see STranslate / GTranslate).
    const signature = microsoftLegacySignature(
      requestUrl.replace(/^https:\/\//, ''),
      new Date(),
      randomUUID().replaceAll('-', '')
    )
    return await callTranslateApi(requestUrl, { 'X-MT-Signature': signature }, body, fetchImpl, signal)
  } catch (error) {
    if (signal.aborted) throw error
    legacyError = error
  }
  try {
    const token = await getEdgeToken(fetchImpl, signal)
    return await callTranslateApi(
      buildRequestUrl(EDGE_API_URL, source, target),
      { Authorization: `Bearer ${token}` },
      body,
      fetchImpl,
      signal
    )
  } catch (error) {
    if (signal.aborted) throw error
    const edgeMessage = error instanceof Error ? error.message : String(error)
    const legacyMessage = legacyError instanceof Error ? legacyError.message : String(legacyError)
    throw new Error(`Microsoft: ${legacyMessage} · edge fallback: ${edgeMessage}`)
  }
}
