import { exec, spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { isWin } from '../platform'
import type { ToolDefinition } from '../ai/OpenAICompatibleClient'
import type { AiMessageInput, AskUserAnswer, AskUserOption, AskUserPrompt, CommandShell, TodoItem } from '@shared/types'
import { MAX_MUTATION_BYTES, mutationTooLargeError } from './mutationLimits'

const MAX_READ_LINES = 2000
// Reading loads the whole file into a string first — cap the size so the
// model cannot ask for a multi-GB file and balloon main-process memory.
const MAX_READ_FILE_SIZE = 10 * 1024 * 1024
const MAX_LIST_ENTRIES = 500
const MAX_COMMAND_OUTPUT = 1_000_000
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000
const MAX_COMMAND_TIMEOUT_MS = 300_000

// The agent operates on real files by design — safety comes from per-call user
// approval, not a sandbox. These are only the last-resort guards.

/** Catastrophic commands are refused outright, even if the user clicks allow. */
const FORBIDDEN_COMMAND_PATTERNS: RegExp[] = [
  // Flags accept --long forms; a trailing comment must not defeat the $ anchor.
  /\brm\s+(-{1,2}[a-z]*[rf][a-z-]*\s+)+(\/|\\|~\/?|"?[a-z]:[\\/]?"?)\s*(?:[#;].*)?$/i,
  /\bmkfs\b/i,
  /\bformat(\.com)?\s+[a-z]:/i,
  /\bshutdown\b|\breboot\b/i,
  /\bdel\s+\/[sq].*[a-z]:\\?"?(\s|$)/i, // del /s /q C:\ (quoted drive included)
  /\b(?:rd|rmdir)\s+\/s.*[a-z]:/i, // recursive dir removal reaching a drive path
  /\breg(?:\.exe)?\s+(add|delete|import)\b/i,
  /\bdd\s+.*\bof=\/dev\//i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/ // fork bomb
]

/** Files whose contents are likely secrets — reading them also needs approval. */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|[\\/])\.env([.-]|$)/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])(id_rsa|id_ed25519|id_ecdsa|id_dsa)([._-][\w.-]*)?$/i,
  /\.(pem|pfx|p12|key)$/i,
  /(^|[\\/])(credentials|secrets?)(\.[a-z]+)?$/i,
  /(^|[\\/])\.(npmrc|netrc|git-credentials|pypirc|vault-token)$/i,
  /(^|[\\/])\.(bash|zsh|sh)_history$/i,
  /(^|[\\/])\.kube([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /(^|[\\/])\.docker[\\/]config\.json$/i,
  /(^|[\\/])\.config[\\/]gcloud([\\/]|$)/i
]

const FORBIDDEN_HEAD_RE = /^(?:rm|del|erase|rd|rmdir|remove-item|ri|reg(?:\.exe)?|mkfs|format(?:\.com)?|shutdown|reboot|dd|:\(\))/i

export function isForbiddenCommand(command: string): boolean {
  const segments = splitShellSegments(command)
  if (!segments.length) return FORBIDDEN_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
  return (
    segments.some((seg) => {
      if (isShellWrapperSegment(seg) || FORBIDDEN_HEAD_RE.test(seg)) {
        return FORBIDDEN_COMMAND_PATTERNS.some(
          (pattern) => pattern.test(seg) || pattern.test(unwrapShellQuotes(seg))
        )
      }
      return FORBIDDEN_COMMAND_PATTERNS.some((pattern) => pattern.test(stripQuotedStrings(seg)))
    }) || FORBIDDEN_COMMAND_PATTERNS.some((pattern) => pattern.test(stripQuotedStrings(command)))
  )
}

export function isSensitivePath(filePath: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(filePath))
}

/** Relative paths resolve against the session working dir; absolute paths are
 * used as-is (the agent edits real files, guarded by user approval). */
export function resolveAgentPath(workingDir: string, inputPath: string): string {
  const trimmed = inputPath.trim()
  if (!trimmed) throw new Error('path must not be empty')
  const expanded = trimmed.startsWith('~') ? resolve(homedir(), trimmed.slice(1).replace(/^[\\/]/, '')) : trimmed
  return isAbsolute(expanded) ? resolve(expanded) : resolve(workingDir, expanded)
}

