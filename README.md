<div align="center">
  <img src="./docs/images/icon-readme-light.svg#gh-light-mode-only" alt="FlashAgent-assistant 图标" width="88" />
  <img src="./docs/images/icon-readme-dark.svg#gh-dark-mode-only" alt="FlashAgent-assistant 图标" width="88" />

  <h1>FlashAgent-assistant</h1>

  <p>划词即问、截图即懂、轻量 Agent 即刻开工。</p>

  <p>
    <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-2f6fed?style=flat-square" alt="支持的平台" />
    <img src="https://img.shields.io/badge/Electron-33-3e4a5f?style=flat-square" alt="Electron 33" />
    <img src="https://img.shields.io/badge/React-18-2d9cdb?style=flat-square" alt="React 18" />
    <img src="https://img.shields.io/badge/TypeScript-5-3178c6?style=flat-square" alt="TypeScript 5" />
    <img src="https://img.shields.io/badge/License-MIT-c9a227?style=flat-square" alt="MIT License" />
  </p>

  <p><a href="./docs/README.en.md">English</a> | <strong>中文</strong></p>

  <p>
    <a href="https://github.com/XD06/FlashAgent-assistant/releases/latest"><img src="https://img.shields.io/github/v/release/XD06/FlashAgent-assistant?style=for-the-badge&label=Latest%20Release&color=2f6fed" alt="最新版本" /></a>
    <a href="https://github.com/XD06/FlashAgent-assistant/releases"><img src="https://img.shields.io/github/downloads/XD06/FlashAgent-assistant/total?style=for-the-badge&label=Downloads&color=c9a227" alt="总下载量" /></a>
  </p>
</div>

FlashAgent-assistant 是面向快速问答与轻量 Agent 工作流的桌面 AI 助手，运行在菜单栏或系统托盘中。选中任意文本即可翻译、解释、总结、润色、搜索、复制或朗读，无需在应用间反复复制粘贴；区域截图可直接标注、保存、复制、钉在桌面，或一键识别文字 / 交给 AI 识图。独立对话窗口支持多话题、本地历史、流式输出、追问和 Markdown 导出。

