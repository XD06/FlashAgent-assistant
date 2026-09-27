import React from 'react'
import { marked, Marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function highlightCode(code: string, lang?: string): string {
  const clean = (lang || '').match(/^\S*/)?.[0]?.toLowerCase() || ''
  if (clean && hljs.getLanguage(clean)) {
    try {
      return hljs.highlight(code, { language: clean, ignoreIllegals: true }).value
    } catch {
      // ignore
    }
  }
  return escapeHtml(code)
}

export function buildHtmlPreviewDoc(code: string): string {
  const trimmed = code.trim()
  if (trimmed.toLowerCase().startsWith('<!doctype') || trimmed.toLowerCase().startsWith('<html')) {
    return trimmed
  }
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 16px;
      margin: 0;
      color: #333;
      background: #fff;
    }
    @media (prefers-color-scheme: dark) {
      body {
        color: #e0e0e0;
        background: #1e1e1e;
      }
    }
    ::-webkit-scrollbar {
      width: 5px;
      height: 5px;
    }
    ::-webkit-scrollbar-track {
      background: transparent;
    }
    ::-webkit-scrollbar-thumb {
      background: rgba(128, 128, 128, 0.35);
      border-radius: 3px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: rgba(128, 128, 128, 0.55);
    }
    * {
      scrollbar-width: thin;
      scrollbar-color: rgba(128, 128, 128, 0.35) transparent;
    }
  </style>
</head>
<body>
${trimmed}
</body>
</html>`
}

export function buildSvgPreviewDoc(code: string): string {
  const clean = code.trim().replace(/^<\?xml[\s\S]*?\?>/i, '').trim()
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      box-sizing: border-box;
      overflow: auto;
    }
    body {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 12px;
      box-sizing: border-box;
      background: repeating-conic-gradient(#80808022 0% 25%, transparent 0% 50%) 50% / 20px 20px;
    }
    svg {
      max-width: 100%;
      max-height: 100%;
      width: auto;
      height: auto;
      display: block;
    }
    ::-webkit-scrollbar {
      width: 5px;
      height: 5px;
    }
    ::-webkit-scrollbar-track {
      background: transparent;
    }
    ::-webkit-scrollbar-thumb {
      background: rgba(128, 128, 128, 0.35);
      border-radius: 3px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: rgba(128, 128, 128, 0.55);
    }
    * {
      scrollbar-width: thin;
      scrollbar-color: rgba(128, 128, 128, 0.35) transparent;
    }
  </style>
</head>
<body>
${clean}
</body>
</html>`
}

const COPY_ICON_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="10" height="10" rx="2"/><path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1"/></svg>'

const RELOAD_ICON_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>'

export const FULLSCREEN_ENTER_ICON_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'

export const FULLSCREEN_EXIT_ICON_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'

const EXPAND_ICON_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'

// Configure marked once: GFM tables, line breaks, and deterministic code-block rendering.
// Emitting the `.code-block` wrapper and `.code-copy` button directly at parse time
// eliminates all flicker during streaming and guarantees 100% presence without DOM thrashing.
marked.setOptions({
  gfm: true,
  breaks: true
})

/** Code-block renderer factory. `useHighlight=false` powers the streaming
 * path: highlight.js is ~97% of parse cost (61ms vs 0.9ms on a 150KB turn
 * with 4 HTML blocks), so an unclosed growing fence renders escaped-only
 * until the turn settles and the highlighted parse runs once. */
