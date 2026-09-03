# FlashAgent-assistant 性能审查报告 v0.8.1

> **[已归档 · 已消化]** 四份独立审查之四。红线清单经核查全部有效；个别数据错误（react-dom 文件数等）已修正。结论并入执行计划，0.8.2 已落地。

> **审查日期**：2026-09-03
> **审查者**：CodeBuddy
> **审查基准**：commit `e5fd9af` (main) · v0.8.1 · Electron 33 · React 18 · electron-vite 2.3
> **审查范围**：运行速度、安装/磁盘占用、内存占用、可维护性（面向新增功能页）
> **审查方式**：全部结论均基于本地 `src/`、`node_modules/`、`dist/win-unpacked/` 的**实测数据**，未经实测的部分已明确标注
> **代码改动**：无。本文为只读审查，未修改任何文件

---

## 〇、前置说明：与既有审计文档的关系

`docs/` 下已有两份同日、同版本的审计报告（`PERF-AUDIT-AND-REFACTOR-0.8.1.md` by Antigravity、`PERF-INDEPENDENT-AUDIT-2026-09-03-Cline.md` by Cline）。为避免重复劳动，我对二者的核心论断逐条做了独立复验。

### 复验结论：两份文档的主体结论均成立

| 既有论断 | 出处 | 我的复验 |
| :--- | :--- | :--- |
| 打包泄漏 onnxruntime 跨平台二进制 | 两份均有 | ✅ **准确**，实测 283 MB 中 256 MB 为死重 |
| `app.asar` 4,277 文件源于 `externalizeDepsPlugin` | 两份均有 | ✅ **准确**，实测文件数完全一致 |
| React 倒灌主进程 asar | 两份均有 | ✅ **准确**，Cline 进一步实测 `out/main/index.cjs` 顶层 require 仅 10 处、无 react |
| 设置窗口幽灵常驻 | Antigravity | ✅ **准确**，`src/main/index.ts:178-183` |
| 上帝组件 `ChatMode.tsx` / `index.ts` | Antigravity | ✅ **准确**，实测 2,425 / 1,154 行 |
| OCR 初始化 ~200 MB RSS | 两份均有 | ✅ **结论成立**；且原文已注明存在 3 分钟空闲销毁 |
| Mermaid 体积与分包数 | 两份均有 | ✅ **准确**，纯体积论述（node_modules >100 MB、43 个分包） |

三份文档的独立测量高度吻合（asar 40.8 MB / 4,277 文件、onnxruntime 283 MB、Portable 186.8 MB、`node_modules` 1.1–1.2 GB），可以互为交叉验证。

### 一处需要修正的细节

Antigravity 报告 §2.4 称：

> "每次 chunk 到来都会触发顶层 `setChat`"

这一句**与代码不符**。`src/renderer/chat/ChatMode.tsx:1207-1227` 已实现 50 ms 批处理 flush —— token 先入队，每 50 ms 才合并成一次 `setChat`。因此"每个 chunk 一次 setState"不成立。相应地，其建议 2.3 提出的"引入 rAF 批处理、每 30~50 ms 刷新"实际上与既有机制几乎等价，属于已落地项。

需要注意，**这一处细节错误不影响其主结论**：真正的问题不是 setState 的频率（已解决），而是**单次 re-render 的粒度**——2,425 行组件、28 个 `useState`、0 个 `React.memo`，任何 state 变化都会让整棵树走一遍 diff。这个判断依然成立。

### 本文的增量价值

既然主体结论一致，本文不再重复论证，只补充三点：

1. **第 1.2 / 1.3 节的体积拆解**：给出 `onnxruntime` 分平台、分文件的明细，以及 asar 内 4,277 个文件按包的分布（`zod` 642 / MCP 568 / `hono` 518 / `ajv` 404），便于排定裁剪优先级。
2. **第三节的"既有优化清单"**：这不是对既有报告的反驳（OCR 懒加载、Mermaid 懒加载、流式批处理、Markdown memo 化等优化确实都已落地，两份报告也均未主张拆除），而是**给后续重构划出红线**——拆 `ChatMode.tsx` 时这些是最容易被无意破坏的地方，尤其是 `selectionToolbar.html` 刻意不引入 React 这一决策。
3. **第五节的接入规范**：面向"后续新增功能页面"给出具体的落点与二选一决策树。

### 关于 Cline 报告

