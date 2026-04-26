# AIA划词助手

[English README](./README.en.md)

GitHub 仓库名：`AIA-selection-assistan`

轻量跨平台 AI 划词助手。选中文本后可通过悬浮工具条快速执行翻译、解释、总结、搜索、复制等动作，并支持 OpenAI-compatible 与 Anthropic API。

## 项目概览

- 桌面端 Electron 应用，适用于 macOS 和 Windows
- 系统级划词监听与悬浮工具条
- 支持自定义动作、API 模板、主题模式、工具条样式
- 支持 OpenAI-compatible 与 Anthropic Messages API

## 截图

### 悬浮工具栏

![悬浮工具栏](./docs/images/悬浮工具栏.png)

### 结果窗口

![结果窗口](./docs/images/结果窗口页.png)

### API 配置页

![API 配置页](./docs/images/api配置页.png)

## 功能特性

- 划词后直接显示悬浮工具条，支持快捷动作
- 动作类型包含翻译、解释、总结、润色、搜索、复制
- 支持多个 API 配置模板，快速切换模型与服务商
- 主题支持亮色、暗色、跟随系统
- 可控制是否显示工具条 app 图标、是否启用紧凑工具条
- 结果窗口支持 Markdown 渲染
- 应用关闭后最小化到状态栏或系统托盘，而不是直接退出

## 平台与权限说明

### macOS

- 需要授予辅助功能权限，应用才能检测系统级划词
- 关闭主窗口后，应用会缩到顶部状态栏
- 悬浮工具条与结果窗口受系统窗口行为影响，首次使用建议手动验证权限和显示效果

### Windows

- 支持系统托盘驻留
- 关闭主窗口后，应用会缩到系统托盘而不是退出
- 划词监听行为可能受目标应用、管理员权限或输入法状态影响

## 安装与本地开发

### 前置要求

- 推荐 Node.js 20+
- `pnpm` 10+
- 若要完整验证运行行为，建议使用 macOS 或 Windows

### 安装依赖

```bash
pnpm install
```

### 开发模式

```bash
pnpm dev
```

### 测试

```bash
pnpm test
pnpm typecheck
```

### 构建

```bash
pnpm build
```

## 打包命令

```bash
pnpm dist:mac
pnpm dist:win
```

说明：

- 打包产物不会提交到 git 仓库
- 如果后续需要公开安装包，建议通过 GitHub Releases 发布

## 配置说明

### API 支持

- OpenAI-compatible：使用 `/chat/completions` 与 `/models`
- Anthropic：使用 `/v1/messages` 与 `/v1/models`
- Anthropic 模式下，设置页中 Base URL 只需要填写基础地址，不需要手动输入 `/v1`

### API 模板

- 每个模板保存 API 类型、Base URL、API Key、Model
- 切换模板会立即切换当前使用的 provider 配置

### 主题与界面

- 亮色、暗色、跟随系统
- 工具条可切换紧凑模式
- 工具条可选择是否显示 app 图标
- 设置页包含 API 配置、划词、窗口、动作 四个分区，并已提供对应界面截图资源

## 隐私说明

- 只有当你主动触发 AI 动作时，选中文本才会被发送到你配置的 API 服务
- API Key 存储在本地 Electron Store 配置中
- 仓库不会包含你的本地配置、构建产物或依赖目录

## 已知限制

- 系统级划词能力依赖第三方 `selection-hook`，在不同应用中的稳定性可能不同
- Linux 当前不是正式支持平台
- 某些应用或输入法环境下，划词位置和窗口跟随效果可能存在差异
- API 协议目前仅覆盖 OpenAI-compatible 与 Anthropic 两类接口

## 贡献

欢迎提交 issue 和 pull request。开始之前请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 安全

如果你发现安全问题，请不要直接公开提 issue，先阅读 [SECURITY.md](./SECURITY.md) 中的说明。

## 许可证

本项目基于 [MIT License](./LICENSE) 开源。
