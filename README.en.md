<div align="center">
  <img src="./docs/images/icon-readme-light.svg#gh-light-mode-only" alt="FlashAgent-assistant icon" width="88" />
  <img src="./docs/images/icon-readme-dark.svg#gh-dark-mode-only" alt="FlashAgent-assistant icon" width="88" />

  <h1>FlashAgent-assistant</h1>

  <p>Highlight text, snap a screenshot, ask AI — skip a few window switches, skip a lot of copy-pasting.</p>

  <p>
    <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-2f6fed?style=flat-square" alt="Platform" />
    <img src="https://img.shields.io/badge/Electron-33-3e4a5f?style=flat-square" alt="Electron 33" />
    <img src="https://img.shields.io/badge/React-18-2d9cdb?style=flat-square" alt="React 18" />
    <img src="https://img.shields.io/badge/TypeScript-5-3178c6?style=flat-square" alt="TypeScript 5" />
    <img src="https://img.shields.io/badge/API-OpenAI%20%7C%20Anthropic-3a7f52?style=flat-square" alt="API Support" />
    <img src="https://img.shields.io/badge/License-MIT-c9a227?style=flat-square" alt="MIT License" />
  </p>

  <p><strong>English</strong> | <a href="./README.md">中文</a></p>

  <p>
    <a href="https://github.com/XD06/FlashAgent-assistant/releases/latest"><img src="https://img.shields.io/github/v/release/XD06/FlashAgent-assistant?style=for-the-badge&label=Latest%20Release&color=2f6fed" alt="Latest release" /></a>
    <a href="https://github.com/XD06/FlashAgent-assistant/releases"><img src="https://img.shields.io/github/downloads/XD06/FlashAgent-assistant/total?style=for-the-badge&label=Downloads&color=c9a227" alt="Total downloads" /></a>
  </p>
</div>

FlashAgent-assistant lives in your menu bar / system tray. Highlight some text in any app and a small toolbar slides in next to it — one click to translate, explain, summarize, rewrite, search, copy, or read aloud. Prefer the keyboard? A global shortcut works too. Toolbar actions can be added, renamed, re-iconed, reordered, edited, or deleted; each prompt action can also use its own model template, adjust reasoning intensity, or open a type-in window from its own shortcut.

It also ships a built-in region screenshot tool: drag to select an area, annotate with pen or arrows (brush size is a quick slider away), then save as PNG, copy to clipboard, pin to the desktop, or hand the image straight to AI for vision-based analysis. Pinned screenshots support wheel zoom, drag-to-move, opacity tweaking, and a right-click menu to re-send them to AI.

The result window is its own conversation — keep asking follow-ups, AI sees the earlier turns, and output streams in so you can interrupt any time. The standalone chat window goes further: multi-topic history is saved locally and can be switched, deleted, or exported to Markdown in one click; long conversations are automatically compacted into a structured recap so context stays bounded. There is also an Agent mode — the model can read/write files and run commands, with every tool call individually approved (dangerous commands always require confirmation, catastrophic ones are blocked outright) and file changes revertible in one click. The extensions panel hooks up memory, Skills, and MCP servers. Flip on web search when you need fresh information; AI will fetch pages itself and cite the sources at the bottom of the answer.

For models you can point it at either **OpenAI-compatible** endpoints (your own endpoint, OpenAI, DeepSeek, Moonshot, Zhipu, any third-party proxy) or the **Anthropic** API. Multiple templates let you swap endpoint / key / model in one click, and individual actions can bind to a specific template. API keys stay on disk. Light / dark / system theme modes are supported, the UI ships in English and Chinese, and the result window's default size, font family, and font size can be customized.

Currently runs on macOS and Windows.

## Overview