其测量方法与风险提示比本文初稿更严谨，值得优先采信的细节包括：跑通 `vitest`（24 文件 / 316 用例）与 `tsc --noEmit` 作为基线；指出 macOS / Linux 打包**同样存在**跨平台二进制泄漏（只是尚未量化）；提示 `electron-store` 底层 `conf` 对 `ajv` 存在动态 require、`ppu-paddle-ocr` 为 ESM-only，因此主进程 bundle 化需逐包验证。这些都已并入本文第四节的风险列。

---

## 一、实测基线

### 1.1 体积基线

| 指标 | 实测值 | 备注 |
| :--- | :--- | :--- |
| `node_modules/` | **1.2 GB** | 开发机安装占用 |
| 便携版 exe (`0.8.1`) | **186.8 MB** | 对比 `0.8.0` 的 89.1 MB，**+97.7 MB（+110%）** |
| `dist/win-unpacked/` | **~590 MB** | |
| ├ `resources/app.asar.unpacked/` | **320 MB** | 原生依赖解包区 |
| │　├ `onnxruntime-node/` | **283 MB** | ← 头号问题 |
| │　└ `@napi-rs/` | **37 MB** | Skia 26.3 MB + icudtl.dat 10.4 MB |
| └ `resources/app.asar` | **40.8 MB** / **4,277 个文件** | 主进程依赖散装 |
| `out/`（Vite 产物） | **7.5 MB** | 其中 renderer assets 7.3 MB |
| `dist/` 内残留 0.8.0 旧产物 | **261 MB** | 3 个文件，纯浪费 |

### 1.2 `onnxruntime-node` 解包明细（283 MB）

| 平台目录 | 体积 | win-x64 目标是否需要 |
| :--- | ---: | :--- |
| `darwin/arm64` | 84 MB | ❌ 不需要 |
| `win32/arm64` | 69 MB | ❌ 不需要 |
| `win32/x64` | 64 MB | ✅ 需要，**但其中 36.3 MB 非必需** |
| `linux/x64` | 44 MB | ❌ 不需要 |
| `linux/arm64` | 24 MB | ❌ 不需要 |
| **可安全删除合计** | **256 MB** | 仅保留 `onnxruntime.dll` 26.7 MB + `onnxruntime_binding.node` 0.3 MB |

`win32/x64` 内部再拆：`DirectML.dll` 17.7 MB、`dxcompiler.dll` 17.2 MB、`dxil.dll` 1.4 MB —— 这三个是 DirectML GPU 推理用的。项目走的是 CPU 推理（PP-OCRv6-tiny），**同样属于死重**。

### 1.3 `app.asar` 内文件数 TOP（4,277 个文件的来源）

| 包 | 文件数 | 说明 |
| :--- | ---: | :--- |
| `zod` | 642 | MCP SDK 传递依赖 |
| `@modelcontextprotocol` | 568 | MCP SDK 本体 |
| `hono` | 518 | MCP SDK 传递依赖 |
| `ajv` | 404 | JSON Schema 校验 |
| `@techstark/opencv-js` | 185 | 经 `ppu-paddle-ocr → ppu-ocv` 引入 |
| `undici` | 158 | |
| `onnxruntime-common` | 155 | |
| `onnxruntime-node` | 94 | |
| `zod-to-json-schema` | 93 | |
| `react-dom` | 命中 62 处 | **主进程用不到，纯冗余** |

### 1.4 代码规模基线

| 文件 | 行数 | 复杂度信号 |
| :--- | ---: | :--- |
| `src/renderer/styles.css` | 4,165 | 单体全局样式，产物 88 KB |
| `src/renderer/chat/ChatMode.tsx` | 2,425 | **28 个 useState、22 个 useEffect、0 个 React.memo** |
| `src/renderer/settings/entry.tsx` | 1,502 | |
| `src/main/index.ts` | 1,154 | 26 处 ipcMain 注册 |
| `src/main/ai/OpenAICompatibleClient.ts` | 1,116 | |
| 源码总量 | **24,709 行**（含测试）/ 21,379 行（不含） | |

---

## 二、问题清单

### P0 · 打包体积泄漏 256 MB 跨平台原生库

**位置**：`electron-builder.yml:14-19` + `scripts/after-pack.mjs`

`asarUnpack` 中声明了 `node_modules/onnxruntime-node/**`，导致 npm 包自带的**全部 5 个平台**二进制都被解包进产物。而 `after-pack.mjs` 只对 `selection-hook` 做了平台裁剪，**完全没有处理 onnxruntime**：

