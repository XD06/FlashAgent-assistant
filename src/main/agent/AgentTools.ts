import { exec } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { isWin } from '../platform'
import type { ToolDefinition } from '../ai/OpenAICompatibleClient'
import type { CommandShell } from '@shared/types'

const MAX_READ_LINES = 2000
// Reading loads the whole file into a string first — cap the size so the
// model cannot ask for a multi-GB file and balloon main-process memory.
const MAX_READ_FILE_SIZE = 10 * 1024 * 1024
const MAX_LIST_ENTRIES = 500
const MAX_COMMAND_OUTPUT = 10_000
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000
const MAX_COMMAND_TIMEOUT_MS = 300_000

// The agent operates on real files by design — safety comes from per-call user
// approval, not a sandbox. These are only the last-resort guards.

/** Catastrophic commands are refused outright, even if the user clicks allow. */
const FORBIDDEN_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|\\|~\/?|"?[a-z]:[\\/]?"?)\s*$/i, // rm -rf on a root/home/drive
  /\bmkfs\b/i,
  /\bformat(\.com)?\s+[a-z]:/i,
  /\bshutdown\b|\breboot\b/i,
  /\bdel\s+\/[sq].*[a-z]:\\(\s|$)/i, // del /s /q C:\
  /\brd\s+\/s.*[a-z]:\\(\s|$)/i,
  /\breg\s+(add|delete)\b/i,
  /\bdd\s+.*\bof=\/dev\//i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/ // fork bomb
]

/** Files whose contents are likely secrets — reading them also needs approval. */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|[\\/])\.env([.-]|$)/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/i,
  /\.(pem|pfx|p12|key)$/i,
  /(^|[\\/])(credentials|secrets?)(\.[a-z]+)?$/i,
  /(^|[\\/])\.(npmrc|netrc|git-credentials)$/i
]

export function isForbiddenCommand(command: string): boolean {
  return FORBIDDEN_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
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
  return `Run a shell command in the working directory (${shellSyntaxLabel(kind)}). Returns stdout+stderr, truncated to 10KB. Not interactive.`
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
    description: 'List the entries of a directory. Directories are suffixed with "/".',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path. Defaults to the working directory.' }
      },
      required: []
    }
  },
  {
    name: 'search_files',
    description:
      'Recursively search for files by name glob and/or line content regex. Returns "path:line: snippet" matches. Much cheaper than reading files one by one — prefer this to locate code. You MUST provide at least one of "glob" or "pattern" (or both).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to search. Defaults to the working directory.' },
        glob: { type: 'string', description: 'Filename glob like "*.ts" or "config.*". Optional, but at least one of glob/pattern is required.' },
        pattern: { type: 'string', description: 'Case-insensitive regex matched against each line. Optional, but at least one of glob/pattern is required.' },
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
  await fs.mkdir(dirname(filePath), { recursive: true })
  const existed = existsSync(filePath)
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
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const names = entries
    .slice(0, MAX_LIST_ENTRIES)
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort()
  const suffix = entries.length > MAX_LIST_ENTRIES ? `\n... (${entries.length - MAX_LIST_ENTRIES} more entries)` : ''
  return `${dirPath}:\n${names.join('\n')}${suffix}`
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

  let shell: string | undefined
  let execCommand = command
  const resolved = resolveCommandShell(shellPref)
  if (resolved === 'gitbash') {
    shell = undefined
    // exec quoting for bash -c is fragile on Windows; pass through cmd with the
    // bash binary quoted and the command single-argument escaped.
    execCommand = `"${findGitBash()}" -c "${command.replace(/(["\\$`])/g, '\\$1')}"`
  } else if (resolved === 'pwsh') {
    shell = findPwsh() ?? 'powershell.exe'
  } else if (resolved === 'powershell') {
    shell = 'powershell.exe'
  } else if (resolved === 'cmd') {
    shell = 'cmd.exe'
  } else {
    shell = '/bin/bash'
  }

  return new Promise<string>((promiseResolve, promiseReject) => {
    const child = exec(
      execCommand,
      {
        cwd: workingDir,
        timeout,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        // Force UTF-8 for piped Python output — on zh-CN Windows it defaults
        // to GBK, which Node then mis-decodes as UTF-8 (mojibake).
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        ...(shell ? { shell } : {})
      },
      (error, stdout, stderr) => {
        const merged = [stdout, stderr].filter(Boolean).join('\n---stderr---\n').trim()
        const truncated =
          merged.length > MAX_COMMAND_OUTPUT ? `${merged.slice(0, MAX_COMMAND_OUTPUT)}\n... (output truncated)` : merged
        if (error) {
          if (error.killed) {
            promiseReject(new Error(`Command timed out after ${Math.round(timeout / 1000)}s.\n${truncated}`))
          } else {
            // Non-zero exit is useful signal for the model, not a hard failure.
            promiseResolve(`Exit code ${error.code ?? 1}\n${truncated || '(no output)'}`)
          }
          return
        }
        promiseResolve(truncated || '(no output)')
      }
    )
    if (onOutput) {
      // Live output for the UI while the command runs; the exec callback above
      // still delivers the complete (merged, truncated) result to the model.
      child.stdout?.on('data', (data) => onOutput(String(data)))
      child.stderr?.on('data', (data) => onOutput(String(data)))
    }
    signal?.addEventListener('abort', () => child.kill(), { once: true })
  })
}

