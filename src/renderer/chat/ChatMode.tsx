import React from 'react'
import type { AgentToolEvent, AiChunkPayload, AiMessageInput, AppSettings } from '@shared/types'
import { MarkdownView } from '../Markdown'
import { Icon } from '../icons'
import { getTranslator } from '../i18n'
import { ThinkingBlock } from './ThinkingBlock'
import { ExtensionsPanel } from './ExtensionsPanel'

/** Ordered content of an assistant turn: text, thinking and tool runs
 * interleaved in the order they actually happened. */
type TurnBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; pending?: boolean }
  | { kind: 'tools'; events: AgentToolEvent[] }

interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
  /** Legacy single reasoning blob (older saved topics); new turns put
   * thinking blocks into `blocks` so multiple requests stay in order. */
  reasoning?: string
  reasoningPending?: boolean
  pending?: boolean
  error?: string
  searchQuery?: string
  blocks?: TurnBlock[]
  /** User note delivered mid-request into the running tool loop. */
  injected?: boolean
  /** Pasted images (data URLs) — sent as OpenAI-style image_url parts. */
  images?: string[]
  /** Pasted text files — content is inlined into the sent text. */
  files?: FileAttachment[]
}

/** A text file pasted into the composer (name + full content). */
interface FileAttachment {
  name: string
  text: string
}

/** Rolling summary of older turns; `covered` = how many turns it replaces. */
interface ChatCompact {
  summary: string
  covered: number
}

/** Session toggles captured with a topic so reopening it restores the
 * same working context (agent mode, workspace, search, MCP servers). */
interface TopicSession {
  agentEnabled: boolean
  workingDir: string | null
  searchEnabled: boolean
  /** IDs of MCP servers that were switched on for this conversation. */
  mcpEnabledIds: string[]
}

/** A saved conversation topic */
interface ChatTopic {
  id: string
  title: string
  /** Title was set by the user — never overwrite it with the auto title. */
  customTitle?: boolean
  turns: ChatTurn[]
  model?: string
  updatedAt: number
  compact?: ChatCompact
  session?: TopicSession
}

const isMac = navigator.userAgent.includes('Mac OS X')
const MAX_TOPICS = 10
const STORAGE_KEY = 'aia-chat-topics'
const MODELS_CACHE_KEY = 'aia-models-cache'
const MODELS_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

// Cap what gets sent to the model on long conversations: latest turns within
// a message/char budget. Acts as the hard safety net under rolling
// compression — the request payload is trimmed, with a short note so the
// model knows. The full history stays visible locally.
const MAX_SEND_MESSAGES = 24
// Generous budget: the last ~2 rounds replay tool outputs at up to 12k per
// call (toolRecap), and starving that replay costs more than it saves — the
// model just re-reads everything. This is a runaway guard, not a diet.
const MAX_SEND_CHARS = 120_000
function truncateForSend(messages: AiMessageInput[], isZh: boolean): AiMessageInput[] {
  const recent = messages.slice(-MAX_SEND_MESSAGES)
  const kept: AiMessageInput[] = []
  let total = 0
  for (let i = recent.length - 1; i >= 0; i--) {
    total += recent[i].text.length
    // Always keep at least the latest message, however large it is.
    if (kept.length > 0 && total > MAX_SEND_CHARS) break
    kept.unshift(recent[i])
  }
  const omitted = messages.length - kept.length
  if (omitted > 0) {
    kept.unshift({
      role: 'user',
      text: isZh
        ? `（提示：这是一段较长的对话，此前 ${omitted} 条消息已省略）`
        : `(Note: long conversation — ${omitted} earlier messages omitted)`
    })
  }
  return kept
}

// Cross-turn grounding: history is replayed to the model as plain text, so
// assistant turns get a terse appended record of the tool calls that actually
// ran. Without it the next turn only knows what the assistant *said*, not
// what it *did*, which invites "I already edited that file" misremembering.
const RECAP_MAX_CALLS = 20
const RECAP_HEADINGS = ['【本轮实际执行的工具调用】', '[Tool calls actually executed this turn]']
const RECAP_ENDINGS = ['【工具记录结束】', '[End of tool record]']
// Recency window for cross-turn tool *outputs*: the last N history entries
// (≈ 4 rounds) replay their outputs so the model can keep working without
// re-reading everything; older turns keep the one-line record only. Per-call
// ceiling matches the in-turn 12k cap — no per-turn total budget (splitting
// a shared pool across many reads starved every file down to a stub).
const RECAP_OUTPUT_TURNS = 8
const RECAP_OUTPUT_PER_CALL = 12_000

// The model sees the machine-appended recap block in replayed history and
// may imitate it, forging a "tool record" for work it never did. Strip
// look-alike blocks from model-written text so only the authentic recap
// appended below survives in the send path; the display/copy/export paths
// strip them too — a hand-written ledger is fabrication noise (the UI shows
// the real tool blocks already). Authentic blocks end with a
// RECAP_ENDINGS marker; for markerless imitations fall back to skipping the
// heading's list/output lines.
function stripForgedRecap(text: string): string {
  if (!RECAP_HEADINGS.some((h) => text.includes(h))) return text
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (RECAP_HEADINGS.some((h) => trimmed.startsWith(h))) {
      const end = lines.findIndex((l, j) => j > i && RECAP_ENDINGS.some((m) => l.trim().startsWith(m)))
      if (end !== -1) {
        i = end
        continue
      }
      let j = i + 1
      while (j < lines.length) {
        const t = lines[j].trim()
        if (t === '' || t.startsWith('- ') || t.startsWith('✓') || t.startsWith('✗') || lines[j].startsWith('  ')) j++
        else break
      }
      i = j - 1
      continue
    }
    out.push(lines[i])
  }
  return out.join('\n').trimEnd()
}

function toolRecap(turn: ChatTurn, isZh: boolean, withOutput = false): string {
  if (turn.role !== 'assistant' || !turn.blocks) return ''
  const settled = turn.blocks
    .flatMap((b) => (b.kind === 'tools' ? b.events : []))
    .filter((e) => e.state === 'done' || e.state === 'error' || e.state === 'rejected' || e.state === 'reverted')
  if (settled.length === 0) return ''
  const lines = settled.slice(0, RECAP_MAX_CALLS).map((e) => {
    const mark = e.state === 'done' ? 'ok' : e.state
    let line = `- ${e.toolName} ${e.summary} [${mark}]`
    // Recent turns carry the output (already head+tail capped at source),
    // indented two spaces so the markerless strip fallback still recognises
    // the block shape.
    if (withOutput && e.result && (e.state === 'done' || e.state === 'error')) {
      const body = e.result.slice(0, RECAP_OUTPUT_PER_CALL)
      const truncated =
        body.length < e.result.length ? (isZh ? '\n  （输出已截断）' : '\n  (output truncated)') : ''
      line += `\n${body.replace(/^/gm, '  ')}${truncated}`
    }
    return line
  })
  if (settled.length > RECAP_MAX_CALLS) {
    lines.push(isZh ? `- （另有 ${settled.length - RECAP_MAX_CALLS} 次调用）` : `- (${settled.length - RECAP_MAX_CALLS} more calls)`)
  }
  return `\n\n${isZh ? RECAP_HEADINGS[0] : RECAP_HEADINGS[1]}\n${lines.join('\n')}\n${isZh ? RECAP_ENDINGS[0] : RECAP_ENDINGS[1]}`
}

// Rolling compression (send-path only — the UI always keeps full turns):
//
//   [==== covered by recap ====][==== stale / compressible ====][==== recent keep ====]
//   0 ........ compact.covered .. keepStart (= len-KEEP) ........ len-1
//
// After a successful compress, compact.covered advances to keepStart. The next
// compress waits until enough *new* turns have slid out of the recent window
// (MIN_STALE_TURNS + TRIGGER_CHARS). That prevents the thrash bug where every
// new message after the first compress immediately re-summarized 1–2 turns.
//
// Only turn.text is *measured* for the trigger; the summarize payload also
// carries each assistant turn's tool-call recap (but not reasoning/MCP/skills).
// Product window (~15 rounds total feel): keep the last ~5 rounds (10 turns)
// verbatim; older turns become the recap once the stale zone is large enough.
const COMPACT_KEEP_RECENT = 10
/** Minimum turns in the stale zone before we re-run (≈ 3–4 rounds). */
const COMPACT_MIN_STALE_TURNS = 6
/** Character budget on stale turn.text before we call the summarizer. */
const COMPACT_TRIGGER_CHARS = 12_000

interface ModelsCache {
  models: string[]
  timestamp: number
  providerKey?: string
}

// Cache is only valid for the provider it was fetched from — switching the
// active provider template must not surface another provider's model list.
function loadCachedModels(providerKey: string): string[] | null {
  try {
    const raw = localStorage.getItem(MODELS_CACHE_KEY)
    if (!raw) return null
    const cache = JSON.parse(raw) as ModelsCache
    if (cache.providerKey !== providerKey) return null
    if (Date.now() - cache.timestamp > MODELS_CACHE_TTL) return null
    return Array.isArray(cache.models) ? cache.models : null
  } catch {
    return null
  }
}

