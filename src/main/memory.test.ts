import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildMemoryPrompt,
  ensureGlobalMemoryFile,
  getGlobalMemoryPath,
  getProjectMemoryPath,
  readMemoryFile
} from './memory'

const dir = mkdtempSync(join(tmpdir(), 'memory-test-'))

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readMemoryFile', () => {
  it('returns trimmed content', async () => {
    const file = join(dir, 'a.md')
    writeFileSync(file, '\n- prefer Chinese comments\n\n', 'utf8')
    expect(await readMemoryFile(file)).toBe('- prefer Chinese comments')
  })

  it('returns empty string for a missing file', async () => {
    expect(await readMemoryFile(join(dir, 'nope.md'))).toBe('')
  })

  it('truncates oversized memory', async () => {
    const file = join(dir, 'big.md')
    writeFileSync(file, 'x'.repeat(10_000), 'utf8')
    const content = await readMemoryFile(file)
    expect(content.length).toBeLessThan(7000)
    expect(content).toContain('(memory truncated)')
  })
})

describe('ensureGlobalMemoryFile', () => {
  it('creates the file with a template on first use, then keeps edits', async () => {
    const userData = join(dir, 'userData')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(userData, { recursive: true })
    const created = await ensureGlobalMemoryFile(userData)
    expect(created).toBe(getGlobalMemoryPath(userData))
    expect(await readMemoryFile(created)).toContain('# Memory')
    writeFileSync(created, '- my rule', 'utf8')
    await ensureGlobalMemoryFile(userData)
    expect(await readMemoryFile(created)).toBe('- my rule')
  })
})

describe('buildMemoryPrompt', () => {
  it('combines global and project memory sections', async () => {
    const userData = join(dir, 'ud2')
    const project = join(dir, 'proj')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(userData, { recursive: true })
    mkdirSync(project, { recursive: true })
    writeFileSync(getGlobalMemoryPath(userData), '- global rule', 'utf8')
    writeFileSync(getProjectMemoryPath(project), '- project rule', 'utf8')
    const prompt = await buildMemoryPrompt(userData, project)
    expect(prompt).toContain('## User memory')
    expect(prompt).toContain('- global rule')
    expect(prompt).toContain('## Project memory')
    expect(prompt).toContain('- project rule')
  })

  it('omits missing layers and returns empty when nothing exists', async () => {
    const userData = join(dir, 'ud3')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(userData, { recursive: true })
    expect(await buildMemoryPrompt(userData)).toBe('')
    writeFileSync(getGlobalMemoryPath(userData), '- only global', 'utf8')
    const prompt = await buildMemoryPrompt(userData)
    expect(prompt).toContain('- only global')
    expect(prompt).not.toContain('## Project memory')
  })
})
