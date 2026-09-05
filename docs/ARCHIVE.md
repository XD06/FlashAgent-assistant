# 文档索引与归档说明

本文件是项目文档的索引入口。**`docs/archive/` 下的归档正文仅保留在本地、永不提交推送**（`.gitignore` 已排除），文件名前缀为归档日期；Git 历史中仍可查阅这些文档的旧版本。

## 现行文档（随仓库分发）

| 文档 | 用途 |
| --- | --- |
| [OCR.md](./OCR.md) | 截图「识别文字」双引擎（Windows 系统 OCR / 高精度 PP-OCR 引擎包）的选型与架构。 |
| [QUICK-TRANSLATE.md](./QUICK-TRANSLATE.md) | 快速翻译窗口、各翻译服务、有道词典、TTS 与生词本的实现结构。 |
| [NEW-FEATURE-PAGE-GUIDE.md](./NEW-FEATURE-PAGE-GUIDE.md) | 新功能页面/面板接入的性能守则与自检清单。 |
| [ocr-winrt-test-result.md](./ocr-winrt-test-result.md) | Windows 系统 OCR 试跑数据（已被 `src/main/ocr` 源码注释引用，保留原位）。 |
| [README.en.md](./README.en.md) | 英文版项目说明。 |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | 开发与贡献约定。 |
| [SECURITY.md](./SECURITY.md) | 安全问题披露方式。 |

## 归档（docs/archive/，仅本地）

| 文档 | 归档日期 | 说明 |
| --- | --- | --- |
| `2026-09-03-PERF-AUDIT-AND-REFACTOR-0.8.1.md` | 2026-09-05 | 四份独立 AI 性能审查之一；结论已核查落地。 |
| `2026-09-03-PERF-INDEPENDENT-AUDIT-2026-09-03-Cline.md` | 2026-09-05 | 四份独立 AI 性能审查之二。 |
| `2026-09-03-PERF-REVIEW-0.8.0.md` | 2026-09-05 | 四份独立 AI 性能审查之三。 |
| `2026-09-03-PERF-REVIEW-0.8.1-2026-09-03-CodeBuddy.md` | 2026-09-05 | 四份独立 AI 性能审查之四。 |
| `2026-09-03-PERF-EXECUTION-PLAN-2026-09-03.md` | 2026-09-05 | 四份审查的核查整合与 0.8.2 执行结果；遗留项已由后续版本消化或在 AGENTS.md 承接。 |
| `2026-08-01-AGENT-CONTEXT-BUDGET-DESIGN.md` | 2026-09-05 | Agent 上下文预算设计（已实现）。 |
| `2026-07-29-AGENT-LOOP-IMPROVEMENT-PLAN.md` | 2026-09-05 | Agent 循环改进计划（已实现）。 |
| `2026-07-28-REFACTOR-PERFORMANCE.md` | 2026-09-05 | v0.6.2 时代的性能诊断与重构建议（已消化或证伪）。 |

当前功能、安装方式、配置和发布信息以项目根目录的 [README](../README.md) 与 [ARCHITECTURE.md](../ARCHITECTURE.md) 为准。