function saveCachedModels(models: string[], providerKey: string): void {
  try {
    localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify({ models, timestamp: Date.now(), providerKey }))
  } catch {
    // ignore quota errors
  }
}

function loadTopics(): ChatTopic[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, MAX_TOPICS)
  } catch {
    return []
  }
}

function saveTopics(topics: ChatTopic[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(topics.slice(0, MAX_TOPICS)))
    return true
  } catch {
    return false
  }
}

// ---- Pasted attachments ----
// Images are downscaled before sending/storing: vision APIs cap image sizes
// and topics persist to localStorage (~5MB quota), so a raw 4K screenshot
// would blow both budgets. PNG stays PNG (crisp screenshot text) unless the
// result is still huge, then it degrades to JPEG.
const IMAGE_MAX_EDGE = 1600
const IMAGE_KEEP_BYTES = 1_200_000
const MAX_ATTACH_IMAGES = 4
const FILE_TEXT_MAX_BYTES = 2_000_000
const FILE_TEXT_MAX_CHARS = 200_000

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

async function imageFileToDataUrl(file: File): Promise<string> {
  const raw = await fileToDataUrl(file)
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('image decode failed'))
    el.src = raw
  })
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
  if (scale === 1 && raw.length <= IMAGE_KEEP_BYTES) return raw
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
  if (file.type === 'image/png') {
    const png = canvas.toDataURL('image/png')
    if (png.length <= IMAGE_KEEP_BYTES) return png
  }
  return canvas.toDataURL('image/jpeg', 0.85)
}

/** What the model receives for a user turn: the typed text plus each pasted
 * file inlined as a fenced block. OpenAI-compatible APIs have no separate
 * "file" content type, so inline text is the standard shape. */
function buildSendText(turn: { text: string; files?: FileAttachment[] }): string {
  if (!turn.files?.length) return turn.text
  const blocks = turn.files.map((f) => `[File: ${f.name}]\n\`\`\`\n${f.text}\n\`\`\``)
  return [turn.text, ...blocks].filter(Boolean).join('\n\n')
}

function makeTitle(text: string): string {
  const trimmed = text.trim().replace(/\n/g, ' ')
  return trimmed.length > 30 ? trimmed.slice(0, 30) + '…' : trimmed
}

const TOOL_LABELS: Record<string, { zh: string; en: string }> = {
  read_file: { zh: '读取', en: 'Read' },
  write_file: { zh: '写入', en: 'Write' },
  edit_file: { zh: '编辑', en: 'Edit' },
  list_dir: { zh: '目录', en: 'List' },
  search_files: { zh: '搜索', en: 'Search' },
  run_command: { zh: '命令', en: 'Run' }
}

const TOOL_ICONS: Record<string, string> = {
  read_file: 'book-open',
  write_file: 'pencil',
  edit_file: 'pencil',
  list_dir: 'scan-text',
  search_files: 'search',
  run_command: 'terminal'
}

/** Visual category — read-only lookups, file mutations, shell commands and
 * external MCP calls get distinct accent colors (Codex-style). */
const TOOL_CATEGORIES: Record<string, string> = {
  read_file: 'read',
  list_dir: 'read',
  search_files: 'read',
  write_file: 'write',
  edit_file: 'write',
  run_command: 'command'
}

function stateLabel(state: AgentToolEvent['state'], isZh: boolean): string {
  switch (state) {
    case 'pending-approval':
      return isZh ? '等待确认' : 'Needs approval'
    case 'running':
      return isZh ? '执行中' : 'Running'
    case 'done':
      return isZh ? '完成' : 'Done'
    case 'error':
      return isZh ? '失败' : 'Failed'
    case 'rejected':
      return isZh ? '已拒绝' : 'Rejected'
    case 'reverted':
      return isZh ? '已回退' : 'Reverted'
  }
}

