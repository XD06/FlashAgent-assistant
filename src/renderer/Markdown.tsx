import React from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const COPY_ICON_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="10" height="10" rx="2"/><path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1"/></svg>'

// Configure marked once: GFM tables, line breaks, and deterministic code-block rendering.
// Emitting the `.code-block` wrapper and `.code-copy` button directly at parse time
// eliminates all flicker during streaming and guarantees 100% presence without DOM thrashing.
marked.setOptions({
  gfm: true,
  breaks: true
})

marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const cleanLang = (lang || '').match(/^\S*/)?.[0] || ''
      const escaped = escapeHtml(text)
      if (cleanLang.toLowerCase() === 'mermaid') {
        return `<pre><code class="language-mermaid">${escaped}</code></pre>\n`
      }
      const langClass = cleanLang ? ` class="language-${escapeHtml(cleanLang)}"` : ''
      return `<div class="code-block"><button type="button" class="code-copy" aria-label="Copy code" title="Copy">${COPY_ICON_SVG}</button><pre><code${langClass}>${escaped}</code></pre></div>\n`
    }
  }
})

// Mermaid is ~1.5 MB — load lazily. Cache rendered SVG by source+theme so
// remounts / re-effects never re-parse a finished diagram.
let mermaidModule: Promise<typeof import('mermaid').default> | null = null
const mermaidCache = new Map<string, string>()
let mermaidSeq = 0

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

  const html = React.useMemo(() => {
    const raw = marked.parse(children, { async: false }) as string
    return DOMPurify.sanitize(raw, {
      ADD_TAGS: ['button', 'svg', 'path', 'rect'],
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
        'stroke-linejoin'
      ]
    })
  }, [children])

  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const cleanups: (() => void)[] = []
    let cancelled = false
    cleanups.push(() => {
      cancelled = true
    })

    // Delegated click handling on the container:
    // Captures copy button clicks and external link opens with zero per-node listeners.
    const onContainerClick = (e: MouseEvent) => {
      // 1. Code copy button
      const copyBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('.code-copy')
      if (copyBtn && container.contains(copyBtn)) {
        e.preventDefault()
        e.stopPropagation()
        void handleCopyClick(copyBtn)
        return
      }

      // 2. External links
      const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>('a')
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
      if (!isMermaidFenceClosed(children)) return
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
  }, [html, pending, children])

  return <div ref={containerRef} className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
})
