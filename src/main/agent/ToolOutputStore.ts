import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

const MAX_OUTPUTS = 100
const MAX_OUTPUT_CHARS = 1_000_000
const DEFAULT_READ_CHARS = 8_000
const MAX_READ_CHARS = 10_000

interface StoredToolOutput {
  output: string
  savedAt: number
}

let dirPromise: Promise<string> | null = null

function outputDir(root?: string): Promise<string> {
  if (root) return fs.mkdir(root, { recursive: true }).then(() => root)
  if (!dirPromise) {
    dirPromise = (async () => {
      const dir = join(app.getPath('userData'), 'tool-outputs')
      await fs.mkdir(dir, { recursive: true })
      return dir
    })()
  }
  return dirPromise
}

function fileFor(dir: string, callId: string): string {
  return join(dir, `${callId.replace(/[^\w-]/g, '_')}.json`)
}

function capStoredOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output
  const head = output.slice(0, Math.floor(MAX_OUTPUT_CHARS * 0.7))
  const tail = output.slice(-Math.floor(MAX_OUTPUT_CHARS * 0.25))
  return `${head}\n[... ${output.length - head.length - tail.length} chars omitted from local archive ...]\n${tail}`
}

async function prune(dir: string): Promise<void> {
  const files = await fs.readdir(dir, { withFileTypes: true })
  const saved = await Promise.all(
    files
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => ({ path: join(dir, entry.name), stat: await fs.stat(join(dir, entry.name)) }))
  )
  saved.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
  await Promise.all(saved.slice(MAX_OUTPUTS).map((entry) => fs.unlink(entry.path)))
}

/** Persist complete agent-tool output locally so an expensive command does
 * not need to run again merely because its replay was later compacted. */
export async function saveToolOutput(callId: string, output: string, root?: string): Promise<void> {
  try {
    const dir = await outputDir(root)
    const record: StoredToolOutput = { output: capStoredOutput(output), savedAt: Date.now() }
    await fs.writeFile(fileFor(dir, callId), JSON.stringify(record), 'utf8')
    await prune(dir)
  } catch {
    // Best effort: normal tool execution must not fail because archival failed.
  }
}

/** Read one bounded page from a persisted result. The bounded page is small
 * enough to travel through the normal in-turn tool-result safety cap. */
export async function readToolOutput(callId: string, offset?: number, limit?: number, root?: string): Promise<string> {
  try {
    const dir = await outputDir(root)
    const raw = JSON.parse(await fs.readFile(fileFor(dir, callId), 'utf8')) as Partial<StoredToolOutput>
    if (typeof raw.output !== 'string') return `No saved output found for call_id=${JSON.stringify(callId)}.`
    const startOffset = Number.isFinite(offset) ? Math.floor(offset!) : 0
    const requestedCount = Number.isFinite(limit) ? Math.floor(limit!) : DEFAULT_READ_CHARS
    const start = Math.min(raw.output.length, Math.max(0, startOffset))
    const count = Math.min(MAX_READ_CHARS, Math.max(1, requestedCount))
    const end = Math.min(raw.output.length, start + count)
    const next = end < raw.output.length ? `\n[more available: offset=${end}]` : ''
    return `[saved output ${start}-${end} of ${raw.output.length} for call_id=${callId}]\n${raw.output.slice(start, end)}${next}`
  } catch {
    return `No saved output found for call_id=${JSON.stringify(callId)}.`
  }
}
