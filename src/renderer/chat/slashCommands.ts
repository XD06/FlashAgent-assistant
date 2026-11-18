import type { McpServerStatus, SkillInfo } from '@shared/types'
import type { ExtensionsPanelTab } from './ExtensionsPanel'

export type SlashCommandAction =
  | { type: 'compact' }
  | { type: 'open-ext'; tab: ExtensionsPanelTab }
  | { type: 'toggle-agent' }
  | { type: 'pick-workspace' }
  | { type: 'toggle-search' }
  | { type: 'new-chat' }
  | { type: 'toggle-temp' }
  | { type: 'toggle-history' }
  | { type: 'use-skill'; skill: SkillInfo }

export interface SlashCommandItem {
  id: string
  /** Command keyword shown after `/` (e.g. `compact`, `skills`). */
  command: string
  /** Icon name registered in `src/renderer/icons.tsx`. */
  icon: string
  description: string
  /** Optional concise status pill shown on the right (e.g. `已开启`, `2 connected`, `Skill`). */
  badge?: string
  aliases: string[]
  kind: 'command' | 'skill'
  action: SlashCommandAction
}

export interface BuildSlashCommandsOptions {
  isZh: boolean
  agentEnabled: boolean
  workingDir: string | null
  searchEnabled: boolean
  temporaryChat: boolean
  skills: SkillInfo[]
  mcpServers: McpServerStatus[]
}

const SINGLE_LEADING_SLASH_RE = /^\s*\/([^\s/]*)$/

/**
 * Extract the active `/` command query only when the composer contains a single
 * leading `/` token (no spaces and no second `/`, so UNIX paths like `/usr/bin`
 * or mid-sentence slashes never hijack the composer).
 */
export function extractSlashQuery(input: string): string | null {
  const match = SINGLE_LEADING_SLASH_RE.exec(input)
  return match ? match[1] : null
}

function toSkillCommandSlug(skill: SkillInfo): string {
  const raw = (skill.name || skill.id).trim().toLowerCase()
  const slug = raw.replace(/\s+/g, '-').replace(/\/+/g, '-')
  return slug || skill.id
}

