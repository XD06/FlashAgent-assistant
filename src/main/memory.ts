import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'

// Two-layer memory, both plain markdown the user (or the agent, with approval)
// edits directly: a global file in userData for personal preferences, and the
// standard AGENTS.md in the working directory for project conventions.

/** Cap per file so a runaway memory file cannot blow up the context. */
const MAX_MEMORY_CHARS = 6000

const GLOBAL_MEMORY_TEMPLATE = `# Memory

<!-- 长期记忆：AI 每次对话都会读取这里的内容。 -->
<!-- 用一行一条的要点记录你的偏好，例如： -->
<!-- - 回答时代码注释使用中文 -->
`

export function getGlobalMemoryPath(userDataDir: string): string {
  return join(userDataDir, 'memory.md')
}

export function getProjectMemoryPath(workingDir: string): string {
  return join(workingDir, 'AGENTS.md')
}

/** Read a memory file; missing/unreadable files are simply empty memory. */
export async function readMemoryFile(filePath: string): Promise<string> {
  try {
    const raw = (await fs.readFile(filePath, 'utf8')).trim()
    if (raw.length <= MAX_MEMORY_CHARS) return raw
    return `${raw.slice(0, MAX_MEMORY_CHARS)}\n... (memory truncated)`
  } catch {
    return ''
  }
}

/** Create the global memory file with a starter template if it is missing. */
export async function ensureGlobalMemoryFile(userDataDir: string): Promise<string> {
  const filePath = getGlobalMemoryPath(userDataDir)
  if (!existsSync(filePath)) {
    await fs.writeFile(filePath, GLOBAL_MEMORY_TEMPLATE, 'utf8')
  }
  return filePath
}

/** Build the system-prompt section for the chat window. Empty when there is
 * nothing to inject. */
export async function buildMemoryPrompt(userDataDir: string, workingDir?: string): Promise<string> {
  const globalPath = getGlobalMemoryPath(userDataDir)
  const [globalMemory, projectMemory] = await Promise.all([
    readMemoryFile(globalPath),
    workingDir ? readMemoryFile(getProjectMemoryPath(workingDir)) : Promise.resolve('')
  ])
  const sections: string[] = []
  if (globalMemory) {
    sections.push(`## User memory (durable notes the user asked to keep; stored at ${globalPath})\n${globalMemory}`)
  }
  if (projectMemory) {
    sections.push(`## Project memory (AGENTS.md in the working directory)\n${projectMemory}`)
  }
  return sections.length ? `\n\n${sections.join('\n\n')}` : ''
}