- Electron desktop app for macOS and Windows
- Floating toolbar appears after text selection
- System TTS can read selected text aloud on macOS and Windows
- Built-in region screenshot: pin to desktop, copy, save, or hand it to AI vision (with a dedicated vision model setting)
- Standalone AI chat window: multi-topic history, automatic long-chat compaction, Markdown export
- Agent mode: file read/write and command tools with per-call approval, tiered dangerous-command gating, and revertible edits
- Extension system: memory, Skills, MCP servers, and a permissions mode
- Multiple API templates, with per-action model template and reasoning intensity
- Custom actions: add, rename, change icons, edit prompts, reorder, and delete
- Per-action input shortcuts: press a shortcut, type text, and run that action directly
- Light, dark, and follow-system theme modes
- Result window supports Markdown rendering, copyable code blocks, and wrapped long lines

## Screenshots

### Everyday Flow

<p>
  <img src="./docs/images/悬浮工具栏.png" alt="Floating Toolbar" width="48%" />
  <img src="./docs/images/结果窗口页.png" alt="Result Window" width="48%" />
</p>

### API and Action Setup

<p>
  <img src="./docs/images/api配置页.png" alt="API Settings" width="48%" />
  <img src="./docs/images/动作配置页.png" alt="Action Settings" width="48%" />
</p>

### Selection and Window Settings

<p>
  <img src="./docs/images/划词配置页.png" alt="Selection Settings" width="48%" />
  <img src="./docs/images/窗口配置页.png" alt="Window Settings" width="48%" />
</p>

## Features

- Shows a floating toolbar right after text selection
- Built-in actions for translate, explain, summarize, polish, search, copy, and read-aloud, plus your own custom actions
- Supports multiple API templates for quick provider/model switching
- Each prompt action can choose its own API template and independently set reasoning intensity
- Each action can have an input shortcut, so it can run without a prior text selection
- Toolbar can run in compact mode and can hide the app icon
- Closing the app minimizes it to the menu bar or system tray instead of quitting

### Screenshot

- Trigger region capture via a global shortcut and drag to select an area
- After capture: send to AI, copy to clipboard, save as PNG, or pin to the desktop
- Pinned images support wheel zoom, drag-to-move, and a right-click menu for opacity / reset / close
- The pin's right-click menu can also send the image straight into the AI image-understanding chat

### AI Chat and Follow-up

- Dedicated chat window, decoupled from the toolbar's one-shot result popup
- Multi-topic history: persisted locally; switch, delete, or rename topics, and export any topic to Markdown (written straight into Downloads and revealed in Explorer). The list is compact, with rename / export / delete tucked into a right-click menu
- Auto-named topics: the model generates a short title after the first exchange; a manual rename always wins
- Automatic compaction: triggered by real token usage (once usage passes ~95% of the context budget, older history is compacted before the next message is sent), earlier turns are summarized by an LLM into a five-section "rework document" (original task / key conclusions / file states / abandoned approaches / next steps), keeping paths and commands verbatim, with an optional dedicated compaction model and an on-screen progress hint
- A live context-usage ring, shown in token terms
- Automatic retry on network hiccups: 429 / 5xx / transient failures back off 1s→2s→4s, so long tasks don't die on a single blip
- Streaming output, rendered as it arrives, with interrupt support at any time
- Markdown code blocks include a copy button and wrap long lines
- The window can be pinned on top

### Agent Mode and Extensions

- In Agent mode the model can use built-in tools: read/write/edit files (with bulk replace), run commands, list directories, and more; once enabled you can pick a working directory for the session
- Tool arguments are validated first: invalid JSON, missing fields, or wrong types come back as actionable errors for the model to self-correct, instead of silently executing with empty args or raising a useless approval prompt
- `edit_file` matching tolerates line-ending (CRLF / LF) and trailing-whitespace differences (indentation must still match exactly) and reports line-level diagnostics on failure; `read_file` labels the file's line-ending type (CRLF / LF)
- Every tool call pauses for approval; "always allow" can be granted per session
- Three-tier command risk gating: catastrophic commands (e.g. `rm -rf /`, `format c:`) are blocked unconditionally; dangerous ones (e.g. `rm`, `git reset --hard`) always require confirmation in any mode
- File mutations are snapshotted to disk, so a single tool edit can be reverted even after an app restart
- Terminal-grade tool output: native ANSI colors are parsed, and edits/writes render as a standard unified diff (old lines red, new lines green) so changes are obvious at a glance
- On Windows without Git Bash, the command tool falls back to PowerShell, and its description adapts to the actual shell
- Extensions panel: memory (writes need confirmation), Skills, MCP servers (tool calls always need confirmation), and a permissions tab with an optional full-access mode that never bypasses the danger gates
- Feature models: dedicated models for vision and compaction, plus per-action model overrides; the context window size can be set per model in settings (defaults to 128000 tokens)