let cachedBashPath: string | null | undefined
/** Locate Git Bash on Windows; returns null when unavailable (fallback: pwsh). */
export function findGitBash(): string | null {
  if (cachedBashPath !== undefined) return cachedBashPath
  const candidates = [
    process.env.ProgramFiles ? resolve(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : '',
    process.env['ProgramFiles(x86)'] ? resolve(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe') : '',
    process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe') : '',
    // Custom install location: derive from the Git\cmd entry on PATH.
    ...(process.env.PATH ?? '')
      .split(';')
      .filter((entry) => /[\\/]Git[\\/]cmd[\\/]?$/i.test(entry.trim()))
      .map((entry) => resolve(entry.trim(), '..', 'bin', 'bash.exe'))
  ].filter(Boolean)
  cachedBashPath = candidates.find((candidate) => existsSync(candidate)) ?? null
  return cachedBashPath
}

let cachedPwshPath: string | null | undefined
/** Locate PowerShell 7+ (pwsh.exe) on Windows — a separate install from the
 * built-in Windows PowerShell 5 (powershell.exe); returns null when absent. */
export function findPwsh(): string | null {
  if (cachedPwshPath !== undefined) return cachedPwshPath
  const candidates = [
    process.env.ProgramFiles ? resolve(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe') : '',
    ...(process.env.PATH ?? '')
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => resolve(entry, 'pwsh.exe'))
  ].filter(Boolean)
  cachedPwshPath = candidates.find((candidate) => existsSync(candidate)) ?? null
  return cachedPwshPath
}

export type ResolvedShellKind = 'gitbash' | 'pwsh' | 'powershell' | 'cmd' | 'bash'

/** Map the user's shell preference to what will actually run. 'auto' prefers
 * Git Bash, then pwsh, then Windows PowerShell 5 (always present), and an
 * unavailable explicit choice degrades the same way — so the label shown to
 * the model never lies about the real executor. */
export function resolveCommandShell(pref: CommandShell = 'auto'): ResolvedShellKind {
  if (!isWin) return 'bash'
  if (pref === 'powershell') return 'powershell'
  if (pref === 'cmd') return 'cmd'
  if (pref === 'pwsh') return findPwsh() ? 'pwsh' : 'powershell'
  if (findGitBash()) return 'gitbash'
  return findPwsh() ? 'pwsh' : 'powershell'
}

/** Shell name + syntax contract, injected verbatim into the run_command tool
 * description and the agent system prompt so the model stops mixing bash
 * pipes into PowerShell (and vice versa). */
export function shellSyntaxLabel(kind: ResolvedShellKind): string {
  switch (kind) {
    case 'gitbash':
      return 'Git Bash on Windows — use bash syntax'
    case 'pwsh':
      return 'PowerShell 7 (pwsh) — use PowerShell syntax (chain with `;`, Select-String instead of grep), NOT bash'
    case 'powershell':
      return 'Windows PowerShell 5 — use PowerShell syntax (chain with `;`, Select-String instead of grep), NOT bash'
    case 'cmd':
      return 'Windows CMD (cmd.exe) — use CMD syntax (dir, findstr, chain with &), NOT bash or PowerShell'
    case 'bash':
      return 'bash'
  }
}

function runCommandDescription(kind: ResolvedShellKind): string {
  return `Run a shell command in the working directory (${shellSyntaxLabel(kind)}). Returns stdout+stderr up to 1MB; long results can be read later in pages from the local tool-output archive. Not interactive.`
}

export const agentToolDefinitions: ToolDefinition[] = [
  {
    name: 'read_file',
    description:
      'Read a text file and return its content with line numbers. Use offset/limit for large files (max 2000 lines per call).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute, or relative to the working directory).' },
        offset: { type: 'number', description: '1-based line number to start reading from. Default 1.' },
        limit: { type: 'number', description: 'Max lines to return. Default 2000.' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content. Parent directories are created automatically.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute, or relative to the working directory).' },
        content: { type: 'string', description: 'Full file content to write.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact text snippet in a file. old_text must match exactly once — include enough surrounding lines to make it unique. Set replace_all to true to replace every occurrence instead. Matching tolerates line-ending (CRLF/LF) and trailing-whitespace differences, but indentation must match exactly.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute, or relative to the working directory).' },
        old_text: { type: 'string', description: 'Exact existing text to replace (must be unique in the file unless replace_all is true).' },
        new_text: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence of old_text. Default false.' }
      },
      required: ['path', 'old_text', 'new_text']
    }
  },
  {
    name: 'list_dir',
    description:
      'List the entries of a directory. Directories are suffixed with "/". Use max_depth to inspect subdirectories as a tree (e.g. max_depth=2).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path. Defaults to the working directory.' },
        max_depth: { type: 'number', description: 'Depth of directory traversal (1 to 3). Default 1 (flat listing).' }
      },
      required: []
    }
  },
  {
    name: 'search_files',
    description:
      'Recursively search for files by name glob and/or line content regex. Returns "path:line: snippet" matches. Set context_lines to include surrounding lines. Much cheaper than reading files one by one — prefer this to locate code. You MUST provide at least one of "glob" or "pattern" (or both).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to search. Defaults to the working directory.' },
        glob: { type: 'string', description: 'Filename glob like "*.ts" or "config.*". Optional, but at least one of glob/pattern is required.' },
        pattern: { type: 'string', description: 'Case-insensitive regex matched against each line. Optional, but at least one of glob/pattern is required.' },
        context_lines: { type: 'number', description: 'Number of surrounding context lines before and after match (0 to 3). Default 0.' },
        max_results: { type: 'number', description: 'Max matches to return. Default 50, max 200.' }
      },
      required: []
    }
  },
  {
    name: 'run_command',
    // Baseline description assumes 'auto'; agentToolDefinitionsForShell()
    // rewrites it per the user's configured shell before each request.
    description: runCommandDescription(resolveCommandShell('auto')),
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to execute.' },
        timeout_seconds: { type: 'number', description: 'Kill the command after this many seconds. Default 60, max 300.' }
      },
      required: ['command']
    }
  },
  {
    name: 'read_tool_output',
    description:
      'Read a saved page of a prior Agent tool result by call_id. Use this when replayed history says an older result was omitted or truncated, instead of rerunning an expensive command. offset is zero-based characters; limit defaults to 8000 and is capped at 10000.',
    parameters: {
      type: 'object',
      properties: {
        call_id: { type: 'string', description: 'The call_id shown in an omitted tool-result replay.' },
        offset: { type: 'number', description: 'Zero-based character offset. Default 0.' },
        limit: { type: 'number', description: 'Characters to read. Default 8000, maximum 10000.' }
      },
      required: ['call_id']
    }
  },
  {
    name: 'todo_list',
    description:
      'Update or view the task checklist for the current complex task. Use this to break down multi-step tasks into clear steps and track progress (pending -> in_progress -> completed). The checklist is displayed prominently to the user.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description:
            'The complete ordered list of task items. Each item must have text and status ("pending", "in_progress", or "completed").',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Step number or id like "1", "2".' },
              text: { type: 'string', description: 'Actionable description of this step.' },
              status: {
                type: 'string',
                description: 'Current status: pending, in_progress, or completed.'
              }
            },
            required: ['text', 'status']
          }
        }
      },
      required: ['tasks']
    }
  },
  {
    name: 'ask_user',
    description:
      'Ask the user a focused clarifying question, present structured options, or request high-impact confirmation/input before continuing. Supports single/multi-select options plus free-text reply. Only invoke when genuine ambiguity or an impactful decision blocks progress — do not interrupt routine steps.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Concise question displayed prominently to the user.' },
        options: {
          type: 'array',
          description: 'Optional choices as objects ({ label, description? }) or short label strings.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Short option label.' },
              description: { type: 'string', description: 'Optional brief explanation or trade-off.' }
            },
            required: ['label']
          }
        },
        multi_select: { type: 'boolean', description: 'Allow selecting multiple options. Default false.' },
        allow_custom: { type: 'boolean', description: 'Show a custom text input alongside options. Default true.' },
        placeholder: { type: 'string', description: 'Optional hint shown inside the custom input box.' }
      },
      required: ['question']
    }
  }
]

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

async function readFileTool(workingDir: string, args: Record<string, unknown>): Promise<string> {
  const filePath = resolveAgentPath(workingDir, asString(args.path))
  const stat = await fs.stat(filePath)
  if (stat.size > MAX_READ_FILE_SIZE) {
    throw new Error(
      `File is too large to read (${Math.round(stat.size / 1024 / 1024)} MB, limit ${MAX_READ_FILE_SIZE / 1024 / 1024} MB): ${filePath}`
    )
  }
  const raw = await fs.readFile(filePath, 'utf8')
  const lines = raw.split(/\r?\n/)
  const offset = Math.max(1, typeof args.offset === 'number' ? Math.floor(args.offset) : 1)
  const limit = Math.min(MAX_READ_LINES, Math.max(1, typeof args.limit === 'number' ? Math.floor(args.limit) : MAX_READ_LINES))
  const slice = lines.slice(offset - 1, offset - 1 + limit)
  const numbered = slice.map((line, i) => `${offset + i}→${line}`).join('\n')
  const remaining = lines.length - (offset - 1 + slice.length)
  const suffix = remaining > 0 ? `\n... (${remaining} more lines, total ${lines.length})` : ''
  // EOL tag so the model knows what to expect before writing an edit_file old_text.
  return `${filePath} (lines ${offset}-${offset + slice.length - 1} of ${lines.length}, ${detectEol(raw)}):\n${numbered}${suffix}`
}