```js
// scripts/after-pack.mjs:8 —— 只有 selection-hook，没有 onnxruntime
const result = spawnSync(process.execPath, ['scripts/prune-selection-hook-win.js', ...])
```

这正是 `0.8.0 → 0.8.1` 体积翻倍的**唯一原因**（git log 显示这个版本只引入了 OCR 功能：`36b4a30 feat(ocr): offline screenshot text recognition`）。

**代价**：解压目录 +256 MB，便携版 exe 约 +90~100 MB。
**风险**：极低。Windows x64 目标永远不加载 darwin/linux/arm64 的 `.so`/`.dylib`。

---

### P0 · `dist/` 残留 261 MB 历史产物

**实测**：`FlashAgent-assistant-Portable-0.8.0.exe` 89.1 MB、`FlashAgent-assistant-Setup-0.8.0.exe` 86.4 MB、`flashagent-assistant-0.8.0-x64.nsis.7z` 85.8 MB。

不影响 exe 体积，但每次构建都白占 261 MB 磁盘，且容易误分发旧版本。

---

### P1 · `app.asar` 4,277 个散碎文件拖慢冷启动

**位置**：`electron.vite.config.ts:7`（主进程 `externalizeDepsPlugin()`）

该插件把主进程依赖全部 external，Rollup 不做 bundle 与 tree-shaking，于是 `zod`/`hono`/`ajv`/`undici` 等以原始 `node_modules` 目录结构散装进 asar。主进程冷启动时 Node 需要在 asar 虚拟文件系统中逐个定位并读取成百上千个小文件。

**代价**：asar 40.8 MB；启动阶段大量随机小文件 IO。
**附带问题**：`react` / `react-dom` 声明在 `dependencies`（`package.json:58-59`），被 electron-builder 拷入 asar，但渲染层的 React 已由 Vite 打进 `useThemeMode-*.js`，主进程根本不用 —— 约 4.4 MB 冗余。

---

### P1 · 设置窗口关闭后永不销毁，常驻 60~80 MB

**位置**：`src/main/index.ts:178-183`

```typescript
settingsWindow.on('close', (event) => {
  if (isQuitting) return
  event.preventDefault()
  settingsWindow?.hide()      // 只隐藏，不 destroy
  app.dock?.hide()
})
```

用户打开过一次设置页后，这个 1,502 行组件的 Chromium 渲染进程就永久驻留到应用退出。

**代价**：后台常驻多出一个渲染进程（含 React 运行时 + 88 KB CSS + 完整表单 DOM）。
**说明**：这个设计可能是为了保住表单状态与打开速度，属于有意的取舍，但缺少"空闲后回收"的兜底。

---

### P2 · `node_modules` 1.2 GB 安装占用

| 包 | 体积 | 性质 |
| :--- | ---: | :--- |
| `onnxruntime-node` | 284 MB | 必需（含 4 个用不到的平台） |
| `electron` | 272 MB | 必需 |
| `app-builder-bin` | 207 MB | **仅打包时用，可按需下载** |
| `mermaid` | 82 MB | 已懒加载，只是开发期占用 |
| `@napi-rs` (Skia) | 37 MB | OCR 图像处理依赖 |
| `typescript` | 22 MB | 开发期 |
| `@techstark/opencv-js` | 15 MB | OCR 依赖 |

**附带问题**：仓库同时存在 `package-lock.json`（196 KB）和 `pnpm-lock.yaml`（219 KB）。两份 lockfile 共存意味着 npm 与 pnpm 混用，容易出现依赖树不一致，也让"哪个才是权威来源"变得模糊。`scripts` 用的是 pnpm，但 `.github/` CI 需确认一致。

---

### P2 · `ChatMode.tsx` 是全应用的性能与可维护性焦点

**实测数据**：2,425 行、**28 个 `useState`**、22 个 `useEffect`、**0 个 `React.memo`**（仅 3 处 `useMemo`、5 处 `useCallback`）。

流式输出的 setState 已经被 50ms 批处理节流（`ChatMode.tsx:1207-1227`），**频率问题解决了，但单次渲染的粒度问题没解决**：任何一个 state 变化都会让这个 2,425 行组件整体 re-render，28 个 state 的订阅树全部走一遍 diff。历史消息里的 `MarkdownView` 已被 `React.memo` 挡住（`Markdown.tsx:126`），但消息气泡本身、侧边栏、输入框、模型选择器等并未隔离。

