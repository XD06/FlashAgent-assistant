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
  }
  return null
}
