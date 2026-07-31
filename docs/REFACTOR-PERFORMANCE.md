# FlashAgent-assistant — 性能重构行动手册

> **归档说明（2026-08-01）**：本文基于 v0.6.2 的代码快照编写，用于保留当时的性能诊断与重构决策，并非当前架构规范。文中的窗口数量、依赖、文件路径、版本和待办状态可能已过时；当前项目概览请见 [README](../README.md)，历史文档索引请见 [ARCHIVE.md](./ARCHIVE.md)。

> 目标：在保持全部功能的前提下，大幅降低内存占用和资源开销。
> 基准版本：v0.6.2 · Electron 33 · React 18 · TypeScript 5

---

## 目录

- [一、资源消耗诊断](#一资源消耗诊断)
- [二、行动项总览](#二行动项总览)
- [三、P0 行动项（零成本调参，立即执行）](#三p0-行动项零成本调参立即执行)
  - [P0-1 开启 sandbox 模式](#p0-1-开启-sandbox-模式)
  - [P0-2 删除 toolbar 窗口预创建](#p0-2-删除-toolbar-窗口预创建)
  - [P0-3 pin 窗口去掉 React](#p0-3-pin-窗口去掉-react)
  - [P0-4 toolbar 窗口去掉 React](#p0-4-toolbar-窗口去掉-react)
  - [P0-5 关闭非必要窗口的 StrictMode](#p0-5-关闭非必要窗口的-strictmode)
  - [P0-6 添加 V8 堆限制与 backgroundThrottling](#p0-6-添加-v8-堆限制与-backgroundthrottling)
- [四、P1 行动项（轻量重构，1-2 天）](#四p1-行动项轻量重构1-2-天)
  - [P1-1 用 marked 替换 react-markdown](#p1-1-用-marked-替换-react-markdown)
  - [P1-2 移除 MCP SDK，直接 HTTP 调用 Exa](#p1-2-移除-mcp-sdk直接-http-调用-exa)
  - [P1-3 合并 chat 窗口与 action 窗口](#p1-3-合并-chat-窗口与-action-窗口)
  - [P1-4 screenshot preview 窗口复用 action 窗口](#p1-4-screenshot-preview-窗口复用-action-窗口)
- [五、P2 行动项（中等重构，3-5 天）](#五p2-行动项中等重构3-5-天)
  - [P2-1 截图 overlay 改用原生 Canvas](#p2-1-截图-overlay-改用原生-canvas)
  - [P2-2 设置页组件懒加载](#p2-2-设置页组件懒加载)
  - [P2-3 窗口空闲自动销毁](#p2-3-窗口空闲自动销毁)
- [六、P3 行动项（架构级迁移）](#六p3-行动项架构级迁移)
  - [P3-1 迁移到 Tauri](#p3-1-迁移到-tauri)
- [七、预估收益汇总](#七预估收益汇总)
- [八、执行检查清单](#八执行检查清单)

---

## 一、资源消耗诊断

### 1.1 当前窗口清单与进程模型

| # | 窗口 | 入口文件 | 创建位置 | 是否常驻 | React | Markdown |
|---|------|---------|---------|---------|-------|----------|
| 1 | 设置窗口 | `renderer/settings/entry.tsx` | `index.ts:97` `createSettingsWindow()` | 否（按需打开） | ✅ | ✗ |
| 2 | AI 对话窗口 | `renderer/chat/entry.tsx` | `index.ts:133` `openChatWindow()` | 否（按需打开） | ✅ | ✅ |
| 3 | 悬浮工具栏 | `renderer/toolbar/entry.tsx` | `SelectionService.ts:226` `createToolbarWindow()` | **是**（start 时预创建） | ✅ | ✗ |
| 4 | 动作结果窗 | `renderer/action/entry.tsx` | `SelectionService.ts:263` `createActionWindow()` | 否（按需打开） | ✅ | ✅ |
| 5 | 截图覆盖层 | `renderer/screenshot/overlay.tsx` | `ScreenshotService.ts:175` `openOverlay()` | 否（截图时短暂存在） | ✅ | ✗ |
| 6 | 截图预览窗 | `renderer/screenshot/preview.tsx` | `ScreenshotService.ts:289` `openPreview()` | 否（按需打开） | ✅ | ✅ |
| 7 | 钉图窗口 | `renderer/screenshot/pin.tsx` | `ScreenshotService.ts:383` `pinImage()` | 否（用户手动关闭） | ✅ | ✗ |

### 1.2 主要消耗源

| 消耗源 | 具体位置 | 影响范围 |
|--------|---------|---------|
| **7 个窗口全部 `sandbox: false`** | 见下方 P0-1 详情 | 每个渲染进程多保留 ~20-40MB Node.js 运行时 |
| **toolbar 窗口在 `start()` 时预创建** | `SelectionService.ts:68` | 即使无划词事件，工具栏窗口及其渲染进程常驻 |
| **pin 窗口用 React 渲染一个 `<img>`** | `screenshot/pin.tsx` 全文 145 行 | 加载完整 React 运行时 (~130KB) 只为渲染一张图 |
| **toolbar 窗口用 React 渲染几个按钮** | `toolbar/entry.tsx` 全文 94 行 | 同上，杀鸡用牛刀 |
| **react-markdown + remark-gfm 重复加载** | `Markdown.tsx:2-3` 和 `preview.tsx:4-5` | 两个窗口各加载一份 ~200KB 的 Markdown 渲染栈 |
| **`@modelcontextprotocol/sdk` 全量引入** | `WebSearch.ts:2-3` | 主进程加载完整 MCP SDK (~500KB+)，只用来调一个工具 |
| **7 个窗口全部 `transparent: true`** | `index.ts:143`、`SelectionService.ts:234,274`、`ScreenshotService.ts:184,303,408` | GPU 合成开销 |
| **所有窗口启用 StrictMode** | 7 个 entry.tsx 文件末尾 | 生产构建中仍有额外 reconciler 开销 |

---

## 二、行动项总览

| 优先级 | 编号 | 行动项 | 预估工时 | 预估内存节省 | 风险 |
|--------|------|--------|---------|-------------|------|
| P0 | P0-1 | 开启 sandbox 模式 | 30 分钟 | 140-280MB | 低 |
| P0 | P0-2 | ✅ 删除 toolbar 窗口预创建 | 15 分钟 | 30-50MB | 极低 |
| P0 | P0-3 | ✅ pin 窗口去掉 React | 2 小时 | 30-50MB | 低 |
| P0 | P0-4 | ✅ toolbar 窗口去掉 React | 3 小时 | 30-50MB | 中 |
| P0 | P0-5 | ✅ 关闭非必要窗口的 StrictMode | 10 分钟 | 间接 | 极低 |
| P0 | P0-6 | ✅ V8 堆限制 + backgroundThrottling | 30 分钟 | 间接控制 | 低 |
| P1 | P1-1 | ✅ marked 替换 react-markdown | 2 小时 | 20-40MB | 低 |
| P1 | P1-2 | ✅ 移除 MCP SDK，直接 HTTP | 3 小时 | 30-50MB | 中 |
| P1 | P1-3 | 合并 chat 与 action 窗口 | 6 小时 | 40-80MB | 中 |
| P1 | P1-4 | preview 复用 action 窗口 | 4 小时 | 30-50MB | 中 |
| P2 | P2-1 | 截图 overlay 改原生 Canvas | 2 天 | 30-50MB | 高 |
| P2 | P2-2 | 设置页组件懒加载 | 1 天 | 间接 | 低 |
| P2 | P2-3 | ✅ 窗口空闲自动销毁 | 1 天 | 30-60MB | 中 |
| P3 | P3-1 | 迁移到 Tauri | 2-4 周 | 200-300MB+ | 极高 |

---

## 三、P0 行动项（零成本调参，立即执行）

### P0-1 开启 sandbox 模式 ✅ 已完成

**问题**：所有 7 个窗口的 `webPreferences` 都设了 `sandbox: false`，导致每个渲染进程保留完整 Node.js 运行时。实际上 preload 脚本已通过 `contextBridge` 做了安全桥接，渲染进程完全不需要 Node.js 能力。

**涉及文件与精确位置**：

| 文件 | 行号 | 上下文 |
|------|------|--------|
| `src/main/index.ts` | 109 | `createSettingsWindow()` 的 webPreferences |
| `src/main/index.ts` | 151 | `openChatWindow()` 的 webPreferences |
| `src/main/SelectionService.ts` | 250 | `createToolbarWindow()` 的 webPreferences |
| `src/main/SelectionService.ts` | 284 | `createActionWindow()` 的 webPreferences |
| `src/main/ScreenshotService.ts` | 201 | `openOverlay()` 的 webPreferences |
| `src/main/ScreenshotService.ts` | 311 | `openPreview()` 的 webPreferences |
| `src/main/ScreenshotService.ts` | 423 | `pinImage()` 的 webPreferences |

**改法**：将上述 7 处的 `sandbox: false` 改为 `sandbox: true`。

**验证要点**：
- preload 脚本 (`src/preload/index.ts`) 中使用的 `ipcRenderer` API 在 sandbox 模式下完全可用，无需修改
- `contextBridge.exposeInMainWorld` 在 sandbox 模式下是标准用法
- 确认 `src/preload/api.d.ts` 的全局类型声明不受影响

**效果**：每个渲染进程减少约 20-40MB，7 个窗口合计节省 140-280MB。

---

### P0-2 删除 toolbar 窗口预创建

**问题**：`SelectionService.start()` 在第 68 行调用了 `this.createToolbarWindow()`，在没有任何划词事件发生时就预创建了工具栏窗口。这个透明窗口及其渲染进程此后一直常驻内存。

**涉及文件与精确位置**：

| 文件 | 行号 | 代码 |
|------|------|------|
| `src/main/SelectionService.ts` | 68 | `this.createToolbarWindow()` |

而 `handleSelection` 方法（第 315-331 行）中第 324 行已经有防御性创建：

```typescript
// SelectionService.ts:324
this.createToolbarWindow()
```

且 `createToolbarWindow` 方法（第 226-227 行）已有守卫：

```typescript
// SelectionService.ts:226-227
private createToolbarWindow(): void {
  if (this.toolbarWindow && !this.toolbarWindow.isDestroyed()) return
```

**改法**：删除 `SelectionService.ts:68` 的 `this.createToolbarWindow()` 调用。`handleSelection` 中的第 324 行会在首次划词时按需创建。

**验证要点**：
- 确认首次划词时工具栏能正常弹出（`handleSelection` → `createToolbarWindow` → `showToolbar` 路径）
- 确认 `hideToolbar()` 方法（第 116-121 行）只是 `hide()` 而非 `close()`，窗口被隐藏后仍然复用

**效果**：空闲状态减少一个常驻透明窗口及其渲染进程，节省 30-50MB。

---

### P0-3 pin 窗口去掉 React ✅ 已完成

**问题**：`screenshot/pin.tsx`（145 行）用完整的 React 运行时渲染了一个 `<img>` 标签，并管理滚轮缩放和拖拽。这些逻辑用原生 JS 实现代码量几乎不变，但省掉了整个 React 运行时加载。

**涉及文件**：

| 文件 | 说明 |
|------|------|
| `src/renderer/screenshot/pin.tsx` | 全文 145 行，需替换为纯 HTML+JS |
| `src/renderer/screenshotPin.html` | 入口 HTML，需添加内联 script |

**当前 pin.tsx 的功能清单**（用于确保改造不丢功能）：

1. 接收 `onPinInit` 事件中的 `imageDataUrl`，设置 `<img>` 的 src（第 8-11 行）
2. Esc 键关闭窗口（第 13-19 行）
3. 滚轮缩放，使用 `requestAnimationFrame` 批量合并 deltaY，通过 IPC 调用 `pinZoom`（第 22-59 行）
4. 鼠标拖拽移动窗口，同样用 `requestAnimationFrame` 批量合并 delta，通过 IPC 调用 `pinMove`（第 61-123 行）
5. 右键菜单通过 IPC 调用 `pinMenu`（第 131-134 行）

**改法**：

将 `screenshotPin.html` 改为包含内联 script 的纯 HTML 页面：

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <link rel="stylesheet" href="../styles.css" />
</head>
<body class="pin-page">
  <div class="screenshot-pin" id="pin-container">
    <img class="screenshot-pin__img" id="pin-img" draggable="false" alt="" />
  </div>
  <script>
    // 1. 接收图片
    const img = document.getElementById('pin-img');
    const container = document.getElementById('pin-container');
    window.assistantLite.screenshot.onPinInit((payload) => {
      img.src = payload.imageDataUrl;
    });

    // 2. Esc 关闭
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') window.assistantLite.windowControls.close();
    });

    // 3. 滚轮缩放 (rAF 批量合并)
    let wheelAccum = 0;
    let wheelRaf = null;
    const flushWheel = () => {
      wheelRaf = null;
      const dy = wheelAccum;
      wheelAccum = 0;
      if (dy !== 0) window.assistantLite.screenshot.pinZoom(dy);
    };
    container.addEventListener('wheel', (e) => {
      e.preventDefault();
      wheelAccum += e.deltaY;
      if (wheelRaf === null) wheelRaf = requestAnimationFrame(flushWheel);
    }, { passive: false });

    // 4. 拖拽移动 (rAF 批量合并)
    let dragging = false;
    let lastX = 0, lastY = 0;
    let pendingX = 0, pendingY = 0;
    let dragRaf = null;
    const flushDrag = () => {
      dragRaf = null;
      if (pendingX !== 0 || pendingY !== 0) {
        window.assistantLite.screenshot.pinMove(pendingX, pendingY);
        pendingX = 0;
        pendingY = 0;
      }
    };
    container.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      lastX = e.screenX; lastY = e.screenY;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.screenX - lastX;
      const dy = e.screenY - lastY;
      if (dx === 0 && dy === 0) return;
      lastX = e.screenX; lastY = e.screenY;
      pendingX += dx; pendingY += dy;
      if (dragRaf === null) dragRaf = requestAnimationFrame(flushDrag);
    });
    window.addEventListener('mouseup', () => {
      dragging = false;
      if (dragRaf !== null) { cancelAnimationFrame(dragRaf); dragRaf = null; }
      flushDrag();
    });

    // 5. 右键菜单
    container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.assistantLite.screenshot.pinMenu();
    });
  </script>
</body>
</html>
```

然后删除 `src/renderer/screenshot/pin.tsx` 文件。

同时从 `electron.vite.config.ts` 的 `rollupOptions.input` 中移除 `screenshotPin` 入口（第 39 行）。

**需要同步修改的文件**：

| 文件 | 修改内容 |
|------|---------|
| `src/renderer/screenshotPin.html` | 替换为包含内联 script 的纯 HTML |
| `src/renderer/screenshot/pin.tsx` | 删除此文件 |
| `electron.vite.config.ts:39` | 删除 `screenshotPin: resolve(__dirname, 'src/renderer/screenshotPin.html')` |

**验证要点**：
- 确认钉图窗口的滚轮缩放、拖拽移动、右键菜单、Esc 关闭全部正常
- 确认 `styles.css` 中 `.screenshot-pin` 相关样式仍然生效（通过 `<link>` 引入）
- 确认 preload 脚本在该窗口中正常注入 `window.assistantLite`

**效果**：pin 窗口不再加载 React 运行时，节省 30-50MB。

---

### P0-4 toolbar 窗口去掉 React ✅ 已完成

**问题**：`toolbar/entry.tsx`（94 行）用 React 渲染了一组按钮。按钮列表来自 `settings.actions`，变化频率极低，用 React 的虚拟 DOM diffing 完全是浪费。

**涉及文件**：

| 文件 | 说明 |
|------|------|
| `src/renderer/toolbar/entry.tsx` | 全文 94 行，需替换为纯 HTML+JS |
| `src/renderer/selectionToolbar.html` | 入口 HTML |
| `electron.vite.config.ts:35` | rollupOptions.input 中的 `selectionToolbar` 入口 |

**当前 toolbar/entry.tsx 的功能清单**：

1. 加载设置，监听设置变更（`useSettings`、`useThemeMode`，第 13-16 行）
2. 监听选中文本事件（第 27 行 `onSelected`）
3. 测量工具栏宽度并通知主进程（第 28-38 行 `determineToolbarSize`）
4. 根据设置渲染动作按钮（第 40-84 行），支持紧凑模式、应用图标显示
5. 按钮点击处理：copy → 写剪贴板；search → 打开 URL；speak → 朗读；prompt → `processAction`（第 42-70 行）

**改法**：

将 `selectionToolbar.html` 改为包含内联 script 的纯 HTML：

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <link rel="stylesheet" href="../styles.css" />
</head>
<body class="toolbar-page">
  <div class="toolbar-root" id="toolbar-root"></div>
  <script>
    const root = document.getElementById('toolbar-root');
    let currentSelection = null;

    // 主题切换
    function applyTheme(theme) {
      const resolved = theme === 'light' || theme === 'dark' ? theme
        : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    }

    // 外观设置
    function applyAppearance(settings) {
      const family = settings.fontFamily?.trim();
      if (family) document.documentElement.style.setProperty('--app-font', `${family}, ui-sans-serif, system-ui, sans-serif`);
      else document.documentElement.style.removeProperty('--app-font');
      document.documentElement.style.setProperty('--app-font-size', `${settings.fontSize}px`);
    }

    // 渲染按钮
    function render(settings) {
      applyTheme(settings.theme);
      applyAppearance(settings);
      const actions = settings.actions.filter(a => a.enabled);
      let html = '';
      if (settings.showToolbarAppIcon) {
        // APP_ICON_SVG 的 SVG 字符串需要内联或从 preload 暴露
        html += '<div class="toolbar-logo">' + window.__APP_ICON_SVG__ + '</div>';
      }
      for (const action of actions) {
        const label = getActionLabel(action, settings.language);
        html += `<button class="toolbar-button" data-action-id="${action.id}" title="${label}">`
          + getIconSvg(action.icon)
          + (settings.compactToolbar ? '' : `<span>${label}</span>`)
          + '</button>';
      }
      root.innerHTML = html;
      // 测量宽度
      requestAnimationFrame(() => {
        const width = Math.max(root.scrollWidth, root.getBoundingClientRect().width);
        if (width > 0) window.assistantLite.selection.determineToolbarSize(width);
      });
    }

    // 按钮点击
    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('.toolbar-button');
      if (!btn || !currentSelection) return;
      const actionId = btn.dataset.actionId;
      const settings = await window.assistantLite.settings.get();
      const action = settings.actions.find(a => a.id === actionId);
      if (!action) return;
      const text = currentSelection.text;
      if (!text) return;
      if (action.type === 'copy') {
        await window.assistantLite.selection.writeClipboard(text);
      } else if (action.type === 'search') {
        // buildSearchUrl 逻辑需要内联或从 preload 暴露
        const url = buildSearchUrl(action, text);
        if (url) await window.assistantLite.app.openExternal(url);
        await window.assistantLite.selection.hideToolbar();
      } else if (action.type === 'speak') {
        await window.assistantLite.speech.speak(text);
        await window.assistantLite.selection.hideToolbar();
      } else {
        await window.assistantLite.selection.processAction({ action, selectedText: text, isFullscreen: currentSelection.isFullscreen });
        await window.assistantLite.selection.hideToolbar();
      }
    });

    window.assistantLite.settings.get().then(render);
    window.assistantLite.settings.onChanged(render);
    window.assistantLite.selection.onSelected((payload) => { currentSelection = payload; });
    window.assistantLite.selection.onVisibility(() => {});
  </script>
</body>
</html>
```

**需要从 preload 暴露的辅助函数**：

当前 `buildSearchUrl` 和 `getActionLabel` 在 `shared/actions.ts` 和 `renderer/i18n.ts` 中，toolbar 窗口改为纯 HTML 后无法直接 import。有两个方案：

- **方案 A**（推荐）：将这些纯函数的简化版本内联到 HTML 的 `<script>` 中
- **方案 B**：在 preload 中暴露这些函数

图标 SVG 也需要处理——当前 `icons.tsx` 是 React 组件。方案 A 下可以在 script 中维护一个 icon name → SVG string 的映射表（仅包含动作用到的几个图标）。

**需要同步修改的文件**：

| 文件 | 修改内容 |
|------|---------|
| `src/renderer/selectionToolbar.html` | 替换为包含内联 script 的纯 HTML |
| `src/renderer/toolbar/entry.tsx` | 删除此文件 |
| `electron.vite.config.ts:35` | 删除 `selectionToolbar` 入口 |
| `src/preload/index.ts` | 可选：暴露 `buildSearchUrl` 和 `getActionLabel` 辅助函数 |

**验证要点**：
- 确认工具栏按钮点击后各动作类型（copy/search/speak/prompt）行为正确
- 确认紧凑模式、应用图标显示开关生效
- 确认工具栏宽度测量和位置定位正确（`determineToolbarSize` 调用）
- 确认主题切换（亮/暗/跟随系统）在工具栏中生效

**效果**：toolbar 窗口不再加载 React 运行时，节省 30-50MB。

---

### P0-5 关闭非必要窗口的 StrictMode ✅ 已完成

**问题**：所有 7 个窗口都用了 `<React.StrictMode>` 包裹，生产构建中仍有额外的 reconciler 开销。对于 pin（已去 React）、toolbar（已去 React）不再适用。对于 settings、overlay 这些交互复杂的窗口可以保留。但对于 chat、action、preview 这些流式输出窗口，StrictMode 的双调用检查在生产环境无实际价值。

**涉及文件与精确位置**：

| 文件 | 行号 | 是否建议移除 |
|------|------|-------------|
| `src/renderer/toolbar/entry.tsx:90` | 已在 P0-4 中删除 | — |
| `src/renderer/screenshot/pin.tsx:141` | 已在 P0-3 中删除 | — |
| `src/renderer/chat/entry.tsx:295` | ✅ 移除 | 是 |
| `src/renderer/action/entry.tsx:499` | ✅ 移除 | 是 |
| `src/renderer/screenshot/preview.tsx:314` | ✅ 移除 | 是 |
| `src/renderer/settings/entry.tsx:996` | 保留 | 否（交互复杂，保留开发期检查） |
| `src/renderer/screenshot/overlay.tsx:690` | 保留 | 否（同上） |

**改法**：将指定的 `<React.StrictMode>` 包裹去掉，直接渲染组件。

示例（`chat/entry.tsx` 第 294-298 行）：

```typescript
// 改前
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ChatApp />
  </React.StrictMode>
)

// 改后
createRoot(document.getElementById('root')!).render(<ChatApp />)
```

**注意**：`chat/entry.tsx` 第 37 行的注释提到了 StrictMode 双触发问题：

```typescript
// chat/entry.tsx:37
// double-fire under React.StrictMode and could send the request twice).
```

去掉 StrictMode 后，`chatRef` 的防御性 ref 仍然保留（不影响正确性，只是不再双触发）。

**效果**：间接减少渲染开销，尤其是流式输出时的高频 state 更新。

---

### P0-6 添加 V8 堆限制与 backgroundThrottling ✅ 已完成

**问题**：主进程没有 V8 堆限制，内存可能无限膨胀。不可见窗口的 JS 定时器没有被显式节流。

**涉及文件与精确位置**：

| 文件 | 行号 | 修改 |
|------|------|------|
| `src/main/index.ts` | 22（`app.commandLine.appendSwitch` 之后） | 添加 V8 堆限制 |
| `src/main/SelectionService.ts` | 246-251（toolbar webPreferences） | 添加 `backgroundThrottling: true` |
| `src/main/SelectionService.ts` | 278-285（action webPreferences） | 添加 `backgroundThrottling: true` |
| `src/main/ScreenshotService.ts` | 197-202（overlay webPreferences） | 添加 `backgroundThrottling: true` |
| `src/main/ScreenshotService.ts` | 307-312（preview webPreferences） | 添加 `backgroundThrottling: true` |
| `src/main/ScreenshotService.ts` | 419-424（pin webPreferences） | 添加 `backgroundThrottling: true` |

**改法 1 — V8 堆限制**：

在 `src/main/index.ts` 第 22 行之后添加：

```typescript
// src/main/index.ts:22 之后
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256')
```

**改法 2 — backgroundThrottling**：

在每个窗口的 `webPreferences` 对象中添加 `backgroundThrottling: true`。例如：

```typescript
// SelectionService.ts:246-251 改前
webPreferences: {
  preload: this.preloadPath,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true  // P0-1 已改
}

// 改后
webPreferences: {
  preload: this.preloadPath,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  backgroundThrottling: true
}
```

**验证要点**：
- 确认 V8 堆限制不影响 AI 流式响应（大段文本的 chunk 处理不应 OOM）
- 确认后台窗口的定时器节流不影响功能（toolbar 的 hide listener 是主进程 native 事件，不受渲染进程节流影响）

**效果**：主进程内存上限控制在 256MB；后台窗口 CPU 占用降低。

---

## 四、P1 行动项（轻量重构，1-2 天）

### P1-1 用 marked 替换 react-markdown ✅ 已完成

**问题**：`react-markdown` + `remark-gfm` 合计约 200KB+ minified，且作为 React 组件树的一部分，每次 markdown 内容更新都触发 reconciler diffing。对于流式 AI 输出（每个 chunk 都触发一次 state 更新），这个开销不可忽视。

**涉及文件与精确位置**：

| 文件 | 行号 | 当前代码 |
|------|------|---------|
| `src/renderer/Markdown.tsx` | 2-3 | `import Markdown from 'react-markdown'` / `import remarkGfm from 'remark-gfm'` |
| `src/renderer/Markdown.tsx` | 32-38 | `MarkdownView` 组件定义 |
| `src/renderer/screenshot/preview.tsx` | 4-5 | 直接 import react-markdown（未走 Markdown.tsx 封装） |
| `src/renderer/screenshot/preview.tsx` | 243 | `<Markdown remarkPlugins={[remarkGfm]}>{turn.text}</Markdown>` |
| `package.json` | 46-47 | `"react-markdown": "^10.1.0"` / `"remark-gfm": "^4.0.1"` |

**被引用位置**：

| 引用方 | 行号 | 引用方式 |
|--------|------|---------|
| `renderer/action/entry.tsx` | 6 | `import { MarkdownView } from '../Markdown'` |
| `renderer/chat/entry.tsx` | 5 | `import { MarkdownView } from '../Markdown'` |
| `renderer/screenshot/preview.tsx` | 4-5 | 直接 import（未走封装） |

**改法**：

1. 安装 `marked`：`pnpm add marked`
2. 重写 `src/renderer/Markdown.tsx`：

```typescript
// src/renderer/Markdown.tsx — 改造后
import { marked } from 'marked'

// 代码块复制按钮需要后处理，用 marked 的 renderer 扩展
marked.setOptions({ gfm: true, breaks: true })

export function MarkdownView({ children }: { children: string }) {
  const html = marked.parse(children) as string
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
}
```

3. 修改 `preview.tsx`：去掉第 4-5 行的 `import Markdown from 'react-markdown'` / `import remarkGfm from 'remark-gfm'`，改为 `import { MarkdownView } from '../Markdown'`，并将第 243 行的 `<Markdown remarkPlugins={[remarkGfm]}>{turn.text}</Markdown>` 改为 `<MarkdownView>{turn.text}</MarkdownView>`。

4. 代码块复制按钮：当前 `Markdown.tsx` 的 `CodeBlock` 组件（第 8-28 行）用 React 管理复制状态。改造后可以在 `MarkdownView` 渲染后用 `useEffect` 查询所有 `<pre>` 元素并注入复制按钮。

5. 从 `package.json` 移除 `react-markdown` 和 `remark-gfm`。

**需要同步修改的文件**：

| 文件 | 修改内容 |
|------|---------|
| `package.json` | 移除 `react-markdown`、`remark-gfm`，添加 `marked` |
| `src/renderer/Markdown.tsx` | 全文重写 |
| `src/renderer/screenshot/preview.tsx:4-5,243` | 改用 `MarkdownView` |

**验证要点**：
- 确认 GFM 表格、删除线、任务列表等语法正确渲染
- 确认代码块的复制按钮仍然工作
- 确认流式输出时 markdown 实时渲染不闪烁
- 确认 `markdown-body` 的 CSS 样式对生成的 HTML 生效

**效果**：bundle 体积减少 ~170KB，渲染性能提升，内存占用降低 20-40MB。

---

### P1-2 移除 MCP SDK，直接 HTTP ✅ 已完成 调用 Exa

**问题**：`@modelcontextprotocol/sdk` 是完整的 MCP 客户端框架（~500KB+），但项目只用它做一件事：连接 Exa 的公共 MCP 端点并调用 `web_search_exa` 工具。

**涉及文件与精确位置**：

| 文件 | 行号 | 当前代码 |
|------|------|---------|
| `src/main/ai/WebSearch.ts` | 2-3 | `import { Client } from '@modelcontextprotocol/sdk/client/index.js'` / `import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'` |
| `src/main/ai/WebSearch.ts` | 65-104 | `searchExa()` 函数，使用 MCP Client + Transport |
| `package.json` | 42 | `"@modelcontextprotocol/sdk": "^1.29.0"` |

**`searchExa()` 的当前逻辑**（第 65-104 行）：

1. 创建 `StreamableHTTPClientTransport`，指向 `https://mcp.exa.ai/mcp`
2. 创建 MCP `Client`，连接 transport
3. 调用 `client.callTool({ name: 'web_search_exa', arguments: { query, numResults } })`
4. 从 `result.structuredContent` 或 `result.content` 中提取文本
5. 调用 `parseExaToolText()` 解析为 `ExaResult[]`
6. 关闭 client

**改法**：

MCP 的 StreamableHTTP 传输本质是 JSON-RPC over HTTP。可以直接用 `net.fetch` 发送等价请求：

```typescript
// src/main/ai/WebSearch.ts — searchExa 改造后
import { net } from 'electron'

const EXA_MCP_URL = 'https://mcp.exa.ai/mcp'

export async function searchExa(query: string, signal: AbortSignal, numResults = 10): Promise<ExaResult[]> {
  // Exa MCP 端点同时接受 JSON-RPC 和 direct HTTP 调用。
  // 用 JSON-RPC tools/call 格式发送请求。
  const response = await net.fetch(EXA_MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: {
        name: 'web_search_exa',
        arguments: { query, numResults }
      }
    })
  })

  if (!response.ok) throw new Error(`Exa search failed (${response.status})`)

  const data = await response.json() as {
    result?: {
      content?: Array<{ type?: string; text?: string }>
      isError?: boolean
    }
  }

  if (data.result?.isError) throw new Error('Exa MCP returned an error result')

  // 提取文本块
  const textBlocks = (data.result?.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')

  return parseExaToolText(textBlocks)
}
```

`parseExaToolText()`（第 29-63 行）和 `formatSearchContext()`（第 106-134 行）保持不变。

**需要同步修改的文件**：

| 文件 | 修改内容 |
|------|---------|
| `src/main/ai/WebSearch.ts:1-3` | 删除 MCP SDK import，添加 `import { net } from 'electron'` |
| `src/main/ai/WebSearch.ts:65-104` | 重写 `searchExa()` 函数 |
| `package.json:42` | 移除 `"@modelcontextprotocol/sdk"` 依赖 |
| `src/main/ai/WebSearch.test.ts` | 更新测试 mock（如有） |

**验证要点**：
- 确认联网搜索功能正常：AI 判断需要搜索 → Exa 搜索 → 结果注入 system prompt → 流式回答带来源链接
- 确认 `decideSearch()` 函数（第 264-277 行）不受影响（它不使用 MCP SDK）
- 确认 Exa MCP 端点的响应格式与 JSON-RPC 调用兼容
- 确认 `AbortSignal` 能正确中断请求

**风险**：Exa MCP 端点可能需要 MCP 的初始化握手（`initialize` → `tools/list` → `tools/call`）。如果直接发 `tools/call` 不行，需要先发 `initialize`。建议先用 `curl` 验证端点行为。

**效果**：主进程 bundle 减少 ~500KB+，内存减少 30-50MB。

---

### P1-3 合并 chat 窗口与 action 窗口 ✅ 已完成

**问题**：`chat/entry.tsx`（299 行）和 `action/entry.tsx`（502 行）是两个独立的窗口入口，但它们的 UI 结构和逻辑高度相似。

**代码对比**：

| 功能 | chat/entry.tsx | action/entry.tsx |
|------|---------------|-----------------|
| 标题栏 | 第 203-222 行 | 第 35-67 行（Titlebar 组件） |
| 消息列表 | 第 224-259 行 | 第 170-210 行（ChatTurns 组件） |
| 流式 chunk 处理 | 第 78-103 行 | 第 81-106 行（useActionStream hook） |
| 滚动跟随 | 第 111-127 行 | 第 151-168 行（useAutoScroll hook） |
| 输入框 | 第 261-289 行 | 第 270-295 行（SelectionResult）/ 第 386-409 行（InputResult） |
| 发送消息 | 第 137-156 行 | 第 111-133 行（useActionStream send） |
| 中断请求 | 第 165-178 行 | 第 135-144 行（useActionStream stop） |
| 新对话 | 第 180-190 行 | 第 301-302 行（regenerate） |
| 置顶切换 | 第 192-196 行 | 第 480-484 行 |

**涉及文件**：

| 文件 | 说明 |
|------|------|
| `src/renderer/chat/entry.tsx` | 全文 299 行，合并后删除 |
| `src/renderer/chat.html` | 合并后删除 |
| `src/renderer/action/entry.tsx` | 全文 502 行，扩展为统一窗口 |
| `src/main/index.ts:126-163` | `openChatWindow()` 改为复用 action 窗口 |
| `src/main/index.ts:133-153` | 删除 chatWindow 相关的 BrowserWindow 创建逻辑 |
| `electron.vite.config.ts:40` | 删除 `chat` 入口 |

**改法**：

在 `action/entry.tsx` 中新增一个 `ChatMode` 组件，作为第三种模式（除了 `SelectionResult` 和 `InputResult`）：

```typescript
// action/entry.tsx 新增 ChatMode 组件
function ChatMode({ settings, t, pinned, togglePin }: Omit<ResultProps, 'payload'>) {
  // 直接复用 chat/entry.tsx 的 ChatApp 逻辑，
  // 但去掉 useSettings（已有 props），去掉独立的 windowControls
  // ...
}
```

在 `ActionApp` 的渲染逻辑中（第 491-495 行），新增 chat 模式判断：

```typescript
// action/entry.tsx:491 改造后
if (!payload) {
  // 无 payload = chat 模式
  return <ChatMode settings={settings} t={t} pinned={pinned} togglePin={togglePin} />
}
return payload.mode === 'input' ? (
  <InputResult key={`input:${payload.action.id}`} {...shared} />
) : (
  <SelectionResult key={`selection:${payload.action.id}`} {...shared} />
)
```

主进程中，`openChatWindow()` 改为创建一个 action 窗口但不传 payload：

```typescript
// index.ts openChatWindow() 改造后
function openChatWindow(): void {
  // 复用 SelectionService 的 action 窗口创建逻辑
  // 或直接创建一个加载 selectionAction.html 的窗口，不传 initial payload
  selectionService.openChatWindow()
}
```

在 `SelectionService` 中新增 `openChatWindow()` 方法，复用 `createActionWindow()` 但不设置 `pendingInitialPayload`。

**需要同步修改的文件**：

| 文件 | 修改内容 |
|------|---------|
| `src/renderer/action/entry.tsx` | 新增 ChatMode 组件，修改 ActionApp 渲染逻辑 |
| `src/renderer/chat/entry.tsx` | 删除 |
| `src/renderer/chat.html` | 删除 |
| `src/main/index.ts:24-25` | 删除 `chatWindow` 变量 |
| `src/main/index.ts:126-163` | 重写 `openChatWindow()` |
| `src/main/SelectionService.ts` | 新增 `openChatWindow()` 方法 |
| `electron.vite.config.ts:40` | 删除 `chat` 入口 |

**验证要点**：
- 确认快捷键 `CommandOrControl+Shift+C` 能打开 chat 窗口
- 确认 chat 窗口的多轮对话、流式输出、中断、新对话功能正常
- 确认 action 窗口的 selection 模式和 input 模式不受影响
- 确认窗口关闭时 abort in-flight 请求的逻辑正常

**效果**：减少一个渲染进程入口，减少一份 React + marked 加载，节省 40-80MB。

---

### P1-4 screenshot preview 窗口复用 action 窗口

**问题**：`screenshot/preview.tsx`（318 行）是一个独立的窗口，用于 AI 识图对话。它的结构与 action 窗口的 `SelectionResult` 模式几乎一致——标题栏 + 消息列表 + 追问输入框 + 流式输出。

**涉及文件**：

| 文件 | 说明 |
|------|------|
| `src/renderer/screenshot/preview.tsx` | 全文 318 行 |
| `src/renderer/screenshotPreview.html` | 独立入口 |
| `src/main/ScreenshotService.ts:289-324` | `openPreview()` 方法，创建独立窗口 |
| `src/main/ScreenshotService.ts:486-494` | 钉图右键菜单中的 "AI 识图" 调用 `openPreview()` |
| `src/main/ScreenshotService.ts:284-286` | 截图确认时 action='explain' 调用 `openPreview()` |
| `electron.vite.config.ts:38` | `screenshotPreview` 入口 |

**改法**：

将 AI 识图改为通过 action 窗口实现。在 `ActionPayload` 类型中新增图片字段：

```typescript
// shared/types.ts 新增
export interface ActionPayload {
  action: ActionItem
  selectedText: string
  isFullscreen?: boolean
  mode?: 'selection' | 'input'
  images?: string[]  // 新增：附带图片
}
```

在 `action/entry.tsx` 的 `SelectionResult` 中，如果 `payload.images` 存在，初始消息携带图片：

```typescript
// action/entry.tsx SelectionResult 的 runInitialAction 改造
const runInitialAction = React.useCallback(() => {
  const messages: AiMessageInput[] = [
    { role: 'user', text: prompt, images: payload.images }
  ]
  // ...
}, [payload, t, send, stick])
```

`ScreenshotService` 中将 `openPreview()` 改为调用 `SelectionService.processAction()`，传入一个特殊的 "explain" 动作和图片：

```typescript
// ScreenshotService.ts 改造后
private openPreview(data: { imageDataUrl: string; width: number; height: number }): void {
  // 不再创建独立窗口，而是通过 SelectionService 打开 action 窗口
  this.selectionService.processAction({
    action: { id: 'screenshot-explain', name: 'AI Explain', enabled: true, icon: 'sparkles', type: 'prompt',
              promptTemplate: 'Explain this image...' },
    selectedText: '',
    images: [data.imageDataUrl]
  })
}
```

这需要 `ScreenshotService` 持有 `SelectionService` 的引用，或通过 IPC 中转。

**需要同步修改的文件**：

| 文件 | 修改内容 |
|------|---------|
| `src/shared/types.ts:79-85` | `ActionPayload` 新增 `images` 字段 |
| `src/renderer/action/entry.tsx` | `SelectionResult` 支持图片消息 |
| `src/main/ScreenshotService.ts:289-324` | `openPreview()` 改为委托 `SelectionService` |
| `src/main/ScreenshotService.ts` | 删除 `previewWindow` 相关逻辑 |
| `src/renderer/screenshot/preview.tsx` | 删除 |
| `src/renderer/screenshotPreview.html` | 删除 |
| `electron.vite.config.ts:38` | 删除 `screenshotPreview` 入口 |

**验证要点**：
- 确认截图后选择 "AI 识图" 能在 action 窗口中正常发起识图对话
- 确认钉图右键 "AI 识图" 功能正常
- 确认识图对话的追问功能正常
- 确认图片显示/隐藏切换功能（preview.tsx 第 205-209 行的 `showImage`）有替代方案

**效果**：减少一个渲染进程入口，节省 30-50MB。

---

## 五、P2 行动项（中等重构，3-5 天）

### P2-1 截图 overlay 改用原生 Canvas

**问题**：`screenshot/overlay.tsx`（694 行）用 React 管理了框选矩形、8 个 resize handle、画笔标注、箭头标注、工具栏切换等大量状态。每次鼠标移动都触发 `setState`，导致频繁的 reconciler diffing。

**涉及文件**：

| 文件 | 说明 |
|------|------|
| `src/renderer/screenshot/overlay.tsx` | 全文 694 行 |
| `src/renderer/screenshotOverlay.html` | 入口 HTML |

**改法概述**：

- 框选矩形、resize handle、遮罩用 Canvas 2D 绘制
- 标注（画笔/箭头）直接在 Canvas 上绘制
- 工具栏用纯 DOM 元素
- 状态管理用普通 JS 变量，无需虚拟 DOM

**预估工作量**：2 天

**效果**：截图覆盖层不再加载 React，鼠标移动时的性能显著提升（无 reconciler 开销），节省 30-50MB。

---

### P2-2 设置页组件懒加载

**问题**：`settings/entry.tsx`（1000 行）是代码量最大的渲染器，包含了 API 配置、动作配置、划词配置、窗口配置四个面板的全部组件。

**涉及文件**：

| 文件 | 说明 |
|------|------|
| `src/renderer/settings/entry.tsx` | 全文 1000 行 |

**改法**：

使用 `React.lazy` + `Suspense` 按面板分块加载：

```typescript
const ApiSection = React.lazy(() => import('./sections/ApiSection'))
const ActionsSection = React.lazy(() => import('./sections/ActionsSection'))
const SelectionSection = React.lazy(() => import('./sections/SelectionSection'))
const WindowSection = React.lazy(() => import('./sections/WindowSection'))
```

将 `renderSection()` 函数（第 587-921 行）拆分为 4 个独立模块文件。

**效果**：设置页初始加载只加载当前激活的面板，减少初始 bundle 解析和执行时间。

---

### P2-3 窗口空闲自动销毁

**问题**：toolbar 窗口 `hide()` 后继续常驻，action 窗口关闭后销毁但下次需要重新创建。

**涉及文件**：

| 文件 | 修改位置 |
|------|---------|
| `src/main/SelectionService.ts:116-121` | `hideToolbar()` 方法 |
| `src/main/SelectionService.ts:226-261` | `createToolbarWindow()` / 窗口生命周期 |

**改法**：

在 `hideToolbar()` 中启动一个定时器（如 30 秒后），如果没有新的划词事件，则 `close()` 销毁窗口而非仅 `hide()`：

```typescript
private hideTimer: NodeJS.Timeout | null = null

hideToolbar(): void {
  this.stopHideListeners()
  if (!this.toolbarWindow || this.toolbarWindow.isDestroyed()) return
  this.toolbarWindow.hide()
  this.toolbarWindow.webContents.send(IPC.SelectionVisibility, false)
  // 30 秒后自动销毁
  this.hideTimer = setTimeout(() => {
    if (this.toolbarWindow && !this.toolbarWindow.isDestroyed() && !this.toolbarWindow.isVisible()) {
      this.toolbarWindow.close()
      this.toolbarWindow = null
    }
  }, 30_000)
}

private showToolbar(...): void {
  if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null }
  // ... 原有逻辑
}
```

**效果**：长时间不使用时释放工具栏窗口占用的内存。

---

## 六、P3 行动项（架构级迁移）

### P3-1 迁移到 Tauri

**概述**：将整个应用从 Electron 迁移到 Tauri 2.x，使用系统原生 WebView 替代 Chromium。

**迁移映射表**：

| Electron 概念 | Tauri 替代 |
|--------------|-----------|
| `BrowserWindow` | `WebviewWindow` |
| `ipcMain.handle` / `ipcRenderer.invoke` | `#[tauri::command]` + `invoke()` |
| `electron-store` | `tauri-plugin-store` 或自定义 serde |
| `desktopCapturer` | `tauri-plugin-screenshot` |
| `globalShortcut` | `tauri-plugin-global-shortcut` |
| `Tray` | `tauri-plugin-tray` |
| `selection-hook` (C++ native) | 需用 Rust 重写（macOS Accessibility API / Windows UI Automation） |
| `net.fetch` | `reqwest` crate |
| `systemPreferences` | `tauri-plugin-notification` / 原生 API |
| `clipboard` | `tauri-plugin-clipboard-manager` |

**预估工作量**：2-4 周（主要风险在 `selection-hook` 的 Rust 重写）

**效果**：安装包从 ~80-120MB 降到 ~3-8MB，空闲内存从 ~200-400MB 降到 ~30-80MB。

---

## 七、预估收益汇总

### 按 P0 全部实施

| 行动项 | 预估内存节省 |
|--------|-------------|
| P0-1 开启 sandbox | 140-280MB |
| P0-2 删除 toolbar 预创建 | 30-50MB |
| P0-3 pin 去 React | 30-50MB |
| P0-4 toolbar 去 React | 30-50MB |
| P0-5 关闭 StrictMode | 间接 |
| P0-6 V8 堆限制 + throttling | 间接 |
| **P0 合计** | **230-430MB** |

### 按 P0 + P1 全部实施

| 行动项 | 预估内存节省 |
|--------|-------------|
| P0 合计 | 230-430MB |
| P1-1 marked 替换 | 20-40MB |
| P1-2 移除 MCP SDK | 30-50MB |
| P1-3 合并 chat + action | 40-80MB |
| P1-4 preview 复用 action | 30-50MB |
| **P0+P1 合计** | **350-650MB** |

### 按 P0 + P1 + P2 全部实施

| 行动项 | 预估内存节省 |
|--------|-------------|
| P0+P1 合计 | 350-650MB |
| P2-1 overlay 改 Canvas | 30-50MB |
| P2-2 设置页懒加载 | 间接 |
| P2-3 窗口空闲销毁 | 30-60MB |
| **P0+P1+P2 合计** | **410-760MB** |

### 迁移 Tauri（P3）

| 指标 | Electron (当前) | Tauri (预估) |
|------|----------------|-------------|
| 安装包大小 | ~80-120MB | ~3-8MB |
| 空闲内存 | ~200-400MB | ~30-80MB |
| 启动时间 | ~1-2s | ~0.3-0.5s |

---

## 八、执行检查清单

### P0 检查清单

- [ ] P0-1：7 处 `sandbox: false` 全部改为 `true`，确认所有窗口功能正常
- [x] P0-2：删除 `SelectionService.ts:68` 的预创建调用，确认首次划词正常弹出工具栏
- [ ] P0-3：pin 窗口改为纯 HTML，确认缩放/拖拽/右键菜单/Esc 全部正常
- [ ] P0-4：toolbar 窗口改为纯 HTML，确认各动作类型点击正常
- [ ] P0-5：chat/action/preview 去掉 StrictMode，确认流式输出不双触发
- [ ] P0-6：添加 V8 堆限制和 backgroundThrottling，确认无 OOM
- [ ] 运行 `pnpm test` 全部通过
- [ ] 运行 `pnpm typecheck` 全部通过
- [ ] macOS + Windows 双平台手动验证核心流程

### P1 检查清单

- [ ] P1-1：marked 替换完成，确认 GFM 语法/代码块复制/流式渲染正常
- [ ] P1-2：MCP SDK 移除，确认联网搜索功能正常
- [ ] P1-3：chat + action 合并，确认快捷键打开 chat / 划词弹出 action 正常
- [ ] P1-4：preview 复用 action，确认截图识图/钉图识图正常
- [ ] 运行 `pnpm test` 全部通过
- [ ] 运行 `pnpm typecheck` 全部通过
- [ ] `pnpm build` 确认 bundle 体积下降

### P2 检查清单

- [ ] P2-1：overlay 改 Canvas，确认框选/标注/工具栏/快捷键正常
- [ ] P2-2：设置页懒加载，确认四个面板切换正常
- [x] P2-3：窗口空闲销毁，确认 30 秒后工具栏窗口被回收
- [ ] 全量手动测试通过
