import { describe, expect, it } from 'vitest'
import { shouldProcessProgram } from './selectionFilter'

describe('selection filtering', () => {
  it('allows everything in default mode', () => {
    expect(shouldProcessProgram('chrome.exe', 'default', ['chrome'])).toBe(true)
  })

  it('supports whitelist mode', () => {
    expect(shouldProcessProgram('Google Chrome', 'whitelist', ['chrome'])).toBe(true)
    expect(shouldProcessProgram('Notes', 'whitelist', ['chrome'])).toBe(false)
  })

  it('supports blacklist mode', () => {
    expect(shouldProcessProgram('Google Chrome', 'blacklist', ['chrome'])).toBe(false)
    expect(shouldProcessProgram('Notes', 'blacklist', ['chrome'])).toBe(true)
  })
})
