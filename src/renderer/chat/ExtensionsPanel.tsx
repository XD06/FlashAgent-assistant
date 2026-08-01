import React from 'react'
import type { AppSettings, CommandShell, McpServerConfig, McpServerStatus, McpTransport, ReasoningMode, SkillInfo } from '@shared/types'
import { parseMcpJson } from '@shared/mcpJson'
import type { ParsedMcpServer } from '@shared/mcpJson'
import { Icon } from '../icons'

interface ExtensionsPanelProps {
  settings: AppSettings
  isZh: boolean
  workingDir: string | null
  onClose: () => void
}

type PanelTab = 'memory' | 'skills' | 'mcp' | 'other'

// Shell picker only makes sense on Windows — macOS/Linux always run bash.
const IS_WINDOWS_UI = navigator.platform.toLowerCase().includes('win')

const STATE_COLORS: Record<McpServerStatus['state'], string> = {
  connected: '#3fb950',
  connecting: '#d29922',
  error: '#f85149',
  disabled: '#8b949e'
}

/** Small pill switch used by the skills / MCP lists. */
function PillSwitch({
  checked,
  onChange,
  title,
  ariaLabel,
  disabled = false
}: {
  checked: boolean
  onChange: (v: boolean) => void
  title?: string
  ariaLabel?: string
  disabled?: boolean
}) {
  return (
    <label className={`ext-switch${disabled ? ' ext-switch--disabled' : ''}`} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={ariaLabel} onChange={(e) => onChange(e.target.checked)} />
      <span className="ext-switch__track" />
    </label>
  )
}