const SEARCH_SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'coverage', '__pycache__', 'target'])
const MAX_SEARCH_VISITED = 5000
const MAX_SEARCH_RESULTS = 200
const MAX_SEARCH_FILE_SIZE = 1024 * 1024

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^\\\\/]*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
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
  const results: string[] = []
  let visited = 0
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
        if (nameRegExp && !nameRegExp.test(entry.name)) continue
        if (!pattern) {
          results.push(full)
          continue
        }
        try {
          const stat = await fs.stat(full)
          if (stat.size > MAX_SEARCH_FILE_SIZE) continue
          const content = await fs.readFile(full, 'utf8')
          if (content.includes('\u0000')) continue // binary
          const lines = content.split(/\r?\n/)
          for (let i = 0; i < lines.length && results.length < maxResults; i++) {
            if (pattern.test(lines[i])) results.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
          }
        } catch {
          // unreadable file — skip
        }
      }
    }
  }
  await walk(root)
  if (!results.length) return `No matches under ${root}`
  const capped = results.length >= maxResults ? ` (capped at ${maxResults})` : ''
  return `${results.length} match(es) under ${root}${capped}:\n${results.join('\n')}`
}

/** True when this call must be approved by the user before running. */
export function requiresApproval(name: string, args: Record<string, unknown>, workingDir: string): boolean {
  if (name === 'write_file' || name === 'edit_file' || name === 'run_command') return true
  if (name === 'read_file') {
    try {
      return isSensitivePath(resolveAgentPath(workingDir, asString(args.path)))
    } catch {
      return false
    }
  }
  return false
}

export type CommandRisk = 'safe' | 'dangerous' | 'forbidden'

// Destructive-but-legitimate commands: always require explicit approval,
// even in full-access mode or after "always allow".
const DANGEROUS_COMMANDS: RegExp[] = [
  /\brm\b/,
  /(?:^|[;&|(\s])(?:rd|rmdir|del|erase)\b/,
  /remove-item\b|(?:^|[;&|(\s])ri\s/,
  /\bgit\s+(?:reset\s+--hard|clean\b|push\b.*(?:--force\b|\s-f\b)|branch\s+-d\b|checkout\s+--\s)/,
  /\btaskkill\b/,
  /\bstop-process\b/,
  /(?:^|[;&|(\s])kill(?:all)?\s/,
  /\brestart-computer\b/,
  /\bchmod\s+(?:-r\b|.*777)/,
  /\bchown\s+-r\b/,
  /\bicacls\b/,
  /\bdiskpart\b/,
  /\bdrop\s+(?:database|table)\b/,
  /\bformat\b/
]

/** Classify a shell command. 'forbidden' is never executed; 'dangerous'
 * always pauses for user approval even when approvals are otherwise waived;
 * 'safe' follows the normal approval rules. */
export function assessCommandRisk(command: string): CommandRisk {
  const text = command.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!text) return 'safe'
  if (isForbiddenCommand(text)) return 'forbidden'
  if (DANGEROUS_COMMANDS.some((pattern) => pattern.test(text))) return 'dangerous'
  return 'safe'
}

/** One-line human summary of a tool call for the approval card. Paths inside
 * the working directory are shown relative to it to keep the row compact. */
export function summarizeToolCall(name: string, args: Record<string, unknown>, workingDir?: string): string {
  switch (name) {
    case 'run_command':
      return asString(args.command)
    case 'search_files':
      return [asString(args.glob), asString(args.pattern)].filter(Boolean).join(' · ')
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
  try {
    const filePath = resolveAgentPath(workingDir, asString(args.path))
    const content = existsSync(filePath) ? await fs.readFile(filePath, 'utf8') : null
    return { path: filePath, content }
  } catch {
    return null
  }
}

/** Restore a snapshot: rewrite the original content, or delete a created file. */
export async function restoreSnapshot(snapshot: MutationSnapshot): Promise<void> {
  if (snapshot.content === null) {
    await fs.rm(snapshot.path, { force: true })
  } else {
    await fs.writeFile(snapshot.path, snapshot.content, 'utf8')
  }
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
