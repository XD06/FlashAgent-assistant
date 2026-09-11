import { describe, expect, it } from 'vitest'
import { marked } from 'marked'
import { highlightCode, buildHtmlPreviewDoc, buildSvgPreviewDoc } from './Markdown'

describe('Markdown Code Block & Syntax Highlighting', () => {
  it('highlights recognized languages with highlight.js span tags', () => {
    const tsCode = 'const x: number = 42;'
    const highlighted = highlightCode(tsCode, 'typescript')
    expect(highlighted).toContain('hljs-keyword')
    expect(highlighted).toContain('const')
    expect(highlighted).toContain('hljs-number')
    expect(highlighted).toContain('42')
  })

  it('escapes special characters when language is unknown or unsupported', () => {
    const raw = '<div onclick="alert(1)">&foo</div>'
    const result = highlightCode(raw, 'unknownlang123')
    expect(result).toBe('&lt;div onclick=&quot;alert(1)&quot;&gt;&amp;foo&lt;/div&gt;')
    expect(result).not.toContain('<div')
  })

  it('wraps HTML snippets with doctype, reset styles and media queries', () => {
    const snippet = '<button class="btn">Click me</button>'
    const doc = buildHtmlPreviewDoc(snippet)
    expect(doc).toContain('<!DOCTYPE html>')
    expect(doc).toContain('<meta charset="utf-8">')
    expect(doc).toContain('prefers-color-scheme: dark')
    expect(doc).toContain(snippet)
  })

  it('preserves complete HTML documents intact', () => {
    const fullDoc = '<!DOCTYPE html><html><head><title>Test</title></head><body><h1>Hi</h1></body></html>'
    const doc = buildHtmlPreviewDoc(fullDoc)
    expect(doc).toBe(fullDoc)
  })

  it('wraps SVG snippets with checkerboard background and responsive SVG styling', () => {
    const svg = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" /></svg>'
    const doc = buildSvgPreviewDoc(svg)
    expect(doc).toContain('<!DOCTYPE html>')
    expect(doc).toContain('repeating-conic-gradient')
    expect(doc).toContain('max-width: 100%')
    expect(doc).toContain(svg)
  })

  it('renders standard code blocks with copy button and highlighted code', () => {
    const md = '```python\ndef hello():\n    return "world"\n```'
    const parsed = marked.parse(md, { async: false }) as string
    expect(parsed).toContain('class="code-block"')
    expect(parsed).toContain('data-action="copy-code"')
    expect(parsed).toContain('class="language-python"')
    expect(parsed).toContain('hljs-keyword')
    expect(parsed).toContain('def')
    expect(parsed).not.toContain('code-block--previewable')
  })

  it('renders HTML code blocks as previewable with code/preview tabs and sandboxed iframe', () => {
    const md = '```html\n<div class="card">Hello World</div>\n```'
    const parsed = marked.parse(md, { async: false }) as string
    expect(parsed).toContain('code-block--previewable')
    expect(parsed).toContain('data-action="tab-code"')
    expect(parsed).toContain('data-action="tab-preview"')
    expect(parsed).toContain('data-action="copy-code"')
    expect(parsed).toContain('data-action="reload-preview"')
    expect(parsed).toContain('class="html-preview-frame"')
    expect(parsed).toContain('sandbox="allow-scripts"')
    expect(parsed).toContain('data-srcdoc=')
    expect(parsed).toContain('Hello World')
  })

  it('leaves mermaid code blocks plain for lazy client-side rendering', () => {
    const md = '```mermaid\ngraph TD;\nA-->B;\n```'
    const parsed = marked.parse(md, { async: false }) as string
    expect(parsed).toBe('<pre><code class="language-mermaid">graph TD;\nA--&gt;B;</code></pre>\n')
    expect(parsed).not.toContain('code-block')
  })
})
