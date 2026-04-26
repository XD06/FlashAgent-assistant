# AIA Selection Assistant

[中文文档](./README.md)

GitHub repository: `AIA-selection-assistan`

Lightweight cross-platform AI selection assistant for macOS and Windows. After selecting text, you can use a floating toolbar to translate, explain, summarize, search, or copy instantly, with support for both OpenAI-compatible and Anthropic APIs.

## Overview

- Electron desktop app for macOS and Windows
- System-level text selection detection with a floating toolbar
- Configurable actions, API templates, theme modes, and toolbar behavior
- Supports OpenAI-compatible APIs and Anthropic Messages API

## Screenshots

This repository does not yet include finalized screenshots. Before the first public release, add screenshots for the settings window, floating toolbar, and result window here.

## Features

- Floating toolbar appears after text selection for quick actions
- Built-in actions include translate, explain, summarize, polish, search, and copy
- Multiple API templates let you switch providers and models quickly
- Theme modes: light, dark, or follow system
- Toolbar options include compact mode and app icon visibility
- Result window renders Markdown output
- Closing the app minimizes it to the menu bar or system tray instead of exiting

## Platform Notes

### macOS

- Accessibility permission is required for system-level text selection detection
- Closing the main window minimizes the app to the menu bar
- Floating toolbar and result window behavior should be verified after the first permission grant

### Windows

- Supports staying resident in the system tray
- Closing the main window minimizes the app to the tray instead of quitting
- Selection detection may vary depending on the target app, elevated permissions, or IME state

## Installation and Local Development

### Prerequisites

- Node.js 20+ recommended
- `pnpm` 10+
- macOS or Windows for full runtime testing

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
- If you want to distribute binaries later, publish them through GitHub Releases

## Configuration

### API Support

- OpenAI-compatible: uses `/chat/completions` and `/models`
- Anthropic: uses `/v1/messages` and `/v1/models`
- In Anthropic mode, the Base URL field should contain only the base endpoint; `/v1` is appended automatically

### API Templates

- Each template stores API type, base URL, API key, and model
- Switching a template immediately switches the active provider configuration

### Theme and UI

- Light, dark, and system-follow modes
- Toolbar supports compact mode
- Toolbar can optionally hide the app icon

## Privacy

- Selected text is only sent to the configured provider when you explicitly trigger an AI action
- API keys are stored locally through Electron Store
- This repository should not include your local settings, build artifacts, or dependency directories

## Known Limitations

- System-level selection depends on the third-party `selection-hook` package and may behave differently across apps
- Linux is not currently a first-class supported platform
- Selection positioning and window follow behavior may vary across apps and IME environments
- The current provider layer supports OpenAI-compatible and Anthropic APIs only

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before contributing.

## Security

If you discover a security issue, please do not open a public issue first. See [SECURITY.md](./SECURITY.md).

## License

This project is released under the [MIT License](./LICENSE).
