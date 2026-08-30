import { createHash } from 'node:crypto'
import type { ProviderFetch } from '../ai/OpenAICompatibleClient'
import { icibaLanguageCode } from '@shared/translate'
import type { DictEntry, DictMeaning, DictPhonetic } from '@shared/types'

// Kingsoft iciba endpoints are reverse-engineered web APIs (no official SLA):
// they require the fixed salt signature plus Origin/Referer/UA headers, or
// the request is rejected.
const SALT = '7ece94d9f9c202b0d2ec557dg4r9bc'
const CLIENT = '6'
const KEY = '1000006'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'

function buildSignature(timestamp: string, path: string): string {
  // Parameter names are signed in ordinal order: client, key, timestamp.
  return createHash('md5').update(`${path}${CLIENT}${KEY}${timestamp}${SALT}`, 'utf8').digest('hex')
}

export interface IcibaTranslateResult {
  text: string
  /** Source language reported by the service when translating from auto. */
  detected?: string
}

export async function translateIciba(
  text: string,
  from: string,
  to: string,
  fetchImpl: ProviderFetch,
  signal: AbortSignal
): Promise<IcibaTranslateResult> {
  const timestamp = Date.now().toString()
  const path = '/dictionary/fy/batch'
  const signature = buildSignature(timestamp, path)
  const params = new URLSearchParams({ client: CLIENT, key: KEY, timestamp, signature })
  const res = await fetchImpl(`https://dictionary.iciba.com${path}?${params}`, {
    method: 'POST',
    headers: {
      Origin: 'https://www.iciba.com',
      Referer: 'https://www.iciba.com/',
      'User-Agent': UA,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: icibaLanguageCode(from), to: icibaLanguageCode(to), textList: [text] }),
    signal
  })
  if (!res.ok) throw new Error(`iciba ${res.status}`)
  const json = (await res.json()) as { code?: number | string; data?: unknown }
  if (!['1', 1].includes(json.code as string | number) || !Array.isArray(json.data)) {
    throw new Error('iciba: unexpected response')
  }
  const lines: string[] = []
  let detected: string | undefined
  for (const item of json.data) {
    if (typeof item === 'string') {
      lines.push(item)
      continue
    }
    if (item && typeof item === 'object') {
      const record = item as { out?: unknown; from?: unknown }
      if (typeof record.out === 'string') lines.push(record.out)
      if (!detected && typeof record.from === 'string' && record.from) detected = record.from
    }
  }
  if (!lines.length) throw new Error('iciba: empty result')
  return { text: lines.join('\n'), detected }
}

// --- Dictionary (word page scrape) -----------------------------------------

interface IcibaBaseInfo {
  word_name?: string
  symbols?: Array<{
    ph_en?: string
    ph_en_mp3?: string
    ph_am?: string
    ph_am_mp3?: string
    word_symbol?: string
    symbol_mp3?: string
    parts?: Array<{ part?: string; means?: unknown }>
  }>
  exchange?: Record<string, unknown>
}

const NEXT_DATA_TAG = '<script id="__NEXT_DATA__" type="application/json">'

function extractNextDataJson(html: string): string | null {
  const trimmed = html.trimStart()
  if (trimmed.startsWith('{')) return trimmed
  const start = html.indexOf(NEXT_DATA_TAG)
  if (start < 0) return null
  const from = start + NEXT_DATA_TAG.length
  const end = html.indexOf('</script>', from)
  return end > from ? html.slice(from, end) : null
}

// The payload nests baesInfo (sic) at varying depths across deployments —
// walk tolerantly instead of hardcoding a path.
function findBaseInfo(el: unknown): IcibaBaseInfo | null {
  if (el && typeof el === 'object') {
    if (!Array.isArray(el)) {
      const record = el as Record<string, unknown>
      if (record.baesInfo) return record.baesInfo as IcibaBaseInfo
      if (record.word_name || record.symbols) return record as IcibaBaseInfo
      for (const value of Object.values(record)) {
        const found = findBaseInfo(value)
        if (found) return found
      }
    } else {
      for (const value of el) {
        const found = findBaseInfo(value)
        if (found) return found
      }
    }
  }
  return null
}

