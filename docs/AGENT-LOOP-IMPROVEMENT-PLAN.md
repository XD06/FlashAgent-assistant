# Agent 流程改进方案（P0 + P1）

> **归档说明（2026-08-01）**：本文记录 2026-07-28 的规划、实施和验证过程，并非当前架构规范。文中的文件路径、行号、版本和待办状态可能已过时；当前项目概览请见 [README](../README.md)，历史文档索引请见 [ARCHIVE.md](./ARCHIVE.md)。

- **日期**：2026-07-28
- **状态**：P0 三项 + P1-A/B/C 已全部实施完成（2026-07-28），并通过真实 E2E 验证（`pnpm e2e:compaction`，见「真实 E2E 测试记录」）；P1-B2 增量归档待做（先实际使用拿真实 usage 数据再决策）；P1-4 搁置；P2 暂不考虑
- **范围**：P0 三项（确定做）、P1（修订为上下文预算体系三步 + 搁置项）；P2 暂不考虑
- **调研依据**：Anthropic《Building Effective Agents》《Effective Context Engineering》《Writing Tools for Agents》、Pi（mariozechner.at 设计复盘）、VILA-Lab《Dive-into-Claude-Code》（v2.1.88 源码级分析），以及本项目代码通读结论

核心指导思想（来自调研共识）：**循环保持极简，把工程投入放在循环周围的确定性基础设施上**——重试恢复、参数校验、可行动的错误信息、协议级消息链。

---

## P0-1 LLM 调用重试与退避

### 现状与根因

- 所有请求经由单一出口 `fetchProvider()`（`src/main/ai/OpenAICompatibleClient.ts` L49-51），但 `!response.ok` 一律直接 `throw`（L461 / L556 / L716）。
- 429（限流）、5xx（服务端抖动）、网络瞬断都会**立即终止整轮对话**，agent 多轮任务做到一半直接报错——对应 `使用bug.txt` 中"对话容易自动中断"的主要成因之一。
- 对照：Claude Code 有 3 次重试 + 降级链；Pi 的 pi-ai 全管线支持中断恢复与部分结果。

### 方案设计

新增 `fetchProviderWithRetry()`，替换 tool loop 与简单流两处 `fetchProvider` 调用点：

1. **重试条件**：HTTP 429、500/502/503/504、`fetch` 网络层异常（`TypeError: fetch failed` 等）。4xx 业务错误（401/400/404）**不重试**，立即抛出。
2. **退避策略**：指数退避 1s → 2s → 4s，最多 3 次；429 响应若带 `Retry-After` 头则优先遵循（封顶 30s）。
3. **中止感知**：退避等待期间监听 `AbortSignal`，用户中止立即放弃重试。
4. **重试边界**：只在**响应流尚未产生任何 delta 前**重试（即 `fetch` 失败或非 2xx 时）。SSE 中途断流（`STREAM_IDLE_TIMEOUT_MS` 触发）不自动重放——已转发给 UI 的增量无法安全去重，维持现状抛错。
5. **tool loop 内的轮级重试**：tool loop 中每轮请求发出前 `apiMessages` 完整不变，因此该轮请求失败重试是幂等的，天然安全。
6. **UI 反馈**：每次重试通过现有 `status` chunk 通知渲染层（如"网络波动，正在重试 (1/3)…"），复用 `AiChunkPayload.type: 'status'`，不新增 IPC 类型。
7. **时间预算**：重试等待时间计入 `toolTimeMs` 豁免（与审批等待同类），不消耗 900s 流式预算。

### 涉及文件

| 文件 | 改动 |
|---|---|
| `src/main/ai/OpenAICompatibleClient.ts` | 新增重试包装函数；替换 3 处调用点（简单流 L456、tool loop L551、listModels L707 可选） |
| `src/main/index.ts` | `onStatus` 已有通道，透传重试提示文案（区分 zh-CN/en） |

### 验收标准

- 模拟 429/503（vitest mock fetcher）：验证按退避序列重试、`Retry-After` 优先、3 次后抛出原始错误。
- 重试期间触发 abort：立即结束，不再发起请求。
- 401 不重试，立即报错。
- agent 模式长任务中途遇 1 次 5xx：任务无感续跑，UI 出现一条重试状态行。

### 风险

低。改动集中在单一函数出口；不重试流中断场景避免了增量去重的复杂度。

---

## P0-2 工具参数校验（校验失败回传模型自纠错）

### 现状与根因

