export interface ChatTurn {
  id?: string
  taskRoundId?: string
  role: 'user' | 'assistant'
  text: string
  [key: string]: any
}

export interface TopicSession {
  agentEnabled: boolean
  workingDir: string | null
  searchEnabled: boolean
}

export interface ChatTopic {
  id: string
  title: string
  customTitle?: boolean
  aiTitle?: boolean
  turns: ChatTurn[]
  model?: string
  updatedAt: number
  isPinned?: boolean
  compact?: any
  session?: TopicSession
  usage?: { tokens: number; atTurns: number }
}

export interface ProjectGroup {
  id: string
  name: string
  path: string
  topics: ChatTopic[]
}

/**
 * Extracts a human-friendly project name from a directory path.
 * E.g. "C:\\Users\\user\\Desktop\\qwen2api" -> "qwen2api"
 * "D:/projects/litellm-proxy/" -> "litellm-proxy"
 */
export function getProjectName(dirPath: string): string {
  if (!dirPath) return ''
  const trimmed = dirPath.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || trimmed
}

/**
 * Formats a timestamp into human-readable relative time matching Codex style.
 * E.g. "刚刚", "3分", "2时", "3天", "85天" (zh)
 * or "just now", "3m", "2h", "3d", "85d" (en).
 */
export function formatTimeAgo(timestamp: number, isZh: boolean = true, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - timestamp)
  const diffMinutes = Math.floor(diffMs / 60000)
  if (diffMinutes < 1) return isZh ? '刚刚' : 'just now'
  if (diffMinutes < 60) return isZh ? `${diffMinutes}分` : `${diffMinutes}m`
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return isZh ? `${diffHours}时` : `${diffHours}h`
  const diffDays = Math.floor(diffHours / 24)
  return isZh ? `${diffDays}天` : `${diffDays}d`
}

/**
 * Groups topics into projects (with workingDir) and general tasks (without workingDir).
 * Within each project/section:
 * Pinned topics are sorted first, then by updatedAt descending.
 */
export function groupTopics(topics: ChatTopic[]): {
  projects: ProjectGroup[]
  generalTasks: ChatTopic[]
} {
  const projectMap = new Map<string, ChatTopic[]>()
  const generalTasks: ChatTopic[] = []

  const sortFn = (a: ChatTopic, b: ChatTopic) => {
    if (!!a.isPinned !== !!b.isPinned) {
      return a.isPinned ? -1 : 1
    }
    return (b.updatedAt || 0) - (a.updatedAt || 0)
  }

  for (const topic of topics) {
    // Only topics with an active agent workspace belong to a project.
    // If agentEnabled is false, or workingDir is empty/missing, it is a general task.
    const isProjectTask = topic.session?.agentEnabled !== false && !!topic.session?.workingDir?.trim()
    const dir = isProjectTask ? topic.session!.workingDir!.trim() : null
    if (dir) {
      const existing = projectMap.get(dir)
      if (existing) {
        existing.push(topic)
      } else {
        projectMap.set(dir, [topic])
      }
    } else {
      generalTasks.push(topic)
    }
  }

  const projects: ProjectGroup[] = Array.from(projectMap.entries()).map(([dir, topicList]) => {
    topicList.sort(sortFn)
    return {
      id: dir,
      name: getProjectName(dir),
      path: dir,
      topics: topicList
    }
  })

  // Sort projects by the latest updated topic in the project
  projects.sort((a, b) => {
    const latestA = a.topics[0]?.updatedAt || 0
    const latestB = b.topics[0]?.updatedAt || 0
    return latestB - latestA
  })

  generalTasks.sort(sortFn)

  return {
    projects,
    generalTasks
  }
}