function collectExchangeWords(el: unknown): string[] {
  const out: string[] = []
  const walk = (x: unknown): void => {
    if (typeof x === 'string') {
      if (x.trim()) out.push(x)
    } else if (Array.isArray(x)) x.forEach(walk)
    else if (x && typeof x === 'object') Object.values(x).forEach(walk)
  }
  walk(el)
  return out
}

// Guard against being redirected to a default page: the returned word (or one
// of its inflected forms) must match what we asked for.
function isExpectedWord(baseInfo: IcibaBaseInfo, word: string): boolean {
  if (!baseInfo.word_name) return false
  if (String(baseInfo.word_name).toLowerCase() === word.toLowerCase()) return true
  return collectExchangeWords(baseInfo.exchange).some((form) => form.toLowerCase() === word.toLowerCase())
}

function extractMeans(means: unknown): string[] {
  const out: string[] = []
  for (const m of Array.isArray(means) ? means : []) {
    if (typeof m === 'string') out.push(m)
    else if (m && typeof m === 'object' && (m as { word_mean?: unknown }).word_mean !== undefined) {
      out.push(String((m as { word_mean: unknown }).word_mean))
    }
  }
  return out
}

const EXCHANGE_KEYS: Array<[string, keyof DictEntry['exchange']]> = [
  ['word_pl', 'plurals'],
  ['word_past', 'pastTense'],
  ['word_done', 'pastParticiple'],
  ['word_ing', 'presentParticiple'],
  ['word_third', 'thirdPersonSingular'],
  ['word_er', 'comparative'],
  ['word_est', 'superlative']
]

export async function lookupIcibaWord(
  word: string,
  fetchImpl: ProviderFetch,
  signal: AbortSignal
): Promise<DictEntry | null> {
  const normalized = word.trim().replace(/\u2019/g, "'")
  const res = await fetchImpl(`https://www.iciba.com/word?w=${encodeURIComponent(normalized.toLowerCase())}`, {
    headers: { Referer: 'https://www.iciba.com/', 'User-Agent': UA },
    signal
  })
  if (!res.ok) throw new Error(`iciba dict ${res.status}`)
  const nextData = extractNextDataJson(await res.text())
  if (!nextData) return null
  const baseInfo = findBaseInfo(JSON.parse(nextData))
  if (!baseInfo || !isExpectedWord(baseInfo, normalized)) return null

  const entry: DictEntry = { word: String(baseInfo.word_name ?? normalized), phonetics: [], meanings: [], exchange: {} }
  const symbol = baseInfo.symbols?.[0]
  if (symbol) {
    const phonetics: DictPhonetic[] = []
    if (symbol.ph_en) phonetics.push({ label: 'uk', phonetic: symbol.ph_en, audioUrl: symbol.ph_en_mp3 ?? '' })
    if (symbol.ph_am) phonetics.push({ label: 'us', phonetic: symbol.ph_am, audioUrl: symbol.ph_am_mp3 ?? '' })
    if (!symbol.ph_en && !symbol.ph_am && symbol.word_symbol) {
      phonetics.push({ label: 'zh', phonetic: symbol.word_symbol, audioUrl: symbol.symbol_mp3 ?? '' })
    }
    entry.phonetics = phonetics
    for (const part of symbol.parts ?? []) {
      const means = extractMeans(part.means)
      if (means.length) {
        const meaning: DictMeaning = { partOfSpeech: part.part ?? '', means }
        entry.meanings.push(meaning)
      }
    }
  }
  const exchange = baseInfo.exchange ?? {}
  for (const [src, dest] of EXCHANGE_KEYS) {
    const value = exchange[src]
    if (value === undefined) continue
    entry.exchange[dest] = Array.isArray(value) ? value.map(String) : [String(value)]
  }
  return entry
}
