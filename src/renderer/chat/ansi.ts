// Terminal-output rendering (pure logic, no React/DOM) — shared between
// ChatMode's tool-output view and unit tests.
//
// Two independent passes, picked by renderTerminalText():
//   1. parseAnsi      — the program emitted real ANSI SGR colours (pytest,
//                       vite, eslint…). We honour exactly what it sent; this
//                       is what Codex/Claude Code do — they never guess field
//                       semantics, they render the ANSI the program produced.
//   2. semanticHint   — no ANSI at all (the common case: a program detects a
//                       pipe and disables colour). We add a *restrained* hint:
//                       only a leading status token (OK/PASS/FAIL/WARN/exit
//                       code) gets tinted, never arbitrary "fields".

export interface TextSegment {
  text: string
  /** Resolved CSS colour, or undefined to inherit the <pre> default. */
  color?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

// 16-colour palette tuned for a dark terminal background (VS Code-ish).
const BASE = ['#6e7681', '#f14c4c', '#23d18b', '#d7ba7d', '#3b8eea', '#d670d6', '#29b8db', '#e5e5e5']
const BRIGHT = ['#808891', '#ff6d67', '#4ee88f', '#f5f543', '#5aa7ff', '#e58fe5', '#5ad4e6', '#ffffff']

const SEMANTIC_GREEN = '#23d18b'
const SEMANTIC_RED = '#f14c4c'
const SEMANTIC_YELLOW = '#d7ba7d'

// Neutral grey for the read_file line-number gutter — readable on both the
// light tool-output surface and a dark terminal, without pulling focus.
const LINE_NUMBER = '#8b949e'

/** True when the text carries any ANSI escape (SGR or other CSI). */
export function hasAnsi(input: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /\u001b\[/.test(input)
}

/** xterm 256-colour index → #rrggbb. */
function xterm256(n: number): string {
  if (n < 16) return n < 8 ? BASE[n] : BRIGHT[n - 8]
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    const h = v.toString(16).padStart(2, '0')
    return `#${h}${h}${h}`
  }
  const c = n - 16
  const r = Math.floor(c / 36)
  const g = Math.floor((c % 36) / 6)
  const b = c % 6
  const conv = (x: number) => (x === 0 ? 0 : 55 + x * 40).toString(16).padStart(2, '0')
  return `#${conv(r)}${conv(g)}${conv(b)}`
}

interface SgrState {
  color?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  /** Standard 30-37 index remembered so a later bold can brighten it. */
  stdIndex?: number
}

/** Apply one SGR parameter run (already split on ';') to the running state. */
function applySgr(state: SgrState, params: number[]): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i]
    if (p === 0) {
      state.color = undefined
      state.bold = state.dim = state.italic = state.underline = false
      state.stdIndex = undefined
    } else if (p === 1) {
      state.bold = true
      if (state.stdIndex !== undefined) state.color = BRIGHT[state.stdIndex]
    } else if (p === 2) state.dim = true
    else if (p === 3) state.italic = true
    else if (p === 4) state.underline = true
    else if (p === 22) {
      state.bold = state.dim = false
      if (state.stdIndex !== undefined) state.color = BASE[state.stdIndex]
    } else if (p === 23) state.italic = false
    else if (p === 24) state.underline = false
    else if (p >= 30 && p <= 37) {
      state.stdIndex = p - 30
      state.color = state.bold ? BRIGHT[p - 30] : BASE[p - 30]
    } else if (p === 39) {
      state.color = undefined
      state.stdIndex = undefined
    } else if (p >= 90 && p <= 97) {
      state.stdIndex = undefined
      state.color = BRIGHT[p - 90]
    } else if (p === 38) {
      // Extended foreground: 38;5;n (256) or 38;2;r;g;b (truecolor).
      if (params[i + 1] === 5) {
        state.color = xterm256(params[i + 2] ?? 0)
        state.stdIndex = undefined
        i += 2
      } else if (params[i + 1] === 2) {
        const r = params[i + 2] ?? 0
        const g = params[i + 3] ?? 0
        const b = params[i + 4] ?? 0
        state.color = `#${[r, g, b].map((x) => (x & 0xff).toString(16).padStart(2, '0')).join('')}`
        state.stdIndex = undefined
        i += 4
      }
    } else if (p === 48) {
      // Background — skip the same way we do for 38, but consume its params so
      // they don't leak into the loop as foreground codes.
      if (params[i + 1] === 5) i += 2
      else if (params[i + 1] === 2) i += 4
    }
    // 40-47 / 100-107 / 49 (background) and anything else: ignored.
  }
}

/** Parse ANSI SGR sequences into styled segments; strips other CSI (cursor
 * moves, clears) and lone carriage returns so nothing renders as garbage. */