async function writeFileTool(workingDir: string, args: Record<string, unknown>): Promise<string> {
  const filePath = resolveAgentPath(workingDir, asString(args.path))
  const content = asString(args.content)
  const contentBytes = Buffer.byteLength(content, 'utf8')
  if (contentBytes > MAX_MUTATION_BYTES) throw mutationTooLargeError(filePath, contentBytes)
  // Refuse to replace a file we cannot snapshot: the undo path would be lost
  // and the old content would be read into memory anyway.
  let existed = true
  try {
    const stat = await fs.stat(filePath)
    if (stat.size > MAX_MUTATION_BYTES) throw mutationTooLargeError(filePath, stat.size)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    existed = false
  }
  await fs.mkdir(dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf8')
  return `${existed ? 'Overwrote' : 'Created'} ${filePath} (${content.length} chars)`
}

interface MatchRange {
  start: number
  end: number
}

function findExactMatches(raw: string, oldText: string): MatchRange[] {
  const ranges: MatchRange[] = []
  for (let i = raw.indexOf(oldText); i >= 0; i = raw.indexOf(oldText, i + oldText.length)) {
    ranges.push({ start: i, end: i + oldText.length })
  }
  return ranges
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Match old_text with line-ending tolerance: models almost always emit \n
 * while files checked out on Windows are often CRLF, which breaks exact
 * byte matching. Every newline in old_text matches \r\n, \n or \r. */
function findFlexibleMatches(raw: string, oldText: string): MatchRange[] {
  const pattern = new RegExp(escapeRegExp(oldText).replace(/\r\n|\r|\n/g, '\\r?\\n'), 'g')
  const ranges: MatchRange[] = []
  for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

/** Last-resort match: additionally tolerate trailing whitespace at the end of
 * each line — editors strip it, models add it, and the mismatch is invisible
 * in any rendering. Leading indentation stays significant: it carries meaning
 * and relaxing it invites wrong-place matches. */
function findWhitespaceTolerantMatches(raw: string, oldText: string): MatchRange[] {
  const source = escapeRegExp(oldText)
    .replace(/[ \t]*(?:\r\n|\r|\n)/g, '[ \\t]*\\r?\\n')
    .replace(/[ \t]*$/, '[ \\t]*')
  const pattern = new RegExp(source, 'g')
  const ranges: MatchRange[] = []
  for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

function detectEol(raw: string): 'CRLF' | 'LF' {
  return raw.includes('\r\n') ? 'CRLF' : 'LF'
}

/** Actionable diagnosis for a failed edit_file match — point the model at the
 * closest spot instead of sending it off to blindly re-read the whole file. */
function buildEditFailureHint(raw: string, oldText: string, fileName: string): string {
  const eol = detectEol(raw)
  const fileLines = raw.split(/\r?\n/)
  const oldLines = oldText.split(/\r?\n/)
  const firstLine = oldLines.map((line) => line.trim()).find((line) => line.length > 0)
  if (firstLine) {
    const index = fileLines.findIndex((line) => line.trim() === firstLine || (firstLine.length >= 8 && line.includes(firstLine)))
    if (index >= 0) {
      const from = index + 1
      const to = Math.min(fileLines.length, index + oldLines.length)
      return `old_text not found in ${fileName} (file uses ${eol} line endings). Its first line appears at line ${from}, but the following lines diverge from the file — re-read lines ${from}-${to} and rebuild old_text from the actual content.`
    }
  }
  return `old_text not found in ${fileName} (${fileLines.length} lines, ${eol} line endings) — re-read the file, or use search_files to locate the text first, then match the exact current content.`
}

/** Convert replacement text to the file's dominant line ending so a CRLF
 * file does not end up with mixed endings after a tolerant match. */
function matchFileEol(text: string, raw: string): string {
  const crlf = (raw.match(/\r\n/g) ?? []).length
  const bareLf = (raw.match(/[^\r]\n|^\n/g) ?? []).length
  return crlf > bareLf ? text.replace(/\r?\n/g, '\r\n') : text
}

async function editFileTool(workingDir: string, args: Record<string, unknown>): Promise<string> {
  const filePath = resolveAgentPath(workingDir, asString(args.path))
  const oldText = asString(args.old_text)
  const newText = asString(args.new_text)
  if (!oldText) throw new Error('old_text must not be empty')
  const stat = await fs.stat(filePath)
  if (stat.size > MAX_MUTATION_BYTES) throw mutationTooLargeError(filePath, stat.size)
  const raw = await fs.readFile(filePath, 'utf8')
  // Tiered matching: exact bytes first, then line-ending tolerance, then
  // trailing-whitespace tolerance — each tier only runs when the stricter
  // one found nothing, so a clean match can never be shadowed.
  let ranges = findExactMatches(raw, oldText)
  let replacement = newText
  if (!ranges.length) {
    ranges = findFlexibleMatches(raw, oldText)
    if (!ranges.length) ranges = findWhitespaceTolerantMatches(raw, oldText)
    if (ranges.length) replacement = matchFileEol(newText, raw)
  }
  if (!ranges.length) {
    throw new Error(buildEditFailureHint(raw, oldText, basename(filePath)))
  }
  if (ranges.length > 1 && args.replace_all !== true) {
    throw new Error(`old_text matches multiple locations (${ranges.length}) in ${basename(filePath)} — include more surrounding context to make it unique, or set replace_all to true`)
  }
  let removedBytes = 0
  for (const range of ranges) {
    removedBytes += Buffer.byteLength(raw.slice(range.start, range.end), 'utf8')
  }
  const finalBytes = Buffer.byteLength(raw, 'utf8') - removedBytes + Buffer.byteLength(replacement, 'utf8') * ranges.length
  if (finalBytes > MAX_MUTATION_BYTES) throw mutationTooLargeError(filePath, finalBytes)
  let next = ''
  let cursor = 0
  for (const range of ranges) {
    next += raw.slice(cursor, range.start) + replacement
    cursor = range.end
  }
  next += raw.slice(cursor)
  await fs.writeFile(filePath, next, 'utf8')
  return args.replace_all === true
    ? `Edited ${filePath} (replaced ${ranges.length} occurrence${ranges.length === 1 ? '' : 's'})`
    : `Edited ${filePath} (replaced ${oldText.length} chars with ${replacement.length} chars)`
}

async function listDirTool(workingDir: string, args: Record<string, unknown>): Promise<string> {
  const dirPath = asString(args.path) ? resolveAgentPath(workingDir, asString(args.path)) : workingDir
  const maxDepth = Math.min(3, Math.max(1, typeof args.max_depth === 'number' ? Math.floor(args.max_depth) : 1))

  if (maxDepth <= 1) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    const names = entries
      .slice(0, MAX_LIST_ENTRIES)
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort()
    const suffix = entries.length > MAX_LIST_ENTRIES ? `\n... (${entries.length - MAX_LIST_ENTRIES} more entries)` : ''
    return `${dirPath}:\n${names.join('\n')}${suffix}`
  }

  const lines: string[] = []
  let totalCount = 0

  const walk = async (currentDir: string, depth: number, indent: string): Promise<void> => {
    if (depth > maxDepth || totalCount >= MAX_LIST_ENTRIES) return
    let entries
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1
      if (!a.isDirectory() && b.isDirectory()) return 1
      return a.name.localeCompare(b.name)
    })
    for (const entry of entries) {
      if (totalCount >= MAX_LIST_ENTRIES) break
      if (entry.name.startsWith('.') || SEARCH_SKIP_DIRS.has(entry.name)) continue
      totalCount++
      if (entry.isDirectory()) {
        lines.push(`${indent}${entry.name}/`)
        await walk(resolve(currentDir, entry.name), depth + 1, `${indent}  `)
      } else {
        lines.push(`${indent}${entry.name}`)
      }
    }
  }

  await walk(dirPath, 1, '  ')
  const suffix = totalCount >= MAX_LIST_ENTRIES ? `\n... (${totalCount} entries, capped at ${MAX_LIST_ENTRIES})` : ''
  return `${dirPath} (tree max_depth=${maxDepth}):\n${lines.join('\n')}${suffix}`
}

function runCommandTool(
  workingDir: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  onOutput?: (chunk: string) => void,
  shellPref: CommandShell = 'auto'
): Promise<string> {
  const command = asString(args.command).trim()
  if (!command) return Promise.reject(new Error('command must not be empty'))
  if (isForbiddenCommand(command)) {
    return Promise.reject(new Error('Command refused: it matches the destructive-command blacklist'))
  }
  const timeoutSeconds = typeof args.timeout_seconds === 'number' ? args.timeout_seconds : 0
  const timeout = Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(1000, timeoutSeconds > 0 ? timeoutSeconds * 1000 : DEFAULT_COMMAND_TIMEOUT_MS))

  // The command always travels as ONE argv entry, never re-assembled into a
  // command line: handing `"bash" -c "…"` to exec lets cmd.exe re-parse the
  // quoted line, so a `"` inside the approved bash command flips cmd's quoting
  // state and a following `&` starts a second OS command.
  const resolved = resolveCommandShell(shellPref)
  let file: string
  let shellArgs: string[]
  let verbatim = false
  if (resolved === 'gitbash') {
    file = findGitBash() ?? 'bash.exe'
    shellArgs = ['-c', command]
  } else if (resolved === 'pwsh') {
    file = findPwsh() ?? 'powershell.exe'
    shellArgs = ['-c', command]
  } else if (resolved === 'powershell') {
    file = 'powershell.exe'
    shellArgs = ['-c', command]
  } else if (resolved === 'cmd') {
    // cmd.exe has its own quoting rules — hand it the pre-quoted line verbatim,
    // the same shape exec's shell mode used.
    file = 'cmd.exe'
    shellArgs = ['/d', '/s', '/c', `"${command}"`]
    verbatim = true
  } else {
    file = '/bin/bash'
    shellArgs = ['-c', command]
  }

  return new Promise<string>((promiseResolve, promiseReject) => {
    const child = spawn(file, shellArgs, {
      cwd: workingDir,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      // Force UTF-8 for piped Python output — on zh-CN Windows it defaults to
      // GBK, which Node then mis-decodes as UTF-8 (mojibake).
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    })
    const cap = MAX_COMMAND_OUTPUT + 1024
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const onData = (target: 'out' | 'err') => (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      if (target === 'out') {
        if (stdout.length < cap) stdout += text
      } else if (stderr.length < cap) {
        stderr += text
      }
      // Live output for the UI while the command runs; the promise below still
      // delivers the complete (merged, truncated) result to the model.
      onOutput?.(text)
    }
    child.stdout?.on('data', onData('out'))
    child.stderr?.on('data', onData('err'))

    // The shell forks the real command, so killing the wrapper alone leaves the
    // work running (and the abort button lying). Take the whole tree down.
    const killTree = (): void => {
      if (child.pid === undefined || child.exitCode !== null) return
      if (isWin) exec(`taskkill /pid ${child.pid} /t /f`, () => undefined)
      else child.kill()
    }
    const onAbort = (): void => killTree()

    const finish = (code: number | string | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const merged = [stdout, stderr].filter(Boolean).join('\n---stderr---\n').trim()
      const truncated =
        merged.length > MAX_COMMAND_OUTPUT ? `${merged.slice(0, MAX_COMMAND_OUTPUT)}\n... (output truncated)` : merged
      if (timedOut) {
        promiseReject(new Error(`Command timed out after ${Math.round(timeout / 1000)}s.\n${truncated}`))
        return
      }
      // Non-zero exit is useful signal for the model, not a hard failure.
      if (code === 0) promiseResolve(truncated || '(no output)')
      else promiseResolve(`Exit code ${code ?? 1}\n${truncated || '(no output)'}`)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeout)
    child.on('error', (error: NodeJS.ErrnoException) => finish(error.code ?? 1))
    child.on('close', (code) => finish(code))
    if (signal?.aborted) killTree()
  })
}

