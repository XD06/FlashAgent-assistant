import type { ProviderFetch } from '../ai/OpenAICompatibleClient'
import type { DictEntry, DictMeaning, DictPhrase, DictPhonetic, DictSentence } from '@shared/types'

// Youdao Dict (dict.youdao.com) reverse-engineered jsonapi — ported from the
// standalone youdao-dict-api project (see its README, "Porting option C").
// Zero dependencies: one POST with a dicts payload, tolerant field access.
// The media/auth sentence dicts and the "top phrases" page scrape are left
// out on purpose: no Chinese upstream and/or fragile HTML parsing, while the
// kept blocks cover the lookup card (definitions, forms, phrases, example).

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
const JSONAPI = 'https://dict.youdao.com/jsonapi'

/** Upstream voice URL — playable through the YoudaoAudio IPC proxy
 * (dict.youdao.com rejects direct hotlinking from other origins). */
export function youdaoVoiceUrl(word: string, type: 1 | 2): string {
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=${type}`
}

/** Raw upstream jsonapi payload — only the shapes we consume are typed. */
interface YoudaoJsonapi {
  meta?: { isHasSimpleDict?: string }
  simple?: { word?: Array<{ ukphone?: string; ukspeech?: string; usphone?: string; usspeech?: string }> }
  ec?: {
    word?: Array<{
      trs?: Array<{ tr?: Array<{ l?: { i?: unknown } }> }>
      wfs?: Array<{ wf?: { name?: string; value?: string } }>
    }>
  }
  phrs?: { phrs?: Array<{ phr?: { headword?: { l?: { i?: unknown } }; trs?: Array<{ tr?: { l?: { i?: unknown } } }> } }> }
  blng_sents_part?: { 'sentence-pair'?: Array<{ 'sentence-eng'?: string; 'sentence-translation'?: string; source?: string; 'sentence-speech'?: string }> }
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

export async function lookupYoudaoWord(
  word: string,
  fetchImpl: ProviderFetch,
  signal: AbortSignal
): Promise<DictEntry | null> {
  const q = word.trim()
  if (!q) return null
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
