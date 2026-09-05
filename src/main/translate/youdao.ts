import { createHash } from 'node:crypto'
import type { ProviderFetch } from '../ai/OpenAICompatibleClient'
import type { DictEntry, DictMeaning, DictPhrase, DictPhonetic, DictSentence } from '@shared/types'

// Youdao Dict (dict.youdao.com) reverse-engineered jsonapi — ported from the
// standalone youdao-dict-api project (see its README, "Porting option C").
// Two upstreams by query language, same DictEntry result:
//  - English words: jsonapi POST (ec/simple/phrs/blng dicts), no signing.
//  - Chinese words: jsonapi_s POST with the webdict MD5 signature (ce dict =
//    pinyin + Chinese-English senses, web_trans = related terms, blng =
//    bilingual examples). #text is the English term, #tran the Chinese gloss.
// The media/auth sentence dicts and the "top phrases" page scrape are left
// out on purpose: no Chinese upstream and/or fragile HTML parsing.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
const JSONAPI = 'https://dict.youdao.com/jsonapi'
const ZH_JSONAPI = 'https://dict.youdao.com/jsonapi_s?doctype=json&jsonversion=4'
const SIGN_SALT = 'Mk6hqtUp33DGGtoS63tTJbMUYjRrG1Lu'

const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex')

/** CJK query → the Chinese-English path (ext-A + CJK + compatibility ideographs). */
export function isZhQuery(q: string): boolean {
  return /[㐀-䶿一-鿿豈-﫿]/.test(q)
}

/** Upstream voice URL — playable through the YoudaoAudio IPC proxy
 * (dict.youdao.com rejects direct hotlinking from other origins). */
export function youdaoVoiceUrl(word: string, type: 1 | 2): string {
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=${type}`
}

/** Raw upstream jsonapi payload — only the shapes we consume are typed. */
interface YoudaoJsonapi {
  meta?: { isHasSimpleDict?: string }
  simple?: { word?: Array<{ ukphone?: string; ukspeech?: string; usphone?: string; usspeech?: string; phone?: string }> }
  ec?: {
    word?: Array<{
      trs?: Array<{ tr?: Array<{ l?: { i?: unknown } }> }>
      wfs?: Array<{ wf?: { name?: string; value?: string } }>
    }>
  }
  phrs?: { phrs?: Array<{ phr?: { headword?: { l?: { i?: unknown } }; trs?: Array<{ tr?: { l?: { i?: unknown } } }> } }> }
  blng_sents_part?: {
    'sentence-pair'?: Array<{
      // EN path: sentence-eng carries markup; ZH path: `sentence` is the
      // Chinese sentence (with markup) and -speech its recorded voice.
      'sentence-eng'?: string
      sentence?: string
      'sentence-translation'?: string
      source?: string
      'sentence-speech'?: string
      'sentence-translation-speech'?: string
    }>
  }
  // Chinese (jsonapi_s): ce.word is an OBJECT (not an array like ec).
  ce?: {
    word?: {
      phone?: string
      trs?: Array<{ '#text'?: string; '#tran'?: string; voice?: string }>
    }
  }
  web_trans?: {
    'web-translation'?: Array<{ key?: string; trans?: Array<{ value?: string }> }>
  }
}

const asText = (i: unknown): string => (Array.isArray(i) ? i.map(String).join('') : typeof i === 'string' ? i : '')

const stripTags = (s: string | undefined | null): string => (s ? s.replace(/<[^>]+>/g, '') : '')

/** "n. 闪光；闪亮" → { pos: 'n.', meanings: ['闪光', '闪亮'] }. */
export function parseYoudaoSense(raw: string): { pos: string; meanings: string[] } {
  const m = raw.match(/^([a-z]+\.|【[^】]+】)\s*([\s\S]*)$/i)
  const pos = m ? m[1] : ''
  const body = (m ? m[2] : raw).trim()
  const meanings = body
    .split('；')
    .map((s) => s.trim())
    .filter(Boolean)
  return { pos, meanings }
}

/** Youdao form names → DictEntry exchange keys (same rows as the iciba card). */
const YOUDAO_FORM_KEYS: Record<string, keyof DictEntry['exchange']> = {
  复数: 'plurals',
  过去式: 'pastTense',
  过去分词: 'pastParticiple',
  现在分词: 'presentParticiple',
  第三人称单数: 'thirdPersonSingular',
  比较级: 'comparative',
  最高级: 'superlative'
}

export async function lookupYoudaoWord(
  word: string,
  fetchImpl: ProviderFetch,
  signal: AbortSignal
): Promise<DictEntry | null> {
  const q = word.trim()
  if (!q) return null
  return isZhQuery(q) ? lookupZh(q, fetchImpl, signal) : lookupEn(q, fetchImpl, signal)
}

// --- Chinese word path (jsonapi_s + webdict signature) ---

/** Signed body per the reference implementation: t is a length digit and
 * sign chains two md5 digests around the fixed salt. */
function zhRequestBody(q: string): URLSearchParams {
  const t = String((q + 'webdict').length % 10)
  const sign = md5('web' + q + t + SIGN_SALT + md5(q + 'webdict'))
  return new URLSearchParams({ q, le: 'en', t, client: 'web', sign, keyfrom: 'webdict' })
}

async function lookupZh(q: string, fetchImpl: ProviderFetch, signal: AbortSignal): Promise<DictEntry | null> {
  const res = await fetchImpl(ZH_JSONAPI, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Origin: 'https://dict.youdao.com',
      Referer: 'https://dict.youdao.com/',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: zhRequestBody(q),
    signal
  })
  if (!res.ok) throw new Error(`youdao dict ${res.status}`)
  const data = (await res.json()) as YoudaoJsonapi
  if (data.meta?.isHasSimpleDict === '0' || !data.ce) return null

  const ceWord = data.ce.word ?? {}
  const pinyin = ceWord.phone ?? data.simple?.word?.[0]?.phone

  const phonetics: DictPhonetic[] = pinyin
    ? [{ label: 'zh', phonetic: pinyin, audioUrl: `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(q)}&le=zh-CHS` }]
    : []

  // Each ce sense: #text is the English term, #tran the Chinese glosses.
  // Lead with the English translation (that is what a zh→en lookup wants)
  // and keep two glosses after it; the display cap trims the rest.
  const meanings: DictMeaning[] = []
  for (const t of ceWord.trs ?? []) {
    const en = (t['#text'] ?? '').trim()
    const zhParts = String(t['#tran'] ?? '')
      .split('；')
      .map((x) => x.trim())
      .filter(Boolean)
    const means = [...(en ? [en] : []), ...zhParts.slice(0, 2)]
    if (means.length) meanings.push({ partOfSpeech: '', means })
  }

  // web-translation[0] echoes the queried word — take the next three.
  const phrases: DictPhrase[] = (data.web_trans?.['web-translation'] ?? [])
    .slice(1, 4)
    .map((w) => ({
      en: w.key ?? '',
      zh: (w.trans ?? [])
        .map((x) => x.value)
        .filter(Boolean)
        .join('；')
    }))
    .filter((p) => p.en)

  // ZH examples: `sentence` is the Chinese sentence (with <b> markup),
  // sentence-translation the English one, -speech its recorded voice.
  const sentences: DictSentence[] = (data.blng_sents_part?.['sentence-pair'] ?? [])
    .map((pair) => {
      const zh = stripTags(pair.sentence)
      const en = pair['sentence-translation'] ?? ''
      if (!en || !zh) return null
      return {
        en,
        zh,
        ...(pair.source ? { source: stripTags(pair.source) } : {}),
        ...(pair['sentence-translation-speech']
          ? { audioUrl: `https://dict.youdao.com/dictvoice?audio=${pair['sentence-translation-speech']}` }
          : {})
      }
    })
    .filter((s): s is DictSentence => s !== null)
    .slice(0, 2)

  return {
    word: q,
    phonetics,
    meanings,
    exchange: {},
    ...(phrases.length ? { phrases } : {}),
    ...(sentences.length ? { sentences } : {})
  }
}

