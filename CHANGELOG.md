# Changelog

## 0.6.1 - 2026-06-16

### Fixed

- 修复设置页服务名称输入中文时被异步设置刷新打断，导致 IME 组合输入异常的问题。
- 修复服务名称清空后会自动恢复为 `Template 1`，导致默认名称首字母无法删除的问题。
- 修复 Windows 便携版中模型列表获取、模型测活和翻译请求可能因 Node `fetch` 未走 Electron 网络栈而报 `fetch failed` 的问题。
- 兼容 OpenAI-compatible 配置中粘贴完整 `/chat/completions` 或 `/models` endpoint 的常见用法。

### Tests

- 增加服务名称清空、OpenAI-compatible URL 规范化、供应商请求 fetcher 注入和 Web Search 预判请求的回归测试。