- 模型返回的 `arguments` JSON 解析失败时仅 `console.warn`，然后**以空对象继续执行工具**（`OpenAICompatibleClient.ts` L650-656）。
- 工具内部用 `asString()` 宽松转换（`AgentTools.ts` L143-145），类型错误的参数静默变为空字符串——如 `path` 传了数字，最终报出的错误是"path must not be empty"，模型无法据此定位真正问题。
- 对照：Pi 用 TypeBox + AJV 严格校验并返回详细错误文本；Anthropic 工具设计原则要求"错误信息可行动，而非错误码"。

### 方案设计

**不引入新依赖**（遵守便携版体积约束），基于工具定义中已有的 JSON Schema（`agentToolDefinitions[].parameters`）实现一个轻量校验器：

1. 新增 `src/main/agent/validateToolArgs.ts`（约 80 行）：
   - 支持本项目 schema 实际用到的子集：`type: object/string/number/boolean`、`required`、顶层 `properties`。不实现完整 JSON Schema 规范。
   - 输出**面向模型的可行动错误文本**，例如：
     `Invalid arguments for edit_file: "old_text" is required but missing; "replace_all" should be boolean, got string "true". Expected schema: {path: string, old_text: string, new_text: string, replace_all?: boolean}`
2. **JSON 解析失败**：不再以空对象执行。将解析错误 + 原始片段（截断 200 字符）作为 tool result 回传：
   `[Invalid tool call: arguments is not valid JSON (Unexpected token ...). Raw: "...". Re-issue the tool call with valid JSON.]`
3. **接入点**：`index.ts` 的 `runAgentTool()` 入口处（审批之前）——参数非法的调用不应弹审批卡片浪费用户注意力；校验失败直接返回错误文本，循环继续，模型自行修正后重试。
4. MCP 工具不做本地校验（schema 归属外部服务器，由服务器自行报错），仅覆盖内置 6 件套 + web_search。

### 涉及文件

| 文件 | 改动 |
|---|---|
| `src/main/agent/validateToolArgs.ts` | 新增：轻量 schema 校验器 |
| `src/main/agent/validateToolArgs.test.ts` | 新增：校验器单测 |
| `src/main/ai/OpenAICompatibleClient.ts` | L650-656：JSON 解析失败改为回传错误 tool result，不再空对象继续 |
| `src/main/index.ts` | `runAgentTool()` 开头接入校验 |

### 验收标准

- 缺失 required 字段 / 类型错误 / 非法 JSON 三类场景各有单测，错误文本包含字段名、期望类型、实际值。
- 校验失败的调用不出现审批卡片，不产生快照。
- 实测：故意让模型传坏参数（低温度小模型易复现），观察其收到错误后能在下一轮自纠。

### 风险

低。纯新增防线，不改变合法调用的行为路径。

---

## P0-3 edit_file 匹配盲区补全与失败诊断

### 现状与根因

- CRLF 容错匹配**已实现**（`AgentTools.ts` L192-230：`findFlexibleMatches` + `matchFileEol`），`使用bug.txt` 的 CRLF 反馈早于该修复。
- 剩余盲区：
  1. **行内空白差异**：模型给的 old_text 行尾多/少空格、Tab 与空格混用时仍匹配失败；
  2. **失败诊断贫瘠**：报错只有"old_text not found — re-read the file"，模型只能盲目重读整个文件再试，浪费 2-3 轮；
  3. `read_file` 输出不提示文件换行符类型，模型无从预判。

### 方案设计

1. **第三级容错匹配**（在 exact → CRLF-flexible 之后追加）：行尾空白容忍匹配——将 old_text 每行的行尾空白替换为 `[ \t]*` 再正则匹配（行首缩进**不**容忍，缩进是语义的一部分且放宽易误匹配）。命中时替换文本按原文件风格写回。
2. **失败诊断**（三级全失败时），错误文本升级为可行动诊断：
   - 取 old_text 第一行（trim 后）在文件中检索：若命中，报告 `First line of old_text found at line N, but the following lines diverge — re-read lines N-M and rebuild old_text from the actual content`；
   - 报告文件换行符类型：`Note: this file uses CRLF line endings`；
   - 若完全无痕迹：维持"re-read the file"建议但附带文件行数，提示用 `search_files` 先定位。
3. **read_file 输出头部追加 EOL 标注**：`(CRLF)` 或 `(LF)`，一个词的成本，让模型写 old_text 前就有预期。
4. 工具描述（`agentToolDefinitions` 中 edit_file 的 description）同步补一句：匹配对行尾空白宽容、对缩进严格。

