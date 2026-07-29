import { describe, it, expect } from 'vitest'
import { hasAnsi, parseAnsi, semanticHint, renderTerminalText, highlightLineNumbers } from './ansi'

describe('hasAnsi', () => {
  it('detects SGR escapes', () => {
    expect(hasAnsi('\u001b[32mgreen\u001b[0m')).toBe(true)
  })
  it('is false for plain text', () => {
    expect(hasAnsi('[OK] model=gpt-4o')).toBe(false)
  })
})

describe('parseAnsi', () => {
  it('colours a basic foreground run and resets', () => {
    const segs = parseAnsi('a\u001b[31mred\u001b[0mb')
    expect(segs.map((s) => s.text).join('')).toBe('aredb')
    const red = segs.find((s) => s.text === 'red')
    expect(red?.color).toBe('#f14c4c')
    // Text after reset inherits (no colour).
    expect(segs.find((s) => s.text === 'b')?.color).toBeUndefined()
  })

  it('brightens a standard colour when bold is set', () => {
    const segs = parseAnsi('\u001b[32m\u001b[1mx\u001b[0m')
    const x = segs.find((s) => s.text === 'x')
    expect(x?.bold).toBe(true)
    expect(x?.color).toBe('#4ee88f') // bright green, not base green
  })

  it('parses 256-colour and truecolor foregrounds', () => {
    expect(parseAnsi('\u001b[38;5;9mx\u001b[0m').find((s) => s.text === 'x')?.color).toBe('#ff6d67')
    expect(parseAnsi('\u001b[38;2;18;52;86mx\u001b[0m').find((s) => s.text === 'x')?.color).toBe('#123456')
  })

  it('skips background codes without leaking into foreground', () => {
    const segs = parseAnsi('\u001b[48;5;9m\u001b[38;5;10mx\u001b[0m')
    expect(segs.find((s) => s.text === 'x')?.color).toBe('#4ee88f')
  })

  it('strips non-SGR CSI (cursor/erase) and carriage returns', () => {
    const segs = parseAnsi('a\u001b[2K\u001b[1Gb\r\nc')
    expect(segs.map((s) => s.text).join('')).toBe('ab\nc')
  })
})

describe('semanticHint', () => {
  it('tints a leading [OK] marker green, leaves the rest neutral', () => {
    const segs = semanticHint('[OK] model=gpt-4o enc=o200k_base')
    expect(segs[0].text).toBe('[OK]')
    expect(segs[0].color).toBe('#23d18b')
    expect(segs[0].bold).toBe(true)
    // The "fields" after the marker are NOT parsed — single neutral run.
    expect(segs[1].text).toBe(' model=gpt-4o enc=o200k_base')
    expect(segs[1].color).toBeUndefined()
  })

  it('tints FAIL/ERROR red and WARN yellow', () => {
    expect(semanticHint('FAILED something')[0].color).toBe('#f14c4c')
    expect(semanticHint('ERROR: boom')[0].color).toBe('#f14c4c')
    expect(semanticHint('WARNING: heads up')[0].color).toBe('#d7ba7d')
  })

  it('colours our Exit code prefix by the code', () => {
    expect(semanticHint('Exit code 0\nok')[0].color).toBe('#23d18b')
    expect(semanticHint('Exit code 1\nnope')[0].color).toBe('#f14c4c')
  })

  it('handles ✓/✗ symbol markers', () => {
    expect(semanticHint('✓ passed')[0].color).toBe('#23d18b')
    expect(semanticHint('✗ failed')[0].color).toBe('#f14c4c')
  })

  it('does not tint a normal line', () => {
    const segs = semanticHint('just some output')
    expect(segs.every((s) => s.color === undefined)).toBe(true)
  })

  it('does not treat a random leading word as a status', () => {
    const segs = semanticHint('model=gpt-4o actual=14')
    expect(segs.every((s) => s.color === undefined)).toBe(true)
  })
})

describe('renderTerminalText', () => {
  it('routes ANSI input to the parser', () => {
    expect(renderTerminalText('\u001b[31mx\u001b[0m').find((s) => s.text === 'x')?.color).toBe('#f14c4c')
  })
  it('routes plain input to the semantic hinter', () => {
    expect(renderTerminalText('[OK] done')[0].color).toBe('#23d18b')
  })
})

describe('highlightLineNumbers', () => {
  it('tints the NNN→ gutter grey and leaves code neutral', () => {
    const segs = highlightLineNumbers('  14→def _ratio(model):')
    expect(segs[0].text).toBe('  14→')
    expect(segs[0].color).toBe('#8b949e')
    expect(segs[1].text).toBe('def _ratio(model):')
    expect(segs[1].color).toBeUndefined()
  })
  it('leaves a line without a gutter untouched', () => {
    const segs = highlightLineNumbers('no number here')
    expect(segs).toHaveLength(1)
    expect(segs[0].color).toBeUndefined()
  })
  it('keeps newlines between rows', () => {
    const segs = highlightLineNumbers('1→a\n2→b')
    expect(segs.map((s) => s.text).join('')).toBe('1→a\n2→b')
  })
})