**代价**：长对话下打字机效果的 CPU 占用偏高；新增任何功能都会加剧状态交叉污染。

---

### P3 · Mermaid 产出 43 个懒加载 chunk，合计 6.2 MB

**实测**：`out/renderer/assets/` 共 7.3 MB，其中 mermaid 系占 **6.2 MB（43 个 chunk）**，含 `cynefin` 1.3 MB、`mermaid.core` 1.0 MB、`cytoscape` 959 KB、`katex` 484 KB、`architectureDiagram` 419 KB 等。

**运行时影响很小**（已懒加载 + LRU 50 缓存 + 流式期间跳过，见 `Markdown.tsx:32,57,181-183`），但 6.2 MB 会进 asar、进安装包，且绝大多数图表类型（C4、甘特、桑基、象限…）在划词助手场景属于极低概率需求。

---

### P3 · 单体 88 KB 全局 CSS 被所有窗口全量加载

**实测**：`styles-C5b_qveD.css`（88 KB）被全部 6 个 HTML 入口引用，包括仅需几十个图标的划词工具栏。

---

## 三、既有优化红线清单（重构时不得破坏）

以下优化已经落地。**这份清单不是要反驳任何人**（两份既有报告也均未主张拆除它们），而是给后续重构划红线——拆 `ChatMode.tsx` 时，这些是最容易被无意破坏的地方：

| 优化项 | 位置 | 说明 |
| :--- | :--- | :--- |
| OCR 懒加载 + 空闲销毁 | `src/main/ocr/index.ts:12,19-25,56-79` | 单例 + 3 min idle destroy，ESM 动态 import 规避 CJS 限制 |
| Mermaid 懒加载 + LRU | `src/renderer/Markdown.tsx:15,32,57` | 缓存上限 50，流式期间不渲染（`pending` 短路） |
| 流式 50ms 批处理 | `src/renderer/chat/ChatMode.tsx:1207-1227` | 每批一次 setState |
| Markdown memo 化 | `src/renderer/Markdown.tsx:126,139-144` | `React.memo` + `useMemo` 按源文本缓存 |
| preload 监听器可退订 | `src/preload/index.ts:20-26` | 每个 `on*` 都返回 unsubscribe 函数 |
| 划词工具栏用原生 JS | `out/renderer/selectionToolbar.html` | **不加载 React**，内联 vanilla JS，保持秒开 |
| React 共享 chunk 无重复打包 | `out/renderer/assets` | 实测各入口 `reactRefs=0`，Vite 分包策略正确 |
| Polling 正确清理 | `src/renderer/chat/ExtensionsPanel.tsx:77` | 仅在 `connecting` 状态轮询，`clearInterval` 有返回 |

**特别提醒**：`selectionToolbar.html` 与 `screenshotPin.html` 走的是内联原生 JS、零 React 依赖，这是正确的架构决策。后续重构时**不要**为了"统一技术栈"把它们改成 React，那会让秒开特性退化。

---

## 四、优化建议（按投入产出比排序）

### 阶段一：纯构建层改动，零业务风险

| # | 动作 | 具体做法 | 预期收益 | 风险 |
| :-- | :--- | :--- | :--- | :--- |
| 1 | **裁剪 onnxruntime 跨平台二进制** | 在 `scripts/after-pack.mjs` 中新增 `prune-onnxruntime-win.js`，按 `context.arch` 删除 `app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6/` 下的 `darwin*`、`linux*`、另一 arch 的 `win32/*`，可复用 `prune-selection-hook-win.js` 的写法 | **解压目录 −256 MB；便携版 186.8 → 约 95~100 MB** | 低。**但删除 `DirectML.dll`/`dxcompiler.dll`/`dxil.dll`（再省 36.3 MB）前，必须用真实截图回归一次「OCR 复制文字」**——ONNX Runtime 仅在请求 DML EP 时加载它们，需实测确认纯 CPU 路径不受影响 |
| 2 | **清理 dist 历史产物** | 构建脚本开头清空 `dist/`；或把旧产物移出仓库并加 `.gitignore` | **−261 MB 磁盘** | 无 |
| 3 | **`react`/`react-dom` 移入 devDependencies** | `package.json` 中挪到 `devDependencies`（渲染层由 Vite 打包，不依赖 npm 分类） | asar −4.4 MB | 低。需验证 `externalizeDepsPlugin` 不因分类变化报错 |
| 4 | **统一 lockfile** | 保留 `pnpm-lock.yaml`，删除 `package-lock.json`，并同步 `.github/` CI | 消除依赖树不一致 | 低。需先确认 CI 用的是 pnpm |

