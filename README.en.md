<p align="center">
  <img src="./build/icon.png" alt="AIA Selection Assistant icon" width="72" />
</p>

# AIA Selection Assistant

[中文文档](./README.md)

`AIA Selection Assistant` is a lightweight desktop app for people who often read, write, translate, or look things up with AI. When you select text in almost any app, it pops up a small toolbar so you can translate, explain, summarize, search, or copy right away without breaking your flow.

It currently supports macOS and Windows, with both OpenAI-compatible and Anthropic APIs. The goal is simple: stay lightweight, open fast, and keep setup easy.

## Overview

- Electron desktop app for macOS and Windows
- Floating toolbar appears after text selection
- API templates make it easy to switch models, keys, and providers
- Light, dark, and follow-system theme modes
- Result window supports Markdown rendering

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
- Built-in actions for translate, explain, summarize, polish, search, and copy
- Supports multiple API templates for quick provider/model switching
- Toolbar can run in compact mode and can hide the app icon
- Closing the app minimizes it to the menu bar or system tray instead of quitting

## Platform Notes

### macOS

- Accessibility permission is required for system-level text selection detection
- Closing the main window minimizes the app to the menu bar
- On first launch, it is worth testing text selection and popup behavior manually

### Windows

- Supports staying resident in the system tray
- Closing the main window minimizes it to the tray instead of quitting
- Selection behavior can vary depending on the target app, elevation level, or IME state

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
- Anthropic: uses `/v1/messages` and `/v1/models`
- In Anthropic mode, you only need to enter the base URL; `/v1` is appended automatically

### API Templates

- Each template stores API type, base URL, API key, and model
- Switching a template immediately switches the active provider configuration

### Theme and UI

- Light, dark, and follow-system modes
- Compact toolbar mode is supported
- The app icon in the floating toolbar can be hidden
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

## Security

If you discover a security issue, please do not open a public issue first. See [SECURITY.md](./SECURITY.md).

## License

This project is released under the [MIT License](./LICENSE).