### 涉及文件

| 文件 | 改动 |
|---|---|
| `src/main/agent/AgentTools.ts` | `editFileTool` 追加第三级匹配与诊断；`readFileTool` 加 EOL 标注；edit_file description 微调 |
| `src/main/agent/AgentTools.test.ts` | 行尾空白匹配、诊断文本、EOL 标注的单测 |

### 验收标准

- 行尾多余空格的 old_text 能命中且文件 EOL 风格不被破坏（已有 `matchFileEol` 单测基础上扩展）。
- 首行命中但后续偏离的场景，错误信息包含具体行号区间。
- 全部现有 `AgentTools.test.ts` 用例保持通过（不回归 exact-first 优先级）。

### 风险

低-中。正则容错逐级降级，exact 匹配永远优先，不影响现有成功路径；主要风险是空白容忍导致的意外多重匹配——由既有的"多匹配需 replace_all"防线兜住。

---

## P1 修订：上下文预算体系（2026-07-28 讨论定稿，同日实施完成）

> 本节取代原 P1-6，并给出 P1 的最终推荐形态。讨论基准：Codex CLI / Claude Code 的压缩机制 + 本项目已验证的"保留最近几轮完整输出"实践。

### 设计来源：Codex/Claude Code 的三个工程细节

1. **触发看真实 token 用量，不数轮次也不估算**：从 API 响应的 `usage.prompt_tokens` 白拿实测值（OpenAI 流式加 `stream_options: {include_usage: true}`；Anthropic 在 `message_start`/`message_delta` 事件里自带），超过窗口比例即触发。零依赖、永远准确。
2. **压缩产物是"复工文档"，不是读后感**：强制结构化输出——原始意图、关键事实、**涉及文件+当前状态**、已犯错误、明确的下一步。这是压缩后模型能无缝接上任务的真正原因。
3. **摘要 + 完整近尾 + 锚点永不压**：system prompt / 最新 user 消息 / 当前轮 in-flight 链条不参与任何压缩。

### 分解为三步（P1-A → P1-B → P1-C，逐步独立可用）

**P1-A：接住 usage 数据（最小改动，先做试水）**
- 流式请求带 `include_usage`，采集 `prompt_tokens` 回传渲染层。
- 副产品：UI 可显示"本会话上下文占用"，后续阈值调参有实测依据。

**P1-B：压缩触发改为 token 驱动**
- `ProviderSettings` 增加「上下文窗口」字段（Provider 级设置，默认 128k），所有阈值百分比化：

| 参数 | 推荐值 | 理由 |
|---|---|---|
| 上下文窗口 | **全局固定 128k**（硬编码常量） | **刻意收窄的“注意力预算”，非模型物理上限**——常用模型多支持 500k+，但小窗口强制模型聚焦当前任务；本工具定位快速简易 agent（非长程任务），128k 够用，需要时改常量即可 |
| 压缩触发线 | **95%**（2026-07-28 由 85% 上调） | 轮间检查（见下「压缩时机」），永不在轮中压缩，无需为 in-flight loop 留大余量；下一轮 loop 自身增长由 loop 内 35% 预算 + MAX_SEND_CHARS 硬闸兜底 |
| 压缩目标水位 | **50%** | 一次压足，避免轮轮压（压缩本身烧 token 烧时间） |
| 跨轮近因窗口预算 | **≤40%** | 8 条全文装得下就全保，装不下从最旧开始降存根 |
| loop 内活跃结果预算 | **≤35%** | 补空洞，见下 |

- 未触发时完全不动历史——上下文没满就不压，把“力”用在合适的地方。

**压缩时机：轮间同步压缩（pre-send compaction，2026-07-28 定稿）**

压缩只发生在轮与轮之间：AI 一轮输出结束后若 usage 超过触发线，**用户下一条消息就是压缩时机**：

1. 用户点发送 → 消息立即上屏（体验上“已发出”），同时显示 compactNotice“正在压缩较早的对话…”；
2. 后台先跑压缩请求（压缩模型可独立配置，挂到已有的“功能模型统一配置”机制上，默认跟随当前对话模型；总结任务用小快模型又快又省）；
3. 压缩成功 → 用压缩后的历史 + 用户最新消息发起正式请求；
4. **压缩失败 → 换当前对话模型重试压缩**（独立配置的压缩小模型可能挂、也可能窗口装不下超长历史；当前模型刚聊过这段历史，窗口一定够且一般不会挂）；当前模型也失败 → 走现有重试退避；仍失败 → 按普通请求失败报错——当前模型都挂了，任务本来也无法继续，不需要“发原历史”这种假降级；
5. 压缩期间用户点停止 → 整体取消本次发送（压缩和正式请求一起 abort）。

