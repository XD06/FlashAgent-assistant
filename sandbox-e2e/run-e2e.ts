/**
 * 上下文压缩 E2E 回归工具：用本机真实 provider 配置，走生产代码链验证
 * P1-A(usage 采集) → P1-B(触发判定) → P1-C(五节复工文档压缩) → 压缩后连续性。
 *
 * 生产代码直接 import：
 *   - shouldCompact / 常量  ← src/renderer/chat/compaction.ts
 *   - streamChatMessages    ← src/main/ai/OpenAICompatibleClient.ts
 * payload 构建、摘要注入格式逐字复刻 ChatMode.tsx / main index.ts ——两处
 * 若有改动，需同步本脚本（详见同目录 README.md）。
 *
 * 运行：pnpm e2e:compaction（会发 4 次真实 API 请求，消耗少量 token）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import {
  COMPACT_KEEP_RECENT,
  COMPACT_TRIGGER_TOKENS,
  shouldCompact
} from '../src/renderer/chat/compaction'
import { streamChatMessages } from '../src/main/ai/OpenAICompatibleClient'
import type { ProviderFetch, TokenUsage } from '../src/main/ai/OpenAICompatibleClient'
import type { AiMessageInput, ProviderSettings } from '../src/shared/types'

// ---------- 0. 读取用户真实配置（与 settingsStore 同一文件） ----------
const settingsPath = path.join(
  process.env.APPDATA ?? '',
  'selection-assistant-lite',
  'settings.json'
)
const stored = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).settings
const provider: ProviderSettings = stored.provider
const compressModel: string = (stored.compressModel ?? '').trim()
const proxyUrl: string = (stored.proxyUrl ?? '').trim()

const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
// 等价于主进程 net.fetch 走 session 手动代理
const providerFetch: ProviderFetch = (url, init) =>
  undiciFetch(url as string, { ...(init as object), dispatcher } as never) as unknown as Promise<Response>

const log = (s: string): void => console.log(s)
const hr = (title: string): void =>
  log(`\n${'='.repeat(12)} ${title} ${'='.repeat(12)}`)

// ---------- 模拟对话素材（围绕 sandbox-e2e/mock-project） ----------
// 陈旧区(前 6 轮)埋入关键事实：ROTATE_TIMEOUT_MS 2000→3500、LOCK_FILE
// '.rotate.lock'、zip→gzip、失败路径 fs.watch。近因区(后 10 轮)刻意不再
// 提这些事实 —— 连续性测试的答案只能来自复工文档。
const fakeLog = Array.from({ length: 220 }, (_, i) =>
  `[2026-07-27T14:${String(10 + (i % 45)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.412Z] WARN rotate worker#${i % 4} slow scan: dir=D:\\logs\\prod entries=${18000 + i * 7} elapsed=${1800 + i * 3}ms`
).join('\n')

interface Turn { role: 'user' | 'assistant'; text: string }
const turns: Turn[] = [
  // ---- 陈旧区（将被压缩） ----
  { role: 'user', text: `我的 log-rotator 项目在生产机上轮转超时，报 "rotate timed out"。项目在 sandbox-e2e/mock-project。下面是这段时间的日志：\n${fakeLog}` },
  { role: 'assistant', text: '我读了 src/rotator.js 和 src/config.js。问题定位：目录有 1.8 万个文件时 listLogs 的全量 statSync 扫描就要 ~2.4s，而 config 里 ROTATE_TIMEOUT_MS 是 2000，必然超时。另外发现 COMPRESS_FORMAT 配的是 zip，但 rotator.js 实际用 zlib.createGzip，配置和实现不一致。我先试了用 fs.watch 增量监听目录来避免全量扫描——失败了，Windows 上 fs.watch 对网络盘不可靠且会漏事件，这条路放弃。' },
  { role: 'user', text: '那就不搞增量了，简单点：超时上调，再加一个锁文件防止并发轮转。' },
  { role: 'assistant', text: '已改 src/config.js：ROTATE_TIMEOUT_MS 从 2000 上调到 3500；新增 LOCK_FILE 配置，值为 ".rotate.lock"，rotate() 开头检测到锁文件存在就跳过本轮；COMPRESS_FORMAT 从 "zip" 修正为 "gzip" 与实现对齐。rotator.js 加了 LOCK_FILE 判断。' },
  { role: 'user', text: '好，跑下测试确认没回归。' },
  { role: 'assistant', text: '跑了 node --test，7 个用例全部通过，包括新加的 "skips when lock file exists"。超时相关改动没有回归。' },
  // ---- 近因区（保留原文，不含上述关键事实） ----
  { role: 'user', text: '接下来把 listLogs 的排序改成按文件名倒序，mtime 在复制场景下不可靠。' },
  { role: 'assistant', text: '已改 listLogs：sort 改为 b.name.localeCompare(a.name)，配合 app-YYYYMMDD-HHmm.log 命名天然按时间倒序。' },
  { role: 'user', text: '清理逻辑呢？保留份数那块我记得有个 off-by-one 的嫌疑。' },
  { role: 'assistant', text: '检查过了，remain.slice(KEEP_RECENT_LOGS) 语义正确：保留前 7 份，删除其余，不存在 off-by-one。' },
  { role: 'user', text: '给 rotate 加个返回值说明吧，写进 README。' },
  { role: 'assistant', text: '已在 README 增加返回值文档：{ skipped: true } 表示本轮跳过，{ rotated: n } 表示压缩了 n 个超大文件。' },
  { role: 'user', text: 'gz 文件本身会被清理逻辑删掉吗？' },
  { role: 'assistant', text: '不会，listLogs 只匹配 .log 后缀，.gz 文件不进清理列表。如果要限制 gz 总量需要另加逻辑，目前没做。' },
  { role: 'user', text: '行，那今天先到这。' },
  { role: 'assistant', text: '好的。今天完成了排序改造和文档补充，随时可以继续。' }
]

// ---------- ChatMode.compactIfNeeded 的窗口数学与 payload 构建（逐字复刻） ----------
function buildCompactPayload(all: Turn[]): { payload: string; stale: Turn[]; keepStart: number } {
  const covered = 0
  const keepStart = Math.max(0, all.length - COMPACT_KEEP_RECENT)
  const stale = all.slice(covered, keepStart)
  const parts: string[] = []
  parts.push('【新增对话】')
  for (const turn of stale) {
    const body = (turn.text ?? '').trim()
    if (!body) continue
    parts.push(`${turn.role === 'user' ? '用户' : '助手'}：${body}`)
  }
  return { payload: parts.join('\n\n'), stale, keepStart }
}

// ---------- main index.ts AiSummarize 的 systemPrompt（逐字复刻） ----------
const summarizeSystemPrompt = [
  '你是对话历史压缩器。把给定的对话（可能包含一段已有摘要）合并压缩成一份「复工文档」，供后续对话作为上下文无缝接上任务。',
  '固定输出以下五节结构（标题逐字使用，缺内容的小节写“无”，不得自创或省略标题）：',
  '# 复工文档',
  '## 1. 原始任务',
  '用户最初的目标 + 后续修正/追加要求（逐条，保留用户原话中的关键限定）',
  '## 2. 关键结论与事实',
  '已确认的事实、决定、参数（列表；标识符/数值/命令逐字保留）',
  '## 3. 涉及文件与当前状态',
  '每行：`路径` — 已改/已读/待改 + 改动要点一行',
  '## 4. 已尝试且失败的路径',
  '踩过的坑与原因，避免重复（无则写“无”）',
  '## 5. 下一步',
  '接下来的具体动作 1–3 条（含进行到一半的操作及其断点）',
  '要求：',
  '- 文件路径、函数名、命令、数值逐字保留，禁止意译改写；',
  '- 只记录实际发生的事，禁止把“计划做”写成“已做”；',
  '- 「3. 涉及文件与当前状态」和「5. 下一步」优先级最高；字数紧张时先压「2」的叙述、再压「1」的历史修正过程，「3」「5」不让步；',
  '- 用原对话的主要语言书写；总长不超过 3000 字；直接输出文档本体，不要寒暄或评论。'
].join('\n')

// ---------- AiSummarize 降级链（逐字复刻：候选去重 + 每模型 2 次 + 60s 超时） ----------
async function summarize(text: string, chatModel: string): Promise<{ summary: string; servedBy: string; ms: number }> {
  const candidates = [...new Set([compressModel, chatModel].filter(Boolean))]
  const runOnce = async (model: string): Promise<string> => {
    const p = { ...provider, model }
    let summary = ''
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 60_000)
    try {
      await streamChatMessages(p, [{ role: 'user', text }], summarizeSystemPrompt, controller.signal,
        (delta) => { if (delta.content) summary += delta.content }, 'off', { fetcher: providerFetch })
    } finally {
      clearTimeout(timeout)
    }
    return summary.trim()
  }
  let lastError: unknown
  for (const model of candidates) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = Date.now()
      try {
        const summary = await runOnce(model)
        if (summary) return { summary, servedBy: model, ms: Date.now() - started }
        lastError = new Error(`Empty summary from model ${model}`)
      } catch (error) {
        lastError = error
        log(`  [降级链] ${model} 第 ${attempt + 1} 次失败：${error instanceof Error ? error.message : error}`)
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

// ---------- 普通对话请求（捕获 usage，P1-A 路径） ----------
async function chat(messages: AiMessageInput[], systemPrompt: string): Promise<{ text: string; usage: TokenUsage | null; ms: number }> {
  let text = ''
  let usage: TokenUsage | null = null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  const started = Date.now()
  try {
    await streamChatMessages(provider, messages, systemPrompt, controller.signal,
      (delta) => { if (delta.content) text += delta.content }, 'off',
      { fetcher: providerFetch, onUsage: (u) => { usage = u } })
  } finally {
    clearTimeout(timeout)
  }
  return { text: text.trim(), usage, ms: Date.now() - started }
}

async function main(): Promise<void> {
  log(`Provider: ${provider.apiType} @ ${provider.baseUrl}`)
  log(`chatModel=${provider.model}  compressModel=${compressModel}  proxy=${proxyUrl || '(direct)'}`)

  // ============ 阶段 1：P1-A usage 采集（真实请求） ============
  hr('阶段 1  P1-A usage 采集')
  const probe = await chat(
    [{ role: 'user', text: '用一句话回答：Node.js 的 zlib.createGzip 返回什么？' }],
    '你是简洁的技术助手。'
  )
  log(`回复(${probe.ms}ms)：${probe.text.slice(0, 120)}`)
  if (probe.usage) {
    const u = probe.usage as TokenUsage
    log(`✅ usage 采集成功：promptTokens=${u.promptTokens} completionTokens=${u.completionTokens}`)
    log(`   → 生产环境 contextUsageRef 将有真实值，压缩走 token 触发路径(≥${COMPACT_TRIGGER_TOKENS})`)
  } else {
    log('⚠️ 网关未回传 usage → 生产环境将回退字符闸门路径（同样有效，见阶段 2）')
  }

  // ============ 阶段 2：触发判定（生产 shouldCompact，真实数据） ============
  hr('阶段 2  P1-B 触发判定')
  const { payload, stale, keepStart } = buildCompactPayload(turns)
  const staleChars = stale.reduce((n, t) => n + t.text.length, 0)
  log(`对话共 ${turns.length} 轮，keepStart=${keepStart}，陈旧区 ${stale.length} 轮 / ${staleChars} 字符`)
  const realTokens = probe.usage ? (probe.usage as TokenUsage).promptTokens : null
  log(`[case A] 真实 usage(${realTokens} tokens) → shouldCompact=${shouldCompact({ promptTokens: realTokens, staleTurns: stale.length, staleChars })}（远低于 121,600，预期 false）`)
  log(`[case B] 模拟长会话 usage=125000 → shouldCompact=${shouldCompact({ promptTokens: 125_000, staleTurns: stale.length, staleChars })}（预期 true，token 触发）`)
  log(`[case C] usage 缺失(null) → shouldCompact=${shouldCompact({ promptTokens: null, staleTurns: stale.length, staleChars })}（陈旧区 ${stale.length}≥6 且 ${staleChars}≥12000，预期 true，字符回退触发）`)

  // ============ 阶段 3：P1-C 真实压缩（走降级链） ============
  hr('阶段 3  P1-C 复工文档压缩（真实 API）')
  log(`payload ${payload.length} 字符，发往降级链 [${[...new Set([compressModel, provider.model])].join(' → ')}] …`)
  const { summary, servedBy, ms } = await summarize(payload, provider.model)
  log(`✅ 压缩完成：${servedBy} 承接，${ms}ms，输出 ${summary.length} 字符`)
  const requiredSections = ['# 复工文档', '## 1. 原始任务', '## 2. 关键结论与事实', '## 3. 涉及文件与当前状态', '## 4. 已尝试且失败的路径', '## 5. 下一步']
  for (const s of requiredSections) log(`  节标题 ${s.padEnd(18)} ${summary.includes(s) ? '✅' : '❌ 缺失'}`)
  const facts = ['3500', '.rotate.lock', 'gzip', 'fs.watch', 'config.js']
  for (const f of facts) log(`  关键事实 ${f.padEnd(14)} ${summary.includes(f) ? '✅ 保留' : '❌ 丢失'}`)
  log('\n---------- 复工文档原文 ----------\n' + summary + '\n----------------------------------')

  // ============ 阶段 4：压缩后连续性（send path 逐字复刻） ============
  hr('阶段 4  压缩后连续性（关键事实只在被压缩区）')
  const recent = turns.slice(keepStart)
  const question = '提醒我一下：我们当时把轮转超时定成多少毫秒？锁文件的文件名是什么？这两处是在哪个文件里改的？'
  const raw: AiMessageInput[] = [
    ...recent.map((t) => ({ role: t.role, text: t.text })),
    { role: 'user' as const, text: question }
  ]
  raw.unshift({ role: 'user', text: `（前情摘要，由较早的对话压缩而来）\n${summary}` })
  // merge 连续 user（复刻 ChatMode send path）
  const merged: AiMessageInput[] = []
  for (const m of raw) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === 'user' && m.role === 'user') prev.text = `${prev.text}\n\n${m.text}`
    else merged.push({ ...m })
  }
  log(`请求含 ${merged.length} 条消息（摘要已合并进首条 user），提问：${question}`)
  const answer = await chat(merged, '你是编程助手，正在继续一个进行中的项目对话。')
  log(`\n回答(${answer.ms}ms)：\n${answer.text}\n`)
  const checks: Array<[string, boolean]> = [
    ['超时值 3500', answer.text.includes('3500')],
    ['锁文件 .rotate.lock', answer.text.includes('.rotate.lock')],
    ['文件 config.js', answer.text.toLowerCase().includes('config.js')]
  ]
  for (const [name, ok] of checks) log(`  ${ok ? '✅' : '❌'} ${name}`)
  if (answer.usage) {
    const u = answer.usage as TokenUsage
    log(`  本轮 usage：promptTokens=${u.promptTokens}（压缩后上下文体积）`)
  }
  const allOk = checks.every(([, ok]) => ok)
  hr(allOk ? '全链路通过 ✅' : '存在失败项 ❌')
  if (!allOk) process.exitCode = 1
}

main().catch((error) => {
  console.error('E2E 失败：', error)
  process.exitCode = 1
})
