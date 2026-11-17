import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadTopicsFromDisk, saveTopicChangesToDisk, saveTopicsToDisk } from './chatTopicsStore'

describe('chatTopicsStore', () => {
  // A fresh directory per test: the store caches per-path shard state, so a
  // shared path would leak state across cases.
  let testDir = ''
  const save = (topics: unknown[], changedTopicIds?: string[]) =>
    saveTopicsToDisk(topics, { customDir: testDir, changedTopicIds })
  const patch = (order: string[], upserts: unknown[], dir = testDir) =>
    saveTopicChangesToDisk({ order, upserts }, { customDir: dir })
  const shardPath = (id: string) => join(testDir, 'chat-topics', `${id}.json`)

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'fa-chat-topics-'))
  })

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('returns empty array if nothing is on disk', async () => {
    await expect(loadTopicsFromDisk(testDir)).resolves.toEqual([])
  })

  it('saves and loads topics atomically', async () => {
    const sampleTopics = [
      { id: 't1', title: 'Topic 1', turns: [] },
      { id: 't2', title: 'Topic 2', turns: [] }
    ]
    await expect(save(sampleTopics)).resolves.toBe(true)
    await expect(loadTopicsFromDisk(testDir)).resolves.toEqual(sampleTopics)
  })

  it(
    'coalesces overlapping saves and leaves the newest snapshot on disk',
    async () => {
      // One shard per topic — a few hundred topics keeps this fast while still
      // exercising overlapping writes.
      const first = Array.from({ length: 300 }, (_, index) => ({ id: `old-${index}`, turns: [] }))
      const latest = [{ id: 'latest', turns: [] }]

      await Promise.all([save(first), save(latest)])

      await expect(loadTopicsFromDisk(testDir)).resolves.toEqual(latest)
    },
    15_000
  )

  it('rewrites only the declared changed topics', async () => {
    await save([{ id: 't1', v: 1 }, { id: 't2', v: 1 }, { id: 't3', v: 1 }])

    // Damage a shard that the next save must NOT touch.
    await fs.writeFile(shardPath('t2'), '{"id":"t2","v":999}', 'utf8')
    await save([{ id: 't1', v: 2 }, { id: 't2', v: 1 }, { id: 't3', v: 1 }], ['t1'])

    await expect(fs.readFile(shardPath('t2'), 'utf8')).resolves.toBe('{"id":"t2","v":999}')
    await expect(loadTopicsFromDisk(testDir)).resolves.toEqual([
      { id: 't1', v: 2 },
      { id: 't2', v: 999 },
      { id: 't3', v: 1 }
    ])
  })

  it('deletes orphan shards of removed topics', async () => {
    await save([{ id: 't1', v: 1 }, { id: 't2', v: 1 }])
    await save([{ id: 't1', v: 1 }], [])

    await expect(fs.access(shardPath('t2'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(loadTopicsFromDisk(testDir)).resolves.toEqual([{ id: 't1', v: 1 }])
  })

  it('migrates the legacy single file on the first sharded save', async () => {
    const legacy = [{ id: 't1', v: 1 }, { id: 't2', v: 1 }]
    await fs.writeFile(join(testDir, 'chat-topics.json'), JSON.stringify(legacy), 'utf8')
    await expect(loadTopicsFromDisk(testDir)).resolves.toEqual(legacy)

    // Changed-set declarations are ignored while the legacy file exists: a
    // partial write would strand the not-yet-sharded topics.
    await save([{ id: 't1', v: 2 }, { id: 't2', v: 1 }], ['t1'])

    await expect(fs.access(join(testDir, 'chat-topics.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(join(testDir, 'chat-topics.json.bak'), 'utf8')).resolves.toBe(JSON.stringify(legacy))
    await expect(loadTopicsFromDisk(testDir)).resolves.toEqual([{ id: 't1', v: 2 }, { id: 't2', v: 1 }])

    // From here on incremental saves apply.
    await save([{ id: 't1', v: 2 }, { id: 't2', v: 3 }], ['t2'])
    await expect(loadTopicsFromDisk(testDir)).resolves.toEqual([{ id: 't1', v: 2 }, { id: 't2', v: 3 }])
  })

  it('recovers shards that a crash left out of the index', async () => {
    await save([{ id: 't1', v: 1 }])
    // Simulate a crash between a shard write and the index commit.
    await fs.writeFile(shardPath('t9'), '{"id":"t9","v":1}', 'utf8')
    await expect(loadTopicsFromDisk(testDir)).resolves.toEqual([{ id: 't1', v: 1 }, { id: 't9', v: 1 }])
  })

  it('incremental save writes only the upserted shards and updates order', async () => {
    await save([{ id: 't1', v: 1 }, { id: 't2', v: 1 }])
    // Damage a shard the patch must not touch.
    await fs.writeFile(shardPath('t2'), '{"id":"t2","v":999}', 'utf8')

    await expect(patch(['t2', 't1'], [{ id: 't1', v: 2 }])).resolves.toEqual({ ok: true })
    await expect(fs.readFile(shardPath('t2'), 'utf8')).resolves.toBe('{"id":"t2","v":999}')
    await expect(loadTopicsFromDisk(testDir)).resolves.toEqual([
      { id: 't2', v: 999 },
      { id: 't1', v: 2 }
    ])
  })

  it('incremental save asks for a full save before the shard layout exists', async () => {
    await fs.writeFile(
      join(testDir, 'chat-topics.json'),
      JSON.stringify([{ id: 't1', v: 1 }]),
      'utf8'
    )
    await expect(loadTopicsFromDisk(testDir)).resolves.toEqual([{ id: 't1', v: 1 }])
    await expect(patch(['t1'], [{ id: 't1', v: 2 }])).resolves.toEqual({ ok: false, needsFull: true })
  })

  it('incremental save asks for a full save when a new order id has no body', async () => {
    await save([{ id: 't1', v: 1 }])
    await expect(patch(['t1', 't2'], [])).resolves.toEqual({ ok: false, needsFull: true })
    await expect(patch(['t1', 't2'], [{ id: 't2', v: 1 }])).resolves.toEqual({ ok: true })
    await expect(loadTopicsFromDisk(testDir)).resolves.toEqual([{ id: 't1', v: 1 }, { id: 't2', v: 1 }])
  })

  it('incremental save deletes orphan shards and supports reorder-only patches', async () => {
    await save([{ id: 't1', v: 1 }, { id: 't2', v: 1 }, { id: 't3', v: 1 }])
    await expect(patch(['t3', 't1'], [])).resolves.toEqual({ ok: true })

    await expect(fs.access(shardPath('t2'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(loadTopicsFromDisk(testDir)).resolves.toEqual([
      { id: 't3', v: 1 },
      { id: 't1', v: 1 }
    ])
  })

  it('coalesces overlapping patches by id and keeps the newest body', async () => {
    await save([{ id: 't1', v: 1 }, { id: 't2', v: 1 }])
    await Promise.all([
      patch(['t1', 't2'], [{ id: 't1', v: 2 }]),
      patch(['t1', 't2'], [{ id: 't1', v: 3 }, { id: 't2', v: 3 }])
    ])
    await expect(loadTopicsFromDisk(testDir)).resolves.toEqual([
      { id: 't1', v: 3 },
      { id: 't2', v: 3 }
    ])
  })

  it('keeps different base directories isolated', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'fa-chat-topics-other-'))
    try {
      await save([{ id: 't1', v: 1 }])
      await saveTopicsToDisk([{ id: 'o1', v: 1 }], { customDir: otherDir })
      await expect(patch(['t1'], [{ id: 't1', v: 2 }])).resolves.toEqual({ ok: true })
      await expect(loadTopicsFromDisk(otherDir)).resolves.toEqual([{ id: 'o1', v: 1 }])
      await expect(loadTopicsFromDisk(testDir)).resolves.toEqual([{ id: 't1', v: 2 }])
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true })
    }
  })

  it('reports a failed patch and succeeds on retry', async () => {
    await save([{ id: 't1', v: 1 }])
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
    await expect(patch(['t1'], [{ id: 't1', v: 2 }])).resolves.toEqual({ ok: false })
    renameSpy.mockRestore()

    await expect(patch(['t1'], [{ id: 't1', v: 2 }])).resolves.toEqual({ ok: true })
    await expect(loadTopicsFromDisk(testDir)).resolves.toEqual([{ id: 't1', v: 2 }])
  })
})
