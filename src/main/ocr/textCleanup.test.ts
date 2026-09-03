import { describe, expect, it } from 'vitest'
import { cleanupOcrSpaces } from './textCleanup'

describe('cleanupOcrSpaces', () => {
  it('removes spaces WinRT inserts between CJK glyphs', () => {
    expect(cleanupOcrSpaces('关 于 我')).toBe('关于我')
  })

  it('keeps spaces at Latin/CJK boundaries', () => {
    expect(cleanupOcrSpaces("Ding's DevLog 关 于 我")).toBe("Ding's DevLog 关于我")
  })

  it('collapses multiple spaces between CJK glyphs', () => {
    expect(cleanupOcrSpaces('你 好   ， 世 界')).toBe('你好，世界')
  })

  it('leaves pure Latin text untouched', () => {
    expect(cleanupOcrSpaces('hello  world')).toBe('hello  world')
  })

  it('removes spaces between CJK and fullwidth punctuation', () => {
    expect(cleanupOcrSpaces('总结 ： 如下 。')).toBe('总结：如下。')
  })
})
