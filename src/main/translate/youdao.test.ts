import { describe, expect, it } from 'vitest'
import { isZhQuery, lookupYoudaoWord, parseYoudaoSense } from './youdao'
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

describe('isZhQuery', () => {
  it('detects CJK input and leaves Latin alone', () => {
    expect(isZhQuery('公司')).toBe(true)
    expect(isZhQuery('参考')).toBe(true)
    expect(isZhQuery('flash')).toBe(false)
    expect(isZhQuery('  ')).toBe(false)
  })
})

describe('lookupYoudaoWord (Chinese)', () => {
  // Fixture mirrors the real jsonapi_s response for "公司" (trimmed).
  const ZH_PAYLOAD = {
    meta: { isHasSimpleDict: '1' },
    simple: { word: [{ phone: 'gōng sī' }] },
    ce: {
      word: {
        trs: [
          { '#text': 'company', '#tran': '公司；陪伴，同伴；宾客，来宾', voice: 'company&type=2' },
          { '#text': 'corporation', '#tran': '社团，公司，法人（团体）；市政当局' },
          { '#text': 'firm', '#tran': '公司，商行' }
        ]
      }
    },
    web_trans: {
      'web-translation': [
        { key: '公司', trans: [{ value: 'COMPANY' }] },
        { key: '英国广播公司', trans: [{ value: 'BBC' }, { value: 'British Broadcasting Corporation' }] },
        { key: '公司法', trans: [{ value: 'the Company Law' }] },
        { key: '跨国公司', trans: [{ value: 'multinational corporation' }] }
      ]
    },
    blng_sents_part: {
      'sentence-pair': [
        {
          sentence: '公司是由三家小<b>公司</b>合并组成的。',
          'sentence-translation': 'The company was formed by merging three smaller firms.',
          source: '《牛津词典》',
          'sentence-translation-speech': 'The+company+was+formed'
        },
        { sentence: '这家<b>公司</b>倒闭了。', 'sentence-translation': 'The firm has gone bankrupt.' }
      ]
    }
  }

  it('maps the ce dict into the shared card shape', async () => {
    const entry = await lookupYoudaoWord('公司', fetchJson(ZH_PAYLOAD), AbortSignal.timeout(1000))
    expect(entry).not.toBeNull()
    expect(entry!.word).toBe('公司')
    expect(entry!.phonetics).toEqual([
      {
        label: 'zh',
        phonetic: 'gōng sī',
        audioUrl: 'https://dict.youdao.com/dictvoice?audio=%E5%85%AC%E5%8F%B8&le=zh-CHS'
      }
    ])
    // English term first, up to two Chinese glosses after it.
    expect(entry!.meanings).toEqual([
      { partOfSpeech: '', means: ['company', '公司', '陪伴，同伴'] },
      { partOfSpeech: '', means: ['corporation', '社团，公司，法人（团体）', '市政当局'] },
      { partOfSpeech: '', means: ['firm', '公司，商行'] }
    ])
    expect(entry!.exchange).toEqual({})
    // web-translation[0] echoes the query — entries start at [1].
    expect(entry!.phrases).toEqual([
      { en: '英国广播公司', zh: 'BBC；British Broadcasting Corporation' },
      { en: '公司法', zh: 'the Company Law' },
      { en: '跨国公司', zh: 'multinational corporation' }
    ])
    // Markup stripped; original voice wired from -speech.
    expect(entry!.sentences).toEqual([
      {
        en: 'The company was formed by merging three smaller firms.',
        zh: '公司是由三家小公司合并组成的。',
        source: '《牛津词典》',
        audioUrl: 'https://dict.youdao.com/dictvoice?audio=The+company+was+formed'
      },
      { en: 'The firm has gone bankrupt.', zh: '这家公司倒闭了。' }
    ])
  })

  it('returns null for unknown Chinese words (no ce dict)', async () => {
    const entry = await lookupYoudaoWord(
      '龘鱻麤',
      fetchJson({ meta: { isHasSimpleDict: '1' } }),
      AbortSignal.timeout(1000)
    )
    expect(entry).toBeNull()
  })
})
