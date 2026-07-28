import React from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

// Configure marked once: GFM tables, line breaks.
marked.setOptions({
  gfm: true,
  breaks: true
})

const COPY_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="10" height="10" rx="2"/><path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1"/></svg>'

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

function enhanceCodeBlocks(container: HTMLElement, cleanups: (() => void)[]): void {
  const pres = container.querySelectorAll('pre')
  pres.forEach((pre) => {
    if (pre.parentElement?.classList.contains('code-block')) return
    // Already upgraded to a diagram — leave alone.
    if (pre.parentElement?.classList.contains('mermaid-diagram')) return

    const wrapper = document.createElement('div')
    wrapper.className = 'code-block'

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'code-copy'
    btn.setAttribute('aria-label', 'Copy code')
    btn.title = 'Copy'
    btn.innerHTML = COPY_ICON_SVG

    const onClick = () => {
      const text = pre.textContent ?? ''
      if (!text) return
      void navigator.clipboard.writeText(text)
      btn.textContent = '✓'
      window.setTimeout(() => {
        btn.innerHTML = COPY_ICON_SVG
      }, 1200)
    }

    btn.addEventListener('click', onClick)
    cleanups.push(() => btn.removeEventListener('click', onClick))

    pre.parentNode!.insertBefore(wrapper, pre)
    wrapper.appendChild(btn)
    wrapper.appendChild(pre)
  })
}

/**
 * MarkdownView — renders markdown as sanitized HTML via `marked` + `DOMPurify`.
 *
 * `pending`: while true (streaming), mermaid fences stay as code blocks. Once
 * the turn settles we upgrade closed fences to diagrams. That avoids the
 * flicker of parse → fail → code → parse → SVG on every 50ms flush.
 *
 * Memoized: historical turns re-render on every streaming flush, but their
 * markdown source never changes — skip them entirely.
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
      ADD_ATTR: ['target', 'rel']
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

    enhanceCodeBlocks(container, cleanups)

    // Link handling
    const links = container.querySelectorAll('a[href]')
    links.forEach((link) => {
      link.setAttribute('target', '_blank')
      link.setAttribute('rel', 'noopener noreferrer')
    })
    const onLinkClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest('a')
      if (!anchor) return
      const href = anchor.getAttribute('href')
      if (!href) return
      if (/^https?:\/\//i.test(href)) {
        e.preventDefault()
        e.stopPropagation()
        void window.assistantLite.app.openExternal(href)
      }
    }
    container.addEventListener('click', onLinkClick)
    cleanups.push(() => container.removeEventListener('click', onLinkClick))

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

    // If we already have cached diagram DOM for this content and React just
    // wiped the container via dangerouslySetInnerHTML, put SVGs back before
    // paint when possible (same-tick sync path only works for cache hits).
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
