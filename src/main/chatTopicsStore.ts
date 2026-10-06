import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

const FILE_NAME = 'chat-topics.json'

// Renderer updates can arrive in bursts (stream completion, topic metadata,
// auto-title). Keep only the newest snapshot while one atomic write is in
// flight so each burst pays for one JSON serialization and rename.
let pendingSave: { topics: unknown[]; customDir?: string } | null = null
let saveInFlight: Promise<boolean> | null = null

function getTopicsFilePath(customDir?: string): string {
  const baseDir = customDir || (app ? app.getPath('userData') : process.cwd())
  return join(baseDir, FILE_NAME)
}

export async function loadTopicsFromDisk(customDir?: string): Promise<unknown[]> {
  try {
    const raw = await fs.readFile(getTopicsFilePath(customDir), 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
    return []
  } catch {
    return []
  }
}

export async function saveTopicsToDisk(topics: unknown[], customDir?: string): Promise<boolean> {
  pendingSave = { topics, customDir }
  if (saveInFlight) return saveInFlight

  saveInFlight = (async () => {
    let ok = true
    while (pendingSave) {
      const next = pendingSave
      pendingSave = null
      try {
        const path = getTopicsFilePath(next.customDir)
        const tmp = `${path}.tmp`
        await fs.writeFile(tmp, JSON.stringify(next.topics, null, 2), 'utf8')
        await fs.rename(tmp, path)
      } catch (err) {
        ok = false
        console.error('[saveTopicsToDisk] failed:', err)
      }
    }
    return ok
  })().finally(() => {
    saveInFlight = null
  })
  return saveInFlight
}