const SEARCH_SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'coverage', '__pycache__', 'target'])
const MAX_SEARCH_VISITED = 5000
const MAX_SEARCH_RESULTS = 200
const MAX_SEARCH_FILE_SIZE = 1024 * 1024

function globToRegExp(glob: string): RegExp {
  const input = glob.replace(/\\/g, '/')
  let source = ''
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (char === '*') {
      if (input[index + 1] === '*') {
        while (input[index + 1] === '*') index++
        if (input[index + 1] === '/') {
          index++
          source += '(?:.*/)?'
        } else source += '.*'
      } else source += '[^/]*'
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    if (char === '/') {
      source += '/'
      continue
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'i')
}

async function searchFilesTool(workingDir: string, args: Record<string, unknown>): Promise<string> {
  const root = asString(args.path) ? resolveAgentPath(workingDir, asString(args.path)) : workingDir
  const globPattern = asString(args.glob)
  const patternSource = asString(args.pattern)
  if (!globPattern && !patternSource) throw new Error('provide "glob" and/or "pattern"')
  let pattern: RegExp | null = null
  if (patternSource) {
    try {
      pattern = new RegExp(patternSource, 'i')
    } catch {
      throw new Error(`invalid regex pattern: ${patternSource}`)
    }
  }
  const nameRegExp = globPattern ? globToRegExp(globPattern) : null
  const maxResults = Math.min(
    MAX_SEARCH_RESULTS,
    Math.max(1, typeof args.max_results === 'number' ? Math.floor(args.max_results) : 50)
  )
  const contextLines = Math.min(3, Math.max(0, typeof args.context_lines === 'number' ? Math.floor(args.context_lines) : 0))
  const results: string[] = []
  let visited = 0
  let skippedSensitive = 0
  const walk = async (dir: string): Promise<void> => {
    if (results.length >= maxResults || visited >= MAX_SEARCH_VISITED) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable directory
    }
    for (const entry of entries) {
      if (results.length >= maxResults || visited >= MAX_SEARCH_VISITED) return
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        await walk(full)
      } else if (entry.isFile()) {
        visited += 1
        const candidate = globPattern.includes('/') || globPattern.includes('\\') ? relative(root, full).replace(/\\/g, '/') : entry.name
        if (nameRegExp && !nameRegExp.test(candidate)) continue
        if (!pattern) {
          results.push(full)
          continue
        }
        try {
          const stat = await fs.stat(full)
          if (stat.size > MAX_SEARCH_FILE_SIZE) continue
          // Never return the contents of a file read_file would gate behind an
          // approval card: search must not become a silent bypass of it.
          if (isSensitivePath(full)) {
            skippedSensitive += 1
            continue
          }
          const content = await fs.readFile(full, 'utf8')
          if (content.includes('\u0000')) continue // binary
          const lines = content.split(/\r?\n/)
          for (let i = 0; i < lines.length && results.length < maxResults; i++) {
            if (pattern.test(lines[i])) {
              if (contextLines === 0) {
                results.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
              } else {
                const start = Math.max(0, i - contextLines)
                const end = Math.min(lines.length - 1, i + contextLines)
                for (let c = start; c <= end; c++) {
                  const sep = c === i ? ':' : '-'
                  results.push(`${full}${sep}${c + 1}${sep} ${lines[c].trim().slice(0, 200)}`)
                }
              }
            }
          }
        } catch {
          // unreadable file — skip
        }
      }
    }
  }
  await walk(root)
  const sensitiveNote = skippedSensitive
    ? `\n(${skippedSensitive} sensitive file(s) skipped; read one with read_file to request approval)`
    : ''
  if (!results.length) return `No matches under ${root}${sensitiveNote}`
  const capped = results.length >= maxResults ? ` (capped at ${maxResults})` : ''
  return `${results.length} match(es) under ${root}${capped}:\n${results.join('\n')}${sensitiveNote}`
}