## Platform Notes

### macOS

- Accessibility permission is required for system-level text selection detection
- Closing the main window minimizes the app to the menu bar
- On first launch, it is worth testing text selection and popup behavior manually

### Windows

- Supports staying resident in the system tray
- Closing the main window minimizes it to the tray instead of quitting
- Selection behavior can vary depending on the target app, elevation level, or IME state
- Without Git Bash installed, the Agent's command tool automatically uses PowerShell

## Installation and Local Development

### Prerequisites

- Node.js 20+ recommended
- `pnpm` 10+
- Use macOS or Windows if you want to test the full runtime behavior

### Install

```bash
pnpm install
```

### Development

```bash
pnpm dev
```

### Test

```bash
pnpm test
pnpm typecheck
```

Optional: `pnpm e2e:compaction` runs the full context-compaction regression against your locally configured real API (sends a few real requests; see `sandbox-e2e/README.md`).

### Build

```bash
pnpm build
```

## Packaging

```bash
pnpm dist:mac
pnpm dist:win
```

Notes:

- Build artifacts should not be committed to the repository
- If you want to distribute binaries, GitHub Releases is the recommended path

## Configuration

### API Support

- OpenAI-compatible: uses `/chat/completions` and `/models`
- For OpenAI-compatible providers, enter the API root when possible, such as `https://api.example.com/v1`; if you paste a full `/chat/completions` or `/models` endpoint, the app normalizes it automatically
- Anthropic: uses `/v1/messages` and `/v1/models`
- In Anthropic mode, you only need to enter the base URL; `/v1` is appended automatically

### API Templates

- Add, rename, and delete multiple API templates
- Each template stores API type, base URL, API key, and model
- Templates can fetch available models, test the configured model, and be marked as default
- Actions can follow the default template or bind to a specific template

### Action Configuration

- Built-in actions can be edited, disabled, and reordered; custom actions can also be deleted
- Prompt actions support custom prompts, icons, provider templates, and reasoning intensity
- Search actions support custom search URL templates
- The read-aloud action uses system TTS, and the tray menu can stop current speech
- Action shortcuts open a type-in window, then run the selected action once against that input

### Theme and UI

- Light, dark, and follow-system modes
- Compact toolbar mode is supported
- The app icon in the floating toolbar can be hidden
- The result window supports custom default width, height, font family, and font size
- Packaged builds support launch-at-login; login launches start hidden in the menu bar / tray
- The settings window is organized into API, Selection, Window, and Actions sections

## Privacy

- Selected text is only sent to the configured provider when you explicitly trigger an AI action
- API keys are stored locally through Electron Store
- This repository should not contain your local settings, dependencies, or build artifacts

## Known Limitations

- System-level selection depends on the third-party `selection-hook` package, so behavior can vary across apps
- Linux is not a first-class supported platform yet
- Selection position and follow-window behavior may differ in some apps or IME environments
- The current provider layer supports OpenAI-compatible and Anthropic APIs only

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before contributing.

## 🙏 Acknowledgments

- Built on top of [zcx960/AIA-selection-assistan](https://github.com/zcx960/AIA-selection-assistan); thanks to the original author
- [LINUX DO](https://linux.do/) — Community support and inspiration

## Security

If you discover a security issue, please do not open a public issue first. See [SECURITY.md](./SECURITY.md).

## License

This project is released under the [MIT License](./LICENSE).
