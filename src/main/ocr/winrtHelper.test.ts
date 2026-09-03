import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { compileWinRtOcr, isWinRtSupported, runWinRtOcr, runWinRtOcrLangs } from './winrtHelper'
import { cleanupOcrSpaces } from './textCleanup'

// End-to-end system-OCR test: really compiles the C# helper with the machine's
// .NET Framework csc.exe and recognizes the checked-in sample. Windows-only —
// CI (ubuntu) skips it, but every Windows dev machine runs the real pipeline.

const onWindows = isWinRtSupported()

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe.runIf(onWindows)('WinRT OCR helper', () => {
  it(
    'compiles and recognizes the sample image',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'winrt-ocr-'))
      dirs.push(dir)
      const exe = await compileWinRtOcr(dir)

      const png = await readFile(resolve(__dirname, '../../../test1.png'))
      const raw = await runWinRtOcr(exe, png, 'zh-Hans-CN')

      // The 1x sample contains "Ding's DevLog 关于我" (see
      // docs/ocr-winrt-test-result.md); assert on the stable Latin part only —
      // CJK glyph accuracy varies by Windows recognizer version.
      expect(cleanupOcrSpaces(raw)).toContain('DevLog')
    },
    120_000
  )

  it(
    'lists installed recognizer languages',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'winrt-ocr-'))
      dirs.push(dir)
      const exe = await compileWinRtOcr(dir)

      const langs = await runWinRtOcrLangs(exe)
      expect(langs.length).toBeGreaterThan(0)
      expect(langs).toContain('en-US')
    },
    120_000
  )
})
