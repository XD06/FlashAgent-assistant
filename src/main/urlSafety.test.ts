import { describe, expect, it } from 'vitest'
import { isExternalUrlAllowed } from './urlSafety'

describe('isExternalUrlAllowed', () => {
  it('allows web and mail URLs', () => {
    expect(isExternalUrlAllowed('https://example.com/a?b=1')).toBe(true)
    expect(isExternalUrlAllowed('HTTP://example.com')).toBe(true)
    expect(isExternalUrlAllowed('mailto:a@b.c')).toBe(true)
    expect(isExternalUrlAllowed('  https://example.com  ')).toBe(true)
  })

  it('refuses anything the shell would execute or resolve as a local path', () => {
    expect(isExternalUrlAllowed('file:///C:/Users/Public/payload.lnk')).toBe(false)
    expect(isExternalUrlAllowed('C:\\Users\\Public\\payload.lnk')).toBe(false)
    expect(isExternalUrlAllowed('javascript:alert(1)')).toBe(false)
    expect(isExternalUrlAllowed('ms-msdt:/id')).toBe(false)
    expect(isExternalUrlAllowed('')).toBe(false)
  })
})
