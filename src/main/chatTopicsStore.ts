import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

// Chat history on disk: one shard file per topic under `chat-topics/`, plus a
// small index.json holding the sidebar order. Rewriting the whole
// (potentially multi-megabyte) history on the main-process thread at every
// stream end froze all windows, so the renderer declares which topics changed
// and only those shards — plus the index — get rewritten. The pre-sharding
// single file `chat-topics.json` is still read and is renamed to `.bak` after
// the first sharded save. Until the shard layout is materialized (index
// present, legacy file gone) a declared changed list is ignored and every
// save is a full one — a partial write would drop the not-yet-sharded topics.

const INDEX_VERSION = 1
const SHARD_DIR_NAME = 'chat-topics'
const INDEX_FILE_NAME = 'index.json'
const LEGACY_FILE_NAME = 'chat-topics.json'

interface ShardState {
  /** Previous order — drives orphan-shard deletion on the next save. */
  order: string[]
  materialized: boolean
}

const states = new Map<string, ShardState>()
// Concurrent cold-start reads (a load racing the first save) must share ONE
// state object — two independently created states would lose each other's
// order/materialized bookkeeping.
const stateInFlight = new Map<string, Promise<ShardState>>()
let pendingSave: { topics: unknown[]; changed: Set<string> | null; baseDir: string } | null = null
let saveInFlight: Promise<boolean> | null = null

function baseDirOf(customDir?: string): string {
  return customDir || (app ? app.getPath('userData') : process.cwd())
}

function shardDirOf(baseDir: string): string {
  return join(baseDir, SHARD_DIR_NAME)
}

// Topic ids are UUIDs in practice; the sanitization is belt for older/imported
// ids. Two distinct ids may in principle sanitize to one file name (e.g.
// "a/b" and "a_b") — the shard then holds whichever saved last, so this must
// stay a last-resort belt, not a supported path.
function shardFileName(topicId: string): string {
  const safe = topicId.replace(/[^\w-]/g, '_').slice(0, 80)
  return `${safe || 'topic'}.json`
}

function hasStringId(value: unknown): value is { id: string } {
  return !!value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' && !!(value as { id: string }).id
}

function idsOf(topics: unknown[]): string[] {
  return topics.filter(hasStringId).map((topic) => topic.id)
}

function ensureState(baseDir: string): Promise<ShardState> {
  const existing = states.get(baseDir)
  if (existing) return Promise.resolve(existing)
  const pending = stateInFlight.get(baseDir)
  if (pending) return pending
  const created = (async (): Promise<ShardState> => {
    const state: ShardState = { order: [], materialized: false }
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(join(shardDirOf(baseDir), INDEX_FILE_NAME), 'utf8'))
      const order = (parsed as { order?: unknown })?.order
      if (Array.isArray(order)) {
        state.order = order.filter((id): id is string => typeof id === 'string')
        state.materialized = !existsSync(join(baseDir, LEGACY_FILE_NAME))
      }
    } catch {
      // No sharded history yet — a full save will create it.
    }
    states.set(baseDir, state)
    return state
  })().finally(() => {
    stateInFlight.delete(baseDir)
  })
  stateInFlight.set(baseDir, created)
  return created
}

async function writeShards(next: { topics: unknown[]; changed: Set<string> | null; baseDir: string }): Promise<void> {
  const state = await ensureState(next.baseDir)
  const valid = next.topics.filter(hasStringId)
  if (valid.length !== next.topics.length) {
    console.error(`[saveTopicsToDisk] dropped ${next.topics.length - valid.length} topic(s) without a string id`)
  }
  const dir = shardDirOf(next.baseDir)
  await fs.mkdir(dir, { recursive: true })

  // Orphan removal first: shards of topics that left the array.
  const keepIds = new Set(valid.map((topic) => topic.id))
  for (const oldId of state.order) {
    if (!keepIds.has(oldId)) await fs.rm(join(dir, shardFileName(oldId)), { force: true })
  }

  const targets = next.changed ? valid.filter((topic) => next.changed!.has(topic.id)) : valid
  for (const topic of targets) {
    const file = join(dir, shardFileName(topic.id))
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(topic), 'utf8')
    await fs.rename(tmp, file)
  }

  // The index is the commit point — a crash before it leaves orphan shards,
  // which loadTopicsFromDisk recovers by appending.
  const indexFile = join(dir, INDEX_FILE_NAME)
  const indexTmp = `${indexFile}.tmp`
  await fs.writeFile(indexTmp, JSON.stringify({ version: INDEX_VERSION, order: valid.map((topic) => topic.id) }), 'utf8')
  await fs.rename(indexTmp, indexFile)
  state.order = valid.map((topic) => topic.id)
  state.materialized = true

  // Retire the legacy single file once shards are the live copy.
  try {
    await fs.rename(join(next.baseDir, LEGACY_FILE_NAME), join(next.baseDir, `${LEGACY_FILE_NAME}.bak`))
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error('[saveTopicsToDisk] legacy rename failed:', error)
    }
  }
}