function codeRenderer(useHighlight: boolean) {
  return {
    code({ text, lang }: { text: string; lang?: string }) {
      const cleanLang = (lang || '').match(/^\S*/)?.[0] || ''
      const lowerLang = cleanLang.toLowerCase()
      if (lowerLang === 'mermaid') {
        return `<pre><code class="language-mermaid">${escapeHtml(text)}</code></pre>\n`
      }

      const highlighted = useHighlight ? highlightCode(text, cleanLang) : escapeHtml(text)
      const isPreviewable = lowerLang === 'html' || lowerLang === 'htm' || lowerLang === 'svg'
      const langClass = cleanLang ? ` class="language-${escapeHtml(cleanLang)}"` : ''

      const lineCount = text.replace(/\r\n/g, '\n').split('\n').length
      const isCollapsible = lineCount > 15
      const expandBtnHtml = isCollapsible
        ? `<div class="code-block__expand-wrap"><button type="button" class="code-expand-btn" data-action="toggle-expand" aria-label="展开全部代码">${EXPAND_ICON_SVG}<span class="code-expand-text">展开全部 (${lineCount} 行)</span></button></div>`
        : ''
      const collapseClass = isCollapsible ? ' code-block--collapsible code-block--collapsed' : ''
      const linesAttr = isCollapsible ? ` data-lines="${lineCount}"` : ''

      if (!isPreviewable) {
        return `<div class="code-block${collapseClass}"${linesAttr}><button type="button" class="code-copy" data-action="copy-code" aria-label="Copy code" title="Copy">${COPY_ICON_SVG}</button><pre><code${langClass}>${highlighted}</code></pre>${expandBtnHtml}</div>\n`
      }

      // Parse output is deliberately iframe-free: every previewable block
      // would otherwise pin a browsing context (Document + layout objects)
      // even when never previewed. Frames are created on demand by
      // ensurePreviewFrame() and destroyed on switching back to code.
      return `<div class="code-block code-block--previewable${collapseClass}" data-lang="${escapeHtml(lowerLang)}"${linesAttr}>
  <div class="code-block__header">
    <div class="code-block__tabs">
      <button type="button" class="code-tab active" data-action="tab-code" aria-label="Code">
        <span class="code-block__lang">${escapeHtml(cleanLang)}</span>
      </button>
      <button type="button" class="code-tab" data-action="tab-preview" aria-label="实时预览" title="实时预览">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
      </button>
    </div>
    <div class="code-block__actions">
      <button type="button" class="code-copy" data-action="copy-code" aria-label="Copy code" title="复制代码">${COPY_ICON_SVG}</button>
      <button type="button" class="preview-reload" data-action="reload-preview" aria-label="刷新预览" title="刷新预览">${RELOAD_ICON_SVG}</button>
      <button type="button" class="preview-fullscreen" data-action="toggle-fullscreen" aria-label="全屏预览" title="全屏预览">${FULLSCREEN_ENTER_ICON_SVG}</button>
    </div>
  </div>
  <div class="code-panel-code">
    <pre><code${langClass}>${highlighted}</code></pre>
    ${expandBtnHtml}
  </div>
  <div class="code-panel-preview"></div>
</div>\n`
    }
  }
}

marked.use({ renderer: codeRenderer(true) })

// Streaming parser: byte-identical block structure, highlight.js skipped.
export const streamingParser = new Marked({ gfm: true, breaks: true })
streamingParser.use({ renderer: codeRenderer(false) })

// Mermaid is ~1.5 MB — load lazily. Cache rendered SVG by source+theme so
// remounts / re-effects never re-parse a finished diagram.
let mermaidModule: Promise<typeof import('mermaid').default> | null = null
const mermaidCache = new Map<string, string>()
let mermaidSeq = 0

// While a turn streams, MarkdownView re-parses its whole (growing) text on
// every upstream flush — marked + highlight.js + DOMPurify + a full innerHTML
// rebuild can overrun the 50ms cadence and jam the main thread. Cap the parse
// at ~6.7Hz while pending; the final text is parsed immediately on settle.
const MARKDOWN_STREAM_PARSE_THROTTLE_MS = 150

// No 'iframe' in ADD_TAGS: preview frames are created programmatically, and
// model-emitted raw iframes must not become live browsing contexts.
const SANITIZE_CONFIG = {
  ADD_TAGS: ['button', 'svg', 'path', 'rect', 'circle', 'polygon', 'polyline', 'line', 'span'],
  ADD_ATTR: [
    'target',
    'rel',
    'class',
    'type',
    'aria-label',
    'title',
    'viewBox',
    'width',
    'height',
    'fill',
    'stroke',
    'stroke-width',
    'stroke-linecap',
    'stroke-linejoin',
    'cx',
    'cy',
    'r',
    'points',
    'd',
    'x',
    'y',
    'x1',
    'y1',
    'x2',
    'y2',
    'rx',
    'data-action',
    'data-lines',
    'loading'
  ]
}

/** True when the text ends inside an unterminated ``` fence (odd fence count)
 * — the streaming tail renders highlight-free until it closes. */