/** True when this call must be approved by the user before running. */
export function requiresApproval(name: string, args: Record<string, unknown>, workingDir: string): boolean {
  if (name === 'write_file' || name === 'edit_file' || name === 'run_command') return true
  if (name !== 'read_file' && name !== 'list_dir' && name !== 'search_files') return false
  try {
    // No path means the working directory itself (list_dir / search_files).
    const resolved = resolveAgentPath(workingDir, asString(args.path) || '.')
    // The working directory is the agent's declared scope: reading outside it is
    // an escape hatch (browser profile DBs, other projects, shell history) and
    // must be a deliberate, visible decision — a filename blacklist alone cannot
    // cover every credential store on the machine.
    return isSensitivePath(resolved) || isOutsideDir(workingDir, resolved)
  } catch {
    return false
  }
}

function isOutsideDir(dir: string, target: string): boolean {
  const rel = relative(resolve(dir), target)
  return rel.startsWith('..') || isAbsolute(rel)
}

export type CommandRisk = 'safe' | 'dangerous' | 'forbidden'

export interface AssessCommandRiskOptions {
  /** True when the user explicitly enabled Agent Full Access mode. */
  fullAccess?: boolean
  /** Workspace root used to decide whether local deletions stay in bounds. */
  workingDir?: string
}

function stripQuotedStrings(cmd: string): string {
  return cmd.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '""')
}

function unwrapShellQuotes(cmd: string): string {
  return cmd.replace(/['"]/g, ' ')
}

function splitShellSegments(cmd: string): string[] {
  const segments: string[] = []
  let quote: "'" | '"' | null = null
  let escape = false
  let start = 0
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (escape) {
      escape = false
      continue
    }
    if (quote === '"') {
      if (ch === '\\') escape = true
      else if (ch === '"') quote = null
      continue
    }
    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === ';' || ch === '|') {
      segments.push(cmd.slice(start, i))
      if (ch === '|' && cmd[i + 1] === '|') i++
      start = i + 1
      continue
    }
    if (ch === '&' && cmd[i + 1] === '&') {
      segments.push(cmd.slice(start, i))
      i++
      start = i + 1
    }
  }
  segments.push(cmd.slice(start))
  return segments.map((s) => s.trim()).filter(Boolean)
}

function tokenizeSegmentArgs(seg: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(seg)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3])
  }
  return tokens
}

const SHELL_WRAPPER_RE =
  /^\s*(?:sudo\s+|eval\s+|iex\b|invoke-expression\b|xargs\b|cmd(?:\.exe)?\s+\/[ck]\b|(?:pwsh|powershell)(?:\.exe)?\s+(?:[^\n]*?\s)?-(?:c|command)\b|(?:ba|z|da|a)?sh\s+-c\b)/i

function isShellWrapperSegment(seg: string): boolean {
  return SHELL_WRAPPER_RE.test(seg) || /\bfind\b[^\n]*-exec\b/i.test(seg)
}

const CD_HEAD_RE = /^(?:cd|chdir|set-location|sl|pushd)\b/i
const DELETE_HEAD_RE = /^(?:rm|del|erase|rd|rmdir|remove-item|ri|clear-content|clc)\b/i
const PS_VALUE_FLAGS = new Set([
  '-erroraction',
  '-ea',
  '-warningaction',
  '-informationaction',
  '-include',
  '-exclude',
  '-filter'
])

// Destructive-but-legitimate commands: require explicit user confirmation even
// when normal approvals are waived, unless a narrower rule marks a safe workspace case.
const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\bgit\s+(?:reset\s+--hard|checkout\b[^\n]*\s--\s)/i,
  /\bgit\s+clean\b(?![^\n]*(?:\s-(?:[a-zA-Z]*n|--dry-run)(?:\s|$)))/i,
  /\bgit\s+push\b[^\n]*(?:(?<![\w-])--force(?![\w-])|(?:\s|^)-[a-zA-Z]*f(?:\s|$))/i,
  // Case-sensitive for git branch -D (force delete); lowercase -d only deletes merged branches.
  /\bgit\s+branch\b[^\n]*(?:\s-[a-zA-Z]*D\b|\s--delete\s+--force\b)/,
  /(?:^|[;&|()])\s*(?:taskkill|stop-process|spps|kill(?:all)?)\b/i,
  /\b(?:re)?start-computer\b|\bstop-computer\b/i,
  /\bchmod\s+(?:-[a-z]*r|\S*777)\b/i,
  /\bchown\s+-[a-z]*r\b/i,
  /\bicacls\b[^\n]*\/(?:grant|deny|remove|setowner|reset|restore|inheritance)\b/i,
  /\b(?:diskpart|format(?:\.com)?\s+[a-z]:|format-volume|clear-disk|vssadmin|cipher\s+\/w|clear-recyclebin)\b/i,
  /\b(?:drop\s+(?:database|table|schema)|truncate\s+table)\b/i,
  /\bdd\b[^\n]*\bof=/i
]

