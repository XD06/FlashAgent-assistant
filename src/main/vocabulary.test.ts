import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DictEntry } from '@shared/types'
import {
  addVocabulary,
  buildVocabMarkdown,
  clearVocabulary,
  compactMeanings,
  hasVocabulary,
  initVocabulary,
  isEnglishWord,
  listVocabulary,
  removeVocabulary
} from './vocabulary'

function dict(word: string): DictEntry {
  return {
    word,
    phonetics: [{ label: 'uk', phonetic: '/flæʃ/', audioUrl: '' }],
    meanings: [
      { partOfSpeech: 'n.', means: ['闪耀', '闪光'] },
      { partOfSpeech: 'v.', means: ['使闪光'] }
    ],
    exchange: { plurals: ['flashes'] }
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fa-vocab-'))
  initVocabulary(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('isEnglishWord', () => {
  it('accepts single latin words', () => {
    expect(isEnglishWord('flash')).toBe(true)
    expect(isEnglishWord("don't")).toBe(true)
    expect(isEnglishWord('real-time')).toBe(true)
    expect(isEnglishWord('  studio ')).toBe(true)
  })

  it('rejects phrases and non-latin input', () => {
    expect(isEnglishWord('hello world')).toBe(false)
    expect(isEnglishWord('优化')).toBe(false)
    expect(isEnglishWord('firewall2')).toBe(false)
    expect(isEnglishWord('')).toBe(false)
  })
})

describe('vocabulary store', () => {
  it('adds, dedups, and persists across re-init', () => {
    expect(addVocabulary(dict('flash'))).toBe(true)
    expect(addVocabulary(dict('FLASH'))).toBe(false) // duplicate, case-insensitive
    expect(hasVocabulary('flash')).toBe(true)
    expect(listVocabulary()).toHaveLength(1)

    initVocabulary(dir) // simulate app restart
    expect(listVocabulary()).toHaveLength(1)
    expect(listVocabulary()[0].meanings[0].means[0]).toBe('闪耀')
  })

  it('removes and clears', () => {
    addVocabulary(dict('flash'))
    addVocabulary(dict('studio'))
    expect(removeVocabulary('FLASH')).toBe(true)
    expect(listVocabulary()).toHaveLength(1)
    clearVocabulary()
    expect(listVocabulary()).toHaveLength(0)
    expect(hasVocabulary('studio')).toBe(false)
  })

  it('rejects malformed entries', () => {
    expect(addVocabulary({ word: '', phonetics: [], meanings: [], exchange: {} })).toBe(false)
    expect(addVocabulary(undefined as unknown as DictEntry)).toBe(false)
  })
})

describe('preview and export formatting', () => {
  it('compacts meanings to one line', () => {
    expect(compactMeanings(dict('flash'))).toBe('n. 闪耀；闪光；v. 使闪光')
  })

  it('builds a markdown export', () => {
    addVocabulary(dict('flash'))
    const md = buildVocabMarkdown(listVocabulary())
    expect(md).toContain('# 生词本（1 词）')
    expect(md).toContain('**flash** — n. 闪耀；闪光；v. 使闪光')
  })

  it('persists a readable json file', () => {
    addVocabulary(dict('flash'))
    const raw = JSON.parse(readFileSync(join(dir, 'vocabulary.json'), 'utf8')) as Array<{ word: string }>
    expect(raw).toHaveLength(1)
    expect(raw[0].word).toBe('flash')
  })
})