相比现有的“发送后异步压缩、服务下一轮”：轮间同步压缩让压缩结果**立即**服务当前请求；“当前轮 in-flight 链条永不参与压缩”从需要维护的规则变成结构性保证；延迟藏进用户发消息本就预期的等待里，感知成本几乎为零。

残留风险窗口：一轮结束时 84%（差一点未触发）→ 不压 → 下一轮 loop 自身再涨 10-15% 逼近上限。由两道护栏兜住：loop 内 35% 总量老化（本节“设计空洞”的修复）+ MAX_SEND_CHARS 硬闸。

### P1-B 本轮实施边界（2026-07-28 拍板）

**本轮交付：核心闭环**（能立即跑起来验证效果）
- 触发信号：有 usage 走真实 `promptTokens ≥ 窗口 95%`；**拿不到 usage（provider 被 400 关掉 include_usage、或首轮还无 usage）时回退现有闸门**——陈旧区 `≥ COMPACT_MIN_STALE_TURNS(6) 条 且 ≥ COMPACT_TRIGGER_CHARS(12k) 字符`。所有 provider 不留死角。（注：现状并非纯轮数触发，而是“固定保留最近 `COMPACT_KEEP_RECENT(10)` 条 + 陈旧区双闸门”，主力是 12k 字符体量闸门。）
- 时机：从 `done` 后 fire-and-forget 改为 **pre-send 同步**——用户发下一条时先压再发，服务本轮（见上「压缩时机」5 步）。
- 失败降级：压缩小模型失败 → 换当前对话模型重试 → 退避 → 报错。
- 近因窗口：**保留现有固定窗口**（`COMPACT_KEEP_RECENT=10` / `RECAP_OUTPUT_TURNS=8`），本轮不动。
- 窗口配置：**全局硬编码常量（渲染层，`CONTEXT_WINDOW_TOKENS = 128_000`），本轮不做设置页 UI**——窗口是刻意收窄的注意力预算、全局通用不随 provider 变，日后有需要再抽成配置项。

**本轮不做，归入 P1-B2（增量）**
- 分级让步梯子（近因窗口内工具输出按最旧最大降存根、8→6→4→2）；
- 近因窗口从固定条数改为 token 预算 ≤40% 的动态窗口；
- loop 内 35% 总量老化（「设计空洞」的修复）。
> 理由：核心闭环用 token 触发 + 换模型降级已能显著改善，且能先跑起来拿真实 token 数据校准；分级让步是“硬预算撞线”才需要的极端路径，等核心闭环验证后再补更稳。

**核心闭环实施记录（2026-07-28）**
- 新增 `src/renderer/chat/compaction.ts`：纯策略模块（可单测）——`CONTEXT_WINDOW_TOKENS=128_000`、`COMPACT_TRIGGER_TOKENS=121_600`（95%，2026-07-28 由 85% 上调）、原 COMPACT_* 常量迁入、`shouldCompact()` 触发判定（usage 优先，null 时回退双闸门；陈旧区为空永不触发）。
- `ChatMode.tsx`：`maybeCompact`（done 后异步）重构为 `compactIfNeeded`（pre-send 同步，失败 throw）；`sendMessage` 改为“立即上屏 → async IIFE 内先压后发”；新增 `preSendRef` 取消门（stop/新对话/切话题可取消）；压缩期间的新消息进队列；压缩失败按普通请求失败报在助手轮上；进度环 tooltip 改为 usage 优先口径。
- 降级链复核：主进程 `AiSummarize` 现成的 `[compressModel, chatModel]` 去重候选 + 每模型 2 次尝试 + streamChatMessages 内置退避，已满足“换当前模型重试→退避→报错”，仅更新注释。
- 验证：新增 `compaction.test.ts` 8 个用例，全仓 207 测试通过，typecheck 干净。

**P1-C：升级压缩 prompt 为复工文档**
- 现有 800 字上限放宽到 **2000–3000 字**（成本不对称：摘要多花 1k token，省掉一串重复 read_file）。
- 固定五节结构（压缩 prompt 强制输出，缺节写“无”，不得自创标题）：