function hasUnclosedFence(markdown: string): boolean {
  return ((markdown.match(/```/g)?.length ?? 0) & 1) === 1
}

/** One top-level markdown block. Memoized on its raw source so a streaming
 * flush that only touches the tail block re-parses nothing else — the whole
 * subtree (highlight spans, code-block DOM) of settled blocks is reused. */
const MarkdownSegment = React.memo(function MarkdownSegment({
  raw,
  plainCode = false
}: {
  raw: string
  /** Unclosed-fence tail while streaming: escaped-only parse (no hljs). */
  plainCode?: boolean
}) {
  const html = React.useMemo(() => {
    const parsed = (plainCode ? streamingParser : marked).parse(raw, { async: false }) as string
    return DOMPurify.sanitize(parsed, SANITIZE_CONFIG)
  }, [raw, plainCode])
  return <div className="md-seg" dangerouslySetInnerHTML={{ __html: html }} />
})

function isMermaidFenceClosed(markdown: string): boolean {
  // Count ```mermaid fences vs closing ```. While streaming the fence is often
  // incomplete — rendering mid-stream causes parse thrash and flicker.
  const opens = markdown.match(/```mermaid\b/gi)?.length ?? 0
  if (!opens) return false
  // Rough close count: total fences minus opens should leave enough closers.
  const fences = markdown.match(/```/g)?.length ?? 0
  return fences >= opens * 2
}

async function renderMermaidBlocks(container: HTMLElement, isCancelled: () => boolean): Promise<void> {
  const codes = container.querySelectorAll<HTMLElement>('code.language-mermaid')
  if (!codes.length) return
  if (!mermaidModule) mermaidModule = import('mermaid').then((m) => m.default)
  const mermaid = await mermaidModule
  const dark = document.documentElement.getAttribute('data-theme') === 'dark'
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'default',
    fontFamily: 'inherit'
  })
  for (const code of Array.from(codes)) {
    if (isCancelled() || !code.isConnected) return
    const source = (code.textContent ?? '').trim()
    if (!source) continue
    const key = `${dark ? 'd' : 'l'}:${source}`
    let svg = mermaidCache.get(key)
    if (!svg) {
      try {
        await mermaid.parse(source)
        const rendered = await mermaid.render(`mermaid-svg-${mermaidSeq++}`, source)
        svg = rendered.svg
      } catch {
        // Incomplete / invalid source — leave the plain code block alone.
        continue
      }
      mermaidCache.set(key, svg)
      if (mermaidCache.size > 50) mermaidCache.delete(mermaidCache.keys().next().value as string)
    }
    if (isCancelled() || !code.isConnected) return
    const pre = code.closest('pre')
    const target = pre?.parentElement?.classList.contains('code-block') ? pre.parentElement : pre
    if (!target || !target.parentNode) continue

    // Preserve layout while swapping so the page doesn't jump when the SVG
    // replaces a tall code block (or vice-versa on a rare re-render).
    const prevHeight = (target as HTMLElement).offsetHeight
    const holder = document.createElement('div')
    holder.className = 'mermaid-diagram'
    holder.dataset.mermaidKey = key
    if (prevHeight > 0) holder.style.minHeight = `${prevHeight}px`
    holder.innerHTML = svg
    target.replaceWith(holder)
    // Release the min-height after paint so later content can reflow naturally.
    requestAnimationFrame(() => {
      if (holder.isConnected) holder.style.minHeight = ''
    })
  }
}

const copyFeedbackTimers = new WeakMap<HTMLButtonElement, number>()

async function copyTextToClipboard(text: string): Promise<boolean> {
  // 1. Electron IPC clipboard (native main process, immune to window blur/focus restrictions)
  try {
    if (window.assistantLite?.selection?.writeClipboard) {
      const ok = await window.assistantLite.selection.writeClipboard(text)
      if (ok !== false) return true
    }
  } catch {
    // fall through to web API
  }
  // 2. Modern browser Clipboard API
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall through to execCommand
    }
  }
  // 3. Fallback execCommand
  if (typeof document !== 'undefined') {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.top = '-9999px'
      ta.style.left = '-9999px'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      const success = document.execCommand('copy')
      document.body.removeChild(ta)
      if (success) return true
    } catch {
      // ignore
    }
  }
  return false
}

async function handleCopyClick(btn: HTMLButtonElement): Promise<void> {
  const codeBlock = btn.closest('.code-block')
  const pre = codeBlock?.querySelector('pre')
  const code = pre?.querySelector('code') ?? pre
  const text = code?.textContent ?? pre?.textContent ?? ''
  if (!text) return

  const success = await copyTextToClipboard(text)
  if (success) {
    const prevTimer = copyFeedbackTimers.get(btn)
    if (prevTimer) window.clearTimeout(prevTimer)

    btn.textContent = '✓'
    btn.classList.add('code-copy--copied')
    const timer = window.setTimeout(() => {
      if (btn.isConnected) {
        btn.innerHTML = COPY_ICON_SVG
        btn.classList.remove('code-copy--copied')
      }
      copyFeedbackTimers.delete(btn)
    }, 1200)
    copyFeedbackTimers.set(btn, timer)
  }
}

/** Create the preview iframe on demand. Parse output is deliberately
 * iframe-free — a frame per previewable block would pin a browsing context
 * (Document + layout objects) for the life of the message even when the
 * preview is never opened. Created here, destroyed on switching back. */
function ensurePreviewFrame(codeBlock: HTMLElement): HTMLIFrameElement | null {
  const panel = codeBlock.querySelector<HTMLDivElement>('.code-panel-preview')
  if (!panel) return null
  let iframe = panel.querySelector<HTMLIFrameElement>('.html-preview-frame')
  if (!iframe) {
    iframe = document.createElement('iframe')
    iframe.className = 'html-preview-frame'
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups')
    panel.appendChild(iframe)
  }
  return iframe
}

/** Build the preview document for a previewable code block (html/htm/svg). */
function buildPreviewDoc(codeBlock: HTMLElement): string {
  const rawCode = codeBlock.querySelector('pre code')?.textContent ?? ''
  const lang = (
    codeBlock.getAttribute('data-lang') || codeBlock.querySelector('.code-block__lang')?.textContent || ''
  )
    .toLowerCase()
    .trim()
  return lang === 'svg' ? buildSvgPreviewDoc(rawCode) : buildHtmlPreviewDoc(rawCode)
}

/**
 * MarkdownView — renders markdown as sanitized HTML via `marked` + `DOMPurify`.
 *
 * Code blocks natively include `.code-block` wrappers and `.code-copy` buttons,
 * rendered at parse time to eliminate streaming flicker and guarantee 100% presence.
 * Click handling uses event delegation on the root container so clicks are never lost
 * even mid-stream.
 */
export const MarkdownView = React.memo(function MarkdownView({
  children,
  pending = false
}: {
  children: string
  /** When true, skip mermaid upgrade (streaming). */
  pending?: boolean
}) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  // Keep last successful mermaid DOM keyed by source so a full innerHTML rewrite
  // (React set) can restore finished diagrams without a blank flash.
  const diagramDomCache = React.useRef(new Map<string, HTMLElement>())

  // Streaming throttle: commit the latest text to the parser at most every
  // MARKDOWN_STREAM_PARSE_THROTTLE_MS while pending, then render the final
  // text immediately when the stream settles.
  const [displayedText, setDisplayedText] = React.useState(children)
  const latestTextRef = React.useRef(children)
  latestTextRef.current = children
  const parseThrottleRef = React.useRef<number | null>(null)
  React.useEffect(() => {
    if (!pending) {
      if (parseThrottleRef.current !== null) {
        window.clearTimeout(parseThrottleRef.current)
        parseThrottleRef.current = null
      }
      setDisplayedText(latestTextRef.current)
      return
    }
    if (parseThrottleRef.current !== null) return
    parseThrottleRef.current = window.setTimeout(() => {
      parseThrottleRef.current = null
      setDisplayedText(latestTextRef.current)
    }, MARKDOWN_STREAM_PARSE_THROTTLE_MS)
  }, [children, pending])
  React.useEffect(
    () => () => {
      if (parseThrottleRef.current !== null) window.clearTimeout(parseThrottleRef.current)
    },
    []
  )

  // Block-split streaming: lex the latest text into top-level blocks so each
  // flush re-parses only the tail block (lexer is ~1ms on 150KB vs ~60ms for a
  // full highlighted parse). Settled blocks keep their DOM untouched — the
  // memoized MarkdownSegment bails on unchanged raw source.
  const segments = React.useMemo(() => {
    if (!pending) return [displayedText]
    return marked.lexer(displayedText).map((token) => token.raw)
  }, [displayedText, pending])

  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const cleanups: (() => void)[] = []
    let cancelled = false
    cleanups.push(() => {
      cancelled = true
    })

    // Delegated click handling on the container:
    // Captures preview tabs, reloads, fullscreen toggles, copy button clicks, expand/collapse toggles, and external link opens with zero per-node listeners.
    const onContainerClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement

      // 1. Code / Preview Tab toggle
      const tabBtn = target.closest<HTMLButtonElement>('[data-action="tab-code"], [data-action="tab-preview"]')
      if (tabBtn && container.contains(tabBtn)) {
        e.preventDefault()
        e.stopPropagation()
        const codeBlock = tabBtn.closest<HTMLElement>('.code-block')
        if (!codeBlock) return
        const isPreview = tabBtn.dataset.action === 'tab-preview'
        const codeTab = codeBlock.querySelector<HTMLButtonElement>('[data-action="tab-code"]')
        const previewTab = codeBlock.querySelector<HTMLButtonElement>('[data-action="tab-preview"]')

        if (isPreview) {
          if (codeBlock.classList.contains('is-previewing')) return
          codeBlock.classList.add('is-previewing')
          codeTab?.classList.remove('active')
          previewTab?.classList.add('active')
          const iframe = ensurePreviewFrame(codeBlock)
          if (iframe) {
            const doc = buildPreviewDoc(codeBlock)
            if (iframe.dataset.loadedDoc !== doc) {
              iframe.dataset.loadedDoc = doc
              iframe.srcdoc = doc
            }
          }
        } else {
          if (!codeBlock.classList.contains('is-previewing')) return
          codeBlock.classList.remove('is-previewing')
          codeBlock.classList.remove('is-fullscreen')
          const fsBtn = codeBlock.querySelector<HTMLButtonElement>('[data-action="toggle-fullscreen"]')
          if (fsBtn) {
            fsBtn.innerHTML = FULLSCREEN_ENTER_ICON_SVG
            fsBtn.title = '全屏预览'
            fsBtn.setAttribute('aria-label', '全屏预览')
          }
          previewTab?.classList.remove('active')
          codeTab?.classList.add('active')
          // Dropping the element releases its browsing context immediately —
          // an idle frame would otherwise keep the parsed preview document
          // alive for as long as the message stays on screen.
          codeBlock.querySelector<HTMLIFrameElement>('.html-preview-frame')?.remove()
        }
        return
      }

      // 2. Reload preview
        const reloadBtn = target.closest<HTMLButtonElement>('[data-action="reload-preview"]')
        if (reloadBtn && container.contains(reloadBtn)) {
          e.preventDefault()
          e.stopPropagation()
          const codeBlock = reloadBtn.closest<HTMLElement>('.code-block')
        if (codeBlock) {
          const iframe = ensurePreviewFrame(codeBlock)
          if (iframe) {
            const doc = buildPreviewDoc(codeBlock)
            iframe.dataset.loadedDoc = doc
            iframe.srcdoc = ''
            requestAnimationFrame(() => {
              iframe.srcdoc = doc
            })
          }
        }
        return
      }

      // 3. Fullscreen toggle
      const fsBtn = target.closest<HTMLButtonElement>('[data-action="toggle-fullscreen"]')
      if (fsBtn && container.contains(fsBtn)) {
        e.preventDefault()
        e.stopPropagation()
        const codeBlock = fsBtn.closest('.code-block')
        if (!codeBlock) return
        const isFs = codeBlock.classList.contains('is-fullscreen')
        if (isFs) {
          codeBlock.classList.remove('is-fullscreen')
          fsBtn.innerHTML = FULLSCREEN_ENTER_ICON_SVG
          fsBtn.title = '全屏预览'
          fsBtn.setAttribute('aria-label', '全屏预览')
        } else {
          codeBlock.classList.add('is-fullscreen')
          fsBtn.innerHTML = FULLSCREEN_EXIT_ICON_SVG
          fsBtn.title = '退出全屏 (Esc)'
          fsBtn.setAttribute('aria-label', '退出全屏')
        }
        return
      }

      // 4. Code copy button
      const copyBtn = target.closest<HTMLButtonElement>('.code-copy')
      if (copyBtn && container.contains(copyBtn)) {
        e.preventDefault()
        e.stopPropagation()
        void handleCopyClick(copyBtn)
        return
      }

      // 5. Toggle expand / collapse for long code blocks
      const expandBtn = target.closest<HTMLButtonElement>('[data-action="toggle-expand"]')
      if (expandBtn && container.contains(expandBtn)) {
        e.preventDefault()
        e.stopPropagation()
        const codeBlock = expandBtn.closest('.code-block')
        if (!codeBlock) return
        const isCollapsed = codeBlock.classList.contains('code-block--collapsed')
        const textSpan = expandBtn.querySelector<HTMLElement>('.code-expand-text')
        const lines = codeBlock.getAttribute('data-lines') || ''

        if (isCollapsed) {
          codeBlock.classList.remove('code-block--collapsed')
          codeBlock.classList.add('code-block--expanded')
          if (textSpan) textSpan.textContent = '收起代码'
        } else {
          codeBlock.classList.remove('code-block--expanded')
          codeBlock.classList.add('code-block--collapsed')
          if (textSpan) textSpan.textContent = `展开全部${lines ? ` (${lines} 行)` : ''}`
          codeBlock.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        }
        return
      }

      // 6. External links
      const anchor = target.closest<HTMLAnchorElement>('a')
      if (anchor && container.contains(anchor)) {
        const href = anchor.getAttribute('href')
        if (href && /^https?:\/\//i.test(href)) {
          e.preventDefault()
          e.stopPropagation()
          void window.assistantLite.app.openExternal(href)
        }
      }
    }

    container.addEventListener('click', onContainerClick)
    cleanups.push(() => container.removeEventListener('click', onContainerClick))

    // Escape key exits fullscreen preview
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const fsBlock = container.querySelector('.code-block.is-fullscreen')
        if (fsBlock) {
          fsBlock.classList.remove('is-fullscreen')
          const fsBtn = fsBlock.querySelector<HTMLButtonElement>('[data-action="toggle-fullscreen"]')
          if (fsBtn) {
            fsBtn.innerHTML = FULLSCREEN_ENTER_ICON_SVG
            fsBtn.title = '全屏预览'
            fsBtn.setAttribute('aria-label', '全屏预览')
          }
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    cleanups.push(() => window.removeEventListener('keydown', onKeyDown))
    cleanups.push(() => {
      container.querySelectorAll('.code-block.is-fullscreen').forEach((el) => el.classList.remove('is-fullscreen'))
      container.querySelectorAll<HTMLIFrameElement>('.html-preview-frame').forEach((iframe) => {
        iframe.remove()
      })
    })

    // Set link target/rel on anchors
    const links = container.querySelectorAll('a[href]')
    links.forEach((link) => {
      link.setAttribute('target', '_blank')
      link.setAttribute('rel', 'noopener noreferrer')
    })

    // Mermaid: only after the turn is no longer streaming, and only when the
    // fence looks closed. Finished diagrams are cached as DOM nodes so even if
    // this effect re-runs, we can put the SVG back immediately.
    const tryMermaid = async () => {
      if (pending || cancelled) return
      if (!isMermaidFenceClosed(displayedText)) return
      await renderMermaidBlocks(container, () => cancelled)
      if (cancelled) return
      // Snapshot upgraded diagrams for instant restore on the next html rewrite.
      container.querySelectorAll<HTMLElement>('.mermaid-diagram[data-mermaid-key]').forEach((el) => {
        const key = el.dataset.mermaidKey
        if (key) diagramDomCache.current.set(key, el.cloneNode(true) as HTMLElement)
      })
    }

    if (!pending) {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark'
      container.querySelectorAll<HTMLElement>('code.language-mermaid').forEach((code) => {
        const source = (code.textContent ?? '').trim()
        if (!source) return
        const key = `${dark ? 'd' : 'l'}:${source}`
        const cached = diagramDomCache.current.get(key)
        if (!cached) return
        const pre = code.closest('pre')
        const target = pre?.parentElement?.classList.contains('code-block') ? pre.parentElement : pre
        if (!target) return
        target.replaceWith(cached.cloneNode(true))
      })
    }

    void tryMermaid()

    return () => cleanups.forEach((fn) => fn())
  }, [segments, pending, displayedText])

  return (
    <div ref={containerRef} className="markdown-body">
      {segments.map((raw, i) => (
        <MarkdownSegment
          key={i}
          raw={raw}
          plainCode={pending && i === segments.length - 1 && hasUnclosedFence(raw)}
        />
      ))}
    </div>
  )
})
