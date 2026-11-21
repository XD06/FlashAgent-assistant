import type { ToolDefinition } from '../ai/OpenAICompatibleClient'
import { agentToolDefinitions } from './AgentTools'

// Lightweight argument validation against the JSON Schema already carried by
// each tool definition. Only the subset this project actually uses is
// implemented (object root, string/number/boolean properties, required) — no
// external schema library, per the portable-build size constraint. The goal
// is an actionable error the model can self-correct from, instead of the
// misleading downstream failures loose coercion used to produce (a numeric
// path silently became '' and surfaced as "path must not be empty").

interface PropertySchema {
  type?: string
}

interface ObjectSchema {
  properties?: Record<string, PropertySchema>
  required?: string[]
}

function typeOfValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function previewValue(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text.length > 80 ? `${text.slice(0, 80)}…` : text
  } catch {
    return String(value)
  }
}

/** Compact signature like "{path: string, offset?: number}" for error texts. */
function describeSchema(schema: ObjectSchema): string {
  const required = new Set(schema.required ?? [])
  const parts = Object.entries(schema.properties ?? {}).map(
    ([key, prop]) => `${key}${required.has(key) ? '' : '?'}: ${prop.type ?? 'any'}`
  )
  return `{${parts.join(', ')}}`
}

/** Validate args against a tool definition. Returns null when valid, or an
 * actionable error text meant to be sent back to the model as a tool result. */
export function validateToolArgs(definition: ToolDefinition, args: Record<string, unknown>): string | null {
  const schema = definition.parameters as ObjectSchema
  const properties = schema.properties ?? {}
  const problems: string[] = []

  for (const key of schema.required ?? []) {
    const value = args[key]
    if (value === undefined || value === null) {
      problems.push(`"${key}" (${properties[key]?.type ?? 'any'}) is required but missing`)
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const prop = properties[key]
    // Unknown extra keys are ignored — failing on them would waste a round.
    if (!prop?.type || value === undefined || value === null) continue
    const actual = typeOfValue(value)
    if (actual !== prop.type) {
      problems.push(`"${key}" expected ${prop.type}, got ${actual} ${previewValue(value)}`)
    }
  }

  if (!problems.length) return null
  return `Invalid arguments for ${definition.name}: ${problems.join('; ')}. Expected arguments: ${describeSchema(schema)}. Fix the arguments and call the tool again.`
}

const definitionsByName = new Map(agentToolDefinitions.map((def) => [def.name, def]))

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed'])

function validateNumberMin(name: string, key: string, value: unknown, min: number, exclusive = false): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number') return null
  if (!Number.isFinite(value) || (exclusive ? value <= min : value < min)) {
    return `Invalid arguments for ${name}: "${key}" must be ${exclusive ? '>' : '>='} ${min}.`
  }
  return null
}

/** Validate a built-in agent tool call by name; unknown names pass through
 * (executeAgentTool reports those itself). */
export function validateAgentToolArgs(name: string, args: Record<string, unknown>): string | null {
  const definition = definitionsByName.get(name)
  if (!definition) return null
  const base = validateToolArgs(definition, args)
  if (base) return base
  // search_files needs at least one of glob/pattern — the schema can't
  // express "anyOf required" so we check it here.
  if (name === 'search_files') {
    const glob = typeof args.glob === 'string' ? args.glob.trim() : ''
    const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : ''
    if (!glob && !pattern) {
      return `Invalid arguments for search_files: at least one of "glob" or "pattern" must be provided (both are empty). Pass glob="*.ts" to match filenames, or pattern="someText" to search file contents. Fix the arguments and call the tool again.`
    }
    return (
      validateNumberMin(name, 'context_lines', args.context_lines, 0) ||
      validateNumberMin(name, 'max_results', args.max_results, 1)
    )
  }
  if (name === 'read_file') {
    return validateNumberMin(name, 'offset', args.offset, 1) || validateNumberMin(name, 'limit', args.limit, 1)
  }
  if (name === 'read_tool_output') {
    if (typeof args.call_id === 'string' && !args.call_id.trim()) {
      return 'Invalid arguments for read_tool_output: "call_id" must be a non-empty string.'
    }
    return validateNumberMin(name, 'offset', args.offset, 0) || validateNumberMin(name, 'limit', args.limit, 1)
  }
  if (name === 'list_dir') {
    return validateNumberMin(name, 'max_depth', args.max_depth, 1)
  }
  if (name === 'run_command') {
    if (typeof args.command === 'string' && !args.command.trim()) {
      return 'Invalid arguments for run_command: "command" must be a non-empty string.'
    }
    return validateNumberMin(name, 'timeout_seconds', args.timeout_seconds, 0, true)
  }
  if (name === 'edit_file') {
    const oldText = typeof args.old_text === 'string' ? args.old_text : ''
    const newText = typeof args.new_text === 'string' ? args.new_text : ''
    if (!oldText) {
      return 'Invalid arguments for edit_file: "old_text" must not be empty.'
    }
    if (oldText === newText) {
      return 'Invalid arguments for edit_file: "old_text" and "new_text" are identical — no edit is needed.'
    }
  }
  if (name === 'todo_list') {
    const tasks = args.tasks
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return 'Invalid arguments for todo_list: "tasks" must be a non-empty array of {text, status} objects.'
    }
    for (let i = 0; i < tasks.length; i++) {
      const item = tasks[i]
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return `Invalid arguments for todo_list: tasks[${i}] must be an object with "text" and "status".`
      }
      const record = item as Record<string, unknown>
      if (typeof record.text !== 'string' || !record.text.trim()) {
        return `Invalid arguments for todo_list: tasks[${i}].text must be a non-empty string.`
      }
      if (typeof record.status !== 'string' || !TODO_STATUSES.has(record.status)) {
        return `Invalid arguments for todo_list: tasks[${i}].status must be "pending", "in_progress", or "completed".`
      }
    }
  }
  if (name === 'ask_user') {
    const question = typeof args.question === 'string' ? args.question.trim() : ''
    if (!question) {
      return `Invalid arguments for ask_user: "question" must be a non-empty string. Provide a clear question for the user and call ask_user again.`
    }
  }
  return null
}
