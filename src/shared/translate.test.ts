import { describe, expect, it } from 'vitest'
import {
  deeplxLanguageCode,
  detectLanguageHeuristic,
  getAutoTargetLanguage,
  icibaLanguageCode,
  isSingleWord,
  microsoftLanguageCode,
  tencentLanguageCode,
  translateLanguageLabel,
  yandexLanguageCode
} from './translate'

describe('isSingleWord', () => {
  it('accepts single words in any script', () => {
    expect(isSingleWord('setting')).toBe(true)
    expect(isSingleWord("don't")).toBe(true)
    expect(isSingleWord('设置')).toBe(true)
    expect(isSingleWord('  hello  ')).toBe(true)
  })

  it('rejects phrases, long text, and letterless input', () => {
    expect(isSingleWord('hello world')).toBe(false)
    expect(isSingleWord('a'.repeat(41))).toBe(false)
    expect(isSingleWord('12345')).toBe(false)
    expect(isSingleWord('')).toBe(false)
  })
})

describe('detectLanguageHeuristic', () => {
  it('detects major scripts', () => {
    expect(detectLanguageHeuristic('你好，世界')).toBe('zh')
    expect(detectLanguageHeuristic('こんにちは')).toBe('ja')
    expect(detectLanguageHeuristic('안녕하세요')).toBe('ko')
    expect(detectLanguageHeuristic('Привет')).toBe('ru')
    expect(detectLanguageHeuristic('hello world')).toBe('en')
  })

  it('prefers kana over han for japanese', () => {
    expect(detectLanguageHeuristic('漢字のテスト')).toBe('ja')
  })
})

describe('service code mapping', () => {
  it('maps traditional chinese per service', () => {
    expect(microsoftLanguageCode('zh')).toBe('zh-Hans')
    expect(microsoftLanguageCode('zh-tw')).toBe('zh-Hant')
    expect(icibaLanguageCode('zh-tw')).toBe('cht')
    expect(deeplxLanguageCode('zh-tw')).toBe('ZH')
    expect(deeplxLanguageCode('ja')).toBe('JA')
  })

  it('degrades traditional chinese for tencent and yandex', () => {
    expect(tencentLanguageCode('zh-tw')).toBe('zh')
    expect(yandexLanguageCode('zh-tw')).toBe('zh')
    expect(tencentLanguageCode('ja')).toBe('ja')
    expect(yandexLanguageCode('en')).toBe('en')
  })

  it('passes common codes through unchanged', () => {
    expect(microsoftLanguageCode('en')).toBe('en')
    expect(icibaLanguageCode('en')).toBe('en')
    expect(icibaLanguageCode('zh')).toBe('zh')
  })
})

describe('translateLanguageLabel', () => {
  it('falls back to the raw code', () => {
    expect(translateLanguageLabel('zh')).toBe('中文（简体）')
    expect(translateLanguageLabel('xx')).toBe('xx')
  })
})

describe('getAutoTargetLanguage', () => {
  it('switches target to en when input is Chinese and target is Chinese', () => {
    expect(getAutoTargetLanguage('如果我想让它移动呢？', 'auto', 'zh')).toBe('en')
    expect(getAutoTargetLanguage('你好世界', 'auto', 'zh-tw')).toBe('en')
  })

  it('preserves target as en when input is Chinese and target is already en', () => {
    expect(getAutoTargetLanguage('如果我想让它移动呢？', 'auto', 'en')).toBe('en')
  })

  it('switches target to zh when input is English and target is en', () => {
    expect(getAutoTargetLanguage('What if I want it to move?', 'auto', 'en')).toBe('zh')
    expect(getAutoTargetLanguage('hello world', 'auto', 'en')).toBe('zh')
  })

  it('preserves target as zh when input is English and target is already zh', () => {
    expect(getAutoTargetLanguage('What if I want it to move?', 'auto', 'zh')).toBe('zh')
  })

  it('preserves explicit foreign targets unless matching the input language', () => {
    expect(getAutoTargetLanguage('如果我想让它移动呢？', 'auto', 'ja')).toBe('ja')
    expect(getAutoTargetLanguage('hello world', 'auto', 'ja')).toBe('ja')
    expect(getAutoTargetLanguage('こんにちは', 'auto', 'ja')).toBe('zh')
  })

  it('does nothing when input is empty or source is not auto', () => {
    expect(getAutoTargetLanguage('', 'auto', 'zh')).toBe('zh')
    expect(getAutoTargetLanguage('   ', 'auto', 'zh')).toBe('zh')
    expect(getAutoTargetLanguage('你好', 'zh', 'zh')).toBe('zh')
  })
})