function isDangerousDeleteSegment(
  seg: string,
  options: AssessCommandRiskOptions,
  effectiveCwd: string,
  escapedWorkingDir: boolean
): boolean {
  const tokens = tokenizeSegmentArgs(seg)
  if (!tokens.length) return true
  const head = tokens[0].toLowerCase()
  const rest = tokens.slice(1)

  const flags: string[] = []
  const targets: string[] = []
  let afterDoubleDash = false
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]
    if (!afterDoubleDash && tok === '--') {
      afterDoubleDash = true
      continue
    }
    const colonPathMatch = !afterDoubleDash ? /^-(?:literal)?path:(.+)$/i.exec(tok) : null
    if (colonPathMatch) {
      targets.push(colonPathMatch[1])
      continue
    }
    if (!afterDoubleDash && (tok.startsWith('-') || (head === 'del' || head === 'erase' || head === 'rd' || head === 'rmdir' ? tok.startsWith('/') : false))) {
      const lowerFlag = tok.toLowerCase()
      flags.push(lowerFlag)
      // Consume PowerShell value arguments like `-ErrorAction SilentlyContinue`
      if (PS_VALUE_FLAGS.has(lowerFlag) && i + 1 < rest.length) {
        i++
      }
      continue
    }
    targets.push(tok)
  }

  // Dry-run deletions never remove files
  if (flags.some((f) => f === '-n' || f === '--dry-run' || f === '-whatif')) return false

  // Directory removal tools or recursive / forced / wildcard flags always confirm
  if (head === 'rd' || head === 'rmdir') return true
  const hasRecursiveOrForceFlag = flags.some((f) =>
    /^(?:--(?:recursive|force)|-[a-z]*(?:r|f)[a-z]*|-recurse|-force|\/(?:s|f|q))$/i.test(f)
  )
  if (hasRecursiveOrForceFlag) return true
  if (targets.some((t) => /[*?]/.test(t))) return true

  // Without Full Access enabled, any explicit deletion pauses for approval
  if (!options.fullAccess) return true

  // Pipelined deletion without explicit filename (`... | Remove-Item`) stays guarded
  if (targets.length === 0 || escapedWorkingDir) return true

  const rootDir = options.workingDir
  return targets.some((target) => {
    if (isSensitivePath(target)) return true
    if (rootDir) {
      try {
        const resolved = resolveAgentPath(effectiveCwd || rootDir, target)
        return isOutsideDir(rootDir, resolved) || isSensitivePath(resolved)
      } catch {
        return true
      }
    }
    return isAbsolute(target) || target.startsWith('~') || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(target)
  })
}

/** Classify a shell command. 'forbidden' is never executed; 'dangerous'
 * always pauses for user approval even when approvals are otherwise waived;
 * 'safe' follows the normal approval rules. */