export function parseAnsi(input: string): TextSegment[] {
  const cleaned = input.replace(/\r\n/g, '\n').replace(/\r/g, '')
  const segments: TextSegment[] = []
  const state: SgrState = {}
  // eslint-disable-next-line no-control-regex
  const csi = /\u001b\[([0-9;?]*)([A-Za-z])/g
  let last = 0
  let match: RegExpExecArray | null
  const push = (text: string) => {
    if (!text) return
    segments.push({
      text,
      color: state.color,
      bold: state.bold || undefined,
      dim: state.dim || undefined,
      italic: state.italic || undefined,
      underline: state.underline || undefined
    })
  }
  while ((match = csi.exec(cleaned)) !== null) {
    push(cleaned.slice(last, match.index))
    last = csi.lastIndex
    if (match[2] === 'm') {
      const params = (match[1] || '0').split(';').map((s) => (s === '' ? 0 : Number(s)))
      applySgr(state, params)
    }
    // Non-'m' CSI (cursor/erase): consumed and dropped.
  }
  push(cleaned.slice(last))
  return segments.length ? segments : [{ text: cleaned }]
}

/** Restrained semantic tint for plain (no-ANSI) output: only a leading status
 * token per line is coloured. Mirrors the way Codex leaves body text neutral
 * and only accents obvious status markers — never key=value "fields". */
export function semanticHint(input: string): TextSegment[] {
  const cleaned = input.replace(/\r\n/g, '\n').replace(/\r/g, '')
  const segments: TextSegment[] = []
  const lines = cleaned.split('\n')
  lines.forEach((line, idx) => {
    const lead = classifyLead(line)
    if (lead) {
      segments.push({ text: line.slice(0, lead.length), color: lead.color, bold: true })
      segments.push({ text: line.slice(lead.length) })
    } else {
      segments.push({ text: line })
    }
    if (idx < lines.length - 1) segments.push({ text: '\n' })
  })
  return segments
}

const OK_WORDS = new Set(['OK', 'OKAY', 'PASS', 'PASSED', 'SUCCESS', 'SUCCEEDED', 'DONE'])
const BAD_WORDS = new Set(['FAIL', 'FAILED', 'FAILURE', 'ERROR', 'ERR', 'FATAL'])
const WARN_WORDS = new Set(['WARN', 'WARNING'])

/** Detect a leading status marker; returns the char span to tint and its
 * colour, or null. Handles `[OK]`, `OK `, `✓`, and our `Exit code N` prefix. */
function classifyLead(line: string): { length: number; color: string } | null {
  // Our own non-zero-exit prefix.
  const exit = line.match(/^Exit code (\d+)/)
  if (exit) {
    return { length: exit[0].length, color: exit[1] === '0' ? SEMANTIC_GREEN : SEMANTIC_RED }
  }
  // Symbol markers.
  const sym = line.match(/^\s*([✓✔√✗✘×])/)
  if (sym) {
    const ok = sym[1] === '✓' || sym[1] === '✔' || sym[1] === '√'
    return { length: sym[0].length, color: ok ? SEMANTIC_GREEN : SEMANTIC_RED }
  }
  // Word markers, optionally wrapped in [ ]. Must be a whole word.
  const word = line.match(/^(\s*\[?\s*)([A-Za-z]+)(\s*\]?)(?=\s|:|$)/)
  if (word) {
    const upper = word[2].toUpperCase()
    const color = OK_WORDS.has(upper)
      ? SEMANTIC_GREEN
      : BAD_WORDS.has(upper)
        ? SEMANTIC_RED
        : WARN_WORDS.has(upper)
          ? SEMANTIC_YELLOW
          : null
    if (color) return { length: word[0].length, color }
  }
  return null
}

/** Pick the right pass: honour real ANSI, else add a restrained hint. */
export function renderTerminalText(input: string): TextSegment[] {
  return hasAnsi(input) ? parseAnsi(input) : semanticHint(input)
}

/** Tint only the `NNN→` gutter that read_file emits so a file read stays
 * scannable; the code itself is left neutral (no syntax guessing). */
export function highlightLineNumbers(input: string): TextSegment[] {
  const cleaned = input.replace(/\r\n/g, '\n').replace(/\r/g, '')
  const segments: TextSegment[] = []
  const lines = cleaned.split('\n')
  lines.forEach((line, idx) => {
    const m = line.match(/^(\s*\d+→)/)
    if (m) {
      segments.push({ text: m[1], color: LINE_NUMBER })
      segments.push({ text: line.slice(m[1].length) })
    } else {
      segments.push({ text: line })
    }
    if (idx < lines.length - 1) segments.push({ text: '\n' })
  })
  return segments
}
