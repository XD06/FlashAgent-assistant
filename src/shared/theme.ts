import { defaultPrimaryColor } from './defaults'
import type { ColorStyle } from './types'

export type ResolvedThemeMode = 'light' | 'dark'

export interface ThemePaletteInput {
  pureBlack: boolean
  primaryColor: string | null
  colorStyle: ColorStyle
}

export interface DerivedThemePalette {
  seedColor: string
  accent: string
  accentOn: string
  vars: Record<string, string>
}

type Rgb = [number, number, number]

const HEX_SHORT_RE = /^#([0-9a-f]{3})$/i
const HEX_FULL_RE = /^#([0-9a-f]{6})$/i
const SYS_HEX_RE = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i

/** Normalize a CSS `#rgb` / `#rrggbb` color string into lowercase `#rrggbb`, or return null. */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  const full = HEX_FULL_RE.exec(trimmed)
  if (full) return `#${full[1].toLowerCase()}`
  const short = HEX_SHORT_RE.exec(trimmed)
  if (!short) return null
  const [r, g, b] = short[1].toLowerCase()
  return `#${r}${r}${g}${g}${b}${b}`
}

/** Normalize OS accent colors (e.g. Windows/macOS `rrggbbaa` without `#`) with fallback. */
export function normalizeSystemAccentColor(value: unknown, fallback = defaultPrimaryColor): string {
  if (typeof value !== 'string') return fallback
  const match = SYS_HEX_RE.exec(value.trim())
  return match ? `#${match[1].toLowerCase()}` : fallback
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export function hexToRgb(hex: string): Rgb {
  const clean = normalizeHexColor(hex) ?? defaultPrimaryColor
  const n = Number.parseInt(clean.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

export function rgbToHex([r, g, b]: Rgb): string {
  const toHex = (c: number) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function srgbToLinear(c: number): number {
  const n = c / 255
  return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(c: number): number {
  const clamped = clamp(c, 0, 1)
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055
}

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

/** CIE Lab L* lightness (0..100), matching Material HCT tone definition. */
export function rgbToTone(rgb: Rgb): number {
  const y = relativeLuminance(rgb)
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y
}

export function wcagContrast(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexToRgb(hexA))
  const l2 = relativeLuminance(hexToRgb(hexB))
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

function rgbToOklch([r, g, b]: Rgb): { L: number; C: number; h: number } {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bComp = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return {
    L,
    C: Math.hypot(a, bComp),
    h: Math.atan2(bComp, a)
  }
}

function oklchToLinearRgb(L: number, C: number, h: number): [number, number, number] {
  const a = C * Math.cos(h)
  const bComp = C * Math.sin(h)

  const l_ = L + 0.3963377774 * a + 0.2158037573 * bComp
  const m_ = L - 0.1055613458 * a - 0.0638541728 * bComp
  const s_ = L - 0.0894841775 * a - 1.291485548 * bComp

  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_

  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ]
}

function inLinearGamut([r, g, b]: [number, number, number]): boolean {
  const eps = 1e-6
  return r >= -eps && r <= 1 + eps && g >= -eps && g <= 1 + eps && b >= -eps && b <= 1 + eps
}

function oklchToRgbGamut(L: number, C: number, h: number): Rgb {
  if (C <= 1e-6) {
    const lum = L * L * L
    const gray = Math.round(linearToSrgb(lum) * 255)
    return [gray, gray, gray]
  }
  let rgb = oklchToLinearRgb(L, C, h)
  if (!inLinearGamut(rgb)) {
    let lo = 0
    let hi = C
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) * 0.5
      if (inLinearGamut(oklchToLinearRgb(L, mid, h))) {
        lo = mid
      } else {
        hi = mid
      }
    }
    rgb = oklchToLinearRgb(L, lo, h)
  }
  return [
    Math.round(linearToSrgb(rgb[0]) * 255),
    Math.round(linearToSrgb(rgb[1]) * 255),
    Math.round(linearToSrgb(rgb[2]) * 255)
  ]
}

/** Generate an sRGB hex color at exact CIE L* tone and OKLCH chroma/hue. */
function colorAtTone(targetTone: number, chroma: number, hue: number): string {
  if (targetTone <= 0) return '#000000'
  if (targetTone >= 100) return '#ffffff'
  const c = Math.max(0, chroma)
  let lo = 0
  let hi = 1
  let bestRgb: Rgb = [0, 0, 0]
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) * 0.5
    const candidate = oklchToRgbGamut(mid, c, hue)
    bestRgb = candidate
    if (rgbToTone(candidate) < targetTone) {
      lo = mid
    } else {
      hi = mid
    }
  }
  return rgbToHex(bestRgb)
}

const MIN_ACCENT_TONE = 35
const MAX_ACCENT_TONE = 60
const DARK_ACCENT_LIFT = 3
const MIN_DARK_ACCENT_TONE = 50
const MAX_DARK_ACCENT_TONE = 75
const DARK_INK = '#141414'
const LIGHT_INK = '#ffffff'

