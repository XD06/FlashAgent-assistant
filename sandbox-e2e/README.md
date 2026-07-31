# sandbox-e2e — 上下文压缩 E2E 回归工具

用本机**真实 provider 配置**（`%APPDATA%/flashagent-assistant/settings.json`）发真实
API 请求，走生产代码链验证 Agent 上下文压缩全流程。与 `pnpm test` 的纯逻辑单测互补：
单测保证判定函数正确，本工具保证"真模型 + 真网关 + 真代理"下的端到端效果。

项目更名前保存的配置会在首次启动时从 `%APPDATA%/selection-assistant-lite` 复制到新目录；
目标目录已存在时不会被覆盖。

## 运行

```bash
pnpm e2e:compaction
```

- 前置条件：应用内已配置好 API（provider、密钥、压缩模型、代理）
- 会发 **4 次真实 API 请求**（探针 / 压缩 / 连续性提问，另含降级链潜在重试），消耗少量 token
- 结果打印到终端；退出码非 0 表示有失败项

## 验证内容

| 阶段 | 验证点 |
| --- | --- |
| 1. P1-A usage 采集 | 网关是否回传 usage（`stream_options.include_usage`）→ token 触发路径有无数据源 |
| 2. P1-B 触发判定 | 生产 `shouldCompact` 三分支：真实低 usage 不触发 / 高 usage 触发 / usage 缺失走字符回退 |
| 3. P1-C 复工文档压缩 | 真实调用压缩降级链（compressModel → chatModel），断言五节标题逐字齐全 + 埋点关键事实 100% 保留 |
| 4. 压缩后连续性 | 按 send path 结构（摘要 unshift + 近因区）提问**只存在于被压缩区**的事实，模型必须靠复工文档答对 |

## 文件说明

- `run-e2e.ts` — 驱动脚本。直接 import 生产代码（`compaction.ts`、`OpenAICompatibleClient.ts`）；
  payload 构建 / 压缩 systemPrompt / 摘要注入格式为**逐字复刻**（来源见脚本内注释）
- `mock-project/` — 模拟项目（log-rotator），16 轮模拟对话的素材；关键事实刻意只埋在
  会被压缩的前 6 轮，连续性测试无法从近因区作弊
- `run-e2e.cjs` — esbuild 构建产物，已 gitignore

## 维护约定

以下生产代码改动时，需同步本脚本对应部分并重跑：

| 生产代码 | 脚本内对应 |
| --- | --- |
| `src/main/index.ts` AiSummarize 的 systemPrompt / 降级链 | `summarizeSystemPrompt` / `summarize()` |
| `src/renderer/chat/ChatMode.tsx` `compactIfNeeded` payload 构建 | `buildCompactPayload()` |
| `src/renderer/chat/ChatMode.tsx` send path 摘要注入 / merge | 阶段 4 的 `raw.unshift` / merge 逻辑 |
| `src/renderer/chat/compaction.ts` 常量与 `shouldCompact` | 直接 import，无需同步 |

首次实测记录（2026-07-28，全链路通过）见 `docs/AGENT-LOOP-IMPROVEMENT-PLAN.md` 的
「真实 E2E 测试记录」节。

## Agent 上下文测量回归

```bash
pnpm e2e:agent-context
```

它使用同一份本机 provider 配置，在被 Git 忽略的
`sandbox-e2e/agent-context-workspace/escape-string-regexp` 公开仓库副本中，复用生产
`streamChatMessages` 和 `AgentTools` 执行一次受限的真实 Agent 任务。结果只写入被
Git 忽略的 `agent-context-result.json`：请求次数、各分段 token 估算、真实 usage（若网关
返回）、耗时与通过状态；不会记录提示词、模型回复、工具输出、配置或密钥。
驱动优先读取新应用目录；若桌面应用尚未执行更名迁移，则只读回退到旧目录，不会复制或修改
任何用户设置。

首次运行前手动创建该隔离副本，例如：

```bash
git clone --depth 1 https://github.com/sindresorhus/escape-string-regexp.git sandbox-e2e/agent-context-workspace/escape-string-regexp
```
