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
    await saveToolOutput('call-1', 'abcdefghij', dir)

    const page = await readToolOutput('call-1', 3, 4, dir)

    expect(page).toContain('defg')
    expect(page).toContain('offset=7')
    expect(page).toContain('call_id=call-1')
  })

  it('uses the first page when optional paging arguments are absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tool-output-'))
    dirs.push(dir)
    await saveToolOutput('call-2', 'saved output', dir)

    await expect(readToolOutput('call-2', Number.NaN, Number.NaN, dir)).resolves.toContain('saved output')
  })
})