function mergeChanged(prev: Set<string> | null, next: Set<string> | null): Set<string> | null {
  if (!prev || !next) return null
  return new Set([...prev, ...next])
}

export async function saveTopicsToDisk(
  topics: unknown[],
  options: { customDir?: string; changedTopicIds?: string[] } = {}
): Promise<boolean> {
  const baseDir = baseDirOf(options.customDir)
  const state = await ensureState(baseDir)
  const changed =
    state.materialized && Array.isArray(options.changedTopicIds) ? new Set(options.changedTopicIds) : null
  pendingSave = {
    topics,
    // Overlapping saves merge their change sets and keep the newest array —
    // the drained write then covers every id from both, at latest content.
    changed: pendingSave ? mergeChanged(pendingSave.changed, changed) : changed,
    baseDir
  }
  if (saveInFlight) return saveInFlight

  saveInFlight = (async () => {
    let ok = true
    while (pendingSave) {
      const next = pendingSave
      pendingSave = null
      try {
        await writeShards(next)
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

async function readShards(
  dir: string,
  indexOrder: string[]
): Promise<{ topics: unknown[]; order: string[] }> {
  let fileNames: string[] = []
  try {
    fileNames = (await fs.readdir(dir)).filter((name) => name.endsWith('.json') && name !== INDEX_FILE_NAME)
  } catch {
    return { topics: [], order: [] }
  }
  const present = new Set(fileNames)
  const expected = new Map<string, string>() // file name → listed id
  for (const id of indexOrder) expected.set(shardFileName(id), id)

  const topics: unknown[] = []
  const order: string[] = []
  const loadedIds = new Set<string>()
  const readShard = async (fileName: string): Promise<{ id: string; value: unknown } | null> => {
    try {
      const value: unknown = JSON.parse(await fs.readFile(join(dir, fileName), 'utf8'))
      if (hasStringId(value)) return { id: value.id, value }
      console.error(`[loadTopicsFromDisk] shard without string id: ${fileName}`)
    } catch {
      console.error(`[loadTopicsFromDisk] unreadable shard skipped: ${fileName}`)
    }
    return null
  }
  for (const id of indexOrder) {
    const fileName = shardFileName(id)
    if (!present.has(fileName) || loadedIds.has(id)) continue
    const shard = await readShard(fileName)
    if (!shard) continue
    topics.push(shard.value)
    order.push(shard.id)
    loadedIds.add(shard.id)
  }
  // Shards the index does not know about — a crash between a shard write and
  // the index commit. Recover them at the end rather than losing the topic.
  for (const fileName of fileNames) {
    if (expected.has(fileName)) continue
    const shard = await readShard(fileName)
    if (!shard || loadedIds.has(shard.id)) continue
    topics.push(shard.value)
    order.push(shard.id)
    loadedIds.add(shard.id)
  }
  return { topics, order }
}

export async function loadTopicsFromDisk(customDir?: string): Promise<unknown[]> {
  const baseDir = baseDirOf(customDir)
  const dir = shardDirOf(baseDir)
  let indexOrder: string[] | null = null
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(join(dir, INDEX_FILE_NAME), 'utf8'))
    const order = (parsed as { order?: unknown })?.order
    if (Array.isArray(order)) indexOrder = order.filter((id): id is string => typeof id === 'string')
  } catch {
    // Fall through to the legacy single file.
  }
  if (indexOrder) {
    const { topics, order } = await readShards(dir, indexOrder)
    states.set(baseDir, { order, materialized: !existsSync(join(baseDir, LEGACY_FILE_NAME)) })
    return topics
  }
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(join(baseDir, LEGACY_FILE_NAME), 'utf8'))
    if (Array.isArray(parsed)) {
      states.set(baseDir, { order: idsOf(parsed), materialized: false })
      return parsed
    }
    return []
  } catch {
    return []
  }
}
