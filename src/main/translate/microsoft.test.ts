import { describe, expect, it } from 'vitest'
import { microsoftLegacySignature, microsoftSignatureDate } from './microsoft'

describe('microsoftSignatureDate', () => {
  it('formats the RFC1123-style stamp with literal GMT suffix', () => {
    expect(microsoftSignatureDate(new Date('2026-08-30T14:23:45Z'))).toBe('Sun, 30 Aug 2026 14:23:45GMT')
    expect(microsoftSignatureDate(new Date('2026-01-05T03:04:05Z'))).toBe('Mon, 05 Jan 2026 03:04:05GMT')
  })
})

describe('microsoftLegacySignature', () => {
  it('has the MSTranslatorAndroidApp::{digest}::{date}::{guid} shape', () => {
    const url = 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-Hans'
    const signature = microsoftLegacySignature(url, new Date('2026-08-30T14:23:45Z'), 'abc123')
    const parts = signature.split('::')
    expect(parts[0]).toBe('MSTranslatorAndroidApp')
    expect(parts[1]).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(parts[2]).toBe('Sun, 30 Aug 2026 14:23:45GMT')
    expect(parts[3]).toBe('abc123')
  })
})
