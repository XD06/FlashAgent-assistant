import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readToolOutput, saveToolOutput } from './ToolOutputStore'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('ToolOutputStore', () => {
  it('reads saved output in bounded pages without rerunning the original tool', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tool-output-'))
    dirs.push(dir)
    await expect(saveToolOutput('call-1', 'abcdefghij', dir)).resolves.toBe(true)

    const page = await readToolOutput('call-1', 3, 4, dir)

    expect(page).toContain('defg')
    expect(page).toContain('offset=7')
    expect(page).toContain('call_id=call-1')
  })

  it('uses the first page when optional paging arguments are absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tool-output-'))
    dirs.push(dir)
    await expect(saveToolOutput('call-2', 'saved output', dir)).resolves.toBe(true)

    await expect(readToolOutput('call-2', Number.NaN, Number.NaN, dir)).resolves.toContain('saved output')
  })

  it('returns false when archival directory cannot be created', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tool-output-'))
    dirs.push(dir)
    const blocker = join(dir, 'not-a-dir')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(blocker, 'x', 'utf8')

    await expect(saveToolOutput('call-err', 'out', blocker)).resolves.toBe(false)
  })
})