> 第 1 项完成后，便携版预计回到 ~95 MB，与 `0.8.0` 的 89.1 MB 基本持平 —— **等于白拿了一个离线 OCR 功能**。
>
> ⚠️ **macOS / Linux 打包存在同一问题**：`after-pack.mjs` 首行即 `if (context.electronPlatformName !== 'win32') return`，意味着 mac / linux 产物会把 Windows 二进制一并带入，且从未被度量。新增的 prune 脚本应对三个平台各自保留对应目录，而不是只在 win32 分支生效。

### 阶段二：主进程打包与内存

| # | 动作 | 具体做法 | 预期收益 | 风险 |
| :-- | :--- | :--- | :--- | :--- |
| 5 | **主进程依赖按需 bundle** | `electron.vite.config.ts` 中仅保留 `selection-hook`、`onnxruntime-node`、`ppu-paddle-ocr` 这类含 `.node`/原生模块的 external，其余纯 JS 依赖（`@modelcontextprotocol/sdk`、`electron-store`、`undici`）交给 Rollup 打包成单文件 | **asar 4,277 → 数百个文件；体积 −20 MB 以上；冷启动 IO 显著改善** | 中。**两个已知动态 require 陷阱**：`electron-store` 底层 `conf` 对 `ajv` 是动态 require；`ppu-paddle-ocr` 为 ESM-only（当前已用 `/* @vite-ignore */` 动态 import 规避，见 `src/main/ocr/index.ts:22`）。建议逐包验证，放在阶段一之后单独排期 |
| 6 | **设置窗口空闲回收** | 保留 `preventDefault + hide()` 的秒开能力，但增加一个 60s 空闲定时器，超时则真正 `destroy()` 并把 `settingsWindow` 置 null；下次打开走冷启动 | **后台常驻 −60~80 MB** | 低。冷启动代价仅在长时间未使用时才发生 |
| 7 | **确认 `ppu-ocv` 的 asarUnpack 必要性** | `electron-builder.yml:18` 声明了 `node_modules/ppu-ocv/**`，但它只有 118 KB 且是纯 JS，实测不需要解包 | 微小 | 低 |

### 阶段三：渲染层与架构（面向新增功能页）

| # | 动作 | 具体做法 | 预期收益 | 风险 |
| :-- | :--- | :--- | :--- | :--- |
| 8 | **拆分 `ChatMode.tsx`** | 见第五节方案 | 单次 re-render 成本下降；新功能不再交叉污染 | 中。需要配套回归测试 |
| 9 | **Mermaid 按需裁剪** | 若确认只需要少数几种图（如 flowchart / sequence），可用 mermaid 的按需注册替代全量引入 | 产物 −4~5 MB | 中。可能丢失用户偶然用到的图表类型 |
| 10 | **CSS 模块化** | 拆分为 `base.css`（变量/重置）+ `toolbar.css`（<5 KB）+ `chat.css` + `settings.css`，各入口按需引入 | 轻量窗口少加载 80+ KB | 低。纯样式重构，可渐进 |

---

## 五、是否需要重构？—— 结论与方案

### 结论：**不需要重写，但必须在加新页面之前做结构解耦。**

理由不是"代码不优雅"，而是有一条明确的临界线：

- `ChatMode.tsx` 已有 **28 个 useState**。新增一个功能面板，保守估计要再加 5~10 个 state，且大概率要往已有的 22 个 `useEffect` 里插依赖 —— 交叉触发的概率呈指数上升。
- `src/main/index.ts` 已有 **26 处 ipcMain 注册**。每加一个页面就往这个文件塞一批 IPC handler，文件很快会突破 2,000 行。
- 二者的共同问题是：**没有明确的"新增一个页面该改哪里"的落点**。不建立这个落点，加页面的边际成本会持续变高。

但技术栈本身（Electron + React + Vite）没有瓶颈，**不需要引入 Zustand、不需要换框架、不需要推倒重来**。

### 5.1 主进程：抽出窗口服务 + IPC 路由层