// --- English word path (jsonapi) ---

async function lookupEn(q: string, fetchImpl: ProviderFetch, signal: AbortSignal): Promise<DictEntry | null> {
  const res = await fetchImpl(JSONAPI, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: `https://dict.youdao.com/result?word=${encodeURIComponent(q)}&lang=en`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    // dicts: only what the card shows; count mirrors the reference project.
    body: new URLSearchParams({
      q,
      le: 'en',
      dicts: JSON.stringify({ count: 99, dicts: [['ec'], ['simple'], ['phrs'], ['blng_sents_part']] })
    }),
    signal
  })
  if (!res.ok) throw new Error(`youdao dict ${res.status}`)
  const data = (await res.json()) as YoudaoJsonapi
  if (data.meta?.isHasSimpleDict === '0' || !data.ec) return null

  const simpleWord = data.simple?.word?.[0] ?? {}
  const ecWord = data.ec.word?.[0] ?? {}

  const phonetics: DictPhonetic[] = []
  if (simpleWord.ukphone && simpleWord.ukspeech) {
    phonetics.push({ label: 'uk', phonetic: simpleWord.ukphone, audioUrl: youdaoVoiceUrl(q, 1) })
  }
  if (simpleWord.usphone && simpleWord.usspeech) {
    phonetics.push({ label: 'us', phonetic: simpleWord.usphone, audioUrl: youdaoVoiceUrl(q, 2) })
  }

  const meanings: DictMeaning[] = []
  for (const t of ecWord.trs ?? []) {
    const raw = asText(t.tr?.[0]?.l?.i)
    if (!raw.trim()) continue
    const { pos, meanings: means } = parseYoudaoSense(raw)
    if (means.length) meanings.push({ partOfSpeech: pos, means })
  }

  const exchange: DictEntry['exchange'] = {}
  for (const wf of ecWord.wfs ?? []) {
    if (!wf.wf?.name || !wf.wf.value) continue
    const key = YOUDAO_FORM_KEYS[wf.wf.name]
    if (!key) continue
    const list = exchange[key]
    if (list) list.push(wf.wf.value)
    else exchange[key] = [wf.wf.value]
  }

  const phrases: DictPhrase[] = (data.phrs?.phrs ?? []).slice(0, 3).map((p) => ({
    en: asText(p.phr?.headword?.l?.i),
    zh: (p.phr?.trs ?? []).map((t) => asText(t.tr?.l?.i)).join('；')
  })).filter((p) => p.en)

  // Two examples read as a real usage feel; more is a wall. sentence-speech
  // is the upstream voice clip param for the original recording.
  const sentences: DictSentence[] = (data.blng_sents_part?.['sentence-pair'] ?? [])
    .map((pair) => {
      const en = stripTags(pair['sentence-eng'])
      const zh = pair['sentence-translation'] ?? ''
      if (!en || !zh) return null
      return {
        en,
        zh,
        ...(pair.source ? { source: stripTags(pair.source) } : {}),
        ...(pair['sentence-speech']
          ? { audioUrl: `https://dict.youdao.com/dictvoice?audio=${pair['sentence-speech']}` }
          : {})
      }
    })
    .filter((s): s is DictSentence => s !== null)
    .slice(0, 2)

  return {
    word: q,
    phonetics,
    meanings,
    exchange,
    ...(phrases.length ? { phrases } : {}),
    ...(sentences.length ? { sentences } : {})
  }
}
