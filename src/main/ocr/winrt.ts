import { join } from 'node:path'
import { app } from 'electron'
import { compileWinRtOcr, isWinRtSupported, runWinRtOcr, runWinRtOcrLangs } from './winrtHelper'
import { cleanupOcrSpaces } from './textCleanup'
import type { AppLanguage } from '@shared/types'

// Electron glue for the WinRT OCR helper: caches the compiled exe under
// userData/bin and maps app language to a Windows language tag.

let helperPromise: Promise<string> | null = null

export function isSystemOcrAvailable(): boolean {
  return isWinRtSupported()
}

async function ensureHelper(): Promise<string> {
  helperPromise ??= compileWinRtOcr(join(app.getPath('userData'), 'bin')).catch((error) => {
    // Allow a later retry (e.g. transient compile failure) instead of caching
    // the rejection forever.
    helperPromise = null
    throw error
  })
  return helperPromise
}

/** Map app language to a Windows BCP-47 tag the OCR engine understands. */
function languageTag(language: AppLanguage): string {
  return language === 'zh-CN' ? 'zh-Hans-CN' : 'en-US'
}

export async function recognizeWithSystem(
  png: Buffer,
  language: AppLanguage
): Promise<{ text: string; elapsedMs: number }> {
  const started = Date.now()
  const exe = await ensureHelper()
  const raw = await runWinRtOcr(exe, png, languageTag(language))
  const text = cleanupOcrSpaces(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
  return { text, elapsedMs: Date.now() - started }
}

/** Installed recognizer tags, for the settings UI availability hint. */
export async function listSystemOcrLanguages(): Promise<string[]> {
  const exe = await ensureHelper()
  return runWinRtOcrLangs(exe)
}