```markdown
# 复工文档
## 1. 原始任务
用户最初的目标 + 后续修正/追加要求（逐条，保留用户原话中的关键限定）
## 2. 关键结论与事实
已确认的事实、决定、参数（列表；标识符/数值/命令逐字保留）
## 3. 涉及文件与当前状态
- `路径` — 已改/已读/待改 + 改动要点一行
## 4. 已尝试且失败的路径
踩过的坑与原因，避免重复（无则写“无”）
## 5. 下一步
接下来的具体动作 1–3 条（含进行到一半的操作及其断点）
```

- 保真约束（写进压缩 prompt）：
  - 文件路径、函数名、命令、数值**逐字保留**，禁止意译改写；
  - 只记录实际发生的事——禁止把“计划做”写成“已做”（与台账反幻觉机制同源）；
  - 语言跟随对话语言；只输出文档本体，不带寒暄/评论。
- 「3. 涉及文件」和「5. 下一步」是压缩后能无缝接上任务的真正原因，优先级最高；字数紧张时先压「2」的叙述、再压「1」的历史修正过程，「3」「5」不让步。

**P1-C 实施记录（2026-07-28）**
- 主进程 `AiSummarize` 的 systemPrompt 替换为上述五节复工文档模板（标题逐字、缺节写“无”、保真约束、「3」「5」不让步），字数上限 800 → 3000 字；降级链/超时/重试机制不变。

**真实 E2E 测试记录（2026-07-28，`sandbox-e2e/`，已转正为常驻回归工具 `pnpm e2e:compaction`，维护约定见 `sandbox-e2e/README.md`）**
- 方法：模拟项目 `sandbox-e2e/mock-project`（log-rotator）+ 16 轮模拟对话；驱动脚本 `sandbox-e2e/run-e2e.ts` 直接 import 生产代码（`compaction.ts` 的 `shouldCompact`、`OpenAICompatibleClient.ts` 的 `streamChatMessages`），payload 构建 / systemPrompt / 摘要注入格式逐字复刻 `ChatMode.tsx` 与 `main/index.ts`，用用户真实 provider 配置（litellm 网关 + 代理）发真实请求。
- 结果（全部通过，日志 `sandbox-e2e/e2e-result.log`）：
  1. P1-A：litellm 网关正常回传 usage（`stream_options.include_usage` 生效）→ 生产环境 token 触发路径有数据源；
  2. P1-B：`shouldCompact` 三分支实测符合预期（真实低 usage 不触发 / 125k 模拟 usage 触发 / usage 缺失走字符回退触发）；
  3. P1-C：`gemini-3.1-pro-low` 首次尝试即成功（≈13s，23,788 字符 → 882 字符），五节标题逐字齐全，埋点关键事实（`3500`、`.rotate.lock`、`gzip`、`fs.watch`、`config.js`）100% 保留，「4. 已尝试且失败的路径」正确记录了 fs.watch 弃案及原因；
  4. 连续性：按 send path 结构（摘要 unshift + 近 10 轮）提问只存在于被压缩区的事实，`deepseek-v4-flash` 全部答对，压缩后 promptTokens 仅 775。

### 冲突裁决：token 上限 vs "近几轮完整输出"

两条规则冲突时（如 3 轮就逼近窗口），**硬预算必须赢**——溢出 = 请求被 API 拒绝，100% 失败；牺牲近因窗口的代价只是一次定向重读。但按"价值密度"分级让步，不无差别压：

```
第1级  压旧对话文本（正常路径，摘要替代）
第2级  近因窗口内工具输出降级：从最旧、最大的开始
        12k 全文 → 诊断性存根（文件名+行范围+一行结论）
        8 条 → 6 → 4 → 2
第3级  （几乎不会到）近尾对话文本也进摘要
─────── 永不牺牲 ───────
· system prompt / 接地规则
· 最新一条 user 消息
· 当前轮 in-flight tool loop 链条
· 摘要本身
· 台账单行痕迹（防重复调用的真正底线，几乎不占 token）
```

**硬底线：最近 2 轮（4 条历史）完整输出不参与降级。** 理由：agent 典型节奏是"上一轮 read → 这一轮 edit"，edit 的 old_text 必须逐字精确，存根写不出来；2 轮之外的输出要么已消化成结论，要么定向重读一次即可。成本最坏 ~15-20k token（128k 窗口的 12-15%），任何情况供得起。第 3-4 轮为软保障区（默认全文、预算不足时降级）。