function AgentToolRow({
  event,
  live,
  isZh,
  onRevert
}: {
  event: AgentToolEvent
  live: boolean
  isZh: boolean
  onRevert: (callId: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  // Keep the live command output pinned to its tail as chunks stream in.
  const liveRef = React.useRef<HTMLPreElement | null>(null)
  React.useEffect(() => {
    if (liveRef.current) liveRef.current.scrollTop = liveRef.current.scrollHeight
  }, [event.liveOutput])
  const label = TOOL_LABELS[event.toolName]
  // MCP tools carry a mcp__server__tool name; the summary already shows
  // "server · tool", so a generic MCP badge is enough here.
  const isMcp = event.toolName.startsWith('mcp__')
  const category = TOOL_CATEGORIES[event.toolName] ?? (isMcp ? 'mcp' : 'other')
  const title = label ? (isZh ? label.zh : label.en) : isMcp ? 'MCP' : event.toolName
  const hasDetail = !!(event.oldText || event.newText || event.result)
  const showDetail = open || event.state === 'pending-approval'
  const canRevert = (event.toolName === 'write_file' || event.toolName === 'edit_file') && event.state === 'done'
  const approve = (approved: boolean, alwaysAllow = false) => {
    void window.assistantLite.agent.approveTool(event.callId, approved, alwaysAllow)
  }
  return (
    <div className={`agent-tool-row agent-tool-row--${event.state} agent-tool-row--cat-${category}`}>
      <div
        className="agent-tool-row__head"
        onClick={() => hasDetail && setOpen((v) => !v)}
        style={hasDetail ? { cursor: 'pointer' } : undefined}
      >
        <Icon name={TOOL_ICONS[event.toolName] ?? (isMcp ? 'blocks' : 'pencil')} size={13} />
        <span className="agent-tool-row__name">{title}</span>
        <code className="agent-tool-row__summary" title={event.summary}>{event.summary}</code>
        {canRevert && (
          <button
            className="agent-tool-row__revert"
            title={isZh ? '恢复到本次修改前的内容' : 'Restore the pre-edit content'}
            onClick={(e) => {
              e.stopPropagation()
              onRevert(event.callId)
            }}
          >
            {isZh ? '回退' : 'Revert'}
          </button>
        )}
        <span className="agent-tool-row__state">{stateLabel(event.state, isZh)}</span>
      </div>
      {event.state === 'pending-approval' && live && (
        <div className="agent-tool-row__actions">
          <button className="agent-tool-row__btn agent-tool-row__btn--allow" onClick={() => approve(true)}>
            {isZh ? '允许' : 'Allow'}
          </button>
          <button className="agent-tool-row__btn" onClick={() => approve(true, true)}>
            {isZh ? '始终允许' : 'Always allow'}
          </button>
          <button className="agent-tool-row__btn agent-tool-row__btn--reject" onClick={() => approve(false)}>
            {isZh ? '拒绝' : 'Reject'}
          </button>
        </div>
      )}
      {event.state === 'running' && event.liveOutput && (
        <pre ref={liveRef} className="agent-tool-row__result agent-tool-row__result--live">{event.liveOutput}</pre>
      )}
      {showDetail && hasDetail && (
        <div className="agent-tool-row__detail">
          {event.oldText !== undefined && (
            <pre className="agent-tool-row__diff agent-tool-row__diff--old">{event.oldText}</pre>
          )}
          {event.newText !== undefined && (
            <pre className="agent-tool-row__diff agent-tool-row__diff--new">{event.newText}</pre>
          )}
          {event.result && (
            // Output inherits the category accent too (Codex-style): command
            // output keeps the terminal look, failures go red regardless.
            <pre
              className={`agent-tool-row__result agent-tool-row__result--${
                event.state === 'error' || event.state === 'rejected' ? 'error' : category
              }`}
            >
              {event.result}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

/** A run of consecutive tool calls. Expanded while it is the tail of the
 * streaming turn (so even instant calls show up open), auto-collapses to a
 * one-line summary once the turn moves on or every call has settled. */
function AgentToolGroup({
  events,
  live,
  current,
  isZh,
  onRevert
}: {
  events: AgentToolEvent[]
  live: boolean
  /** True while this is the last block of a still-streaming turn. */
  current: boolean
  isZh: boolean
  onRevert: (callId: string) => void
}) {
  const active = events.some((ev) => ev.state === 'pending-approval' || ev.state === 'running')
  const [manual, setManual] = React.useState<boolean | null>(null)
  // Each newly started call clears the manual toggle so the group re-expands
  // while work is in flight, then auto-collapses once everything settles.
  React.useEffect(() => {
    if (active || current) setManual(null)
  }, [active, current, events.length])
  const open = manual ?? (active || current)
  const failed = events.filter((ev) => ev.state === 'error' || ev.state === 'rejected').length
  return (
    <div className={`agent-tool-group${open ? ' agent-tool-group--open' : ''}`}>
      <div className="agent-tool-group__header" onClick={() => setManual(!open)}>
        <span className="agent-tool-group__chevron">
          <Icon name="chevron-right" size={12} />
        </span>
        <span className="agent-tool-group__title">
          {isZh ? `${events.length} 个操作` : `${events.length} action${events.length > 1 ? 's' : ''}`}
          {active || (current && live) ? (isZh ? ' · 进行中' : ' · in progress') : ''}
          {failed > 0 ? (isZh ? ` · ${failed} 个失败` : ` · ${failed} failed`) : ''}
        </span>
        {!open && <code className="agent-tool-group__peek">{events[events.length - 1]?.summary}</code>}
      </div>
      {open &&
        events.map((event) => (
          <AgentToolRow key={event.callId} event={event} live={live} isZh={isZh} onRevert={onRevert} />
        ))}
    </div>
  )
}

export function ChatMode({ settings }: { settings: AppSettings }) {
  const t = getTranslator(settings.language)
  const isZh = settings.language === 'zh-CN'

  // ---- Topics (persisted conversation history) ----
  const [topics, setTopics] = React.useState<ChatTopic[]>(() => loadTopics())
  const [activeTopicId, setActiveTopicId] = React.useState<string | null>(null)

  // ---- Current chat state ----
  const [chat, setChat] = React.useState<ChatTurn[]>([])
  const [input, setInput] = React.useState('')
  const [pinned, setPinned] = React.useState(false)
  const [showHistory, setShowHistory] = React.useState(false)
  const [showExtensions, setShowExtensions] = React.useState(false)
  const [toast, setToast] = React.useState<string | null>(null)
  // Messages typed while a request is streaming: queued, injected into the
  // tool loop at the next round gap, or sent as a new request on completion.
  const [queued, setQueued] = React.useState<string[]>([])
  const queuedRef = React.useRef<string[]>([])
  // Inline edit state for the latest user message (edit & resend).
  const [editingUser, setEditingUser] = React.useState<{ index: number; text: string } | null>(null)
  // Attachments pasted into the composer, waiting to be sent with the next
  // message. No picker button by design — paste (Ctrl+V) is the only entry.
  const [pendingImages, setPendingImages] = React.useState<string[]>([])
  const [pendingFiles, setPendingFiles] = React.useState<FileAttachment[]>([])

  // ---- Model selection ----
  const [models, setModels] = React.useState<string[]>([])
  const [selectedModel, setSelectedModel] = React.useState<string>(settings.provider.model)
  const [modelsLoading, setModelsLoading] = React.useState(false)
  const [searchEnabled, setSearchEnabled] = React.useState(false)
  const [agentEnabled, setAgentEnabled] = React.useState(false)
  const [workingDir, setWorkingDir] = React.useState<string | null>(null)

  // The titlebar <select> is sized to the *selected* model name via a hidden
  // mirror span — otherwise it sizes to the longest option and drifts
  // off-center on wide windows (max-width in CSS still caps narrow ones).
  const modelMeasureRef = React.useRef<HTMLSpanElement | null>(null)
  const [modelSelectWidth, setModelSelectWidth] = React.useState(0)
  // Custom dropdown with a search box — /v1/models can return hundreds of
  // entries, which a native <select> can't filter.
  const [modelMenuOpen, setModelMenuOpen] = React.useState(false)
  const [modelQuery, setModelQuery] = React.useState('')
  const modelFilter = modelQuery.trim().toLowerCase()
  const filteredModels = modelFilter
    ? models.filter((m) => m.toLowerCase().includes(modelFilter))
    : models
  const chooseModel = (m: string): void => {
    setSelectedModel(m)
    setModelMenuOpen(false)
    setModelQuery('')
  }
  const modelLabel = modelsLoading
    ? (isZh ? '加载模型…' : 'Loading…')
    : selectedModel || (isZh ? '手动输入' : 'Manual')
  React.useLayoutEffect(() => {
    const el = modelMeasureRef.current
    if (!el) return
    // Sub-pixel text width (offsetWidth rounds down on fractional DPI) plus
    // the select's fixed chrome: 9px left pad + 24px right pad (custom
    // chevron) + 2px borders + 2px slack. Keep in sync with .titlebar__select.
    setModelSelectWidth(Math.ceil(el.getBoundingClientRect().width) + 37)
  }, [modelLabel])

  const activeRequestId = React.useRef<string | null>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  const chatRef = React.useRef<ChatTurn[]>([])
  // Rolling summary of turns already compressed out of the send window.
  const compactRef = React.useRef<ChatCompact | null>(null)
  const compactingRef = React.useRef(false)
  // UI notice shown while/after compressing history.
  const [compactNotice, setCompactNotice] = React.useState<string | null>(null)
  const compactNoticeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearCompactNotice = React.useCallback(() => {
    if (compactNoticeTimerRef.current) {
      clearTimeout(compactNoticeTimerRef.current)
      compactNoticeTimerRef.current = null
    }
    setCompactNotice(null)
  }, [])
  // Bumped on new chat / topic switch so an in-flight summary can detect it.
  const chatSessionRef = React.useRef(0)
  const stickToBottomRef = React.useRef(true)
  const lastUserTextRef = React.useRef('')
  const chatUpdateRef = React.useRef<ChatTurn[] | null>(null)
  const messageHistoryRef = React.useRef<string[]>([])
  const historyNavIndexRef = React.useRef(-1) // -1 = not navigating
  // Lets the chunk-handler effect (deps: [t]) call the latest sendMessage.
  const sendMessageRef = React.useRef<(text: string) => void>(() => {})

  React.useEffect(() => {
    document.documentElement.classList.add('action-page-root')
    document.body.classList.add('action-page')
    return () => {
      document.documentElement.classList.remove('action-page-root')
      document.body.classList.remove('action-page')
    }
  }, [])

  React.useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Ctrl/Cmd+L: new chat
      if ((event.ctrlKey || event.metaKey) && event.key === 'l') {
        event.preventDefault()
        newChat()
        return
      }
      if (event.key === 'Escape') {
        if (modelMenuOpen) {
          setModelMenuOpen(false)
        } else if (showHistory || showExtensions) {
          setShowHistory(false)
          setShowExtensions(false)
        } else {
          void window.assistantLite.windowControls.close()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showHistory, showExtensions, modelMenuOpen])

  // Clicking any blank area closes the overlay panels (history / extensions)
  // — no need to hunt for the ✕ button. The titlebar toggle buttons opt out
  // via [data-panel-toggle] so their own onClick can flip the state without
  // the panel instantly reopening.
  React.useEffect(() => {
    if (!showHistory && !showExtensions) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.chat-history-panel, .ext-panel, [data-panel-toggle]')) return
      setShowHistory(false)
      setShowExtensions(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [showHistory, showExtensions])

  // Model dropdown closes on any click outside of it.
  React.useEffect(() => {
    if (!modelMenuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.titlebar__model')) return
      setModelMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [modelMenuOpen])

  React.useEffect(() => {
    const onBeforeUnload = () => {
      if (activeRequestId.current) {
        void window.assistantLite.ai.abort(activeRequestId.current)
        activeRequestId.current = null
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // ---- Sync selectedModel when settings change ----
  React.useEffect(() => {
    setSelectedModel(settings.provider.model)
  }, [settings.provider.model])

  // ---- Fetch models from /v1/models (cached, 5min TTL, per provider) ----
  const providerKey = `${settings.activeProviderTemplateId}|${settings.provider.baseUrl}`
  const fetchModels = React.useCallback(async () => {
    // Try cache first
    const cached = loadCachedModels(providerKey)
    if (cached) {
      setModels(cached)
      return
    }
    setModelsLoading(true)
    try {
      const list = await window.assistantLite.ai.listModels()
      setModels(list)
      saveCachedModels(list, providerKey)
    } catch {
      // silent fail, user can still type manually
    } finally {
      setModelsLoading(false)
    }
  }, [providerKey])

  React.useEffect(() => {
    void fetchModels()
  }, [fetchModels])

  // ---- Persist topic whenever chat changes (debounced 500ms) ----
  const persistTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const topicsRef = React.useRef<ChatTopic[]>(topics)
  React.useEffect(() => {
    topicsRef.current = topics
  }, [topics])
  // Snapshot of the current session toggles, read by the debounced persist so
  // the saved topic always carries the latest working context.
  const sessionSnapshotRef = React.useRef<TopicSession>({
    agentEnabled: false,
    workingDir: null,
    searchEnabled: false,
    mcpEnabledIds: []
  })
  React.useEffect(() => {
    sessionSnapshotRef.current = {
      agentEnabled,
      workingDir,
      searchEnabled,
      mcpEnabledIds: settings.mcpServers.filter((s) => s.enabled).map((s) => s.id)
    }
  }, [agentEnabled, workingDir, searchEnabled, settings.mcpServers])
  const persistTopic = React.useCallback((turns: ChatTurn[], model?: string) => {
    if (!turns.length) return
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      // Compute the next list outside the setState updater so the side effects
      // (localStorage write, toast, active-topic switch) run exactly once.
      const prev = topicsRef.current
      const id = activeTopicId ?? crypto.randomUUID()
      const firstUser = turns.find((t) => t.role === 'user')
      const existing = prev.find((tp) => tp.id === id)
      const topic: ChatTopic = {
        id,
        // A user-renamed topic keeps its custom title across auto-saves.
        title: existing?.customTitle
          ? existing.title
          : firstUser
            ? makeTitle(firstUser.text) ||
              (firstUser.images?.length ? (isZh ? '[图片]' : '[Image]') : firstUser.files?.[0]?.name || 'New chat')
            : 'New chat',
        ...(existing?.customTitle ? { customTitle: true } : {}),
        turns: turns.map((t) => ({ ...t, pending: false })),
        model,
        updatedAt: Date.now(),
        compact: compactRef.current ?? undefined,
        session: { ...sessionSnapshotRef.current }
      }
      const exists = prev.findIndex((tp) => tp.id === id)
      let next: ChatTopic[]
      if (exists >= 0) {
        next = [...prev]
        next[exists] = topic
      } else {
        next = [topic, ...prev]
      }
      next = next.slice(0, MAX_TOPICS)
      if (!saveTopics(next)) {
        setToast(isZh ? '对话历史保存失败（存储空间不足）' : 'Failed to save history (storage quota exceeded)')
      }
      if (!activeTopicId) setActiveTopicId(id)
      setTopics(next)
    }, 500)
  }, [activeTopicId, isZh])

  React.useEffect(() => {
    chatRef.current = chat
    // Persist non-empty chats that are not currently streaming
    if (chat.length > 0) {
      const last = chat[chat.length - 1]
      if (!last.pending) {
        persistTopic(chat, selectedModel)
      }
    }
  }, [chat, persistTopic, selectedModel])

  // Also re-save when session toggles change mid-conversation (workspace pick,
  // agent/search switch, MCP on/off) so reopening the topic restores them even
  // if no further message was sent.
  React.useEffect(() => {
    const turns = chatRef.current
    if (turns.length > 0 && !turns[turns.length - 1]?.pending) {
      persistTopic(turns, selectedModel)
    }
  }, [agentEnabled, workingDir, searchEnabled, settings.mcpServers, persistTopic, selectedModel])

  // ---- Rolling history compression (after each completed assistant turn) ----
  // UI keeps every turn; only the *send* payload substitutes [0, covered) with
  // the recap. See COMPACT_* constants above for the window math.
  const maybeCompact = React.useCallback(async () => {
    if (compactingRef.current) return
    const turns = chatRef.current
    const covered = compactRef.current?.covered ?? 0
    // keepStart: first index of the "always send full text" window.
    const keepStart = Math.max(0, turns.length - COMPACT_KEEP_RECENT)
    if (keepStart <= covered) return
    const stale = turns.slice(covered, keepStart)
    if (stale.length < COMPACT_MIN_STALE_TURNS) return
    const staleChars = stale.reduce((n, turn) => n + (turn.text?.length ?? 0), 0)
    if (staleChars < COMPACT_TRIGGER_CHARS) return

    compactingRef.current = true
    const session = chatSessionRef.current
    const staleCount = stale.length
    clearCompactNotice()
    setCompactNotice(isZh ? '正在压缩较早的对话…' : 'Compressing earlier messages…')
    let applied = false
    try {
      const parts: string[] = []
      if (compactRef.current?.summary) {
        parts.push(`${isZh ? '【已有摘要】' : '[Existing recap]'}\n${compactRef.current.summary}`)
      }
      parts.push(isZh ? '【新增对话】' : '[New messages]')
      for (const turn of stale) {
        const body = (turn.role === 'assistant' ? stripForgedRecap(turn.text ?? '') : (turn.text ?? '')).trim()
        // Keep the tool record in the recap too — "what was actually done"
        // must survive compression, not just the assistant's prose.
        const recap = toolRecap(turn, isZh)
        if (!body && !recap) continue
        parts.push(`${turn.role === 'user' ? (isZh ? '用户' : 'User') : (isZh ? '助手' : 'Assistant')}：${body}${recap}`)
      }
      const payload = parts.join('\n\n')
      if (!payload.trim()) return

      // Main process: prefer compressModel, retry, then fall back to chat model.
      const summary = await window.assistantLite.ai.summarize(payload, selectedModel || undefined)
      if (!summary?.trim()) {
        throw new Error(isZh ? '压缩结果为空' : 'Empty compression result')
      }
      // Topic switched / new chat while summarizing — discard.
      if (chatSessionRef.current !== session) return

      // Advance the covered frontier to keepStart *at compress time*. Turns that
      // arrived during the async summarize stay in the recent/uncovered zone and
      // will be considered on a later pass once they slide out of KEEP_RECENT.
      compactRef.current = { summary: summary.trim(), covered: keepStart }
      persistTopic(chatRef.current, selectedModel)
      applied = true
      setCompactNotice(
        isZh
          ? `已将较早的 ${staleCount} 条消息压缩为前情摘要`
          : `Compressed ${staleCount} earlier messages into a recap`
      )
      compactNoticeTimerRef.current = setTimeout(() => {
        compactNoticeTimerRef.current = null
        setCompactNotice(null)
      }, 4000)
    } catch {
      // Leave compactRef unchanged so the next successful turn can retry.
      // truncateForSend still caps payload size if compression keeps failing.
      setCompactNotice(isZh ? '上下文压缩失败，将在下轮重试' : 'Context compression failed — will retry next turn')
      compactNoticeTimerRef.current = setTimeout(() => {
        compactNoticeTimerRef.current = null
        setCompactNotice(null)
      }, 4000)
      applied = true // keep the error notice visible (don't clear in finally)
    } finally {
      compactingRef.current = false
      if (!applied) setCompactNotice(null)
    }
  }, [isZh, selectedModel, persistTopic, clearCompactNotice])
  const maybeCompactRef = React.useRef(maybeCompact)
  React.useEffect(() => {
    maybeCompactRef.current = maybeCompact
  }, [maybeCompact])

  // ---- AI chunk handler ----
  // Text/reasoning deltas are buffered as an ordered queue and flushed at
  // most every 50ms — one setState per flush instead of one per token keeps
  // long replies cheap, while preserving the order thinking and text
  // actually arrived in (multiple tool rounds each get their own block).
  const pendingItemsRef = React.useRef<Array<{ kind: 'text' | 'reasoning'; value: string }>>([])
  const flushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(() => {
    // Close any still-streaming thinking block (a text delta or tool call
    // means the model moved on; the block auto-collapses in the UI).
    const settleThinking = (blocks: TurnBlock[]): TurnBlock[] =>
      blocks.map((block) => (block.kind === 'thinking' && block.pending ? { ...block, pending: false } : block))
    const applyBuffered = (items: Array<{ kind: 'text' | 'reasoning'; value: string }>): void => {
      if (!items.length) return
      setChat((current) => {
        if (!current.length) return current
        const next = [...current]
        const last = { ...next[next.length - 1] }
        let blocks = [...(last.blocks ?? [])]
        for (const item of items) {
          const tail = blocks[blocks.length - 1]
          if (item.kind === 'reasoning') {
            if (tail?.kind === 'thinking' && tail.pending) {
              blocks[blocks.length - 1] = { kind: 'thinking', text: tail.text + item.value, pending: true }
            } else {
              blocks.push({ kind: 'thinking', text: item.value, pending: true })
            }
            last.reasoningPending = true
          } else {
            blocks = settleThinking(blocks)
            const newTail = blocks[blocks.length - 1]
            if (newTail?.kind === 'text') {
              blocks[blocks.length - 1] = { kind: 'text', text: newTail.text + item.value }
            } else {
              blocks.push({ kind: 'text', text: item.value })
            }
            last.text += item.value
            last.reasoningPending = false
          }
        }
        last.blocks = blocks
        last.pending = true
        next[next.length - 1] = last
        return next
      })
    }
    const flush = (): void => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      const items = pendingItemsRef.current
      pendingItemsRef.current = []
      applyBuffered(items)
    }
    const unsubscribe = window.assistantLite.ai.onChunk((chunk: AiChunkPayload) => {
      if (chunk.requestId !== activeRequestId.current) return
      if (chunk.type === 'delta' || chunk.type === 'reasoning') {
        const kind = chunk.type === 'delta' ? ('text' as const) : ('reasoning' as const)
        const value = (chunk.type === 'delta' ? chunk.text : chunk.reasoning) ?? ''
        if (value) {
          const queue = pendingItemsRef.current
          const tail = queue[queue.length - 1]
          if (tail?.kind === kind) tail.value += value
          else queue.push({ kind, value })
        }
        if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flush, 50)
        return
      }
      // Non-text events must see buffered text applied first so tool blocks
      // land at the right position in the stream.
      flush()
      if (chunk.type === 'injected') {
        // The queued note was delivered into the running tool loop — move it
        // from the queue into the transcript, placed before the streaming
        // assistant turn (that reply now accounts for it).
        const note = chunk.text ?? ''
        const qi = queuedRef.current.indexOf(note)
        if (qi >= 0) {
          queuedRef.current = [...queuedRef.current.slice(0, qi), ...queuedRef.current.slice(qi + 1)]
          setQueued(queuedRef.current)
        }
        setChat((current) => {
          if (!current.length) return current
          const next = [...current]
          next.splice(next.length - 1, 0, { role: 'user', text: note, injected: true })
          return next
        })
        return
      }
      setChat((current) => {
        if (!current.length) return current
        const next = [...current]
        const last = { ...next[next.length - 1] }
        if (chunk.type === 'status') {
          last.searchQuery = chunk.text ?? ''
        } else if (chunk.type === 'tool' && chunk.tool) {
          // Upsert by callId: state transitions arrive as separate events.
          // Consecutive calls join the same tools block; a text delta in
          // between starts a new one. A new tool call also closes any
          // still-open thinking block.
          let blocks = [...(last.blocks ?? [])]
          let found = false
          for (let i = blocks.length - 1; i >= 0 && !found; i--) {
            const block = blocks[i]
            if (block.kind !== 'tools') continue
            const eventIndex = block.events.findIndex((ev) => ev.callId === chunk.tool!.callId)
            if (eventIndex >= 0) {
              const events = [...block.events]
              events[eventIndex] = { ...events[eventIndex], ...chunk.tool }
              blocks[i] = { kind: 'tools', events }
              found = true
            }
          }
          if (!found) {
            blocks = settleThinking(blocks)
            const tail = blocks[blocks.length - 1]
            if (tail?.kind === 'tools') {
              blocks[blocks.length - 1] = { kind: 'tools', events: [...tail.events, chunk.tool] }
            } else {
              blocks.push({ kind: 'tools', events: [chunk.tool] })
            }
          }
          last.blocks = blocks
          last.pending = true
        } else if (chunk.type === 'done') {
          last.pending = false
          last.reasoningPending = false
          if (last.blocks) last.blocks = settleThinking(last.blocks)
        } else if (chunk.type === 'error') {
          last.pending = false
          last.reasoningPending = false
          if (last.blocks) last.blocks = settleThinking(last.blocks)
          last.error = chunk.error ?? t('unknownProviderError')
        }
        next[next.length - 1] = last
        return next
      })
      if (chunk.type === 'done' || chunk.type === 'error') {
        activeRequestId.current = null
        // Notes that never found an in-loop gap (plain chat, or the loop
        // ended first) go out right away as the next request.
        const pending = queuedRef.current
        if (pending.length) {
          queuedRef.current = []
          setQueued([])
          setTimeout(() => sendMessageRef.current(pending.join('\n\n')), 0)
        }
      }
      if (chunk.type === 'done') void maybeCompactRef.current()
    })
    return () => {
      unsubscribe()
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
    }
  }, [t])

  React.useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      stickToBottomRef.current = distance < 32
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  React.useEffect(() => {
    if (!stickToBottomRef.current) return
    const el = contentRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat])

  // Also auto-scroll during streaming when stick-to-bottom is active
  React.useEffect(() => {
    if (!stickToBottomRef.current) return
    const el = contentRef.current
    if (!el) return
    // Use requestAnimationFrame to avoid layout thrashing during rapid updates
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  })

  React.useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(140, el.scrollHeight)}px`
  }, [input])

  // ---- Actions ----
  const sendMessage = (text: string, atts?: { images?: string[]; files?: FileAttachment[] }) => {
    const images = atts?.images ?? []
    const files = atts?.files ?? []
    if ((!text.trim() && !images.length && !files.length) || activeRequestId.current) return
    if (text.trim()) {
      messageHistoryRef.current.push(text)
      historyNavIndexRef.current = -1
    }
    const history = chatRef.current
    const compact = compactRef.current
    // Send path only: UI still shows full `history`. Request body is
    //   [recap as synthetic user msg?] + history[covered..] + new user text
    // so the model sees a short context while the user sees everything.
    const recent = compact ? history.slice(compact.covered) : history
    const raw: AiMessageInput[] = [
      // Assistant turns carry their tool-call record so later turns stay
      // grounded in what actually executed; the most recent turns also
      // replay capped outputs (cheaper than the model re-reading files).
      // User turns re-send their images (standard for vision chats) and
      // inline pasted-file contents so the model keeps seeing them.
      ...recent.map((turn, i) =>
        turn.role === 'assistant'
          ? {
              role: turn.role,
              text: `${stripForgedRecap(turn.text)}${toolRecap(turn, isZh, i >= recent.length - RECAP_OUTPUT_TURNS)}`
            }
          : { role: turn.role, text: buildSendText(turn), ...(turn.images?.length ? { images: turn.images } : {}) }
      ),
      { role: 'user' as const, text: buildSendText({ text, files }), ...(images.length ? { images } : {}) }
    ]
    if (compact?.summary) {
      raw.unshift({
        role: 'user',
        text: `${isZh ? '（前情摘要，由较早的对话压缩而来）' : '(Recap compressed from earlier conversation)'}\n${compact.summary}`
      })
    }
    // Merge consecutive user messages (recap + first turn, or an injected
    // note following its original message) — Anthropic requires alternating
    // roles and OpenAI providers read merged text just as well.
    const mergedRaw: AiMessageInput[] = []
    for (const m of raw) {
      const prev = mergedRaw[mergedRaw.length - 1]
      if (prev && prev.role === 'user' && m.role === 'user') {
        prev.text = `${prev.text}\n\n${m.text}`
        if (m.images?.length) prev.images = [...(prev.images ?? []), ...m.images]
      } else mergedRaw.push({ ...m })
    }
    const messages = truncateForSend(mergedRaw, isZh)
    const requestId = crypto.randomUUID()
    activeRequestId.current = requestId
    lastUserTextRef.current = text
    void window.assistantLite.ai.stream({
      requestId,
      messages,
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(searchEnabled ? { forceSearch: true } : {}),
      ...(agentEnabled ? { agentMode: true, ...(workingDir ? { workingDir } : {}) } : {}),
      // The chat window always carries long-term memory and extensions.
      useMemory: true,
      useExtensions: true
    })
    stickToBottomRef.current = true
    setChat([
      ...history,
      { role: 'user', text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) },
      { role: 'assistant', text: '', pending: true }
    ])
  }
  sendMessageRef.current = sendMessage

  const submit = () => {
    const text = input.trim()
    const hasAttachments = pendingImages.length > 0 || pendingFiles.length > 0
    if (!text && !hasAttachments) return
    // Mid-request sends do not interrupt: the note is queued, delivered into
    // the tool loop at the next round gap, or sent as a new request on done.
    // Attachments cannot ride the inject channel (text-only) — they stay
    // pending in the composer and go out with the next idle send.
    if (activeRequestId.current) {
      if (!text) return
      setInput('')
      queuedRef.current = [...queuedRef.current, text]
      setQueued(queuedRef.current)
      void window.assistantLite.ai.inject(activeRequestId.current, text)
      return
    }
    setInput('')
    const atts = { images: pendingImages, files: pendingFiles }
    setPendingImages([])
    setPendingFiles([])
    sendMessage(text, atts)
  }

  // Paste is the only attachment entry (no picker button): screenshots /
  // copied images become image_url parts, copied text files are inlined.
  // Plain text pastes fall through to the textarea untouched.
  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const fileList = Array.from(event.clipboardData?.files ?? [])
    if (!fileList.length) return
    event.preventDefault()
    void (async () => {
      for (const file of fileList) {
        if (file.type.startsWith('image/')) {
          if (pendingImages.length >= MAX_ATTACH_IMAGES) {
            setToast(isZh ? `最多附带 ${MAX_ATTACH_IMAGES} 张图片` : `Up to ${MAX_ATTACH_IMAGES} images per message`)
            continue
          }
          try {
            const url = await imageFileToDataUrl(file)
            setPendingImages((cur) => (cur.length >= MAX_ATTACH_IMAGES ? cur : [...cur, url]))
          } catch {
            setToast(isZh ? '图片读取失败' : 'Failed to read image')
          }
          continue
        }
        if (file.size > FILE_TEXT_MAX_BYTES) {
          setToast(isZh ? `文件过大（上限 ${Math.round(FILE_TEXT_MAX_BYTES / 1_000_000)}MB）：${file.name}` : `File too large (max ${Math.round(FILE_TEXT_MAX_BYTES / 1_000_000)}MB): ${file.name}`)
          continue
        }
        try {
          const content = await file.text()
          // NUL byte = binary payload; only real text files are inlined.
          if (content.includes('\0')) {
            setToast(isZh ? `不支持的文件类型（仅图片和文本文件）：${file.name}` : `Unsupported file (images & text only): ${file.name}`)
            continue
          }
          const clipped = content.length > FILE_TEXT_MAX_CHARS
          setPendingFiles((cur) => [...cur, { name: file.name, text: content.slice(0, FILE_TEXT_MAX_CHARS) }])
          if (clipped) setToast(isZh ? `${file.name} 内容过长，已截断` : `${file.name} truncated (too long)`)
        } catch {
          setToast(isZh ? `文件读取失败：${file.name}` : `Failed to read file: ${file.name}`)
        }
      }
    })()
  }

  const stop = () => {
    if (activeRequestId.current) {
      void window.assistantLite.ai.abort(activeRequestId.current)
      activeRequestId.current = null
    }
    // The user chose to interrupt — hand queued notes back to the input box
    // instead of auto-firing a new request.
    const pending = queuedRef.current
    if (pending.length) {
      queuedRef.current = []
      setQueued([])
      setInput((cur) => [cur.trim(), ...pending].filter(Boolean).join('\n'))
    }
    setChat((current) => {
      if (!current.length) return current
      const next = [...current]
      const last = { ...next[next.length - 1] }
      last.pending = false
      next[next.length - 1] = last
      return next
    })
  }

  // Roll the transcript back to just before the latest real user message and
  // resend it (optionally with edited text). Injected notes and the replaced
  // assistant reply are discarded together — they belonged to the old run.
  const resendLastUser = (overrideText?: string) => {
    if (activeRequestId.current) return
    const turns = chatRef.current
    let idx = -1
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === 'user' && !turns[i].injected) {
        idx = i
        break
      }
    }
    if (idx < 0) return
    const text = overrideText ?? turns[idx].text
    // Attachments belong to the message — editing the text keeps them.
    const atts = { images: turns[idx].images, files: turns[idx].files }
    const next = turns.slice(0, idx)
    chatRef.current = next
    if (compactRef.current && compactRef.current.covered > next.length) {
      compactRef.current = { ...compactRef.current, covered: next.length }
    }
    setChat(next)
    setEditingUser(null)
    setTimeout(() => sendMessage(text, atts), 0)
  }

  const retry = () => {
    if (activeRequestId.current) return
    if (!lastUserTextRef.current) return
    resendLastUser()
  }

  const copyLast = () => {
    const last = [...chatRef.current].reverse().find((turn) => turn.role === 'assistant' && turn.text)
    if (last) void navigator.clipboard.writeText(stripForgedRecap(last.text))
  }

  // Export a saved conversation as a Markdown file (role-labelled turns).
  const exportTopic = async (topic: ChatTopic) => {
    if (!topic.turns.length) return
    const lines: string[] = [
      `# ${topic.title}`,
      '',
      `> ${new Date(topic.updatedAt).toLocaleString()}${topic.model ? ` · ${topic.model}` : ''}`
    ]
    for (const turn of topic.turns) {
      lines.push('', `## ${turn.role === 'user' ? (isZh ? '用户' : 'User') : (isZh ? '助手' : 'Assistant')}`, '', turn.role === 'assistant' ? stripForgedRecap(turn.text) : turn.text)
    }
    const saved = await window.assistantLite.chat.exportMarkdown(topic.title, lines.join('\n') + '\n')
    if (saved) {
      clearCompactNotice()
      setCompactNotice(isZh ? `已导出：${saved}` : `Exported: ${saved}`)
      compactNoticeTimerRef.current = setTimeout(() => {
        compactNoticeTimerRef.current = null
        setCompactNotice(null)
      }, 4000)
    }
  }

  const newChat = () => {
    if (activeRequestId.current) {
      void window.assistantLite.ai.abort(activeRequestId.current)
      activeRequestId.current = null
    }
    chatRef.current = []
    compactRef.current = null
    chatSessionRef.current += 1
    clearCompactNotice()
    lastUserTextRef.current = ''
    messageHistoryRef.current = []
    historyNavIndexRef.current = -1
    stickToBottomRef.current = true
    queuedRef.current = []
    setQueued([])
    setEditingUser(null)
    setActiveTopicId(null)
    setChat([])
    setInput('')
    setShowHistory(false)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const loadTopic = (topic: ChatTopic) => {
    if (activeRequestId.current) {
      void window.assistantLite.ai.abort(activeRequestId.current)
      activeRequestId.current = null
    }
    setActiveTopicId(topic.id)
    chatRef.current = topic.turns
    compactRef.current = topic.compact ?? null
    chatSessionRef.current += 1
    clearCompactNotice()
    lastUserTextRef.current = [...topic.turns].reverse().find((turn) => turn.role === 'user')?.text ?? ''
    stickToBottomRef.current = true
    queuedRef.current = []
    setQueued([])
    setEditingUser(null)
    setChat(topic.turns)
    if (topic.model) setSelectedModel(topic.model)
    // Restore the session context saved with the topic (agent mode, workspace,
    // search, MCP toggles). Legacy topics without a snapshot keep the current
    // toggles untouched.
    const session = topic.session
    if (session) {
      setSearchEnabled(session.searchEnabled)
      setWorkingDir(session.workingDir)
      setAgentEnabled(session.agentEnabled && !!session.workingDir)
      const wantEnabled = new Set(session.mcpEnabledIds)
      const servers = settings.mcpServers
      // Only touch global settings when a still-existing server differs —
      // the main process reconciles connections on update (mcpManager.sync).
      if (servers.some((s) => (s.enabled === true) !== wantEnabled.has(s.id))) {
        void window.assistantLite.settings.update({
          mcpServers: servers.map((s) => ({ ...s, enabled: wantEnabled.has(s.id) }))
        })
      }
    }
    setShowHistory(false)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const deleteTopic = (id: string) => {
    const next = topicsRef.current.filter((tp) => tp.id !== id)
    if (!saveTopics(next)) {
      setToast(isZh ? '删除失败（存储空间不足）' : 'Failed to save (storage quota exceeded)')
    }
    setTopics(next)
  }

  // ---- Topic rename (inline, in the history panel) ----
  const [renamingTopicId, setRenamingTopicId] = React.useState<string | null>(null)
  const [renameDraft, setRenameDraft] = React.useState('')
  const startRename = (topic: ChatTopic) => {
    setRenamingTopicId(topic.id)
    setRenameDraft(topic.title)
  }
  const commitRename = () => {
    const id = renamingTopicId
    setRenamingTopicId(null)
    if (!id) return
    const title = renameDraft.trim().slice(0, 60)
    if (!title) return
    const next = topicsRef.current.map((tp) => (tp.id === id ? { ...tp, title, customTitle: true } : tp))
    if (!saveTopics(next)) {
      setToast(isZh ? '重命名失败（存储空间不足）' : 'Failed to save (storage quota exceeded)')
      return
    }
    setTopics(next)
  }

  const togglePin = () => {
    const next = !pinned
    setPinned(next)
    void window.assistantLite.windowControls.pin(next)
  }

  const toggleAgent = async () => {
    if (agentEnabled) {
      setAgentEnabled(false)
      return
    }
    // Enabling requires a working directory; keep the previous pick if any.
    let dir = workingDir
    if (!dir) {
      dir = await window.assistantLite.agent.pickWorkingDir()
      if (!dir) return
      setWorkingDir(dir)
    }
    setAgentEnabled(true)
  }

  const changeWorkingDir = async () => {
    const dir = await window.assistantLite.agent.pickWorkingDir()
    if (dir) setWorkingDir(dir)
  }

  const revertTool = React.useCallback((callId: string) => {
    void window.assistantLite.agent.revertTool(callId).then((ok) => {
      if (!ok) {
        setToast(isZh ? '回退失败（快照已失效或文件被占用）' : 'Revert failed (snapshot expired or file locked)')
        return
      }
      setChat((current) =>
        current.map((turn) => {
          if (!turn.blocks) return turn
          let changed = false
          const blocks = turn.blocks.map((block) => {
            if (block.kind !== 'tools') return block
            const eventIndex = block.events.findIndex((ev) => ev.callId === callId)
            if (eventIndex < 0) return block
            changed = true
            const events = [...block.events]
            events[eventIndex] = { ...events[eventIndex], state: 'reverted' }
            return { kind: 'tools' as const, events }
          })
          return changed ? { ...turn, blocks } : turn
        })
      )
    })
  }, [isZh])

  const lastTurn = chat[chat.length - 1]
  const loading = !!lastTurn?.pending
  const hasResult = chat.some((turn) => turn.role === 'assistant' && turn.text)
  // Latest real (non-injected) user message — the only one offering
  // edit & resend actions.
  const lastUserIndex = (() => {
    for (let i = chat.length - 1; i >= 0; i--) {
      if (chat[i].role === 'user' && !chat[i].injected) return i
    }
    return -1
  })()

  // ---- Toast auto-dismiss ----
  React.useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(timer)
  }, [toast])

  return (
    <div className="action-window action-window--flex">
      <div className="titlebar titlebar--left titlebar--chat">
        <Icon name="sparkles" />
        <button
          className={`icon${showExtensions ? ' icon--active' : ''}`}
          title={isZh ? '扩展：记忆 / Skills / MCP' : 'Extensions: memory / skills / MCP'}
          data-panel-toggle
          onClick={() => setShowExtensions((v) => !v)}
        >
          <Icon name="blocks" size={15} />
        </button>
        <button
          className={`icon${showHistory ? ' icon--active' : ''}`}
          title={isZh ? '历史对话' : 'History'}
          data-panel-toggle
          onClick={() => setShowHistory((v) => !v)}
        >
          <Icon name="history" size={15} />
        </button>
        {/* Model selector: absolutely centered in the titlebar via CSS. Its
            width tracks the *selected* name (measured via the hidden mirror
            span). A custom dropdown (not <select>) so long /v1/models lists
            can be filtered by typing. */}
        <div className="titlebar__model">
          <button
            className="titlebar__select"
            style={modelSelectWidth ? { width: `${modelSelectWidth}px` } : undefined}
            title={t('modelSwitch')}
            disabled={modelsLoading}
            onClick={() => {
              setModelQuery('')
              setModelMenuOpen((v) => !v)
            }}
          >
            {modelLabel}
          </button>
          {modelMenuOpen && (
            <div className="model-menu">
              <input
                className="model-menu__search"
                autoFocus
                placeholder={isZh ? '搜索模型…' : 'Search models…'}
                value={modelQuery}
                onChange={(e) => setModelQuery(e.target.value)}
                onKeyDown={(e) => {
                  // Keep Escape from bubbling to the window handler (closes
                  // the chat window); Enter picks the first match.
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setModelMenuOpen(false)
                  } else if (e.key === 'Enter' && filteredModels.length > 0) {
                    e.preventDefault()
                    chooseModel(filteredModels[0])
                  }
                }}
              />
              <div className="model-menu__list">
                {filteredModels.length > 0 ? (
                  filteredModels.map((m) => (
                    <button
                      key={m}
                      className={`model-menu__item${m === selectedModel ? ' model-menu__item--active' : ''}`}
                      title={m}
                      onClick={() => chooseModel(m)}
                    >
                      {m}
                    </button>
                  ))
                ) : (
                  <div className="model-menu__empty">
                    {models.length === 0
                      ? (isZh ? '未获取到模型列表，可在设置中手动填写' : 'No models — set one manually in settings')
                      : (isZh ? '无匹配模型' : 'No matching model')}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        <span ref={modelMeasureRef} className="titlebar__select-measure" aria-hidden>
          {modelLabel}
        </span>
        <div className="titlebar__spacer" />
        <button className="icon" title={pinned ? t('unpin') : t('pin')} onClick={togglePin}>
          <Icon name={pinned ? 'pin-off' : 'pin'} />
        </button>
        {!isMac && (
          <>
            <button className="icon" title={t('minimize')} onClick={() => window.assistantLite.windowControls.minimize()}>
              <span>-</span>
            </button>
            <button className="icon" title={t('close')} onClick={() => window.assistantLite.windowControls.close()}>
              <Icon name="x" />
            </button>
          </>
        )}
      </div>

      {/* History panel (slide-in overlay) */}
      {showHistory && (
        <div className="chat-history-panel">
          <div className="chat-history-panel__header">
            <span>{isZh ? '历史对话' : 'History'}</span>
            <button className="icon" onClick={() => setShowHistory(false)}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="chat-history-panel__list">
            {topics.length === 0 ? (
              <div className="chat-history-panel__empty">
                {isZh ? '暂无历史对话' : 'No conversations yet'}
              </div>
            ) : (
              topics.map((topic) => (
                <div
                  key={topic.id}
                  className={`chat-history-item${topic.id === activeTopicId ? ' chat-history-item--active' : ''}`}
                  onClick={() => {
                    if (renamingTopicId === topic.id) return
                    loadTopic(topic)
                  }}
                >
                  {renamingTopicId === topic.id ? (
                    <input
                      className="chat-history-item__title-input"
                      value={renameDraft}
                      autoFocus
                      maxLength={60}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') commitRename()
                        if (e.key === 'Escape') setRenamingTopicId(null)
                      }}
                      onBlur={commitRename}
                    />
                  ) : (
                    <div className="chat-history-item__title">{topic.title}</div>
                  )}
                  <div className="chat-history-item__meta">
                    {new Date(topic.updatedAt).toLocaleString(isZh ? 'zh-CN' : 'en', {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                    })}
                    {' · '}
                    {Math.floor(topic.turns.length / 2)} {isZh ? '轮' : 'turns'}
                  </div>
                  <button
                    className="chat-history-item__rename"
                    onClick={(e) => { e.stopPropagation(); startRename(topic) }}
                    title={isZh ? '重命名' : 'Rename'}
                  >
                    <Icon name="pencil" size={13} />
                  </button>
                  <button
                    className="chat-history-item__export"
                    onClick={(e) => { e.stopPropagation(); void exportTopic(topic) }}
                    title={isZh ? '导出为 Markdown' : 'Export as Markdown'}
                  >
                    <Icon name="download" size={14} />
                  </button>
                  <button
                    className="chat-history-item__delete"
                    onClick={(e) => { e.stopPropagation(); deleteTopic(topic.id) }}
                    title={isZh ? '删除' : 'Delete'}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 7h16" />
                      <path d="M10 3h4" />
                      <path d="M6.5 7 7.3 19a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7" />
                      <path d="M10 11v5" />
                      <path d="M14 11v5" />
                    </svg>
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div className="content chat-content" ref={contentRef}>
        {chat.length === 0 ? (
          <div className="chat-empty">
            <Icon name="sparkles" size={28} />
            <div className="chat-empty__title">{isZh ? '开始一段对话' : 'Start a chat'}</div>
            <div className="chat-empty__hint">
              {isZh ? '话题自动保存最近 10 条，关闭再开仍可恢复。' : 'Conversations are saved (up to 10). Resume anytime.'}
            </div>
            <div className="chat-empty__features">
              <button className="chat-empty__feature" onClick={() => setSearchEnabled(true)}>
                <Icon name="globe" size={14} />
                <span>{isZh ? '联网搜索，获取实时信息' : 'Web search for live info'}</span>
              </button>
              <button className="chat-empty__feature" onClick={() => void toggleAgent()}>
                <Icon name="terminal" size={14} />
                <span>{isZh ? 'Agent 模式，读写文件 / 执行命令' : 'Agent mode: files & commands'}</span>
              </button>
              <button className="chat-empty__feature" onClick={() => setShowExtensions(true)}>
                <Icon name="blocks" size={14} />
                <span>{isZh ? '扩展：记忆 / Skills / MCP' : 'Extensions: memory / skills / MCP'}</span>
              </button>
            </div>
          </div>
        ) : (
          chat.map((turn, index) => {
            if (turn.role === 'user') {
              const editing = editingUser?.index === index
              return (
                <React.Fragment key={index}>
                  <div
                    className={`screenshot-preview__user-msg${turn.injected ? ' screenshot-preview__user-msg--injected' : ''}${editing ? ' screenshot-preview__user-msg--editing' : ''}`}
                  >
                    {turn.injected && (
                      <span className="user-msg-injected-tag">
                        <Icon name="corner-down-right" size={11} />
                        {isZh ? '任务中追加' : 'Added mid-task'}
                      </span>
                    )}
                    {editing ? (
                      <div className="user-msg-edit">
                        <textarea
                          autoFocus
                          value={editingUser.text}
                          onChange={(e) => setEditingUser({ index, text: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                              e.preventDefault()
                              if (editingUser.text.trim()) resendLastUser(editingUser.text.trim())
                            }
                            if (e.key === 'Escape') {
                              e.stopPropagation()
                              setEditingUser(null)
                            }
                          }}
                        />
                        <div className="user-msg-edit__actions">
                          <button
                            type="button"
                            className="user-msg-edit__send"
                            disabled={!editingUser.text.trim()}
                            onClick={() => resendLastUser(editingUser.text.trim())}
                          >
                            {isZh ? '重新发送' : 'Resend'}
                          </button>
                          <button type="button" onClick={() => setEditingUser(null)}>
                            {isZh ? '取消' : 'Cancel'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {turn.images && turn.images.length > 0 && (
                          <div className="user-msg-imgs">
                            {turn.images.map((src, i) => (
                              <img key={i} src={src} alt="" />
                            ))}
                          </div>
                        )}
                        {turn.files && turn.files.length > 0 && (
                          <div className="user-msg-files">
                            {turn.files.map((f, i) => (
                              <span key={i} className="user-msg-files__chip" title={`${f.text.length}${isZh ? ' 字符' : ' chars'}`}>
                                <Icon name="file-text" size={11} />
                                {f.name}
                              </span>
                            ))}
                          </div>
                        )}
                        {turn.text}
                      </>
                    )}
                  </div>
                  {/* Actions live outside the bubble, on their own row below.
                      Always rendered for the latest user message — hiding via
                      CSS keeps the row's height so the list doesn't jump when
                      a request starts/ends. */}
                  {index === lastUserIndex && !editing && (
                    <div className={`user-msg-actions${loading ? ' user-msg-actions--hidden' : ''}`}>
                      <button
                        type="button"
                        title={isZh ? '编辑并重新发送' : 'Edit & resend'}
                        disabled={loading}
                        onClick={() => setEditingUser({ index, text: turn.text })}
                      >
                        <Icon name="pencil" size={12} />
                      </button>
                      <button
                        type="button"
                        title={isZh ? '重新发送' : 'Resend'}
                        disabled={loading}
                        onClick={() => resendLastUser()}
                      >
                        <Icon name="undo-2" size={12} />
                      </button>
                    </div>
                  )}
                </React.Fragment>
              )
            }
            const isLastAssistant = index === chat.length - 1
            const showMessageActions = isLastAssistant && !turn.pending && !loading
            return (
              <div key={index} className="result markdown-body">
                {turn.searchQuery && (
                  <div className={`search-tool-status${turn.searchQuery.startsWith('⚠️') ? ' search-tool-status--error' : ''}`}>
                    <Icon name="search" size={13} />
                    <span>{turn.searchQuery.startsWith('⚠️')
                      ? turn.searchQuery
                      : (isZh ? `联网搜索：${turn.searchQuery}` : `Web search: ${turn.searchQuery}`)}</span>
                  </div>
                )}
                {turn.reasoning && !turn.blocks?.some((block) => block.kind === 'thinking') && (
                  <ThinkingBlock text={turn.reasoning} pending={turn.reasoningPending ?? false} t={t} />
                )}
                {(turn.blocks?.length
                  ? turn.blocks
                  : turn.text
                    ? [{ kind: 'text' as const, text: turn.text }]
                    : []
                ).map((block, blockIndex, blockList) =>
                  block.kind === 'text' ? (
                    // Display path also drops model-imitated tool-record blocks:
                    // the real execution blocks are rendered right here, so a
                    // hand-written ledger is pure noise (and often confusing).
                    block.text && stripForgedRecap(block.text) ? (
                      <MarkdownView key={blockIndex} pending={!!turn.pending}>
                        {stripForgedRecap(block.text)}
                      </MarkdownView>
                    ) : null
                  ) : block.kind === 'thinking' ? (
                    <ThinkingBlock
                      key={blockIndex}
                      text={block.text}
                      pending={!!block.pending && !!turn.pending}
                      t={t}
                    />
                  ) : (
                    <AgentToolGroup
                      key={blockIndex}
                      events={block.events}
                      live={!!turn.pending}
                      current={!!turn.pending && blockIndex === blockList.length - 1}
                      isZh={isZh}
                      onRevert={revertTool}
                    />
                  )
                )}
                {!turn.text && !turn.blocks?.length && turn.pending ? (
                  <span className="thinking-indicator">{t('preparing')}</span>
                ) : null}
                {turn.error && <div className="error">{turn.error}</div>}
                {/* Message actions sit under the last assistant turn so they
                    read as part of the reply, not a floating middle bar. */}
                {showMessageActions && (
                  <div className="chat-msg-actions">
                    <button type="button" onClick={retry} disabled={!lastUserTextRef.current} title={t('retry')}>
                      <Icon name="undo-2" size={13} />
                      <span>{t('retry')}</span>
                    </button>
                    <button type="button" onClick={copyLast} disabled={!hasResult} title={t('copy')}>
                      <Icon name="copy" size={13} />
                      <span>{t('copy')}</span>
                    </button>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {showExtensions && (
        <ExtensionsPanel
          settings={settings}
          isZh={isZh}
          workingDir={workingDir}
          onClose={() => setShowExtensions(false)}
        />
      )}

      <div className="chat-input">
        {queued.length > 0 && (
          <div className="chat-queue">
            {queued.map((q, i) => (
              <div key={i} className="chat-queue__item" title={isZh ? '将在不打断任务的前提下送达模型；点击停止可取回到输入框' : 'Delivered without interrupting; press stop to reclaim into the input'}>
                <Icon name="clock" size={12} />
                <span>{q}</span>
              </div>
            ))}
          </div>
        )}
        {(pendingImages.length > 0 || pendingFiles.length > 0) && (
          <div className="chat-attach">
            {pendingImages.map((src, i) => (
              <div key={`img-${i}`} className="chat-attach__img">
                <img src={src} alt="" />
                <button
                  type="button"
                  title={isZh ? '移除' : 'Remove'}
                  onClick={() => setPendingImages((cur) => cur.filter((_, j) => j !== i))}
                >
                  <Icon name="x" size={10} />
                </button>
              </div>
            ))}
            {pendingFiles.map((f, i) => (
              <div key={`file-${i}`} className="chat-attach__file" title={`${f.name} · ${f.text.length}${isZh ? ' 字符' : ' chars'}`}>
                <Icon name="file-text" size={12} />
                <span>{f.name}</span>
                <button
                  type="button"
                  title={isZh ? '移除' : 'Remove'}
                  onClick={() => setPendingFiles((cur) => cur.filter((_, j) => j !== i))}
                >
                  <Icon name="x" size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="chat-input__toolbar">
          <button
            className={`chat-input__tool${searchEnabled ? ' chat-input__tool--active' : ''}`}
            title={isZh ? (searchEnabled ? '联网搜索已开启' : '联网搜索已关闭') : (searchEnabled ? 'Web search on' : 'Web search off')}
            onClick={() => setSearchEnabled((v) => !v)}
          >
            <Icon name="globe" size={16} />
          </button>
          <button
            className={`chat-input__tool${agentEnabled ? ' chat-input__tool--active' : ''}`}
            title={isZh
              ? (agentEnabled ? 'Agent 模式已开启（可读写文件/执行命令）' : 'Agent 模式已关闭')
              : (agentEnabled ? 'Agent mode on (file & command tools)' : 'Agent mode off')}
            onClick={() => void toggleAgent()}
          >
            <Icon name="terminal" size={16} />
          </button>
          {agentEnabled && workingDir && (
            <button
              className="chat-input__workdir"
              title={`${workingDir}\n${isZh ? '点击更换工作目录' : 'Click to change working directory'}`}
              onClick={() => void changeWorkingDir()}
            >
              {workingDir.split(/[\\/]/).filter(Boolean).pop()}
            </button>
          )}
          <button
            className="chat-input__tool"
            title={isZh ? '新对话' : 'New chat'}
            onClick={newChat}
            disabled={chat.length === 0 && !loading}
          >
            <Icon name="plus" size={16} />
          </button>
          {chat.length > 0 && (() => {
            // Ring fill = progress of the *stale* zone toward the next compress.
            // Matches maybeCompact: [covered, keepStart) must also reach MIN_STALE.
            const covered = compactRef.current?.covered ?? 0
            const keepStart = Math.max(0, chat.length - COMPACT_KEEP_RECENT)
            const stale = chat.slice(covered, Math.max(covered, keepStart))
            const staleChars = stale.reduce((n, turn) => n + (turn.text?.length ?? 0), 0)
            const charRatio = Math.min(1, staleChars / COMPACT_TRIGGER_CHARS)
            const turnRatio = Math.min(1, stale.length / COMPACT_MIN_STALE_TURNS)
            // Both gates must open — show the more-empty of the two so the ring
            // only looks "full" when compression is actually imminent.
            const ratio = Math.min(charRatio, turnRatio)
            const rounds = chat.filter((turn) => turn.role === 'user').length
            const pct = Math.round(ratio * 100)
            const tip = isZh
              ? `已进行 ${rounds} 轮 · 距下次压缩 ${pct}%（待压 ${stale.length} 条 / ${staleChars} 字）${covered > 0 ? ` · 已压进摘要 ${covered} 条` : ''}`
              : `${rounds} round${rounds === 1 ? '' : 's'} · ${pct}% to next compress (${stale.length} turns / ${staleChars} chars pending)${covered > 0 ? ` · ${covered} in recap` : ''}`
            const C = 2 * Math.PI * 6.5
            return (
              <div className="chat-context-ring" title={tip} aria-label={tip}>
                <svg width="16" height="16" viewBox="0 0 16 16">
                  <circle cx="8" cy="8" r="6.5" fill="none" stroke="var(--divider)" strokeWidth="2.5" />
                  <circle
                    cx="8"
                    cy="8"
                    r="6.5"
                    fill="none"
                    stroke={ratio >= 0.85 ? 'var(--danger)' : 'var(--accent)'}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeDasharray={`${Math.max(ratio, 0.02) * C} ${C}`}
                    transform="rotate(-90 8 8)"
                  />
                </svg>
              </div>
            )
          })()}
        </div>
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          placeholder={
            loading
              ? (isZh ? '排队发送…（不打断当前任务，在合适时机送达）' : 'Queue a message… (delivered at the next gap, no interrupt)')
              : (isZh ? '发消息…（Enter 发送，Shift+Enter 换行）' : 'Message… (Enter to send, Shift+Enter for newline)')
          }
          onChange={(e) => setInput(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              // Mid-stream Enter queues instead of stopping — interrupting is
              // the stop button's job.
              submit()
            }
            // Arrow Up to navigate message history (only when input is empty or already navigating)
            if (e.key === 'ArrowUp' && !e.shiftKey && !e.nativeEvent.isComposing) {
              const hist = messageHistoryRef.current
              if (hist.length === 0) return
              const curIdx = historyNavIndexRef.current
              // Start navigating only if input is empty or we're already in history mode
              if (curIdx === -1 && input.trim()) return
              const newIdx = curIdx === -1 ? hist.length - 1 : Math.max(0, curIdx - 1)
              if (newIdx !== curIdx) {
                e.preventDefault()
                historyNavIndexRef.current = newIdx
                setInput(hist[newIdx])
              }
            }
            // Arrow Down to navigate forward in message history
            if (e.key === 'ArrowDown' && !e.shiftKey && !e.nativeEvent.isComposing) {
              const curIdx = historyNavIndexRef.current
              if (curIdx === -1) return
              const hist = messageHistoryRef.current
              const newIdx = curIdx + 1
              e.preventDefault()
              if (newIdx >= hist.length) {
                historyNavIndexRef.current = -1
                setInput('')
              } else {
                historyNavIndexRef.current = newIdx
                setInput(hist[newIdx])
              }
            }
          }}
        />
        {loading ? (
          <>
            <button className="chat-input__btn chat-input__btn--stop" onClick={stop} title={t('stop')}>
              <Icon name="square" size={18} />
            </button>
            <button
              className="chat-input__btn"
              onClick={submit}
              disabled={!input.trim()}
              title={isZh ? '加入队列（不打断当前任务）' : 'Queue (no interrupt)'}>
              <Icon name="arrow-up" size={18} />
            </button>
          </>
        ) : (
          <button
            className="chat-input__btn"
            onClick={submit}
            disabled={!input.trim() && !pendingImages.length && !pendingFiles.length}
            title={isZh ? '发送' : 'Send'}>
            <Icon name="arrow-up" size={18} />
          </button>
        )}
      </div>
      {compactNotice && (
        <div className="chat-compact-notice">
          <Icon name="sparkles" size={12} />
          <span>{compactNotice}</span>
        </div>
      )}
      {toast && <div className="chat-toast">{toast}</div>}
    </div>
  )
}