/** Popup panel consolidating chat-mode extensions: memory, skills and MCP. */
export function ExtensionsPanel({ settings, isZh, workingDir, onClose }: ExtensionsPanelProps): React.JSX.Element {
  const [tab, setTab] = React.useState<PanelTab>('memory')
  const [skills, setSkills] = React.useState<SkillInfo[]>([])
  const [mcp, setMcp] = React.useState<McpServerStatus[]>([])
  const [showAdd, setShowAdd] = React.useState(false)
  const [addMode, setAddMode] = React.useState<'form' | 'json'>('form')
  const [form, setForm] = React.useState({ name: '', transport: 'stdio' as McpTransport, command: '', url: '', env: '' })
  const [jsonText, setJsonText] = React.useState('')
  const [jsonError, setJsonError] = React.useState<string | null>(null)
  const [linkError, setLinkError] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    try {
      const status = await window.assistantLite.ext.status()
      setSkills(status.skills)
      setMcp(status.mcp)
    } catch {
      /* window may be closing */
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  // Poll while any server is still connecting so the dots settle on their own.
  React.useEffect(() => {
    if (!mcp.some((s) => s.state === 'connecting')) return
    const timer = setInterval(() => void refresh(), 1500)
    return () => clearInterval(timer)
  }, [mcp, refresh])

  const toggleSkill = (id: string, enabled: boolean): void => {
    const disabled = settings.disabledSkills.filter((s) => s !== id)
    if (!enabled) disabled.push(id)
    void window.assistantLite.settings.update({ disabledSkills: disabled }).then(refresh)
  }

  // Link an existing folder as a skill in place (no copy). The main process
  // validates that the folder actually contains a parseable SKILL.md.
  const linkSkillFolder = async (): Promise<void> => {
    setLinkError(null)
    const result = await window.assistantLite.ext.linkSkillDir()
    if (result === null) return // dialog cancelled
    if (!result.ok) {
      setLinkError(isZh ? '该文件夹没有 SKILL.md，不是有效的技能文件夹' : 'No SKILL.md found — not a valid skill folder')
      return
    }
    void refresh()
  }

  const unlinkSkill = (dir: string): void => {
    void window.assistantLite.ext.unlinkSkillDir(dir).then(refresh)
  }

  const patchServers = (servers: McpServerConfig[]): void => {
    void window.assistantLite.settings.update({ mcpServers: servers }).then(refresh)
  }

  const toggleServer = (id: string, enabled: boolean): void => {
    patchServers(settings.mcpServers.map((s) => (s.id === id ? { ...s, enabled } : s)))
  }

  const removeServer = (id: string): void => {
    patchServers(settings.mcpServers.filter((s) => s.id !== id))
  }

  // New servers start disabled: the pill switch decides when to connect.
  const addFromForm = (): void => {
    const name = form.name.trim()
    const target = form.transport === 'stdio' ? form.command.trim() : form.url.trim()
    if (!name || !target) return
    patchServers([
      ...settings.mcpServers,
      {
        id: crypto.randomUUID(),
        name,
        transport: form.transport,
        command: form.transport === 'stdio' ? form.command.trim() : undefined,
        env: form.transport === 'stdio' && form.env.trim() ? form.env.trim() : undefined,
        url: form.transport === 'http' ? form.url.trim() : undefined,
        enabled: false
      }
    ])
    setForm({ name: '', transport: 'stdio', command: '', url: '', env: '' })
    setShowAdd(false)
  }

  const addFromJson = (): void => {
    let parsed: ParsedMcpServer[]
    try {
      parsed = parseMcpJson(jsonText)
    } catch {
      setJsonError(isZh ? 'JSON 解析失败，请检查格式' : 'Invalid JSON')
      return
    }
    if (parsed.length === 0) {
      setJsonError(isZh ? '未识别到服务器配置（需要 command 或 url 字段）' : 'No server config found (needs command or url)')
      return
    }
    patchServers([
      ...settings.mcpServers,
        ...parsed.map((p) => ({ id: crypto.randomUUID(), ...p, enabled: false }))
    ])
    setJsonText('')
    setJsonError(null)
    setShowAdd(false)
  }

  const TABS: { id: PanelTab; label: string }[] = [
    { id: 'memory', label: isZh ? '记忆' : 'Memory' },
    { id: 'skills', label: 'Skills' },
    { id: 'mcp', label: 'MCP' },
    { id: 'other', label: isZh ? '其他' : 'Other' }
  ]

  const updateTemperature = (value: string): void => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return
    const max = settings.provider.apiType === 'anthropic' ? 1 : 2
    void window.assistantLite.settings.update({ provider: { temperature: Math.min(max, Math.max(0, parsed)) } })
  }

  return (
    <div className="ext-panel">
      <div className="ext-panel__header">
        <div className="ext-panel__tabs">
          {TABS.map((item) => (
            <button
              key={item.id}
              className={`ext-panel__tab${tab === item.id ? ' ext-panel__tab--active' : ''}`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="ext-panel__header-spacer" />
        <button className="ext-panel__icon-btn" title={isZh ? '刷新' : 'Refresh'} onClick={() => void refresh()}>
          <Icon name="refresh-cw" size={13} />
        </button>
        <button className="ext-panel__icon-btn" title={isZh ? '关闭' : 'Close'} onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>

      {tab === 'memory' && (
        <div className="ext-panel__section">
          <div className="ext-panel__hint">
            {isZh
              ? '每次对话自动注入；让 AI「记住 XX」即可写入（需 Agent 模式）'
              : 'Injected into every chat; ask the AI to "remember X" to update (agent mode)'}
          </div>
          <div className="ext-panel__row-btns">
            <button onClick={() => void window.assistantLite.memory.open()}>
              {isZh ? '全局记忆' : 'Global memory'}
            </button>
            <button
              disabled={!workingDir}
              title={workingDir ?? (isZh ? '先在 Agent 模式选择工作目录' : 'Pick a working directory in agent mode first')}
              onClick={() => workingDir && void window.assistantLite.memory.openProject(workingDir)}
            >
              {isZh ? '项目记忆 (AGENTS.md)' : 'Project memory (AGENTS.md)'}
            </button>
          </div>
        </div>
      )}

      {tab === 'skills' && (
        <div className="ext-panel__section">
          <div className="ext-panel__title">
            <span>{isZh ? '已安装技能' : 'Installed skills'}</span>
            <button className="ext-panel__link" onClick={() => void linkSkillFolder()}>
              {isZh ? '链接文件夹' : 'Link folder'}
            </button>
            <button className="ext-panel__link" onClick={() => void window.assistantLite.ext.openSkillsDir()}>
              {isZh ? '打开技能目录' : 'Open skills folder'}
            </button>
          </div>
          {linkError && <div className="ext-panel__error">{linkError}</div>}
          {skills.length === 0 ? (
            <div className="ext-panel__hint">
              {isZh
                ? '暂无技能。在技能目录下创建 <名称>/SKILL.md，或「链接文件夹」复用已有的技能文件夹。'
                : 'No skills yet. Create <name>/SKILL.md under the skills folder, or link an existing skill folder.'}
            </div>
          ) : (
            skills.map((skill) => (
              <div key={skill.id} className="ext-panel__item" title={skill.linked ? `${skill.file}\n${skill.description}` : skill.description}>
                <span className="ext-panel__item-name">
                  {skill.name}
                  {skill.linked && (
                    <span className="ext-panel__item-tag" title={isZh ? '链接的外部文件夹（原地复用）' : 'Linked external folder (reused in place)'}>
                      <Icon name="link" size={10} />
                    </span>
                  )}
                </span>
                <span className="ext-panel__item-desc">{skill.description}</span>
                {skill.linked && (
                  <button
                    className="ext-panel__icon-btn ext-panel__icon-btn--danger"
                    title={isZh ? '取消链接（不会删除原文件夹）' : 'Unlink (folder is kept)'}
                    onClick={() => unlinkSkill(skill.id)}
                  >
                    <Icon name="trash-2" size={12} />
                  </button>
                )}
                <PillSwitch
                  checked={skill.enabled}
                  onChange={(v) => toggleSkill(skill.id, v)}
                  title={isZh ? (skill.enabled ? '点击停用' : '点击启用') : (skill.enabled ? 'Disable' : 'Enable')}
                />
              </div>
            ))
          )}
          {skills.length > 0 && (
            <div className="ext-panel__hint">{isZh ? '技能需要开启 Agent 模式才会生效' : 'Skills take effect in agent mode'}</div>
          )}
        </div>
      )}

      {tab === 'other' && (
        <div className="ext-panel__section">
          <div className="ext-panel__item">
            <span className="ext-panel__item-name">{isZh ? '完全访问模式' : 'Full access mode'}</span>
            <span className="ext-panel__item-desc">
              {isZh ? 'Agent 工具无需逐条确认' : 'Agent tools run without per-call approval'}
            </span>
            <PillSwitch
              checked={settings.agentFullAccess}
              onChange={(v) => void window.assistantLite.settings.update({ agentFullAccess: v })}
              title={isZh ? (settings.agentFullAccess ? '点击关闭' : '点击开启') : (settings.agentFullAccess ? 'Disable' : 'Enable')}
            />
          </div>
          <div className="ext-panel__hint">
            {isZh
              ? '开启后文件读写与普通命令自动放行；删除等危险命令仍会暂停等待确认，格式化磁盘等毁灭性命令始终直接拦截；MCP 工具调用不受影响，仍需确认。'
              : 'When on, file edits and ordinary commands run automatically. Destructive commands (e.g. deletions) still pause for confirmation, catastrophic ones (e.g. formatting a drive) are always blocked, and MCP tool calls still require approval.'}
          </div>
          {IS_WINDOWS_UI && (
            <>
              <div className="ext-panel__item">
                <span className="ext-panel__item-name">{isZh ? '命令执行环境' : 'Command shell'}</span>
                <span className="ext-panel__item-desc">
                  {isZh ? 'run_command 工具使用的终端' : 'Shell used by the run_command tool'}
                </span>
                <select
                  className="ext-panel__select"
                  value={settings.commandShell}
                  onChange={(e) =>
                    void window.assistantLite.settings.update({ commandShell: e.target.value as CommandShell })
                  }
                >
                  <option value="auto">{isZh ? '自动（Git Bash 优先）' : 'Auto (prefer Git Bash)'}</option>
                  <option value="gitbash">Git Bash</option>
                  <option value="pwsh">PowerShell 7 (pwsh)</option>
                  <option value="powershell">Windows PowerShell 5</option>
                  <option value="cmd">CMD</option>
                </select>
              </div>
              <div className="ext-panel__hint">
                {isZh
                  ? '选定后会在工具描述和系统提示词中明确告知 AI 当前终端及语法要求，减少 bash / PowerShell 语法混用错误；所选终端未安装时自动回退（Git Bash / pwsh → Windows PowerShell 5）。'
                  : 'The chosen shell (and its syntax rules) is stated explicitly in the tool description and system prompt, reducing bash/PowerShell syntax mix-ups. Missing shells fall back automatically (Git Bash / pwsh → Windows PowerShell 5).'}
              </div>
            </>
          )}
          <div className="ext-panel__item ext-panel__item--model-settings">
            <span className="ext-panel__item-name">{isZh ? '模型参数' : 'Model defaults'}</span>
            <span className="ext-panel__item-desc">
              {isZh ? '当前服务商的默认值' : 'Defaults for the current provider'}
            </span>
            <div className="ext-panel__model-controls">
              <label
                className="ext-panel__model-control"
                title={isZh ? '影响所有模型回复的随机性，包括 Agent 工具调用。' : 'Controls randomness for every model response, including Agent tool calls.'}
              >
                <span>{isZh ? '温度' : 'Temp.'}</span>
                <input
                  className="ext-panel__number"
                  type="number"
                  min="0"
                  max={settings.provider.apiType === 'anthropic' ? 1 : 2}
                  step="0.1"
                  value={settings.provider.temperature}
                  aria-label={isZh ? '模型温度' : 'Model temperature'}
                  onChange={(event) => updateTemperature(event.target.value)}
                />
              </label>
              <label
                className="ext-panel__model-control"
                title={isZh ? '自动时不额外发送思考参数；其他选项会按服务商协议请求对应强度。' : 'Auto sends no extra reasoning parameter; other options use the matching provider protocol.'}
              >
                <span>{isZh ? '思考' : 'Reasoning'}</span>
                <select
                  className="ext-panel__select"
                  value={settings.provider.reasoning}
                  aria-label={isZh ? '思考强度' : 'Reasoning intensity'}
                  onChange={(event) =>
                    void window.assistantLite.settings.update({ provider: { reasoning: event.target.value as ReasoningMode } })
                  }
                >
                  <option value="on">{isZh ? '自动' : 'Auto'}</option>
                  <option value="off">{isZh ? '关闭' : 'Off'}</option>
                  <option value="low">{isZh ? '低' : 'Low'}</option>
                  <option value="medium">{isZh ? '中' : 'Medium'}</option>
                  <option value="high">{isZh ? '高' : 'High'}</option>
                </select>
              </label>
            </div>
          </div>
        </div>
      )}

      {tab === 'mcp' && (
        <div className="ext-panel__section">
          <div className="ext-panel__title">
            <span>{isZh ? '服务器' : 'Servers'}</span>
            <button className="ext-panel__link" onClick={() => setShowAdd((v) => !v)}>
              {showAdd ? (isZh ? '收起' : 'Cancel') : (isZh ? '添加服务器' : 'Add server')}
            </button>
          </div>
          {mcp.length === 0 && !showAdd && (
            <div className="ext-panel__hint">{isZh ? '暂无 MCP 服务器' : 'No MCP servers configured'}</div>
          )}
          {mcp.map((server) => {
            const config = settings.mcpServers.find((s) => s.id === server.id)
            const enabled = config?.enabled === true
            return (
              <div key={server.id} className="ext-panel__item" title={server.error ?? server.toolNames.join(', ')}>
                <span className="ext-panel__dot" style={{ background: STATE_COLORS[server.state] }} />
                <span className="ext-panel__item-name">{server.name}</span>
                <span className="ext-panel__item-desc">
                  {server.state === 'connected'
                    ? `${server.toolNames.length} ${isZh ? '个工具' : 'tools'}`
                    : server.state === 'error'
                      ? (isZh ? '连接失败' : 'error')
                      : server.state === 'connecting'
                        ? (isZh ? '连接中…' : 'connecting…')
                        : (isZh ? '未启用' : 'off')}
                </span>
                {enabled && (
                  <button
                    className="ext-panel__icon-btn"
                    title={isZh ? '重新连接' : 'Reconnect'}
                    onClick={() => void window.assistantLite.ext.reconnectMcp(server.id).then(refresh)}
                  >
                    <Icon name="refresh-cw" size={12} />
                  </button>
                )}
                <button className="ext-panel__icon-btn ext-panel__icon-btn--danger" title={isZh ? '删除' : 'Remove'} onClick={() => removeServer(server.id)}>
                  <Icon name="trash-2" size={12} />
                </button>
                <div className="ext-panel__mcp-controls">
                  <span className="ext-panel__mcp-control">
                    <span>{isZh ? '连接' : 'Connect'}</span>
                    <PillSwitch
                      checked={enabled}
                      onChange={(v) => toggleServer(server.id, v)}
                      title={isZh ? (enabled ? '点击断开服务器' : '点击连接服务器') : (enabled ? 'Disconnect server' : 'Connect server')}
                      ariaLabel={isZh ? `${server.name}：连接服务器` : `${server.name}: connect server`}
                    />
                  </span>
                </div>
              </div>
            )
          })}
          {showAdd && (
            <div className="ext-panel__form">
              <div className="ext-panel__seg">
                <button
                  className={addMode === 'form' ? 'ext-panel__seg--active' : ''}
                  onClick={() => setAddMode('form')}
                >
                  {isZh ? '表单' : 'Form'}
                </button>
                <button
                  className={addMode === 'json' ? 'ext-panel__seg--active' : ''}
                  onClick={() => setAddMode('json')}
                >
                  JSON
                </button>
              </div>
              {addMode === 'form' ? (
                <>
                  <input
                    placeholder={isZh ? '名称' : 'Name'}
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                  <select
                    value={form.transport}
                    onChange={(e) => setForm({ ...form, transport: e.target.value as McpTransport })}
                  >
                    <option value="stdio">{isZh ? '本地 (stdio)' : 'Local (stdio)'}</option>
                    <option value="http">{isZh ? '远程 (HTTP/SSE)' : 'Remote (HTTP/SSE)'}</option>
                  </select>
                  {form.transport === 'stdio' ? (
                    <>
                      <input
                        placeholder={isZh ? '命令，如 npx -y @modelcontextprotocol/server-everything' : 'Command, e.g. npx -y @modelcontextprotocol/server-everything'}
                        value={form.command}
                        onChange={(e) => setForm({ ...form, command: e.target.value })}
                      />
                      <textarea
                        rows={2}
                        placeholder={isZh ? '环境变量（可选），每行 KEY=VALUE' : 'Env vars (optional), KEY=VALUE per line'}
                        value={form.env}
                        onChange={(e) => setForm({ ...form, env: e.target.value })}
                      />
                    </>
                  ) : (
                    <input
                      placeholder="https://example.com/mcp"
                      value={form.url}
                      onChange={(e) => setForm({ ...form, url: e.target.value })}
                    />
                  )}
                  <button
                    className="ext-panel__primary"
                    disabled={!form.name.trim() || !(form.transport === 'stdio' ? form.command.trim() : form.url.trim())}
                    onClick={addFromForm}
                  >
                    {isZh ? '添加（默认关闭，用开关连接）' : 'Add (off by default)'}
                  </button>
                </>
              ) : (
                <>
                  <textarea
                    rows={6}
                    placeholder={'{\n  "mcpServers": {\n    "everything": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-everything"]\n    }\n  }\n}'}
                    value={jsonText}
                    onChange={(e) => {
                      setJsonText(e.target.value)
                      setJsonError(null)
                    }}
                  />
                  {jsonError && <div className="ext-panel__error">{jsonError}</div>}
                  <button className="ext-panel__primary" disabled={!jsonText.trim()} onClick={addFromJson}>
                    {isZh ? '识别并添加' : 'Parse & add'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
