import { describe, expect, it } from 'vitest'
import { formatTimeAgo, getProjectName, groupTopics, type ChatTopic } from './topicsGrouping'

describe('topicsGrouping', () => {
  it('extracts project basename accurately from windows and unix paths', () => {
    expect(getProjectName('C:\\Users\\dev\\Desktop\\qwen2api')).toBe('qwen2api')
    expect(getProjectName('D:/projects/litellm-proxy/')).toBe('litellm-proxy')
    expect(getProjectName('/home/user/my-agent')).toBe('my-agent')
  })

  it('formats time ago matching Codex style', () => {
    const now = 1700000000000
    expect(formatTimeAgo(now - 10000, true, now)).toBe('刚刚')
    expect(formatTimeAgo(now - 10000, false, now)).toBe('just now')
    expect(formatTimeAgo(now - 3 * 60000, true, now)).toBe('3分')
    expect(formatTimeAgo(now - 4 * 3600000, true, now)).toBe('4时')
    expect(formatTimeAgo(now - 3 * 86400000, true, now)).toBe('3天')
    expect(formatTimeAgo(now - 85 * 86400000, true, now)).toBe('85天')
    expect(formatTimeAgo(now - 85 * 86400000, false, now)).toBe('85d')
  })

  it('groups topics by project workingDir and isolates general tasks', () => {
    const topics: ChatTopic[] = [
      {
        id: 't1',
        title: 'Qwen task',
        turns: [],
        updatedAt: 1000,
        session: { workingDir: 'C:\\projects\\qwen2api', agentEnabled: true, searchEnabled: false }
      },
      {
        id: 't2',
        title: 'LiteLLM pinned',
        turns: [],
        updatedAt: 2000,
        isPinned: true,
        session: { workingDir: 'C:\\projects\\litellm-proxy', agentEnabled: true, searchEnabled: false }
      },
      {
        id: 't3',
        title: 'LiteLLM normal',
        turns: [],
        updatedAt: 3000,
        session: { workingDir: 'C:\\projects\\litellm-proxy', agentEnabled: true, searchEnabled: false }
      },
      {
        id: 't4',
        title: 'General task without workspace',
        turns: [],
        updatedAt: 4000
      },
      {
        id: 't5',
        title: 'General task with cancelled agent workspace',
        turns: [],
        updatedAt: 5000,
        session: { workingDir: 'C:\\projects\\qwen2api', agentEnabled: false, searchEnabled: false }
      }
    ]

    const result = groupTopics(topics)
    expect(result.projects).toHaveLength(2)

    // litellm-proxy has latest update (3000) so it's first
    expect(result.projects[0].name).toBe('litellm-proxy')
    expect(result.projects[0].topics).toHaveLength(2)
    // Within litellm-proxy, pinned task t2 comes first despite lower updatedAt!
    expect(result.projects[0].topics[0].id).toBe('t2')
    expect(result.projects[0].topics[0].isPinned).toBe(true)
    expect(result.projects[0].topics[1].id).toBe('t3')

    expect(result.projects[1].name).toBe('qwen2api')
    expect(result.projects[1].topics).toHaveLength(1)

    // General tasks (t4 has no session, t5 has agentEnabled: false -> both are general tasks!)
    expect(result.generalTasks).toHaveLength(2)
    expect(result.generalTasks[0].id).toBe('t5')
    expect(result.generalTasks[1].id).toBe('t4')
  })

  it('sorts projects by newest topic timestamp even when an older topic in the project is pinned', () => {
    const topics: ChatTopic[] = [
      {
        id: 'p1-old-pin',
        title: 'Old pinned',
        turns: [],
        updatedAt: 100,
        isPinned: true,
        session: { workingDir: 'C:\\projects\\alpha', agentEnabled: true, searchEnabled: false }
      },
      {
        id: 'p1-new',
        title: 'Newest in alpha',
        turns: [],
        updatedAt: 9000,
        session: { workingDir: 'C:\\projects\\alpha', agentEnabled: true, searchEnabled: false }
      },
      {
        id: 'p2-mid',
        title: 'Mid in beta',
        turns: [],
        updatedAt: 5000,
        session: { workingDir: 'C:\\projects\\beta', agentEnabled: true, searchEnabled: false }
      }
    ]

    const result = groupTopics(topics)
    expect(result.projects.map((p) => p.name)).toEqual(['alpha', 'beta'])
    expect(result.projects[0].topics.map((t) => t.id)).toEqual(['p1-old-pin', 'p1-new'])
  })
})
