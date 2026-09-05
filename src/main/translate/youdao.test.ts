import { describe, expect, it } from 'vitest'
import { lookupYoudaoWord, parseYoudaoSense } from './youdao'
import type { ProviderFetch } from '../ai/OpenAICompatibleClient'

// Fixture mirrors the real dict.youdao.com/jsonapi response shape for
// "flash" (fields trimmed to what the service consumes).
const FLASH_PAYLOAD = {
  meta: { isHasSimpleDict: '1' },
  simple: {
    word: [{ ukphone: 'flæʃ', ukspeech: 'flæʃ', usphone: 'flæʃ', usspeech: 'flæʃ' }]
  },
  ec: {
    word: [
      {
        trs: [
          { tr: [{ l: { i: ['v.', '闪光，闪亮；（快速）出示，显示；飞驰，掠过'] } }] },
          { tr: [{ l: { i: ['n.', '闪光；闪光灯'] } }] }
        ],
        wfs: [
          { wf: { name: '复数', value: 'flashes' } },
          { wf: { name: '第三人称单数', value: 'flashes' } },
          { wf: { name: '现在分词', value: 'flashing' } },
          { wf: { name: '过去式', value: 'flashed' } },
          { wf: { name: '未知词形', value: 'ignored' } }
        ]
      }
    ]
  },
  phrs: {
    phrs: [
      { phr: { headword: { l: { i: 'in a flash' } }, trs: [{ tr: { l: { i: '瞬间；立刻' } } }] } },
      { phr: { headword: { l: { i: 'flash memory' } }, trs: [{ tr: { l: { i: '闪速存储器' } } }] } },
      { phr: { headword: { l: { i: 'flash point' } }, trs: [{ tr: { l: { i: '闪点；燃点' } } }] } },
      { phr: { headword: { l: { i: 'fourth — dropped' } }, trs: [] } }
    ]
  },
  blng_sents_part: {
    'sentence-pair': [
      {
        'sentence-eng': "I'll need <b>flash</b> for this shot.",
        'sentence-translation': '拍这个镜头我需要闪光灯。',
        source: '《牛津词典》',
        'sentence-speech': "I'll%20need%20flash"
      },
      {
        'sentence-eng': 'The <b>flash</b> of a torch gave us light.',
        'sentence-translation': '手电筒的光给我们照亮了。',
        source: '',
        'sentence-speech': ''
      },
      {
        'sentence-eng': 'third pair — dropped for lacking zh',
        'sentence-translation': ''
      }
    ]
  }
}

function fetchJson(payload: unknown): ProviderFetch {
  return (async () =>
    new Response(JSON.stringify(payload), { status: 200 })) as unknown as ProviderFetch
}

describe('parseYoudaoSense', () => {
  it('splits the pos prefix and ；-separated meanings', () => {
    expect(parseYoudaoSense('v. 闪光，闪亮；飞驰')).toEqual({
      pos: 'v.',
      meanings: ['闪光，闪亮', '飞驰']
    })
  })

  it('handles bracketed pos and missing pos', () => {
    expect(parseYoudaoSense('【名】闪光').pos).toBe('【名】')
    expect(parseYoudaoSense('闪光')).toEqual({ pos: '', meanings: ['闪光'] })
  })
})

describe('lookupYoudaoWord', () => {
  it('maps the jsonapi payload into a DictEntry', async () => {
    const entry = await lookupYoudaoWord('flash', fetchJson(FLASH_PAYLOAD), AbortSignal.timeout(1000))
    expect(entry).not.toBeNull()
    expect(entry!.word).toBe('flash')
    expect(entry!.phonetics).toEqual([
      { label: 'uk', phonetic: 'flæʃ', audioUrl: 'https://dict.youdao.com/dictvoice?audio=flash&type=1' },
      { label: 'us', phonetic: 'flæʃ', audioUrl: 'https://dict.youdao.com/dictvoice?audio=flash&type=2' }
    ])
    expect(entry!.meanings).toEqual([
      { partOfSpeech: 'v.', means: ['闪光，闪亮', '（快速）出示，显示', '飞驰，掠过'] },
      { partOfSpeech: 'n.', means: ['闪光', '闪光灯'] }
    ])
    expect(entry!.exchange).toEqual({
      plurals: ['flashes'],
      thirdPersonSingular: ['flashes'],
      presentParticiple: ['flashing'],
      pastTense: ['flashed']
    })
    // Only the first three phrases make the card.
    expect(entry!.phrases).toHaveLength(3)
    expect(entry!.phrases![0]).toEqual({ en: 'in a flash', zh: '瞬间；立刻' })
    // Two examples; markup stripped; original voice wired when provided.
    expect(entry!.sentences).toEqual([
      {
        en: "I'll need flash for this shot.",
        zh: '拍这个镜头我需要闪光灯。',
        source: '《牛津词典》',
        audioUrl: "https://dict.youdao.com/dictvoice?audio=I'll%20need%20flash"
      },
      {
        en: 'The flash of a torch gave us light.',
        zh: '手电筒的光给我们照亮了。'
      }
    ])
  })

  it('returns null for unknown words (no ec dict)', async () => {
    const entry = await lookupYoudaoWord(
      'asdfghjkl',
      fetchJson({ meta: { isHasSimpleDict: '1' } }),
      AbortSignal.timeout(1000)
    )
    expect(entry).toBeNull()
  })

  it('returns null for words without the simple dict either', async () => {
    const entry = await lookupYoudaoWord(
      'x',
      fetchJson({ meta: { isHasSimpleDict: '0' } }),
      AbortSignal.timeout(1000)
    )
    expect(entry).toBeNull()
  })

  it('omits empty phrases and sentence blocks instead of shipping empties', async () => {
    const entry = await lookupYoudaoWord(
      'tiny',
      fetchJson({
        meta: { isHasSimpleDict: '1' },
        simple: { word: [{ ukphone: 't', ukspeech: 't' }] },
        ec: { word: [{ trs: [{ tr: [{ l: { i: 'n. 极小' } }] }] }] }
      }),
      AbortSignal.timeout(1000)
    )
    expect(entry).not.toBeNull()
    expect(entry!.phrases).toBeUndefined()
    expect(entry!.sentences).toBeUndefined()
  })
})
