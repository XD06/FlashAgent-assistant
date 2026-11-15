import { describe, expect, it } from 'vitest'
import { defaultPrimaryColor, defaultPrimaryColors } from './defaults'
import {
  deriveThemePalette,
  hexToRgb,
  normalizeHexColor,
  normalizeSystemAccentColor,
  rgbToTone,
  wcagContrast
} from './theme'
import type { ColorStyle } from './types'

describe('theme hex normalization', () => {
  it('normalizes short and full hex values', () => {
    expect(normalizeHexColor('#ABC')).toBe('#aabbcc')
    expect(normalizeHexColor(' #007AFF ')).toBe('#007aff')
    expect(normalizeHexColor('#12345')).toBeNull()
    expect(normalizeHexColor('red')).toBeNull()
  })

  it('normalizes OS accent rgba hex strings with fallback', () => {
    expect(normalizeSystemAccentColor('0078d7ff')).toBe('#0078d7')
    expect(normalizeSystemAccentColor('#cb30e0')).toBe('#cb30e0')
    expect(normalizeSystemAccentColor('invalid', '#007aff')).toBe('#007aff')
  })
})

describe('FlClash theme palette derivation', () => {
  it('keeps default blue vivid seed exact in light mode and legible in dark mode', () => {
    const light = deriveThemePalette(
      { pureBlack: false, primaryColor: '#007aff', colorStyle: 'vivid' },
      'light'
    )
    expect(light.accent).toBe('#007aff')
    expect(light.accentOn).toBe('#ffffff')
    expect(rgbToTone(hexToRgb(light.vars['--surface-card']))).toBeGreaterThan(
      rgbToTone(hexToRgb(light.vars['--surface-page']))
    )

    const dark = deriveThemePalette(
      { pureBlack: false, primaryColor: '#007aff', colorStyle: 'vivid' },
      'dark'
    )
    expect(dark.accentOn).toBe('#ffffff')
    expect(rgbToTone(hexToRgb(dark.accent))).toBeGreaterThanOrEqual(50)
  })

  it('switches to dark ink on bright yellow/amber accents in dark mode', () => {
    const darkYellow = deriveThemePalette(
      { pureBlack: false, primaryColor: '#ffcc00', colorStyle: 'vivid' },
      'dark'
    )
    expect(darkYellow.accentOn).toBe('#141414')
    expect(wcagContrast(darkYellow.accentOn, darkYellow.accent)).toBeGreaterThan(7)

    const lightYellow = deriveThemePalette(
      { pureBlack: false, primaryColor: '#ffcc00', colorStyle: 'vivid' },
      'light'
    )
    expect(lightYellow.accentOn).toBe('#ffffff')
    expect(wcagContrast(lightYellow.accentOn, lightYellow.accent)).toBeGreaterThanOrEqual(3)
  })

  it('enforces pure black OLED page background while keeping stepped dark surfaces', () => {
    const pureDark = deriveThemePalette(
      { pureBlack: true, primaryColor: '#ff8d28', colorStyle: 'vivid' },
      'dark'
    )
    expect(pureDark.vars['--surface-page']).toBe('#000000')
    const chromeTone = rgbToTone(hexToRgb(pureDark.vars['--surface-chrome']))
    const cardTone = rgbToTone(hexToRgb(pureDark.vars['--surface-card']))
    const blockTone = rgbToTone(hexToRgb(pureDark.vars['--surface-block']))
    const insetTone = rgbToTone(hexToRgb(pureDark.vars['--surface-inset']))
    expect(chromeTone).toBeGreaterThan(0)
    expect(cardTone).toBeGreaterThan(chromeTone)
    expect(blockTone).toBeGreaterThan(cardTone)
    expect(insetTone).toBeGreaterThan(blockTone)
  })

  it('renders monochrome without channel chroma skew and respects follow-system fallback', () => {
    const mono = deriveThemePalette(
      { pureBlack: false, primaryColor: '#ff2d55', colorStyle: 'monochrome' },
      'light'
    )
    for (const key of ['--surface-page', '--surface-chrome', '--surface-card', '--surface-block', '--accent']) {
      const [r, g, b] = hexToRgb(mono.vars[key])
      expect(r).toBe(g)
      expect(g).toBe(b)
    }

    const followSystem = deriveThemePalette(
      { pureBlack: false, primaryColor: null, colorStyle: 'vivid' },
      'light',
      '#cb30e0'
    )
    expect(followSystem.seedColor).toBe('#cb30e0')
    expect(followSystem.accent).toBe('#cb30e0')

    const fallback = deriveThemePalette(
      { pureBlack: false, primaryColor: null, colorStyle: 'vivid' },
      'light',
      ''
    )
    expect(fallback.seedColor).toBe(defaultPrimaryColor)
  })

  it('guarantees readable contrast across all 8 presets, modes, styles and pureBlack', () => {
    const styles: ColorStyle[] = ['vivid', 'tinted', 'soft', 'monochrome']
    for (const seed of defaultPrimaryColors) {
      for (const mode of ['light', 'dark'] as const) {
        for (const colorStyle of styles) {
          for (const pureBlack of [false, true]) {
            const { accent, accentOn, vars } = deriveThemePalette(
              { pureBlack, primaryColor: seed, colorStyle },
              mode
            )
            expect(wcagContrast(vars['--text'], vars['--surface-card'])).toBeGreaterThanOrEqual(7)
            expect(wcagContrast(vars['--text'], vars['--surface-block'])).toBeGreaterThanOrEqual(7)
            expect(wcagContrast(accentOn, accent)).toBeGreaterThanOrEqual(3)
          }
        }
      }
    }
  })
})