export function assessCommandRisk(command: string, options: AssessCommandRiskOptions = {}): CommandRisk {
  const normalized = command.replace(/\s+/g, ' ').trim()
  if (!normalized) return 'safe'
  if (isForbiddenCommand(normalized)) return 'forbidden'

  const segments = splitShellSegments(normalized)
  let effectiveCwd = options.workingDir ?? ''
  let escapedWorkingDir = false

  for (const seg of segments) {
    if (isShellWrapperSegment(seg)) {
      const unwrapped = unwrapShellQuotes(seg)
      if (/[`]|\$\(/.test(unwrapped)) return 'dangerous'
      if (DELETE_HEAD_RE.test(unwrapped.replace(/^\s*(?:cmd(?:\.exe)?\s+\/[ck]|(?:pwsh|powershell)(?:\.exe)?\s+[^\n]*?-(?:c|command)|(?:ba|z|da|a)?sh\s+-c)\s+/i, ''))) {
        const inner = unwrapped.replace(/^\s*(?:cmd(?:\.exe)?\s+\/[ck]|(?:pwsh|powershell)(?:\.exe)?\s+[^\n]*?-(?:c|command)|(?:ba|z|da|a)?sh\s+-c)\s+/i, '')
        if (isDangerousDeleteSegment(inner, options, effectiveCwd, escapedWorkingDir)) return 'dangerous'
      } else if (/\b(?:rm|del|erase|rd|rmdir|remove-item|ri|clear-content)\b/i.test(unwrapped)) {
        return 'dangerous'
      }
      if (DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(unwrapped))) return 'dangerous'
      continue
    }

    if (CD_HEAD_RE.test(seg)) {
      const args = tokenizeSegmentArgs(seg).slice(1)
      const dest = args.find((tok) => !tok.startsWith('-') && tok.toLowerCase() !== '/d')
      if (dest && options.workingDir) {
        try {
          const nextDir = resolveAgentPath(effectiveCwd || options.workingDir, dest)
          if (isOutsideDir(options.workingDir, nextDir)) escapedWorkingDir = true
          else effectiveCwd = nextDir
        } catch {
          escapedWorkingDir = true
        }
      } else if (dest) {
        if (isAbsolute(dest) || dest.startsWith('~') || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(dest)) {
          escapedWorkingDir = true
        }
      }
      continue
    }

    if (DELETE_HEAD_RE.test(seg)) {
      if (isDangerousDeleteSegment(seg, options, effectiveCwd, escapedWorkingDir)) return 'dangerous'
      continue
    }

    const unquoted = stripQuotedStrings(seg)
    if (DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(unquoted))) return 'dangerous'
  }

  return 'safe'
}

/** One-line human summary of a tool call for the approval card. Paths inside
 * the working directory are shown relative to it to keep the row compact. */
export function summarizeToolCall(name: string, args: Record<string, unknown>, workingDir?: string): string {
  switch (name) {
    case 'todo_list': {
      const tasks = parseTodoTasks(args.tasks)
      const done = tasks.filter((t) => t.status === 'completed').length
      return `Update checklist (${done}/${tasks.length} done)`
    }
    case 'ask_user':
      return asString(args.question).trim() || 'Question'
    case 'run_command':
      return asString(args.command)
    case 'search_files':
      return [asString(args.path), asString(args.glob), asString(args.pattern)].filter(Boolean).join(' · ')
    case 'read_tool_output':
      return asString(args.call_id)
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'list_dir': {
      const path = asString(args.path) || (name === 'list_dir' ? '.' : '')
      if (workingDir && path) {
        try {
          const resolved = resolveAgentPath(workingDir, path)
          const rel = relative(workingDir, resolved)
          if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel
          return resolved
        } catch {
          return path
        }
      }
      return path
    }
    default:
      return JSON.stringify(args).slice(0, 200)
  }
}

export function parseAskUserArgs(args: Record<string, unknown>): AskUserPrompt {
  const question = asString(args.question).trim()
  const rawOptions = Array.isArray(args.options) ? args.options : []
  const seen = new Set<string>()
  const options: AskUserOption[] = []
  for (const item of rawOptions) {
    if (options.length >= 8) break
    if (typeof item === 'string') {
      const label = item.trim()
      if (label && !seen.has(label)) {
        seen.add(label)
        options.push({ label })
      }
      continue
    }
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>
      const label = asString(obj.label ?? obj.title ?? obj.value).trim()
      if (!label || seen.has(label)) continue
      seen.add(label)
      const description = asString(obj.description ?? obj.desc).trim()
      options.push(description ? { label, description } : { label })
    }
  }
  const multiSelect = args.multi_select === true || args.allow_multiple === true
  // Always keep free-text enabled when no selectable options exist so the user is never stuck.
  const allowCustom = args.allow_custom === false && options.length > 0 ? false : true
  const placeholder = asString(args.placeholder).trim() || undefined
  return { question, options, multiSelect, allowCustom, ...(placeholder ? { placeholder } : {}) }
}

export function formatAskUserResult(prompt: AskUserPrompt, answer: AskUserAnswer): string {
  if (!answer.answered) {
    return `[User skipped/dismissed question "${prompt.question}" without providing an answer.]`
  }
  const lines: string[] = [`User answered "${prompt.question}":`]
  if (answer.selectedOptions?.length) {
    lines.push(`- Selected: ${answer.selectedOptions.join(', ')}`)
  }
  if (answer.customText?.trim()) {
    lines.push(`- Response: ${answer.customText.trim()}`)
  }
  return lines.join('\n')
}

export function parseTodoTasks(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .map((t, idx) => ({
      id: typeof t.id === 'string' && t.id.trim() ? t.id.trim() : String(idx + 1),
      text: typeof t.text === 'string' ? t.text.trim() : '',
      status: (['pending', 'in_progress', 'completed'].includes(String(t.status)) ? t.status : 'pending') as 'pending' | 'in_progress' | 'completed'
    }))
    .filter((t) => t.text.length > 0)
}

export function formatChecklistAnchor(tasks: TodoItem[]): string {
  if (!tasks.length) return ''
  const completed = tasks.filter((t) => t.status === 'completed').length
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length
  const pending = tasks.filter((t) => t.status === 'pending').length
  const formatted = tasks
    .map((t) => {
      const mark = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[>]' : '[ ]'
      return `${mark} ${t.id}. ${t.text}`
    })
    .join('\n')
  return `(${completed}/${tasks.length} completed, ${inProgress} in progress, ${pending} pending):\n${formatted}`
}

export function findLatestChecklistState(messages: AiMessageInput[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.toolTrace?.length) {
      for (let j = m.toolTrace.length - 1; j >= 0; j--) {
        const t = m.toolTrace[j]
        if (t.name === 'todo_list') {
          try {
            const parsed = JSON.parse(t.argsJson || '{}')
            const tasks = parseTodoTasks(parsed.tasks)
            if (tasks.length > 0) {
              return formatChecklistAnchor(tasks)
            }
          } catch {
            // ignore
          }
        }
      }
    }
  }
  return null
}

function todoListTool(args: Record<string, unknown>): string {
  const tasks = parseTodoTasks(args.tasks)
  const completed = tasks.filter((t) => t.status === 'completed').length
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length
  const pending = tasks.filter((t) => t.status === 'pending').length

  const formatted = tasks
    .map((t) => {
      const mark = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[>]' : '[ ]'
      return `${mark} ${t.id}. ${t.text}`
    })
    .join('\n')

  return `Task checklist updated (${completed}/${tasks.length} completed, ${inProgress} in progress, ${pending} pending):\n${formatted}\n(Action required: Checklist updated. Now proceed to execute the real tools for your active step; do not call todo_list again until step progress changes.)`
}

export type ToolConcurrency = 'read' | 'command' | 'serial'

const READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_dir',
  'search_files',
  'read_tool_output',
  'todo_list',
  'web_search'
])

const MCP_MUTATING_TOKEN_RE =
  /(?:^|[_-])(?:write|edit|create|delete|del|remove|rm|rmdir|unlink|drop|truncate|kill|stop|terminate|exec|execute|run|bash|shell|cmd|powershell|post|put|patch|update|upsert|insert|save|upload|send|trigger|deploy|install|mkdir|move|rename|copy|append|modify|set|reset|clear|format|wipe|click|drag|fill|type|press|hover|navigate|close|new|select|submit)(?:[_-]|$)/i

const MCP_READ_TOKEN_RE =
  /(?:^|[_-])(?:read|get|list|ls|search|fetch|find|show|describe|inspect|view|query|extract|scrape|crawl|map|browse|lookup|resolve|check|status|stat|info|ping|count|verify)(?:[_-]|$)/i

export function isReadOnlyTool(name: string, mcpReadOnlyHint?: boolean): boolean {
  if (READ_ONLY_TOOLS.has(name)) return true
  if (name.startsWith('mcp__')) {
    const secondSep = name.indexOf('__', 5)
    const raw = secondSep >= 0 ? name.slice(secondSep + 2) : name.slice(5)
    const normalized = raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    if (MCP_MUTATING_TOKEN_RE.test(normalized)) return false
    if (mcpReadOnlyHint === false) return false
    if (mcpReadOnlyHint === true) return true
    return MCP_READ_TOKEN_RE.test(normalized)
  }
  return false
}

const FILE_REDIRECT_RE = /(?:^|\s)\d?>>?\s*(?!&\d\b|\/dev\/null\b|\$null\b)\S/i

const MUTATING_OR_LOCKING_CMD_RE: RegExp[] = [
  /\b(?:tee|out-file|set-content|add-content)\b|-outfile\b/i,
  /\b(?:npm|pnpm|yarn|bun|pip|pip3|uv|poetry|cargo|composer|gem|apt|apt-get|brew|choco|winget|scoop)\s+(?:install|i|add|remove|rm|uninstall|update|up|upgrade|ci|link|unlink|rebuild|publish|build|dist(?::|\b))\b/i,
  /\b(?:electron-vite|electron-builder|vite)\s+build\b/i,
  /\bgit\s+(?:add|commit|push|pull|fetch|merge|rebase|cherry-pick|checkout|switch|restore|reset|stash|clean|tag|worktree|submodule|am|apply|revert|branch\s+-[dDmMfF]|gc|prune|init|clone)\b/i,
  /(?:^|[;&|(\s])(?:rm|rmdir|rd|del|erase|mv|move|ren|rename|cp|copy|mkdir|md|touch|ln|chmod|chown|icacls|attrib|new-item|remove-item|copy-item|move-item|rename-item|clear-content|taskkill|stop-process|kill)\b/i,
  /\b(?:curl|wget)\b[^|;&\n]*(?:(?:-o|-O|--output)\b|-X\s*(?:POST|PUT|PATCH|DELETE)\b|--request\s+(?:POST|PUT|PATCH|DELETE)\b|\s-(?:d|F)\b|--data\b)/i,
  /\bdocker(?:-compose|\s+compose)?\s+(?:build|up|down|rm|stop|kill|start|restart|run|exec)\b/i
]

const READ_ONLY_SEGMENT_HEAD_RE =
  /^(?:cd|chdir|set-location|sl|pushd|echo|write-output|write-host|out-null|git\s+(?:status|diff|log|show|branch(?!\s+-[dDmMfF])|rev-parse|describe|remote|ls-files|ls-tree|config\s+--(?:get|list))|ls|dir|cat|head|tail|type|more|less|rg|grep|egrep|fgrep|ag|fd|findstr|find|wc|pwd|which|where|whereis|whoami|hostname|uname|date|ps|tasklist|env|printenv|ping|nslookup|dig|tracert|traceroute|netstat|stat|file|du|df|tree|realpath|readlink|get-content|gc|get-childitem|gci|get-item|gi|get-itemproperty|gp|get-location|gl|get-process|gps|get-service|gsv|get-nettcpconnection|get-date|select-object|select|select-string|sls|where-object|sort-object|sort|measure-object|measure|format-table|ft|format-list|fl|out-string|test-path|resolve-path|split-path|convertfrom-json|convertfrom-csv|curl|invoke-webrequest|iwr|invoke-restmethod|irm|pip3?\s+(?:list|show|freeze)|npm\s+(?:ls|list|view|-v|--version)|pnpm\s+(?:ls|list|-v|--version)|node\s+(?:-v|--version)|python3?\s+(?:-V|--version))\b/i

/** True when a shell command appears free of workspace/git/package mutations
 * so consecutive independent commands from one model turn can run concurrently. */
export function isParallelSafeCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  if (assessCommandRisk(trimmed) !== 'safe') return false
  if (FILE_REDIRECT_RE.test(stripQuotedStrings(trimmed))) return false
  return !MUTATING_OR_LOCKING_CMD_RE.some((re) => re.test(trimmed))
}

/** True when every chained/piped segment of a shell command is a read-only inspection or harmless cd/echo preamble. */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!isParallelSafeCommand(trimmed)) return false
  if (/[`]|\$\(/.test(trimmed)) return false
  const segments = splitShellSegments(trimmed)
  if (!segments.length) return false
  return segments.every((seg) => {
    const cleaned = seg.replace(/(?:^|\s)\d?>>?\s*(?:&\d|\/dev\/null|\$null)\s*$/i, '').trim()
    return cleaned.length > 0 && READ_ONLY_SEGMENT_HEAD_RE.test(cleaned)
  })
}

/** Determine whether a tool call may run in parallel with adjacent read/command
 * calls, or must execute on its own as a sequential barrier. */
export function classifyToolConcurrency(
  name: string,
  args: Record<string, unknown>,
  mcpReadOnlyHint?: boolean
): ToolConcurrency {
  if (isReadOnlyTool(name, mcpReadOnlyHint)) return 'read'
  if (name === 'run_command') {
    const cmd = typeof args.command === 'string' ? args.command : ''
    if (isReadOnlyCommand(cmd)) return 'read'
    if (isParallelSafeCommand(cmd)) return 'command'
  }
  return 'serial'
}

export interface MutationSnapshot {
  path: string
  /** Original file content, or null when the file did not exist yet. */
  content: string | null
}

/** Capture the pre-image of a write/edit so the user can revert it later. */
export async function snapshotForMutation(
  name: string,
  args: Record<string, unknown>,
  workingDir: string
): Promise<MutationSnapshot | null> {
  if (name !== 'write_file' && name !== 'edit_file') return null
  const filePath = resolveAgentPath(workingDir, asString(args.path))
  try {
    const stat = await fs.stat(filePath)
    if (stat.size > MAX_MUTATION_BYTES) throw mutationTooLargeError(filePath, stat.size)
    return { path: filePath, content: await fs.readFile(filePath, 'utf8') }
  } catch (error) {
    // Only "file does not exist yet" is a valid null snapshot. Permission and
    // size errors must surface so the tool never mutates without an undo path.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { path: filePath, content: null }
    throw error
  }
}

/** Restore a snapshot: rewrite the original content, or delete a created file. */
export async function restoreSnapshot(snapshot: MutationSnapshot): Promise<void> {
  if (snapshot.content === null) {
    await fs.rm(snapshot.path, { force: true })
    return
  }
  if (typeof snapshot.content !== 'string') {
    throw new Error(`Invalid snapshot for ${snapshot.path}; refusing to modify the file.`)
  }
  const bytes = Buffer.byteLength(snapshot.content, 'utf8')
  if (bytes > MAX_MUTATION_BYTES) throw mutationTooLargeError(snapshot.path, bytes)
  await fs.writeFile(snapshot.path, snapshot.content, 'utf8')
}

export async function executeAgentTool(
  name: string,
  args: Record<string, unknown>,
  workingDir: string,
  signal?: AbortSignal,
  onOutput?: (chunk: string) => void,
  shellPref?: CommandShell
): Promise<string> {
  switch (name) {
    case 'read_file':
      return readFileTool(workingDir, args)
    case 'write_file':
      return writeFileTool(workingDir, args)
    case 'edit_file':
      return editFileTool(workingDir, args)
    case 'search_files':
      return searchFilesTool(workingDir, args)
    case 'list_dir':
      return listDirTool(workingDir, args)
    case 'todo_list':
      return todoListTool(args)
    case 'ask_user':
      throw new Error('ask_user must be handled by an interactive Agent session')
    case 'run_command':
      return runCommandTool(workingDir, args, signal, onOutput, shellPref)
    default:
      throw new Error(`Unknown agent tool: ${name}`)
  }
}

/** Tool definitions with the run_command contract rewritten for the user's
 * configured shell — evaluated per request so a settings change (or Git Bash
 * appearing/disappearing) is reflected without restart. */
export function agentToolDefinitionsForShell(pref: CommandShell): ToolDefinition[] {
  const kind = resolveCommandShell(pref)
  return agentToolDefinitions.map((def) =>
    def.name === 'run_command' ? { ...def, description: runCommandDescription(kind) } : def
  )
}
