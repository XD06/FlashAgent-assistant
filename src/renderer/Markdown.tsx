import React from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Icon } from './icons'

// Fenced code blocks get a hover copy button. Long lines wrap (see styles.css)
// so nothing is hidden behind a horizontal scrollbar in the narrow result window.
function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
  const preRef = React.useRef<HTMLPreElement>(null)
  const [copied, setCopied] = React.useState(false)

  const copy = () => {
    const text = preRef.current?.textContent ?? ''
    if (!text) return
    void navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="code-block">
      <button type="button" className="code-copy" onClick={copy} aria-label="Copy code" title="Copy">
        {copied ? '✓' : <Icon name="copy" size={13} />}
      </button>
      <pre ref={preRef} {...props} />
    </div>
  )
}

const COMPONENTS = { pre: CodeBlock }

export function MarkdownView({ children }: { children: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
      {children}
    </Markdown>
  )
}
