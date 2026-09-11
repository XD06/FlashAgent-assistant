import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

const FILE_NAME = 'chat-topics.json'

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
  try {
    const path = getTopicsFilePath(customDir)
    const tmp = `${path}.tmp`
    await fs.writeFile(tmp, JSON.stringify(topics, null, 2), 'utf8')
    await fs.rename(tmp, path)
    return true
  } catch (err) {
    console.error('[saveTopicsToDisk] failed:', err)
    return false
  }
}
