import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, promises as fs, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const state = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }))

import { deleteSnapshot, loadSnapshot, saveSnapshot } from './SnapshotStore'
import { MAX_MUTATION_BYTES } from './mutationLimits'

const testDir = mkdtempSync(join(tmpdir(), 'fa-snapshots-'))
state.dir = testDir
const snapDir = join(testDir, 'tool-snapshots')

describe('SnapshotStore', () => {
  beforeEach(async () => {
    // snapshotDir() caches the directory for the process, so clear its files
    // between cases instead of swapping the mocked userData path.
    await fs.rm(snapDir, { recursive: true, force: true })
    await fs.mkdir(snapDir, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true })
  })

  it('saves and loads a snapshot', async () => {
    const target = join(testDir, 'a.txt')
    await saveSnapshot('c1', { path: target, content: 'old content' })
    await expect(loadSnapshot('c1')).resolves.toEqual({ path: target, content: 'old content' })
  })

  it('keeps a created-file snapshot (null content)', async () => {
    const target = join(testDir, 'new.txt')
    await saveSnapshot('c2', { path: target, content: null })
    await expect(loadSnapshot('c2')).resolves.toEqual({ path: target, content: null })
  })

  it('deletes a snapshot', async () => {
    await saveSnapshot('c3', { path: join(testDir, 'c.txt'), content: 'x' })
    await deleteSnapshot('c3')
    await expect(loadSnapshot('c3')).resolves.toBeNull()
  })

  it('refuses an oversized snapshot but keeps the record on disk', async () => {
    const target = join(testDir, 'big.txt')
    const file = join(snapDir, 'big.json')
    writeFileSync(file, JSON.stringify({ path: target, content: 'a'.repeat(MAX_MUTATION_BYTES + 1) }), 'utf8')
    await expect(loadSnapshot('big')).resolves.toBeNull()
    expect((await fs.stat(file)).size).toBeGreaterThan(0)
  })

  it('refuses malformed content instead of treating it as a created file', async () => {
    const file = join(snapDir, 'bad.json')
    writeFileSync(file, JSON.stringify({ path: join(testDir, 'x.txt'), content: 123 }), 'utf8')
    await expect(loadSnapshot('bad')).resolves.toBeNull()
  })

  it('prunes the oldest snapshots beyond the count cap', async () => {
    for (let i = 0; i < 105; i++) {
      await saveSnapshot(`cap-${i}`, { path: join(testDir, `${i}.txt`), content: 'x' })
    }
    const names = (await fs.readdir(snapDir)).filter((name) => name.endsWith('.json'))
    expect(names.length).toBe(100)
    await expect(loadSnapshot('cap-0')).resolves.toBeNull()
    await expect(loadSnapshot('cap-104')).resolves.not.toBeNull()
  })
})
