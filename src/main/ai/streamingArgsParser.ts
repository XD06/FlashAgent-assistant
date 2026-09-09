import { isAbsolute, relative, resolve } from 'node:path'

/**
 * Heuristic parser for incomplete/streaming JSON arguments from LLM tool calls.
 * Allows extracting target file path, streamed file content, and commands
 * in real-time before the JSON payload is fully closed.
 */

export interface StreamingParsedArgs {
  summary: string
  oldText?: string
  content?: string
  command?: string
  charCount: number
}

/** Unescapes a streaming JSON string value up to unescaped quote or EOF. */
export function unescapePartialJsonString(str: string): string {
  let result = ''
  let i = 0
  while (i < str.length) {
    const ch = str[i]
    if (ch === '"') {
      // End of JSON string token
      break
    }
    if (ch === '\\') {
      i++
      if (i >= str.length) break
      const esc = str[i]
      if (esc === 'n') result += '\n'
      else if (esc === 'r') result += '\r'
      else if (esc === 't') result += '\t'
      else if (esc === '"') result += '"'
      else if (esc === '\\') result += '\\'
      else if (esc === '/') result += '/'
      else if (esc === 'u') {
        const hex = str.slice(i + 1, i + 5)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          result += String.fromCharCode(parseInt(hex, 16))
          i += 4
        } else {
          result += 'u'
        }
      } else {
        result += esc
      }
    } else {
      result += ch
    }
    i++
  }
  return result
}

/** Extract a specific string property value from an incomplete JSON object string. */
export function extractPartialProperty(json: string, propName: string): string | null {
  const pattern = new RegExp(`"${propName}"\\s*:\\s*"`, 'i')
  const match = pattern.exec(json)
  if (!match) return null

  const startIndex = match.index + match[0].length
  const remainder = json.slice(startIndex)
  return unescapePartialJsonString(remainder)
}

/**
 * Parses streaming tool arguments and produces real-time UI hints and partial content.
 */
export function parseStreamingToolArgs(
  toolName: string,
  rawArgs: string,
  workingDir?: string
): StreamingParsedArgs {
  try {
    if (!rawArgs || typeof rawArgs !== 'string') {
      return { summary: '...', charCount: 0 }
    }
    const charCount = rawArgs.length

    if (toolName === 'write_file' || toolName === 'edit_file') {
      const path = extractPartialProperty(rawArgs, 'path')
      const oldText = toolName === 'edit_file' ? extractPartialProperty(rawArgs, 'old_text') : undefined
      const content =
        toolName === 'write_file'
          ? extractPartialProperty(rawArgs, 'content')
          : extractPartialProperty(rawArgs, 'new_text')

      let summary = '...'
      if (path) {
        if (workingDir) {
          try {
            const resolved = isAbsolute(path) ? path : resolve(workingDir, path)
            const rel = relative(workingDir, resolved)
            summary = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : resolved
          } catch {
            summary = path
          }
        } else {
          summary = path
        }
      }

      return {
        summary,
        oldText: oldText ? oldText.slice(0, 4000) : undefined,
        content: content ? content.slice(0, 4000) : undefined,
        charCount
      }
    }

    if (toolName === 'run_command') {
      const command = extractPartialProperty(rawArgs, 'command')
      return {
        summary: command || '...',
        command: command ? command.slice(0, 4000) : undefined,
        charCount
      }
    }

    if (toolName === 'read_file' || toolName === 'list_dir') {
      const path = extractPartialProperty(rawArgs, 'path')
      return {
        summary: path || '...',
        charCount
      }
    }

    if (toolName === 'search_files') {
      const query = extractPartialProperty(rawArgs, 'query') || extractPartialProperty(rawArgs, 'pattern')
      return {
        summary: query || '...',
        charCount
      }
    }

    // MCP or generic tool: try common property names
    const candidate =
      extractPartialProperty(rawArgs, 'path') ||
      extractPartialProperty(rawArgs, 'command') ||
      extractPartialProperty(rawArgs, 'query') ||
      extractPartialProperty(rawArgs, 'prompt') ||
      extractPartialProperty(rawArgs, 'url')

    return {
      summary: candidate || (charCount > 0 ? `${charCount} chars` : '...'),
      charCount
    }
  } catch {
    return {
      summary: '...',
      charCount: typeof rawArgs === 'string' ? rawArgs.length : 0
    }
  }
}