本项目基于 [zcx960/AIA-selection-assistan](https://github.com/zcx960/AIA-selection-assistan) 二次开发。FlashAgent-assistant 在保留划词工作流的基础上，扩展了可配置的模型服务、视觉识图、Agent 工作流、上下文压缩、联网搜索、Skills 与 MCP 集成等能力。上游项目的授权与鸣谢信息保留在本文档和 [LICENSE](./LICENSE) 中。

## 核心能力

- **快速问答与划词操作**：浮动工具栏、内置和自定义动作、动作专属快捷键、全局快捷键一键呼出设置与窗口、紧凑模式；选中内容即可就地提问。
- **快速翻译与语音合成**：快捷键呼出轻量翻译窗，输入中英文智能双向互切；微软 / 金山 / 腾讯 / Yandex / DeepLX 等免 Key 或可选引擎并行翻译；金山词霸与有道词典卡片（音标发音、分词性释义、词形、短语、双语例句）；查过的英文单词自动/手动收进生词本；支持 Edge TTS 与小米 MiMo 大模型高保真语音合成（标准新闻播音腔）。
- **截图与识图**：区域截图支持画笔和箭头标注，可保存、复制、钉图，一键「识别文字」（默认 Windows 系统引擎零下载即用，可选下载高精度 PP-OCR 引擎），或交给 AI 视觉对话。
- **多模型配置**：支持 OpenAI-compatible 与 Anthropic API；可维护多个服务商模板，并为动作、识图和压缩分别指定模型。
- **对话与上下文**：多话题本地历史、自动命名、Markdown 导出和 token 驱动的长对话压缩；压缩摘要保留任务、事实、文件状态和下一步。
- **轻量 Agent 与扩展**：需要处理文件、目录、命令或联网搜索时，可在独立对话中快速进入 Agent 流程；工具调用实时流式解析命令与写入进度，逐项确认，危险命令分级拦截，多轮调用严格物理隔离，文件改动可回退；支持记忆、Skills 与 MCP 服务器。
- **桌面体验与多主题工坊**：支持跟随系统 / 亮色 / 暗色与 OLED 纯黑模式，提供 Live Preview 实时微缩预览、跟随系统强调色或自定义调色盘、4 档色彩风格（Vivid / Tinted / Soft / Monochrome）及字号滑块实时调节；全应用采用四级明度表面与无边框卡片层级，设置窗配备可折叠侧栏；支持中英双语与结果窗口尺寸记忆，macOS 与 Windows 均可使用。

## 界面预览

以下截图展示当前版本 FlashAgent-assistant 的设置界面。

### 设置

<p>
  <img src="./docs/images/api配置.png" alt="API 配置：服务商、模型、密钥和功能模型" width="48%" />
  <img src="./docs/images/动作.png" alt="动作配置：内置和自定义操作的排序与启用状态" width="48%" />
</p>

<p>
  <img src="./docs/images/划词.png" alt="划词配置：触发方式与全局快捷键" width="48%" />
  <img src="./docs/images/窗口.png" alt="窗口配置：结果窗口行为、尺寸和字体" width="48%" />
</p>

### Agent 工作流

<p>
  <img src="./docs/images/agentmode.png" alt="独立 AI 对话窗口和 Agent 模式入口" width="48%" />
  <img src="./docs/images/agentmode1.png" alt="扩展面板：记忆、Skills、MCP 和权限" width="48%" />
</p>

<p>
  <img src="./docs/images/agentmode2.png" alt="Agent 文件写入与统一 diff 输出" width="48%" />
  <img src="./docs/images/agentmode3.png" alt="MCP 工具调用的审批卡片" width="48%" />
</p>

### AI 识图

<p>
  <img src="./docs/images/识图.png" alt="AI 识图结果窗口" width="82%" />
</p>

## 平台说明

### macOS

- 需要授予辅助功能权限，应用才能检测系统级划词。
- 关闭主窗口后，应用会驻留在菜单栏。

### Windows

- 支持系统托盘驻留，关闭所有窗口后应用仍驻留托盘。
- 划词监听效果可能受目标应用、管理员权限或输入法状态影响。
- 未安装 Git Bash 时，Agent 命令工具会自动回退到 PowerShell。

## 安装与开发

### 前置条件

- Node.js 20+
- pnpm 10+
- macOS 或 Windows，用于验证完整的桌面功能

### 本地运行

```bash
pnpm install
pnpm dev
```

### 验证与构建

```bash
pnpm test
pnpm typecheck
pnpm build
```

`pnpm e2e:compaction` 会使用本机已配置的真实 API 运行上下文压缩回归，产生少量真实请求；详情见 [sandbox-e2e/README.md](./sandbox-e2e/README.md)。

### 打包

```bash
pnpm dist:mac
pnpm dist:win
```

打包产物不应提交到 Git。公开分发建议通过 [GitHub Releases](https://github.com/XD06/FlashAgent-assistant/releases)。

### 分享预置配置的便携版

想让别人打开就能用、免去设置，用一条命令生成开箱即用的分享包：

```bash
pnpm dist:win:share
```

它会先打包便携版，再把本机的设置、全局记忆和技能复制进 `dist/data/`。把 `FlashAgent-assistant-Portable-<版本>.exe` 和 `data/` 一起压缩发给对方，对方解压后直接双击 exe 即可，无需进设置页。

- 便携版把用户数据目录改为 exe 同目录的 `data/`：配置、聊天历史、生词本都留在这个文件夹里，不写系统目录，删掉文件夹即可彻底清理。
- 随包预置的只有 `settings.json`、`memory.md` 和 `skills/`；聊天历史、生词本、缓存不会带过去。本机代理地址、链接的技能目录与开机自启会自动中和，划词总开关会自动打开，保证对方开箱即用。
- `data/settings.json` 含 API Key 与服务商配置，请只发给信任的人，并优先使用可随时吊销的专用 Key。
- 换一台机器的配置做模板：`node scripts/prepare-portable-preset.mjs --from <用户数据目录>`（需先完成一次 `pnpm dist:win`）。
- exe 请放在可写目录，不要放进 `C:\Program Files` 等只读位置，`data/` 需要写权限。

## 配置与隐私

- API Key、模型模板、话题记录、记忆和本地工具快照均保存在本机用户数据目录。
- 只有主动触发 AI 动作时，选中文本、截图或对话内容才会发送给你配置的服务商。
- OpenAI-compatible 服务建议填写 API 根路径，例如 `https://api.example.com/v1`；完整的 `/chat/completions` 或 `/models` 地址会被自动归一化。
- Anthropic 配置只需填写基础地址，应用会补全 `/v1`。

项目更名后，首次启动会将旧 `selection-assistant-lite` 用户数据目录复制到新的 `flashagent-assistant` 目录；如果新目录已经存在，则不会覆盖任何内容。

## 项目文档

- [ARCHITECTURE.md](./ARCHITECTURE.md)：系统架构全景（进程模型、模块边界、关键数据流）。
- [CHANGELOG.md](./CHANGELOG.md)：版本变更记录。
- [docs/QUICK-TRANSLATE.md](./docs/QUICK-TRANSLATE.md)：快速翻译、各翻译服务、有道词典、语音合成与生词本的架构说明。
- [docs/OCR.md](./docs/OCR.md)：截图文字识别双引擎的选型与架构说明。
- [docs/NEW-FEATURE-PAGE-GUIDE.md](./docs/NEW-FEATURE-PAGE-GUIDE.md)：新功能页面接入的性能守则。
- [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md)：开发与贡献约定。
- [docs/SECURITY.md](./docs/SECURITY.md)：安全问题披露方式。
- [docs/ARCHIVE.md](./docs/ARCHIVE.md)：文档索引与历史归档说明。

## 贡献、致谢与许可证

欢迎提交 issue 和 pull request。提交前请阅读 [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md)。

- 上游项目：[zcx960/AIA-selection-assistan](https://github.com/zcx960/AIA-selection-assistan)，感谢原作者的工作。
- 社区支持：[LINUX DO](https://linux.do/)。
- 本项目基于 [MIT License](./LICENSE) 开源；分发本项目或其重要部分时，请保留许可证和版权声明。
