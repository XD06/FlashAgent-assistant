/** Quick-translate language table and per-service code mapping.
 * Codes are the app's canonical ids; each service gets its own mapper. */

export interface TranslateLanguage {
  code: string
  /** Native name — renders correctly in both UI languages. */
  label: string
  /** 'auto' only appears in the source dropdown. */
  auto?: boolean
}

/** All built-in quick-translate service ids (runtime mirror of the
 * TranslateServiceId union in types.ts — keep in sync). */
export const TRANSLATE_SERVICE_IDS = ['microsoft', 'iciba', 'icibaDict', 'tencent', 'yandex', 'deeplx'] as const

export const TRANSLATE_LANGUAGES: TranslateLanguage[] = [
  { code: 'auto', label: 'Auto', auto: true },
  { code: 'zh', label: '中文（简体）' },
  { code: 'zh-tw', label: '中文（繁體）' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'de', label: 'Deutsch' },
  { code: 'ru', label: 'Русский' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'sv', label: 'Svenska' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'th', label: 'ไทย' },
  { code: 'ar', label: 'العربية' }
]

export function translateLanguageLabel(code: string): string {
  return TRANSLATE_LANGUAGES.find((lang) => lang.code === code)?.label ?? code
}

/** A "single word" gets the dictionary card in addition to translations:
 * no whitespace, ≤ 40 chars, at least one letter (any script). */
export function isSingleWord(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 40 || /\s/.test(trimmed)) return false
  return /\p{L}/u.test(trimmed)
}

/** Cheap script-based detection for the "识别为" chip when no service
 * reports one. Good enough for display; never used to pick codes. */
export function detectLanguageHeuristic(text: string): string {
  const sample = text.slice(0, 400)
  if (/[\u3040-\u30ff]/.test(sample)) return 'ja'
  if (/[\uac00-\ud7af]/.test(sample)) return 'ko'
  if (/[\u4e00-\u9fff]/.test(sample)) return 'zh'
  if (/[\u0400-\u04ff]/.test(sample)) return 'ru'
  if (/[\u0600-\u06ff]/.test(sample)) return 'ar'
  if (/[\u0e00-\u0e7f]/.test(sample)) return 'th'
  return 'en'
}

/** Microsoft Translator: zh-Hans / zh-Hant, others pass through. */
export function microsoftLanguageCode(code: string): string {
  if (code === 'zh') return 'zh-Hans'
  if (code === 'zh-tw') return 'zh-Hant'
  return code
}

/** iciba batch API codes; traditional Chinese is 'cht'. */
export function icibaLanguageCode(code: string): string {
  return code === 'zh-tw' ? 'cht' : code
}

/** DeepLX/DeepL style: uppercase; DeepL free has no traditional-Chinese
 * target, so zh-tw degrades to ZH. */
export function deeplxLanguageCode(code: string): string {
  if (code === 'zh-tw') return 'ZH'
  return code.toUpperCase()
}

/** Tencent Transmart / Yandex use ISO 639-1 short codes. Neither converts
 * traditional Chinese natively (Tencent zh-TW echoes simplified, Yandex maps
 * to zh), so zh-tw degrades to zh for both. */
export function tencentLanguageCode(code: string): string {
  return code === 'zh-tw' ? 'zh' : code
}

export function yandexLanguageCode(code: string): string {
  return code === 'zh-tw' ? 'zh' : code
}
