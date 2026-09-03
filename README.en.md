<div align="center">
  <img src="./docs/images/icon-readme-light.svg#gh-light-mode-only" alt="FlashAgent-assistant icon" width="88" />
  <img src="./docs/images/icon-readme-dark.svg#gh-dark-mode-only" alt="FlashAgent-assistant icon" width="88" />

  <h1>FlashAgent-assistant</h1>

  <p>Ask from any selection, understand any screenshot, and start a lightweight Agent workflow without breaking focus.</p>

  <p>
    <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-2f6fed?style=flat-square" alt="Supported platforms" />
    <img src="https://img.shields.io/badge/Electron-33-3e4a5f?style=flat-square" alt="Electron 33" />
    <img src="https://img.shields.io/badge/React-18-2d9cdb?style=flat-square" alt="React 18" />
    <img src="https://img.shields.io/badge/TypeScript-5-3178c6?style=flat-square" alt="TypeScript 5" />
    <img src="https://img.shields.io/badge/License-MIT-c9a227?style=flat-square" alt="MIT License" />
  </p>

  <p><strong>English</strong> | <a href="./README.md">中文</a></p>

  <p>
    <a href="https://github.com/XD06/FlashAgent-assistant/releases/latest"><img src="https://img.shields.io/github/v/release/XD06/FlashAgent-assistant?style=for-the-badge&label=Latest%20Release&color=2f6fed" alt="Latest release" /></a>
    <a href="https://github.com/XD06/FlashAgent-assistant/releases"><img src="https://img.shields.io/github/downloads/XD06/FlashAgent-assistant/total?style=for-the-badge&label=Downloads&color=c9a227" alt="Total downloads" /></a>
  </p>
</div>

FlashAgent-assistant is a desktop AI companion for fast answers and lightweight Agent workflows, living in the menu bar or system tray. Select text in any app to translate, explain, summarize, rewrite, search, copy, or read it aloud without repeated copy-paste. Capture a screen region to annotate, save, copy, pin to the desktop, or send directly to vision-capable AI. The separate chat window supports multiple topics, local history, streaming replies, follow-ups, and Markdown export.

This project is a derivative of [zcx960/AIA-selection-assistan](https://github.com/zcx960/AIA-selection-assistan). FlashAgent-assistant retains the selection-first workflow and adds configurable model providers, image understanding, Agent workflows, context compaction, web search, Skills, and MCP integration. The upstream link, attribution, and MIT license are retained here and in [LICENSE](./LICENSE).

## Highlights

- **Fast answers from text selection**: a floating toolbar, built-in and custom actions, per-action shortcuts, system TTS, and compact mode. Ask about selected content in place.
- **Quick translate and vocabulary**: a hotkey summons a lightweight translate window with key-free Microsoft / Kingsoft / DeepLX engines running in parallel, an iciba dictionary card, and Edge TTS read-aloud (no LLM API needed). Looked-up English words can be saved into a vocabulary book automatically or manually, with grid preview, dictionary details, search, and Markdown export.
- **Multi-provider configuration**: OpenAI-compatible and Anthropic APIs, multiple provider templates, and dedicated models for actions, vision, and compaction.
- **Screenshots and vision**: region capture with pen and arrow annotations; save, copy, pin, and send to AI vision; source images can be expanded from the result window.
- **Chat and context**: local multi-topic history, automatic titles, Markdown export, and token-driven compaction that preserves task state and next steps.
- **Lightweight Agent and extensions**: move quickly from a chat to file operations, directory browsing, command execution, or web search; each tool call is confirmed, dangerous commands are tiered and blocked, and file changes can be reverted; includes memory, Skills, and MCP servers.
- **Desktop experience**: light, dark, and system themes; English and Chinese UI; configurable result window size and font; macOS and Windows support.

## Screenshots

The screenshots below show the current FlashAgent-assistant settings interface.

### Settings

<p>
  <img src="./docs/images/api配置.png" alt="API providers, models, keys, and feature-model settings" width="48%" />
  <img src="./docs/images/动作.png" alt="Action ordering and enablement settings" width="48%" />
</p>

<p>
  <img src="./docs/images/划词.png" alt="Selection trigger and global shortcut settings" width="48%" />
  <img src="./docs/images/窗口.png" alt="Result-window behavior, dimensions, and typography settings" width="48%" />
</p>

### Agent workflow

<p>
  <img src="./docs/images/agentmode.png" alt="Standalone AI chat with Agent mode entry point" width="48%" />
  <img src="./docs/images/agentmode1.png" alt="Extensions panel for memory, Skills, MCP, and permissions" width="48%" />
</p>

<p>
  <img src="./docs/images/agentmode2.png" alt="Agent file writing with unified diff output" width="48%" />
  <img src="./docs/images/agentmode3.png" alt="MCP tool approval card" width="48%" />
</p>

### AI vision

<p>
  <img src="./docs/images/识图.png" alt="AI vision result window" width="82%" />
</p>

## Platform notes

### macOS

- Accessibility permission is required for system-wide selection detection.
- Closing the main window keeps the app in the menu bar.

### Windows

- The app can remain resident in the system tray.
- Selection behavior can vary by target application, elevation level, or IME state.
- When Git Bash is unavailable, the Agent command tool falls back to PowerShell.

## Install and develop

### Prerequisites

- Node.js 20+
- pnpm 10+
- macOS or Windows to validate the full desktop workflow

### Run locally

```bash
pnpm install
pnpm dev
```

### Validate and build

```bash
pnpm test
pnpm typecheck
pnpm build
```

`pnpm e2e:compaction` runs the context-compaction regression against your locally configured real API and sends a small number of real requests. See [sandbox-e2e/README.md](./sandbox-e2e/README.md).

### Package

```bash
pnpm dist:mac
pnpm dist:win
```

Do not commit build artifacts. For public distribution, use [GitHub Releases](https://github.com/XD06/FlashAgent-assistant/releases).

## Configuration and privacy

- API keys, provider templates, topic history, memory, and local tool snapshots stay in the local user-data directory.
- Selected text, screenshots, and chat content are only sent to the provider you configure when you explicitly invoke an AI action.
- For OpenAI-compatible providers, prefer the API root, such as `https://api.example.com/v1`; full `/chat/completions` and `/models` URLs are normalized automatically.
- Anthropic configuration accepts a base URL; the app appends `/v1`.

On the first launch after the project rename, the app copies the legacy `selection-assistant-lite` user-data directory to `flashagent-assistant`. It never overwrites an existing new directory.

## Project documentation

- [CHANGELOG.md](./CHANGELOG.md): release history.
- [docs/QUICK-TRANSLATE.md](./docs/QUICK-TRANSLATE.md): architecture notes for quick translate, TTS, and the vocabulary book.
- [docs/OCR.md](./docs/OCR.md): selection and architecture notes for offline screenshot OCR.
- [CONTRIBUTING.md](./CONTRIBUTING.md): development and contribution guidance.
- [SECURITY.md](./SECURITY.md): private security reporting guidance.
- [docs/ARCHIVE.md](./docs/ARCHIVE.md): historical design and implementation records.

## Contributing, attribution, and license

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) first.

- Upstream: [zcx960/AIA-selection-assistan](https://github.com/zcx960/AIA-selection-assistan), with thanks to the original author.
- Community support: [LINUX DO](https://linux.do/).
- This project is released under the [MIT License](./LICENSE). Preserve the license and copyright notice when distributing substantial portions of the project.