极端兜底：若硬底线自身超窗（单轮几十个调用），底线内部也按"最旧调用先降"收缩，但当前轮最后几个调用绝对保全。**终极不变式只有一条：请求必须发得出去。**

### 已发现的设计空洞：loop 内无总量预算（2026-07-28 核对代码确认）

- 现状：`maxToolRounds=50`，但**每轮内调用次数无上限**；单条 12k cap 管"单条"，`TOOL_KEEP_RECENT_ROUNDS=10` 管"轮龄"，没有任何东西管**总量**。
- 风险：模型一轮并发 4 个调用时，近 10 轮全文 = 10×4×12k = 480k 字符 ≈ 120–160k token，**单是活跃窗口就能撑爆 128k 模型**。跨轮侧有 `MAX_SEND_CHARS=120k` 总闸，loop 内是真空。
- 修复：把按"轮龄"老化改为"**轮龄 + 总量**"双条件老化——活跃结果区超过窗口 35% 时，窗口内最旧的调用提前老化成存根。

### 决策状态

- P1-A/B/C 三步均已实施完成（2026-07-28）并通过真实 E2E 验证；P1-B2 增量（分级让步梯子、动态近因窗口、loop 内 35% 老化）归档待做——先实际使用一段时间，拿真实 usage 数据看 95% 触发频率和复工文档质量后再决策。
- 原 P1-6（本地 token 估算）**废弃**：引 tokenizer 违背便携体积约束且不准，真实 usage 白拿即可。
- P1-4（协议级消息链）**建议继续搁置**：台账 + 近 8 条完整输出已验证够用，协议重放收益边际、改动大。
- P1-5（ContextBuilder 收拢）降级为 P1-B 的可选实施载体，不再独立立项。

---

## P1-4 跨轮历史升级为协议级消息链（建议搁置，设计存档）

> **2026-07-28 实践记录（P1 决策前提）**：实际使用中验证过——上下文给得过少时，模型看不到上一轮结果会反复重新调用工具（重读同一文件等），反而增加 token 消耗且效果变差；后来引入“保留最近几轮完整输出”（TOOL_KEEP_RECENT_ROUNDS / RECAP_OUTPUT_TURNS）后效果明显改善。**结论：压缩不是目标，“模型拿得到它需要的上下文”才是目标。**裁剪过狠的成本（重复工具调用）可能高于保留成本；P1 的任何设计都必须把“避免重复工具调用”作为与“控制上下文总量”平级的硬指标。

### 现状与根因

- 跨轮历史被渲染层降级为**纯文本重放**：`ChatMode.tsx` 的 `toolRecap()` 生成"【本轮实际执行的工具调用】"台账文本，配套 `stripForgedRecap()` 防伪、幻觉守卫正则、Grounding 台账权威性规则——一整套补丁机制的存在，根因都是**模型在后续轮次看不到真正的 tool_call/tool_result 协议消息**。
- 对照：Pi 将 Context（含工具消息）整体 JSON 序列化跨轮接力；Claude Code 用 append-only JSONL 转录。两者都不需要台账/防伪机制——问题被消除而非对抗。

### 方案设计（分三阶段，可随时停在任一阶段）

**阶段一：结构化传输（不改模型所见内容）**
1. `src/shared/types.ts` 扩展 `AiMessageInput`：assistant 消息可选携带 `toolCalls: Array<{ id, name, arguments, result, state }>`（result 已按 12k 截断，与现有 `capResultForEvent` 一致）。
2. 渲染层发送历史时，从 `ChatTurn.blocks` 中提取已落定的 `AgentToolEvent` 填入 `toolCalls`，**同时保留现有台账文本**（双轨）。
3. 主进程收到后暂不使用 `toolCalls`（仅落日志），验证数据完整性。

**阶段二：协议重放（设置项开关，默认关）**
1. 主进程 `streamChatMessages` 构建初始 `apiMessages` 时，将带 `toolCalls` 的 assistant 历史轮展开为协议消息：
   - OpenAI：`assistant(tool_calls)` + 逐条 `tool` 消息；
   - Anthropic：`assistant(tool_use blocks)` + `user(tool_result blocks)`。历史轮不含 thinking 签名——不启用 extended thinking 的历史重放该结构合法；启用 thinking 时的兼容性需在真实 Anthropic API 上先行验证（这是本阶段最大的不确定点）。
