import { describe, expect, it } from 'vitest'
import {
  deeplxLanguageCode,
  detectLanguageHeuristic,
  icibaLanguageCode,
  isSingleWord,
  microsoftLanguageCode,
  translateLanguageLabel
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
