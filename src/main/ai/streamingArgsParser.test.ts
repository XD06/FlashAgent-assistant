import { describe, expect, it } from 'vitest'
import {
  extractPartialProperty,
  parseStreamingToolArgs,
  unescapePartialJsonString
} from './streamingArgsParser'

describe('unescapePartialJsonString', () => {
  it('handles regular text without escapes', () => {
    expect(unescapePartialJsonString('hello world')).toBe('hello world')
  })

  it('stops at unescaped closing double quote', () => {
    expect(unescapePartialJsonString('hello" trailing')).toBe('hello')
  })

  it('correctly handles escape sequences', () => {
    expect(unescapePartialJsonString('line 1\\nline 2\\tindent \\"quoted\\"')).toBe(
      'line 1\nline 2\tindent "quoted"'
    )
  })

  it('handles incomplete escape sequence at the end of stream', () => {
    expect(unescapePartialJsonString('line 1\\')).toBe('line 1')
  })

  it('handles unicode escape sequence', () => {
    expect(unescapePartialJsonString('\\u4e2d\\u6587 text')).toBe('中文 text')
  })
})

describe('extractPartialProperty', () => {
  it('extracts property from incomplete JSON', () => {
    const raw = '{"path": "src/index.ts", "content": "function main() {'
    expect(extractPartialProperty(raw, 'path')).toBe('src/index.ts')
    expect(extractPartialProperty(raw, 'content')).toBe('function main() {')
  })

  it('extracts property even when spaces exist around colon', () => {
    const raw = '{\n  "path"  :  "README.md"\n}'
    expect(extractPartialProperty(raw, 'path')).toBe('README.md')
  })

  it('returns null if property is not found', () => {
    const raw = '{"other": "val"}'
    expect(extractPartialProperty(raw, 'path')).toBeNull()
  })
})

describe('parseStreamingToolArgs', () => {
  it('parses write_file streaming progress', () => {
    const partialJson = '{"path": "src/components/Button.tsx", "content": "export const Button = () => {\\n  return <button>Click</button>\\n}"'
    const result = parseStreamingToolArgs('write_file', partialJson)
    expect(result.summary).toBe('src/components/Button.tsx')
    expect(result.content).toBe('export const Button = () => {\n  return <button>Click</button>\n}')
    expect(result.charCount).toBe(partialJson.length)
  })

  it('parses write_file when only path is available', () => {
    const partialJson = '{"path": "src/foo.ts"'
    const result = parseStreamingToolArgs('write_file', partialJson)
    expect(result.summary).toBe('src/foo.ts')
    expect(result.content).toBeUndefined()
  })

  it('parses run_command streaming progress', () => {
    const partialJson = '{"command": "pnpm test --watch'
    const result = parseStreamingToolArgs('run_command', partialJson)
    expect(result.summary).toBe('pnpm test --watch')
    expect(result.command).toBe('pnpm test --watch')
  })

  it('parses edit_file with old_text and new_text', () => {
    const partialJson = '{"path": "src/foo.ts", "old_text": "const a = 1", "new_text": "const a = 2'
    const result = parseStreamingToolArgs('edit_file', partialJson)
    expect(result.summary).toBe('src/foo.ts')
    expect(result.oldText).toBe('const a = 1')
    expect(result.content).toBe('const a = 2')
  })

  it('resolves relative path when workingDir is provided', () => {
    const cwd = process.platform === 'win32' ? 'C:\\project' : '/project'
    const filePath = process.platform === 'win32' ? 'C:\\project\\src\\index.ts' : '/project/src/index.ts'
    const partialJson = `{"path": "${filePath.replace(/\\/g, '\\\\')}"`
    const result = parseStreamingToolArgs('write_file', partialJson, cwd)
    expect(result.summary.replace(/\\/g, '/')).toBe('src/index.ts')
  })
})