2. 开关开启时，该轮历史**不再附加台账文本**，Grounding 提示词中台账段落同步移除（提示词瘦身）。
3. `truncateForSend` / 滚动压缩对结构化轮次的处理：被压缩进摘要的轮次丢弃 `toolCalls`（摘要已覆盖）；保留窗口内的轮次原样传递。

**阶段三：退役补丁机制（新会话）**
- 开关默认开启后，新会话不再生成台账文本；`stripForgedRecap`、幻觉守卫正则、台账 Grounding 规则仅对旧格式历史保留，待旧会话自然淘汰后删除。

### 涉及文件

`src/shared/types.ts`、`src/renderer/chat/ChatMode.tsx`（send 路径）、`src/main/ai/OpenAICompatibleClient.ts`（apiMessages 构建）、`src/main/index.ts`（Grounding 段落条件化）、`src/main/settingsStore.ts`（开关）。

### 验收标准

- 阶段二开关开启后：模型对"你刚才改了哪个文件"类问题的回答与真实执行记录一致（人工回归 + 既有反幻觉场景用例）；
- OpenAI 与 Anthropic 两种 apiType 各自通过多轮工具会话实测；
- tool_call id 跨轮一致性校验（同一 id 的 call 与 result 成对出现，缺 result 的调用降级为文本描述避免 API 400）。

### 风险

中-高。涉及双协议的消息合法性细节（Anthropic 的 tool_use/tool_result 配对、thinking 块要求；OpenAI 的 tool_call_id 配对）；任何供应商侧 400 都会中断对话。因此设计为**开关渐进 + 双轨过渡**，每阶段可独立回退。建议在 P0 三项落地稳定后再启动。

---

## P1-5 上下文管理收拢到主进程（考虑做）

### 现状与根因

- 压缩/截断逻辑分裂两处：轮内压缩在主进程（`capToolResult`/`stubToolResult`），跨轮截断、滚动压缩、台账、防伪在渲染层（`ChatMode.tsx`）。渲染层承担了接地核心逻辑，无法用 vitest 直接覆盖主链路，也阻碍 P1-4 的干净实现。
- 对照：Claude Code 的 5 层压缩全部在"调模型前"的单一管线（cheapest-first：先剪工具结果，摘要是最后手段）。

### 方案设计

1. 新增 `src/main/ai/ContextBuilder.ts`：输入渲染层传来的完整结构化历史 + 压缩摘要状态，输出最终 `apiMessages`。迁移 `truncateForSend`、recap 组装（或 P1-4 的协议展开）、预算裁剪至此。
2. 渲染层瘦身为"存储 + 展示 + 透传"：`ChatMode.tsx` 只管理 `ChatTurn[]` 与 `ChatCompact` 状态，发送时原样交给主进程。
3. 滚动压缩的触发判断与摘要请求仍由渲染层发起（UI 需要展示压缩状态），但**摘要进入发送载荷的方式**由 ContextBuilder 统一处理。
4. 裁剪顺序遵循 cheapest-first：老化工具结果 → 截断超窗轮次 → 应用压缩摘要，每步独立可测。

### 依赖关系

与 P1-4 强耦合：**建议作为 P1-4 阶段二的实施载体一并做**（协议展开逻辑天然属于 ContextBuilder），避免两次搬迁。

### 验收标准

- ContextBuilder 具备完整 vitest 覆盖（各裁剪层独立用例 + 组合用例）；
- 迁移前后对同一输入产出的发送载荷逐字节一致（迁移正确性快照测试）。

### 风险

中。纯重构 + 搬迁，行为不变是硬约束；快照对比测试兜底。

---

## P1-6 Token 估算替代纯字符计数（已废弃——被「P1 修订」节取代）

> **2026-07-28**：本节方案废弃。本地启发式估算不准，真实 `usage.prompt_tokens` 可从 API 响应直接获取（见 P1-A），`contextWindow` 设置项与预算派生思路并入 P1-B。以下保留原文存档。

### 现状与根因

- 所有预算是拍脑袋字符数：12k（单条工具结果）、120k（发送上限）、6k（记忆文件）、300（存根），与模型真实上下文窗口无关——128k 窗口的模型和 32k 窗口的模型用同一套魔数，前者浪费、后者仍会溢出。

### 方案设计

