# selection-assistant-lite

轻量跨平台 AI 划词助手。选中文本后可通过悬浮工具条快速执行翻译、解释、总结、搜索、复制等动作，并支持 OpenAI-compatible 与 Anthropic API。

Lightweight cross-platform AI selection assistant for macOS and Windows. After selecting text, you can use a floating toolbar to translate, explain, summarize, search, or copy instantly, with support for both OpenAI-compatible and Anthropic APIs.

## 项目概览 | Overview

- 桌面端 Electron 应用，适用于 macOS 和 Windows
- 系统级划词监听与悬浮工具条
- 支持自定义动作、API 模板、主题模式、工具条样式
- 支持 OpenAI-compatible 与 Anthropic Messages API

- Electron desktop app for macOS and Windows
- System-level text selection detection with floating toolbar
- Configurable actions, API templates, theme modes, and toolbar behavior
- Supports OpenAI-compatible APIs and Anthropic Messages API

## 截图 | Screenshots

当前仓库暂未附带正式截图资源；建议在首次公开发布前补充设置页、悬浮工具条、结果窗口的截图到本节。

This repository does not yet include finalized screenshots. Before the first public release, add screenshots for the settings window, floating toolbar, and result window here.

## 功能特性 | Features

- 划词后直接显示悬浮工具条，支持快捷动作
- 动作类型包含翻译、解释、总结、润色、搜索、复制
- 支持多个 API 配置模板，快速切换模型与服务商
- 主题支持亮色、暗色、跟随系统
- 可控制是否显示工具条 app 图标、是否启用紧凑工具条
- 结果窗口支持 Markdown 渲染
- 应用关闭后最小化到状态栏或系统托盘，而不是直接退出

- Floating toolbar appears after text selection for quick actions
- Built-in actions include translate, explain, summarize, polish, search, and copy
- Multiple API templates let you switch providers and models quickly
- Theme modes: light, dark, or follow system
- Toolbar options include compact mode and app icon visibility
- Result window renders Markdown output
- Closing the app minimizes it to the menu bar or system tray instead of exiting

## 平台与权限说明 | Platform Notes

### macOS

- 需要授予辅助功能权限，应用才能检测系统级划词
- 关闭主窗口后，应用会缩到顶部状态栏
- 悬浮工具条与结果窗口受系统窗口行为影响，首次使用建议手动验证权限和显示效果

### Windows

- 支持系统托盘驻留
- 关闭主窗口后，应用会缩到系统托盘而不是退出
- 划词监听行为可能受目标应用、管理员权限或输入法状态影响

### macOS

- Accessibility permission is required for system-level text selection detection
- Closing the main window minimizes the app to the menu bar
- Floating toolbar and result window behavior should be verified after the first permission grant

### Windows

- Supports staying resident in the system tray
- Closing the main window minimizes the app to the tray instead of quitting
- Selection detection may vary depending on the target app, elevated permissions, or IME state

## 安装与本地开发 | Installation and Local Development

### 前置要求 | Prerequisites

- Node.js 20+ recommended
- `pnpm` 10+
- macOS or Windows for full runtime testing

### 安装依赖 | Install

```bash
pnpm install
```

### 开发模式 | Development

```bash
pnpm dev
```

### 测试 | Test

```bash
pnpm test
pnpm typecheck
```

### 构建 | Build

```bash
pnpm build
```

## 打包命令 | Packaging

```bash
pnpm dist:mac
pnpm dist:win
```

说明：

- 打包产物不会提交到 git 仓库
- 如果后续需要公开安装包，建议通过 GitHub Releases 发布

Notes:

- Build artifacts should not be committed to the repository
- If you want to distribute binaries later, publish them through GitHub Releases

## 配置说明 | Configuration

### API 支持 | API Support

- OpenAI-compatible: 使用 `/chat/completions` 与 `/models`
- Anthropic: 使用 `/v1/messages` 与 `/v1/models`
- Anthropic 模式下，设置页中 Base URL 只需要填写基础地址，不需要手动输入 `/v1`

- OpenAI-compatible: uses `/chat/completions` and `/models`
- Anthropic: uses `/v1/messages` and `/v1/models`
- In Anthropic mode, the Base URL field should contain only the base endpoint; `/v1` is appended automatically

### API 模板 | API Templates

- 每个模板保存 API 类型、Base URL、API Key、Model
- 切换模板会立即切换当前使用的 provider 配置

- Each template stores API type, base URL, API key, and model
- Switching a template immediately switches the active provider configuration

### 主题与界面 | Theme and UI

- 亮色、暗色、跟随系统
- 工具条可切换紧凑模式
- 工具条可选择是否显示 app 图标

- Light, dark, and system-follow modes
- Toolbar supports compact mode
- Toolbar can optionally hide the app icon

## 隐私说明 | Privacy

- 只有当你主动触发 AI 动作时，选中文本才会被发送到你配置的 API 服务
- API Key 存储在本地 Electron Store 配置中
- 仓库不会包含你的本地配置、构建产物或依赖目录

- Selected text is only sent to the configured provider when you explicitly trigger an AI action
- API keys are stored locally through Electron Store
- This repository should not include your local settings, build artifacts, or dependency directories

## 已知限制 | Known Limitations

- 系统级划词能力依赖第三方 `selection-hook`，在不同应用中的稳定性可能不同
- Linux 当前不是正式支持平台
- 某些应用或输入法环境下，划词位置和窗口跟随效果可能存在差异
- API 协议目前仅覆盖 OpenAI-compatible 与 Anthropic 两类接口

- System-level selection depends on the third-party `selection-hook` package and may behave differently across apps
- Linux is not currently a first-class supported platform
- Selection positioning and window follow behavior may vary across apps and IME environments
- The current provider layer supports OpenAI-compatible and Anthropic APIs only

## 贡献 | Contributing

欢迎提交 issue 和 pull request。开始之前请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before contributing.

## 安全 | Security

如果你发现安全问题，请不要直接公开提 issue，先阅读 [SECURITY.md](./SECURITY.md) 中的说明。

If you discover a security issue, please do not open a public issue first. See [SECURITY.md](./SECURITY.md).

## 许可证 | License

本项目基于 [MIT License](./LICENSE) 开源。

This project is released under the [MIT License](./LICENSE).
