import { describe, expect, it, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadTopicsFromDisk, saveTopicsToDisk } from './chatTopicsStore'

describe('chatTopicsStore', () => {
  const testDir = join(tmpdir(), `chat-topics-test-${Date.now()}`)

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('returns empty array if file does not exist', async () => {
    const topics = await loadTopicsFromDisk(testDir)
    expect(topics).toEqual([])
  })

  it('saves and loads topics atomically', async () => {
    await fs.mkdir(testDir, { recursive: true })
    const sampleTopics = [
      { id: 't1', title: 'Topic 1', turns: [] },
      { id: 't2', title: 'Topic 2', turns: [] }
    ]
    const saved = await saveTopicsToDisk(sampleTopics, testDir)
    expect(saved).toBe(true)

    const loaded = await loadTopicsFromDisk(testDir)
    expect(loaded).toEqual(sampleTopics)
  })

  it('coalesces overlapping saves and leaves the newest snapshot on disk', async () => {
    await fs.mkdir(testDir, { recursive: true })
    const first = Array.from({ length: 20_000 }, (_, index) => ({ id: `old-${index}`, turns: [] }))
    const latest = [{ id: 'latest', turns: [] }]

    const firstWrite = saveTopicsToDisk(first, testDir)
    const latestWrite = saveTopicsToDisk(latest, testDir)
    await Promise.all([firstWrite, latestWrite])

    await expect(loadTopicsFromDisk(testDir)).resolves.toEqual(latest)
  })
})