1. 新增 `src/shared/tokenEstimate.ts`：启发式估算，中英混合场景按 `chars / 2.5`，纯 ASCII 段按 `chars / 4`（简单两档，不引 tokenizer 依赖——遵守便携版体积约束）。
2. `ProviderSettings` 增加可选 `contextWindow`（默认 131072），设置页模板附带常见值。
3. 预算派生化：`ContextBuilder`（或现有各截断点）从 `contextWindow` 派生预算——发送载荷上限 = 窗口 × 60%，单条工具结果上限 = min(12k 字符, 窗口 × 8% 折算字符)，其余魔数逐步挂钩。
4. SSE 末尾的 `usage` 字段（多数供应商返回）best-effort 采集，仅落日志校准估算偏差，不做 UI 展示（那是 P2）。

### 验收标准

- 32k 窗口配置下长 agent 会话不再出现 provider 端 context-overflow 报错；
- 128k 窗口下发送预算相比现状放宽，长任务重复读文件次数下降（人工对比）。

### 风险

低。估算不准的代价只是预算松紧，有既有硬截断兜底。

---

## 实施顺序与节奏建议

```
P0-2 参数校验 ──┐
P0-3 edit_file ──┼── ✅ 已完成（2026-07-28）
P0-1 重试退避 ──┘
        │
        ▼
P1-A usage 采集 ──┐
P1-B token 驱动压缩 ──┼── ✅ 已完成（2026-07-28，同日过真实 E2E）
P1-C 复工文档 prompt ──┘
        │
        ▼
P1-B2 增量（分级让步梯子 / 动态近因窗口 / loop 内 35% 老化）── 归档待做，实测数据驱动

（P1-4 协议级消息链：搁置；P1-5 ContextBuilder：并入 P1-B2 可选载体）
```

- P0 三项均为局部改动、低风险、有单测护栏，已进主干。
- P1-A/B/C 已全部落地；回归手段：`pnpm test`（纯逻辑）+ `pnpm e2e:compaction`（真实链路，见 `sandbox-e2e/README.md`）。
- 每项完成后在本文件勾选状态并记录日期。

## 进度追踪

| 项 | 状态 | 完成日期 |
|---|---|---|
| P0-1 LLM 重试退避 | ✅ 已完成 | 2026-07-28 |
| P0-2 工具参数校验 | ✅ 已完成 | 2026-07-28 |
| P0-3 edit_file 诊断 | ✅ 已完成 | 2026-07-28 |
| P1-A usage 采集 | ✅ 已完成 | 2026-07-28 |
| P1-B token 驱动压缩 | ✅ 核心闭环已完成 | 2026-07-28 |
| P1-B2 增量（让步梯子/动态窗口/loop 老化） | 📁 归档待做（实测数据驱动） | — |
| P1-C 复工文档 prompt | ✅ 已完成 | 2026-07-28 |
| 真实 E2E 回归工具（sandbox-e2e） | ✅ 已转正 `pnpm e2e:compaction`，首次全链路通过 | 2026-07-28 |
| P1-4 协议级消息链 | 搁置（设计存档） | — |
| P1-5 ContextBuilder | 并入 P1-B2（可选载体） | — |
| P1-6 Token 估算 | ❌ 已废弃（被 P1-A/B 取代） | — |

### P0 实施记录（2026-07-28）

- **P0-1**：`fetchProviderWithRetry()` 落地 `OpenAICompatibleClient.ts`，覆盖简单流与 tool loop 两处调用点。429/5xx/网络层异常按 1s→2s→4s 退避重试 3 次，`Retry-After` 优先（封顶 30s）；退避等待可被 abort 立即中断；tool loop 内重试等待计入 `toolTimeMs` 豁免；重试提示通过 `retryNotice` 模板（zh/en）走现有 status 通道。listModels/testModel 未包装（交互式操作，快速失败更合适）。
- **P0-2**：新增 `validateToolArgs.ts`（零依赖轻量校验器），`runAgentTool()` 入口处先校验再走审批/快照；`arguments` JSON 解析失败不再静默空对象继续，改为回传可行动错误让模型自纠（含原始片段前 200 字符）。MCP 工具不做本地校验（按方案）。
- **P0-3**：`edit_file` 新增第三级行尾空白容错匹配（缩进保持严格）；失败时输出行号级诊断（首行命中位置 + 行区间 + EOL 类型）；`read_file` 输出头部标注 CRLF/LF；工具 description 同步说明容错边界。
- **验证**：新增 20+ 单测，全量 192 个测试通过，`pnpm typecheck` 无错误。
