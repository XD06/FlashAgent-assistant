import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { MutationSnapshot } from './AgentTools'
import { MAX_MUTATION_BYTES, MAX_SNAPSHOT_JSON_BYTES, MAX_SNAPSHOT_TOTAL_BYTES } from './mutationLimits'

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
    const payload = JSON.stringify({ ...snapshot, savedAt: Date.now() })
    // Escaping can expand a 2 MiB file up to ~6x; refuse the write rather than
    // hold another multi-megabyte string and risk the heap.
    if (Buffer.byteLength(payload, 'utf8') > MAX_SNAPSHOT_JSON_BYTES) {
      console.warn(`[saveSnapshot] snapshot too large to persist; revert unavailable: ${snapshot.path}`)
      return
    }
    await fs.writeFile(fileFor(dir, callId), payload, 'utf8')
    await prune(dir)
  } catch {
    // Best-effort: losing a snapshot only disables revert for that call.
  }
}

export async function loadSnapshot(callId: string): Promise<MutationSnapshot | null> {
  try {
    const dir = await snapshotDir()
    const file = fileFor(dir, callId)
    const stat = await fs.stat(file)
    if (stat.size > MAX_SNAPSHOT_JSON_BYTES) return null
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<MutationSnapshot>
    if (typeof raw.path !== 'string') return null
    if (raw.content !== null && typeof raw.content !== 'string') return null
    if (typeof raw.content === 'string' && Buffer.byteLength(raw.content, 'utf8') > MAX_MUTATION_BYTES) return null
    return { path: raw.path, content: raw.content }
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
  if (!names.length) return
  const stats = await Promise.all(
    names.map(async (name) => {
      const stat = await fs.stat(join(dir, name))
      return { name, mtime: stat.mtimeMs, size: stat.size }
    })
  )
  stats.sort((a, b) => a.mtime - b.mtime)
  let count = stats.length
  let total = stats.reduce((sum, entry) => sum + entry.size, 0)
  for (const entry of stats) {
    if (count <= MAX_SNAPSHOTS && total <= MAX_SNAPSHOT_TOTAL_BYTES) break
    await fs.rm(join(dir, entry.name), { force: true })
    count -= 1
    total -= entry.size
  }
}
