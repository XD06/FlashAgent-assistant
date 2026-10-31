import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc'
import type { DictEntry, VocabEntry } from '@shared/types'

// Vocabulary book (生词本): one JSON file in userData. Entries snapshot the
// iciba dict data at save time so the detail view works offline.

let store: VocabEntry[] = []
let filePath = ''
const wordIndex = new Set<string>()

function isValidEntry(value: unknown): value is VocabEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<VocabEntry>
  return typeof entry.word === 'string' && !!entry.word.trim() && Array.isArray(entry.meanings)
}

export function initVocabulary(userDataDir: string): void {
  filePath = join(userDataDir, 'vocabulary.json')
  store = []
  wordIndex.clear()
  try {
    if (existsSync(filePath)) {
      const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
      if (Array.isArray(raw)) {
        store = raw.filter(isValidEntry)
        for (const entry of store) wordIndex.add(entry.word.toLowerCase())
      }
    }
  } catch {
    // Corrupt file: start fresh rather than crash the app; the next persist
    // overwrites it.
    store = []
  }
}

// Saving happens on the lookup hot path (every recorded word), so writes
// coalesce behind one in-flight save and each snapshot lands atomically
// (tmp + rename) — the old sync write blocked the main process and a crash
// mid-write could leave a torn JSON. Quit-time flush keeps it lossless.
let pendingPersist = false
let persistInFlight: Promise<void> | null = null

function persist(): void {
  if (!filePath) return
  pendingPersist = true
  if (persistInFlight) return
  persistInFlight = (async () => {
    while (pendingPersist) {
      pendingPersist = false
      const tmp = `${filePath}.tmp`
      try {
        await fsp.writeFile(tmp, JSON.stringify(store), 'utf8')
        await fsp.rename(tmp, filePath)
      } catch {
        // Best-effort: a failed write keeps the in-memory list usable.
      }
    }
  })().finally(() => {
    persistInFlight = null
  })
}

/** Resolve once the queued persist reached the disk (tests). */
export function flushVocabularyPersist(): Promise<void> {
  return persistInFlight ?? Promise.resolve()
}

/** Land the newest snapshot synchronously when it may not be on disk yet
 * (quit path). An in-flight save may still be mid-write, so an extra sync
 * write of the same store here is always benign — same content, atomic file. */
export function flushVocabularyPersistSync(): void {
  if (!filePath || (!pendingPersist && !persistInFlight)) return
  try {
    writeFileSync(filePath, JSON.stringify(store), 'utf8')
    pendingPersist = false
  } catch {
    // Best-effort: the in-memory list stays usable.
  }
}

export function listVocabulary(): VocabEntry[] {
  return [...store].sort((a, b) => b.addedAt - a.addedAt)
}

export function hasVocabulary(word: string): boolean {
  return wordIndex.has(word.trim().toLowerCase())
}

/** Add a dict entry. Returns false when the word is empty or already saved. */
export function addVocabulary(dict: DictEntry): boolean {
  const word = String(dict?.word ?? '').trim()
  if (!word) return false
  const key = word.toLowerCase()
  if (wordIndex.has(key)) return false
  store.push({
    word,
    addedAt: Date.now(),
    phonetics: Array.isArray(dict.phonetics) ? dict.phonetics : [],
    meanings: Array.isArray(dict.meanings) ? dict.meanings : [],
    exchange: dict.exchange ?? {}
  })
  wordIndex.add(key)
  persist()
  return true
}

export function removeVocabulary(word: string): boolean {
  const key = word.trim().toLowerCase()
  if (!wordIndex.has(key)) return false
  store = store.filter((entry) => entry.word.toLowerCase() !== key)
  wordIndex.delete(key)
  persist()
  return true
}

export function clearVocabulary(): void {
  store = []
  wordIndex.clear()
  persist()
}

/** A recordable English word: single Latin-script token (apostrophes and
 * hyphens allowed), e.g. "flash", "don't", "real-time". */
export function isEnglishWord(text: string): boolean {
  const trimmed = text.trim()
  return /^[a-zA-Z][a-zA-Z'’-]*$/.test(trimmed)
}

/** Compact per-word meanings for previews and export: "n. 闪耀；v. 使闪光". */
export function compactMeanings(entry: Pick<VocabEntry, 'meanings'>, maxParts = 4): string {
  return entry.meanings
    .slice(0, maxParts)
    .map((meaning) => `${meaning.partOfSpeech ? `${meaning.partOfSpeech} ` : ''}${meaning.means.join('；')}`)
    .join('；')
}

export function buildVocabMarkdown(entries: VocabEntry[]): string {
  const lines = [`# 生词本（${entries.length} 词）`, '']
  for (const entry of entries) {
    const date = new Date(entry.addedAt)
    const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    lines.push(`- **${entry.word}** — ${compactMeanings(entry) || '（无释义）'} _(${stamp})_`)
  }
  return lines.join('\n')
}

/** Register the vocabulary IPC handlers. Call after initVocabulary. */
export function registerVocabularyIpc(): void {
  ipcMain.handle(IPC.VocabList, () => listVocabulary())

  ipcMain.handle(IPC.VocabAdd, (_event, dict: DictEntry) => {
    if (!dict || typeof dict !== 'object' || typeof dict.word !== 'string') return false
    return addVocabulary(dict)
  })

  ipcMain.handle(IPC.VocabRemove, (_event, word: string) => {
    if (typeof word !== 'string') return false
    return removeVocabulary(word)
  })

  ipcMain.handle(IPC.VocabClear, () => {
    clearVocabulary()
  })

  // Export all words as Markdown. Save dialog first (parented to the caller so
  // it stays on the right display), then write and reveal in Explorer/Finder.
  ipcMain.handle(IPC.VocabExport, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const stamp = new Date().toISOString().slice(0, 10)
    const options = {
      title: '导出生词本',
      defaultPath: `生词本 ${stamp}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    try {
      writeFileSync(result.filePath, buildVocabMarkdown(listVocabulary()), 'utf8')
      shell.showItemInFolder(result.filePath)
      return result.filePath
    } catch {
      return null
    }
  })
}
