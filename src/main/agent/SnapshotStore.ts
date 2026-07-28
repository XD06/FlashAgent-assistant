import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { MutationSnapshot } from './AgentTools'

// Tool mutation snapshots are persisted under userData so a revert still
// works after the app restarts. One JSON file per tool call, pruned by age.
const MAX_SNAPSHOTS = 100

let dirPromise: Promise<string> | null = null
function snapshotDir(): Promise<string> {
  if (!dirPromise) {
    dirPromise = (async () => {
      const dir = join(app.getPath('userData'), 'tool-snapshots')
      await fs.mkdir(dir, { recursive: true })
      return dir
    })()
  }
  return dirPromise
}

function fileFor(dir: string, callId: string): string {
  return join(dir, `${callId.replace(/[^\w-]/g, '_')}.json`)
}

export async function saveSnapshot(callId: string, snapshot: MutationSnapshot): Promise<void> {
  try {
    const dir = await snapshotDir()
    await fs.writeFile(fileFor(dir, callId), JSON.stringify({ ...snapshot, savedAt: Date.now() }), 'utf8')
    await prune(dir)
  } catch {
    // Best-effort: losing a snapshot only disables revert for that call.
  }
}

export async function loadSnapshot(callId: string): Promise<MutationSnapshot | null> {
  try {
    const dir = await snapshotDir()
    const raw = JSON.parse(await fs.readFile(fileFor(dir, callId), 'utf8')) as Partial<MutationSnapshot>
    if (typeof raw.path !== 'string') return null
    return { path: raw.path, content: typeof raw.content === 'string' ? raw.content : null }
  } catch {
    return null
  }
}

export async function deleteSnapshot(callId: string): Promise<void> {
  try {
    const dir = await snapshotDir()
    await fs.rm(fileFor(dir, callId), { force: true })
  } catch {
    // ignore
  }
}

async function prune(dir: string): Promise<void> {
  const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.json'))
  if (names.length <= MAX_SNAPSHOTS) return
  const stats = await Promise.all(
    names.map(async (name) => ({ name, mtime: (await fs.stat(join(dir, name))).mtimeMs }))
  )
  stats.sort((a, b) => a.mtime - b.mtime)
  const excess = stats.slice(0, stats.length - MAX_SNAPSHOTS)
  await Promise.all(excess.map((entry) => fs.rm(join(dir, entry.name), { force: true })))
}