```
src/main/
├── index.ts                    # 目标 < 150 行：app 生命周期、单实例锁、全局异常
├── services/
│   ├── WindowService.ts        # 所有窗口的创建/复用/预热/销毁策略（含 settings 空闲回收）
│   ├── TrayService.ts
│   └── AgentEngine.ts          # 从 index.ts 抽出 Agent 循环、审批流、快照
└── ipc/
    ├── windowIpc.ts
    ├── settingsIpc.ts
    ├── aiStreamIpc.ts
    ├── agentIpc.ts
    └── [newFeature]Ipc.ts      # ← 新功能页的落点
```

**关键收益**：新页面接入时 `index.ts` 零改动。

### 5.2 渲染进程：拆 `ChatMode.tsx`

```
src/renderer/chat/
├── ChatMode.tsx            # 布局外壳，目标 < 150 行
├── hooks/
│   ├── useChatStream.ts    # 流式调度、Abort、50ms flush（现有逻辑原样迁移）
│   ├── useTopicPersistence.ts
│   └── useToolApproval.ts
└── components/
    ├── MessageList/MessageItem.tsx     # React.memo —— 当前 0 处 memo，这是主要缺口
    ├── StreamingBlock.tsx              # 正在打字的节点独立成组件
    ├── Composer/
    ├── Sidebar/
    └── ToolCards/
```

**优先做 `MessageItem` 的 `React.memo`**：这是 2,425 行组件里性价比最高的一刀 —— 历史消息在流式期间完全不需要重渲染。

**状态管理建议**：先按上面把 state 就近下沉到 hooks/子组件。只有当跨组件共享确实成为问题时，再考虑引入 1 KB 级的轻量 store。**不要为了拆分而提前引入状态库。**

### 5.3 新功能页接入规范（建议立为约定）

按页面性质二选一：

**类型 A — 独立工作窗口**（如知识库中心、工作流编排）
- 在 `electron.vite.config.ts` 的 `rollupOptions.input` 注册独立 HTML 入口
- 在 `WindowService` 声明窗口规格与生命周期策略
- 在 `src/main/ipc/` 新增对应 `[feature]Ipc.ts`
- 独立渲染进程，与托盘划词内存隔离

**类型 B — 现有页面内的辅助面板**（如生词本抽屉、Prompt 模板库）
- 用 `React.lazy` 以 Tab / Drawer / Modal 挂载
- **不新建 Chromium 进程**，省 40~60 MB

**若为轻量悬浮 UI（如新的划词工具）**：沿用 `selectionToolbar.html` 的原生 JS 内联模式，**不要引入 React**，保住秒开。

### 5.4 建议实施顺序

```
阶段一（纯构建，零业务风险）
  ├─ 裁剪 onnxruntime 跨平台二进制      → −256 MB
  ├─ 清理 dist 历史产物                 → −261 MB
  └─ react 移入 devDependencies + 统一 lockfile
        ↓
阶段二（主进程）
  ├─ 主进程依赖 bundle 化               → asar 4,277 文件 → 数十个
  └─ 设置窗口空闲回收                   → −60~80 MB 常驻
        ↓
阶段三（渲染层 + 架构，为加页面铺路）
  ├─ MessageItem 加 React.memo
  ├─ 拆分 ChatMode.tsx hooks / components
  ├─ 主进程拆 WindowService + ipc/
  └─ 确立新页面接入规范
```

阶段一和阶段二完全不碰业务代码，可以放心先做。阶段三建议在新功能页开发**之前**完成，否则新代码也会落进同样的泥潭。

---

## 六、本次审查未覆盖 / 需实测确认项

以下内容需要运行应用或接入 profile 才能得出可靠数字，本文不做断言：

1. **实际 RSS 内存**：既有报告称"320~580 MB"，我无法在静态审查中复现。建议用 `process.getProcessMemoryInfo()` + Chromium Task Manager 在"冷启动空闲 / 划词中 / OCR 进行中 / 长对话流式"四个场景实测。
2. **冷启动耗时**：asar 4,277 文件的 IO 影响有多大，需对比"bundle 化前后"的 `app.whenReady → window.ready-to-show` 耗时。
3. **划词动作窗口冷启动延迟**：既有报告称 300~600 ms，需实测确认后再决定是否上"预热单例池"。
4. **截图 Base64 内存峰值**：`ScreenshotService.ts:153` 的 `toDataURL()` 在 4K 屏下的实际堆占用。
5. **`app-builder-bin`（207 MB）** 是否可改为按需下载，取决于 CI/打包环境是否允许网络访问。

---

*本报告由 CodeBuddy 于 2026-09-03 完成，基于 commit `e5fd9af` 的静态代码审查与本地产物实测。未修改任何代码。*