function deriveAccentPair(
  seedHex: string,
  seedOklch: { C: number; h: number },
  seedTone: number,
  isDark: boolean,
  style: ColorStyle
): { accent: string; accentOn: string } {
  if (style === 'monochrome') {
    return isDark
      ? { accent: '#e8e8e8', accentOn: DARK_INK }
      : { accent: '#1c1c1c', accentOn: LIGHT_INK }
  }

  if (style === 'soft') {
    const softChroma = Math.min(seedOklch.C, isDark ? 0.13 : 0.14)
    const tone = isDark ? 76 : 44
    return {
      accent: colorAtTone(tone, softChroma, seedOklch.h),
      accentOn: tone <= MAX_ACCENT_TONE ? LIGHT_INK : DARK_INK
    }
  }

  const clampedTone = isDark
    ? clamp(seedTone + DARK_ACCENT_LIFT, MIN_DARK_ACCENT_TONE, MAX_DARK_ACCENT_TONE)
    : clamp(seedTone, MIN_ACCENT_TONE, MAX_ACCENT_TONE)

  const accent =
    Math.abs(clampedTone - seedTone) < 0.25
      ? seedHex
      : colorAtTone(clampedTone, seedOklch.C, seedOklch.h)

  return {
    accent,
    accentOn: clampedTone <= MAX_ACCENT_TONE ? LIGHT_INK : DARK_INK
  }
}

/**
 * Derive a FlClash-inspired perceptual theme palette and CSS custom properties
 * for all application windows. Pure TypeScript with zero DOM/Node dependencies.
 */
export function deriveThemePalette(
  input: ThemePaletteInput,
  resolvedMode: ResolvedThemeMode,
  systemAccentColor: string = defaultPrimaryColor
): DerivedThemePalette {
  const seedColor =
    normalizeHexColor(input.primaryColor) ??
    normalizeHexColor(systemAccentColor) ??
    defaultPrimaryColor
  const isDark = resolvedMode === 'dark'
  const seedRgb = hexToRgb(seedColor)
  const seedOklch = rgbToOklch(seedRgb)
  const seedTone = rgbToTone(seedRgb)

  const { accent, accentOn } = deriveAccentPair(
    seedColor,
    seedOklch,
    seedTone,
    isDark,
    input.colorStyle
  )
  const [ar, ag, ab] = hexToRgb(accent)

  const tintChroma =
    input.colorStyle === 'monochrome'
      ? 0
      : input.colorStyle === 'tinted'
        ? Math.min(seedOklch.C / 6, 0.028)
        : Math.min(seedOklch.C * 0.035, 0.006)
  const cardChroma =
    input.colorStyle === 'monochrome'
      ? 0
      : input.colorStyle === 'tinted'
        ? tintChroma * 0.55
        : Math.min(tintChroma, 0.0025)
  const inkChroma = Math.min(tintChroma, 0.006)

  const surface = (tone: number, chroma = tintChroma) =>
    colorAtTone(tone, chroma, seedOklch.h)

  let vars: Record<string, string>
  if (!isDark) {
    const surfaceCard = surface(99.0, cardChroma)
    const surfaceInset = surface(91.2)
    vars = {
      '--surface-page': surface(95.3),
      '--surface-chrome': surface(92.3),
      '--surface-card': surfaceCard,
      '--surface-block': surface(95.3),
      '--surface-inset': surfaceInset,
      '--segment-track': surfaceInset,
      '--segment-thumb': surfaceCard,
      '--toolbar-bg': surface(97.6, cardChroma),
      '--text': surface(11.5, inkChroma),
      '--text-soft': surface(20.5, inkChroma),
      '--muted': surface(45.5, inkChroma),
      '--muted-soft': surface(60.5, inkChroma),
      '--danger': '#c6362c',
      '--status-ok': '#28a745',
      '--status-ok-soft': 'rgba(40, 167, 69, 0.12)',
      '--status-warn': '#d97706',
      '--status-warn-soft': 'rgba(217, 119, 6, 0.12)',
      '--status-err': '#c6362c',
      '--status-err-soft': 'rgba(198, 54, 44, 0.12)'
    }
  } else {
    const pureBlack = input.pureBlack
    const surfaceChrome = surface(pureBlack ? 4.6 : 9.2)
    const surfaceCard = surface(pureBlack ? 8.4 : 12.5)
    const surfaceBlock = surface(pureBlack ? 13.2 : 17.2)
    const surfaceInset = surface(pureBlack ? 18.2 : 22.2)
    vars = {
      '--surface-page': pureBlack ? '#000000' : surface(6.2),
      '--surface-chrome': surfaceChrome,
      '--surface-card': surfaceCard,
      '--surface-block': surfaceBlock,
      '--surface-inset': surfaceInset,
      '--segment-track': surfaceChrome,
      '--segment-thumb': surfaceBlock,
      '--toolbar-bg': surface(pureBlack ? 7.8 : 13.2),
      '--text': surface(96.8, inkChroma),
      '--text-soft': surface(88.0, inkChroma),
      '--muted': surface(64.5, inkChroma),
      '--muted-soft': surface(49.0, inkChroma),
      '--danger': '#ff7a70',
      '--status-ok': '#30d158',
      '--status-ok-soft': 'rgba(48, 209, 88, 0.16)',
      '--status-warn': '#ffb340',
      '--status-warn-soft': 'rgba(255, 179, 64, 0.16)',
      '--status-err': '#ff7a70',
      '--status-err-soft': 'rgba(255, 122, 112, 0.16)'
    }
  }

  vars['--accent'] = accent
  vars['--accent-on'] = accentOn
  vars['--primary'] = accent
  vars['--primary-on'] = accentOn
  vars['--accent-soft'] = `rgba(${ar}, ${ag}, ${ab}, ${isDark ? 0.16 : 0.11})`
  vars['--focus'] = `rgba(${ar}, ${ag}, ${ab}, ${isDark ? 0.34 : 0.28})`
  vars['--settings-success'] = vars['--status-ok']

  return {
    seedColor,
    accent,
    accentOn,
    vars
  }
}

export function deriveThemeCssVars(
  input: ThemePaletteInput,
  resolvedMode: ResolvedThemeMode,
  systemAccentColor: string = defaultPrimaryColor
): Record<string, string> {
  return deriveThemePalette(input, resolvedMode, systemAccentColor).vars
}