export function buildSlashCommands(opts: BuildSlashCommandsOptions): SlashCommandItem[] {
  const { isZh, agentEnabled, workingDir, searchEnabled, temporaryChat, skills, mcpServers } = opts
  const enabledSkills = skills.filter((s) => s.enabled)
  const connectedMcp = mcpServers.filter((m) => m.state === 'connected').length
  const totalMcp = mcpServers.length
  const dirLabel = workingDir ? workingDir.split(/[\\/]/).filter(Boolean).pop() : undefined

  const builtins: SlashCommandItem[] = [
    {
      id: 'compact',
      command: 'compact',
      icon: 'summarize',
      description: isZh
        ? '压缩较早的历史对话，释放上下文空间'
        : 'Compact earlier conversation to free context window',
      aliases: ['compress', 'ctx', 'recap', '压缩'],
      kind: 'command',
      action: { type: 'compact' }
    },
    {
      id: 'skills',
      command: 'skills',
      icon: 'blocks',
      description: isZh
        ? '打开 Skills 技能面板（启用、导入或管理）'
        : 'Open Skills panel to enable or manage skills',
      badge: enabledSkills.length > 0 ? (isZh ? `${enabledSkills.length} 已启用` : `${enabledSkills.length} on`) : undefined,
      aliases: ['skill', '技能'],
      kind: 'command',
      action: { type: 'open-ext', tab: 'skills' }
    },
    {
      id: 'mcp',
      command: 'mcp',
      icon: 'link',
      description: isZh
        ? '打开 MCP 服务面板（查看连接与可用工具）'
        : 'Open MCP servers panel & tool connections',
      badge: totalMcp > 0 ? `${connectedMcp}/${totalMcp}` : undefined,
      aliases: ['servers', 'server', 'connectors', '工具服务'],
      kind: 'command',
      action: { type: 'open-ext', tab: 'mcp' }
    },
    {
      id: 'memory',
      command: 'memory',
      icon: 'brain',
      description: isZh
        ? '打开长期记忆面板（查看与管理记忆条目）'
        : 'Open long-term Memory panel',
      aliases: ['mem', '记忆'],
      kind: 'command',
      action: { type: 'open-ext', tab: 'memory' }
    },
    {
      id: 'agent',
      command: 'agent',
      icon: 'terminal',
      description: isZh
        ? '开启或关闭 Agent 本地文件与命令工具模式'
        : 'Toggle Agent mode for local tools & workspace',
      badge: agentEnabled ? (isZh ? '已开启' : 'On') : isZh ? '未开启' : 'Off',
      aliases: ['tools', 'code', '代理'],
      kind: 'command',
      action: { type: 'toggle-agent' }
    },
    {
      id: 'workspace',
      command: 'workspace',
      icon: 'folder',
      description: isZh
        ? '选择或切换 Agent 工作区目录'
        : 'Choose or switch the Agent working directory',
      badge: dirLabel,
      aliases: ['dir', 'cwd', 'folder', '工作区', '目录'],
      kind: 'command',
      action: { type: 'pick-workspace' }
    },
    {
      id: 'search',
      command: 'search',
      icon: 'globe',
      description: isZh
        ? '开启或关闭联网搜索增强回答'
        : 'Toggle web search for live information',
      badge: searchEnabled ? (isZh ? '已开启' : 'On') : isZh ? '已关闭' : 'Off',
      aliases: ['web', 'net', '联网', '搜索'],
      kind: 'command',
      action: { type: 'toggle-search' }
    },
    {
      id: 'new',
      command: 'new',
      icon: 'new-topic',
      description: isZh
        ? '开始一段新对话'
        : 'Start a new conversation',
      aliases: ['clear', 'reset', '新对话'],
      kind: 'command',
      action: { type: 'new-chat' }
    },
    {
      id: 'temp',
      command: 'temp',
      icon: 'incognito',
      description: isZh
        ? '切换无痕对话模式（不保存历史）'
        : 'Toggle incognito conversation mode',
      badge: temporaryChat ? (isZh ? '无痕中' : 'Active') : undefined,
      aliases: ['incognito', 'private', '无痕', '临时'],
      kind: 'command',
      action: { type: 'toggle-temp' }
    },
    {
      id: 'history',
      command: 'history',
      icon: 'history',
      description: isZh
        ? '打开或收起历史对话侧栏'
        : 'Toggle conversation history sidebar',
      aliases: ['topics', '历史'],
      kind: 'command',
      action: { type: 'toggle-history' }
    }
  ]

  const skillItems: SlashCommandItem[] = enabledSkills.map((skill) => ({
    id: `skill:${skill.id}`,
    command: toSkillCommandSlug(skill),
    icon: 'sparkles',
    description:
      skill.description?.trim() ||
      (isZh ? `启用技能「${skill.name}」` : `Use skill "${skill.name}"`),
    badge: isZh ? '技能' : 'Skill',
    aliases: [skill.name.toLowerCase(), skill.id.toLowerCase()],
    kind: 'skill',
    action: { type: 'use-skill', skill }
  }))

  return [...builtins, ...skillItems]
}

export function filterSlashCommands(items: SlashCommandItem[], query: string): SlashCommandItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items

  const scored: Array<{ item: SlashCommandItem; score: number }> = []
  for (const item of items) {
    const cmd = item.command.toLowerCase()
    const desc = item.description.toLowerCase()
    let score = 0
    if (cmd.startsWith(q)) {
      score = 4
    } else if (item.aliases.some((alias) => alias.toLowerCase().startsWith(q))) {
      score = 3
    } else if (cmd.includes(q) || item.aliases.some((alias) => alias.toLowerCase().includes(q))) {
      score = 2
    } else if (desc.includes(q)) {
      score = 1
    }
    if (score > 0) scored.push({ item, score })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.map((entry) => entry.item)
}
