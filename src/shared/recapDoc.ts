// Recap document ("复工文档") v2 — the structured summary that replaces
// compressed-out history. Shared between the main process (validates model
// output at the boundary) and the renderer (parses & merges, since the
// previous summary lives there).
//
// Five fixed sections. Headers are literal Chinese regardless of UI language
// (they are machine-matched anchors; the body follows the conversation's
// language). Two kinds of sections with different lifetimes:
//   - rewrite sections (1/3/5): replaced wholesale on every compression;
//   - ledger sections (2/4): append-only — the model emits only entries newly
//     established in the latest batch, and the code merges them below the
//     existing ledger. Repeated rewriting is lossy compounding; append-only
//     ledgers are what keep long-lived facts from drifting away.

export const RECAP_DOC_TITLE = '# 复工文档'
export const RECAP_DOC_SECTION_HEADERS = [
  '## 1. 原始任务',
  '## 2. 事实台账',
  '## 3. 涉及文件与当前状态',
  '## 4. 失败路径台账',
  '## 5. 当前任务与下一步'
] as const
export const RECAP_DOC_HEADERS = [RECAP_DOC_TITLE, ...RECAP_DOC_SECTION_HEADERS] as const

/** Indices (into sections[]) of the append-only ledger sections. */
const LEDGER_SECTION_INDEXES = [1, 3] as const
/** Rolling cap per ledger — enforced by code, never by asking the model to
 * "tidy up" (a tidy-up is a lossy rewrite, exactly what ledgers exist to avoid). */
export const LEDGER_MAX_LINES = 60
/** Hard cap on the merged document. */
export const RECAP_DOC_MAX_CHARS = 15_000
/** Marker inserted at the top of a ledger once old entries have rolled off. */
export const LEDGER_ROLL_MARK = '- （更早条目已滚动移除）'
/** Placeholder body for an empty section. */
const EMPTY_SECTION = '无'

/** Cut leading chatter ("好的，以下是…") and a trailing markdown fence the
 * model may have wrapped the doc in. Returns null when no doc title exists —
 * the caller treats that as a failed attempt. */
export function stripDocJunk(raw: string): string | null {
  const idx = raw.indexOf(RECAP_DOC_TITLE)
  if (idx === -1) return null
  return raw
    .slice(idx)
    .replace(/\n```\s*$/, '')
    .trim()
}

/** All five section headers must be present, in order, at line starts.
 * Returns null when valid, else a description of what is missing (used in
 * the retry-chain error message). */
export function validateRecapDoc(doc: string): string | null {
  const lines = doc.split('\n')
  let cursor = 0
  const missing: string[] = []
  for (const header of RECAP_DOC_SECTION_HEADERS) {
    let found = -1
    for (let i = cursor; i < lines.length; i++) {
      if (lines[i].trim().startsWith(header)) {
        found = i
        break
      }
    }
    if (found === -1) missing.push(header)
    else cursor = found + 1
  }
  return missing.length ? `missing section header(s): ${missing.join(', ')}` : null
}

/** Split a valid doc into its five section bodies. Returns null when the
 * structure cannot be recovered (e.g. a legacy v1 summary). */
export function parseRecapDoc(doc: string): { sections: string[] } | null {
  const lines = doc.split('\n')
  const headerAt: number[] = []
  let cursor = 0
  for (const header of RECAP_DOC_SECTION_HEADERS) {
    let found = -1
    for (let i = cursor; i < lines.length; i++) {
      if (lines[i].trim().startsWith(header)) {
        found = i
        break
      }
    }
    if (found === -1) return null
    headerAt.push(found)
    cursor = found + 1
  }
  const sections = headerAt.map((start, s) => {
    const end = s + 1 < headerAt.length ? headerAt[s + 1] : lines.length
    return lines
      .slice(start + 1, end)
      .join('\n')
      .trim()
  })
  return { sections }
}

/** Ledger body → entry lines. Drops blanks, the "无" placeholder and roll
 * marks (re-added by the merge when entries actually rolled off). */
function ledgerEntries(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line !== EMPTY_SECTION && line !== `- ${EMPTY_SECTION}` && line !== LEDGER_ROLL_MARK)
}

interface LedgerMergeResult {
  body: string
  rolled: boolean
}

/** prev entries stay on top (oldest first), new entries append below; exact
 * duplicates collapse. Over the cap the oldest entries roll off. */
function mergeLedger(prevBody: string, nextBody: string, hadRolled: boolean): LedgerMergeResult {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const line of [...ledgerEntries(prevBody), ...ledgerEntries(nextBody)]) {
    if (seen.has(line)) continue
    seen.add(line)
    entries.push(line)
  }
  const overflow = entries.length - LEDGER_MAX_LINES
  const kept = overflow > 0 ? entries.slice(overflow) : entries
  const rolled = hadRolled || overflow > 0
  if (!kept.length) return { body: EMPTY_SECTION, rolled }
  return { body: (rolled ? [LEDGER_ROLL_MARK, ...kept] : kept).join('\n'), rolled }
}

function buildDoc(sections: string[]): string {
  const parts = [RECAP_DOC_TITLE]
  RECAP_DOC_SECTION_HEADERS.forEach((header, i) => {
    parts.push(header, sections[i]?.trim() || EMPTY_SECTION)
  })
  return parts.join('\n')
}

/** Merge an incremental doc (`next`, straight from the compression model)
 * into the previous full doc. `prev` being null or unparseable (legacy v1
 * summary) falls back to `next` alone — the old summary rode inside the
 * payload, so its facts resurface as "new" ledger entries. Always returns a
 * doc within RECAP_DOC_MAX_CHARS. */
export function mergeRecapDoc(prev: string | null, next: string): string {
  const nextParsed = parseRecapDoc(next)
  if (!nextParsed) return next.trim().slice(0, RECAP_DOC_MAX_CHARS)
  const prevParsed = prev ? parseRecapDoc(prev) : null

  const sections = [...nextParsed.sections]
  if (prevParsed) {
    for (const i of LEDGER_SECTION_INDEXES) {
      const hadRolled = prevParsed.sections[i].includes(LEDGER_ROLL_MARK)
      sections[i] = mergeLedger(prevParsed.sections[i], nextParsed.sections[i], hadRolled).body
    }
  } else {
    // No previous doc: still normalize the ledgers (dedupe + cap).
    for (const i of LEDGER_SECTION_INDEXES) {
      sections[i] = mergeLedger('', nextParsed.sections[i], false).body
    }
  }

  // Size enforcement: shed the oldest ledger entries first (facts, then
  // failures), and only then truncate section 1's tail — sections 3/5 never
  // give way (they carry the resume-critical state).
  let doc = buildDoc(sections)
  while (doc.length > RECAP_DOC_MAX_CHARS) {
    const target = LEDGER_SECTION_INDEXES.find((i) => ledgerEntries(sections[i]).length > 0)
    if (target === undefined) break
    const kept = ledgerEntries(sections[target]).slice(1)
    sections[target] = kept.length ? [LEDGER_ROLL_MARK, ...kept].join('\n') : EMPTY_SECTION
    doc = buildDoc(sections)
  }
  if (doc.length > RECAP_DOC_MAX_CHARS) {
    // +1 accounts for the ellipsis appended below.
    const excess = doc.length - RECAP_DOC_MAX_CHARS + 1
    const body = sections[0]
    sections[0] = body.length > excess ? `${body.slice(0, body.length - excess)}…` : EMPTY_SECTION
    doc = buildDoc(sections)
  }
  return doc
}
