# FlashAgent-assistant 独立性能审查报告（v0.8.1）

> **审查日期**：2026-09-03
> **审查者**：Cline
> **审查基准**：`git HEAD = e5fd9af`（main 分支）· Electron 33.2.1 · React 18.3.1 · electron-vite 2.3.0 · TypeScript 5
> **审查原则**：
> 1. 严格以**实际源码**与 **`dist/win-unpacked`、`node_modules`、`out/` 的真实构建产物**为准重新度量，不采信任何既有审查文档的结论。
> 2. 只诊断、不修改任何代码（本次审查对仓库零代码改动）。
> 3. 建议按「保持全部现有功能不破坏」为前提排优先级，覆盖用户关心的三项指标：**运行速度、依赖安装占用、内存占用**，并为后续新增功能页面给出是否重构的结论。

---

## 一、实测基线（全部为本地实测数据）

| 指标 | 实测值 | 度量方法 |
| :--- | :--- | :--- |
| `dist/win-unpacked` 解压运行目录 | **589.7 MB / 145 文件** | PowerShell 递归 `Measure-Object` |
| `dist/win-unpacked/resources` | **360.6 MB** | 同上 |
| └ `app.asar` | **40.8 MB（4,277 个文件）** | `@electron/asar list` + 文件度量 |
| └ `app.asar.unpacked` | **319.7 MB（123 文件）** | 同类度量 |
| └ onnxruntime-node（unpacked） | **282.7 MB** | 同类度量 |
| └ @napi-rs（unpacked） | **36.7 MB** | 同类度量 |
| └ selection-hook（unpacked） | **0.3 MB** | 同类度量 |
| Electron + Chromium 运行时本身 | ≈ **229 MB**（exe 188.8MB + pak/icudtl/DLL） | `589.7 − 360.6` |
| 便携版安装包 `Portable-0.8.1.exe` | **186.8 MB**（0.8.0 为 93.4 MB，**+93 MB**） | 直接度量文件 |
| `node_modules` | **1.13 GB / 23,761 文件 / 738 包** | pnpm install 后度量 |
| `out/`（electron-vite 产物） | **7.67 MB**，renderer/assets 71 个 JS + 1 个 CSS(88KB) | 同类度量 |
| `out/main/index.cjs` | 239 KB；`out/preload/index.cjs` 10.5 KB | 同类度量 |
| 单元测试 | **24 个文件 / 316 个用例全部通过** | `vitest run` |
| 类型检查 | node + web 两套 tsconfig 全部通过 | `tsc --noEmit` |

### node_modules 中最大的前 10 个包（实测）

| 包 | 体积 | 归属 | 是否会进安装包 |
| :--- | :--- | :--- | :--- |
| `onnxruntime-node` | 282.8 MB | 生产依赖（OCR） | ✅ 全量进入，见问题 1 |
| `electron` | 271.2 MB | 开发依赖 | ❌ |
| `app-builder-bin` | 206.8 MB | 开发依赖（electron-builder） | ❌ |
| `mermaid` | 80.1 MB | 开发依赖（被打进 renderer bundle） | 仅 renderer 中约 4.4MB 分包 |
| `@napi-rs`（canvas/skia） | 36.7 MB | 生产依赖（OCR 图像处理） | ✅ 全量进入 |
| `typescript` | 21.7 MB | 开发依赖 | ❌ |
| `@techstark`（builder 相关） | 14.0 MB | 开发依赖 | ❌ |
| `7zip-bin` | 11.7 MB | 开发依赖 | ❌ |
| `@mermaid-js` | 11.7 MB | 开发依赖 | 仅 renderer 分包 |
| `@modelcontextprotocol/sdk` 整树（含 zod/hono/ajv） | ≈ 12 MB | 生产依赖 | ✅ 全量进入 asar |
---

## 二、问题清单（按「收益 / 风险」排序）

### 问题 1【P0 / 体积 + 安装占用，收益最大】打包泄漏 onnxruntime 跨平台二进制 + DirectML 冗余

**证据（`dist/win-unpacked/resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6/`）**：

| 文件 | 体积 | 本机（win32-x64）是否需要 |
| :--- | :--- | :--- |
| `darwin/arm64/libonnxruntime.1.dylib` | 43.9 MB | ❌ |
| `darwin/arm64/libonnxruntime.1.29.0.dylib` | 43.9 MB | ❌ |
| `linux/x64/libonnxruntime.so.1` | 44.7 MB | ❌ |
| `linux/arm64/libonnxruntime.so.1` | 24.5 MB | ❌ |
| `win32/arm64/*`（onnxruntime.dll + DirectML + dxcompiler + dxil） | 71.8 MB | ❌ |
| `win32/x64/onnxruntime.dll` | 28.0 MB | ✅（纯 CPU 推理必需） |
| `win32/x64/onnxruntime_binding.node` | 0.3 MB | ✅ |
| `win32/x64/DirectML.dll` + `dxcompiler.dll` + `dxil.dll` | 37.9 MB | ⚠️ 仅在启用 GPU/DirectML 推理时加载 |
| **合计** | **282.7 MB** | **最少只需 28.3 MB** |

**根因**：`scripts/after-pack.mjs`（electron-builder `afterPack` 钩子）在 Windows 下只调用了 `scripts/prune-selection-hook-win.js` 清理 `selection-hook` 的跨平台 prebuild，**完全遗漏了 `onnxruntime-node`**；而 `onnxruntime-node` 的 postinstall 会把全部平台二进制写入 `bin/napi-v6`，electron-builder 的 `asarUnpack: node_modules/onnxruntime-node/**` 又把它们原样搬进安装包。

**建议（零业务代码改动，纯构建层）**：
1. 在 `after-pack.mjs` 中按 `context.arch`（x64 / arm64）新增一个 `prune-onnxruntime-win.js`，只保留 `bin/napi-v6/{win32,x64}`（或 win32,arm64）目录，删除 darwin、linux、另一 arch 目录（约省 **230 MB**）。
2. **可选**：进一步验证纯 CPU 路径不加载 DML 后，删除 `DirectML.dll` / `dxcompiler.dll` / `dxil.dll`（再省 **37.9 MB**）。运行时 OCR 走 CPU EP，ONNX Runtime 只在请求 DML EP 时才加载这些 DLL；但必须用真实截图回归一次「OCR 复制文字」后才可落地。
3. macOS / Linux 打包同样要加对等的 prune（当前 macOS 产物会把 Windows/Linux 二进制一并带入，只是还没人量过）。

**收益**：`app.asar.unpacked` 从 319.7 MB → 约 90 MB；`win-unpacked` 从 589.7 MB → 约 350 MB；`Portable-0.8.1.exe` 预计从 186.8 MB →约 95~100 MB（回到 0.8.0 量级）。`node_modules` 安装占用同时减少约 250 MB。
---

### 问题 2【P0 / 体积 + 启动速度】app.asar 40.8 MB、4,277 个散碎文件：生产依赖整包进包

**证据**：
- `electron.vite.config.ts` 主进程使用 `externalizeDepsPlugin()`，会把 `package.json` 中 **所有 `dependencies`** 外部化；electron-builder 于是把整个生产依赖树拷入 `app.asar/node_modules`（实测 4,277 个文件）。
- 主进程 bundle `out/main/index.cjs` 顶层 `require()` 只有 10 处（electron / node:fs / node:path / node:child_process / **undici** / **electron-store** / selection-hook），**根本没用到 react**。
- 但 `react`、`react-dom`、`scheduler`、`marked`、`undici` 都声明在 `dependencies` 中被整包带入 asar：react/react-dom/scheduler ≈ 6 MB 是**纯死重**（renderer 已被 Vite 打进 `out/renderer`）；MCP SDK 及其传递依赖（hono、zod、ajv、zod-to-json-schema、@hono/node-server 等）≈ 12 MB 是「磁盘死重」（运行时已懒加载，但安装包 / 解压 / 病毒扫描时间照付）。

**建议**：
1. **把 `react`、`react-dom`、`marked`、`dompurify`（dev）、`@types/*` 移入 `devDependencies`**——它们只在 renderer 被 Vite 打包，主进程从不 require。asar 至少减 6 MB + 数百小文件。
2. 中等收益改造：主进程构建对纯 JS 依赖（`@modelcontextprotocol/sdk`、`electron-store`、`undici`、`marked`）部分 `noExternal` 打进 bundle，让 asar 只保留原生模块（selection-hook / onnxruntime-node / @napi-rs）。**风险提示**：`electron-store` 底层 `conf` 对 `ajv` 有动态 require、`ppu-paddle-ocr` 是 ESM-only（当前已用 `@vite-ignore` 动态 import 规避），这一步需要逐包验证，建议放在 P1 排期并单独做回归。
3. 简单兜底：在 `electron-builder.yml` 的 `files` 中显式排除 `!node_modules/react/**` 等，先止血。

**收益**：asar 从 40.8 MB →预估 20~28 MB，文件数从 4,277 →数百；主进程冷启动减少对 asar 虚拟文件系统的散碎小文件读取。

---

### 问题 3【P1 / 内存】设置窗口「隐藏不销毁」，且非 `--hidden` 启动时立即创建

**证据（`src/main/index.ts`）**：
- `app.whenReady()` 末尾：`if (!wasStartedHidden()) createSettingsWindow()` —— 普通启动（含用户开机直接打开）会**立即**启动一个全功能设置渲染进程（React 表单，入口 1412 行 + 共享 chunk ~500KB JS + 88KB CSS）。
- 关闭事件：`event.preventDefault(); settingsWindow?.hide()` —— 关闭只是隐藏，**渲染进程永久驻留**（实测单窗口稳态约 60~80 MB 量级）。
- 该窗口 `webPreferences.sandbox: true` `backgroundThrottling: true`（是正确的，但进程不会因此退出）。

**建议**（保持「设置」秒开体验与释放内存的折中，二选一）：
1. **惰性创建 + 随用随销**：首次点托盘「设置」时才 `createSettingsWindow()`；`close` 时改为 `destroy()`（`isQuitting` 分支保留），配合 `second-instance` / `activate` 事件重建——收益最大。
2. 保守方案：保留 hide 行为，但学习 toolbar 的「idle 销毁」模式：隐藏超过 N 分钟（如 10 分钟）自动 `destroy`。
3. 打开设置窗口时若 OCR 已加载且空闲，可顺带触发 `destroyOcr()` 的提前回收。

**收益**：长期后台常驻内存下降 60~80 MB（约占应用空闲总内存的 1/4~1/3）。

---

### 问题 4【P1 / 安装占用 + 首次安装时间】依赖安装 1.13 GB

**结论先说**：devDependencies 中 electron（271 MB）、app-builder-bin（207 MB）、mermaid（80 MB）等是开发/构建必需，属于「合理成本」，不是问题；**真正可省的是 onnxruntime 的跨平台二进制（约 250 MB）**（见问题 1）。

次要项：
- `pnpm install` 全程由 onnxruntime-node postinstall 下载/落盘全平台二进制，首次安装耗时明显；如果做问题 1 的 prune，可同步考虑在 CI/lockfile 侧对 onnxruntime 瘦身（如安装后立即清理 bin 非本平台目录，再进缓存）。
- `app-builder-bin` 206.8 MB 是 electron-builder 的预编译工具（含 7za 等，按平台提供）；`@techstark` 14 MB 是 builder 签名相关。二者不进入安装包，可不动（除非换更轻的打包工具链）。

---

### 问题 5【P2 / 主进程启动】`undici` 被急切 require

**证据**：`out/main/index.cjs` 顶层 `const undici = require("undici")`；`src/main/proxy.ts` 在 `applyProxy()`（app 启动时即调用）中使用 `ProxyAgent`/`Agent` 设置 Node 全局 dispatcher。undici 完整包约 1.6 MB JS，启动时整段解析。


**建议**：将 `proxy.ts` 内对 `undici` 的引用改为按需 `import('undici')`（如 `applyProxy` 被调用时才加载，或设置 `setGlobalDispatcher` 之前）。收益为启动阶段减少一次大模块解析（约几十毫秒量级），风险极低。可选做。

---

### 问题 6【P2 / 内存峰值】截图流程在 overlay 初始化后仍保留完整帧

**证据（`src/main/ScreenshotService.ts`）**：
- `startCapture()`：`this.currentCapture = { display, image, dataUrl: image.toDataURL() }`（`image` 为全屏 NativeImage，`dataUrl` 为 PNG base64，4K 下可达 10~25 MB 字符串）；
- `ScreenshotOverlayReady` 处理器把 `dataUrl` 发给 overlay renderer 后，`currentCapture` 会一直保留到「下次截图或取消」（`ScreenshotOverlayCancel` 才会清空）。
- 主进程因此配置了 `--max-old-space-size=512`（`index.ts` 顶部），副产物是主进程 V8 堆上限偏低，遇到极端长对话 / 大批量工具输出时可能提前 GC 抖动。



**建议**：
1. overlay `did-finish-load`/init payload 发送完成后，主进程即可清掉 `currentCapture.image` 与 `dataUrl`（只留 display/尺寸元数据，供后续裁剪比率计算；裁剪本身由 renderer 产出新的 `imageDataUrl` 传回）。这能即时回收 10~25 MB。
2. 对高分屏 region 裁剪，可让 renderer 在传给主进程前先 `canvas.toBlob`（JPEG q=0.9）而非 PNG base64，减少 AI 识图 IPC 传输量与目标端内存（视觉识别对 JPEG 不敏感）。收益中等、需要 UI 回归。



---

### 问题 7【P3 / 安装包体积】压缩等级被压到最低

**证据**：`scripts/dist-win.cjs` 固定 `ELECTRON_BUILDER_COMPRESSION_LEVEL=1`（注解：7za mx=9 需要 ~1GB 提交内存，低配机 OOM）。后果是 7z 自解压便携版/NSIS 对可压缩内容压缩不足；但 Electron 的 DLL/pak 本身压缩率差，此项收益有限（约 5~15 MB），且提升压缩等级有打包机内存风险。

**建议**：先完成问题 1（剪掉 250 MB 冗余）后，再评估把压缩等级提到 3~6 是否在 CI 机器上可接受；不要为它单独冒险。


---

### 问题 8【P3 / 渲染层小项】样式与入口耦合

- `styles.css` 88.9 KB 单文件被全部 6 个页面引用；toolbar / screenshotPin 这两个「无 React」页面其实只用到其中 <5 KB。可拆 `base/toolbar/chat/settings/overlay` 多份，对 toolbar/pin 首帧解析与内存有少量收益。
- chat 窗口与 action 窗口共用 `selectionAction.html`（`action/entry.tsx` 用「有无初始 payload」来分流到 `ChatMode`）。当前 `React.lazy` 拆分做得不错（chat 路径才拉 ChatMode chunk），但后续加新页面时这个「一入口双窗口」的模式会让入口文件继续膨胀，建议按下方「重构建议」逐步拆独立入口。
- 渲染层 bundle 总量 7.4 MB 中 mermaid 系分包约 4.4 MB（39 个 chunk），已全部懒加载、SVG 缓存有 50 条上限——**不需要动**，仅提醒：以后不要改为静态引入。

---

## 三、已优化部分（验证卡：不要回改）

以下项目我在源码中逐项核实为「已经做对 / 已修复」，与旧文档描述不一致的地方以当前代码为准：

| 项目 |现状（实测源码） |
| :--- | :--- |
| 窗口 `sandbox` | 7 个窗口全部 `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`（设置/聊天/翻译/工具栏/动作/截图 overlay/pin） |
| MCP SDK 加载 | `McpManager.loadMcpSdk()`：仅在真的连接 MCP 服务器时才动态 import，平时零开销 ✅ |
| Exa 搜索 | `WebSearch.ts` 已用 60 行极简 MCP JSON-RPC + `net.fetch` 替代 SDK ✅ |
| 离线 OCR 生命周期 |懒加载单例 + 3 分钟空闲 `destroyOcr()`（`src/main/ocr/index.ts`）✅ |
| 工具栏窗口 |按需创建 + 30 秒隐藏即销毁（`SelectionService.scheduleToolbarIdleDestroy`）✅ |
| 动作窗口复用 |可见时复用同一窗口（`openActionWindow`）✅ |
| Markdown |`marked` + DOMPurify，已替换旧 react-markdown 栈 ✅ |
| Mermaid |懒加载 + 按主题/源码缓存 + 50 条 LRU 上限（`Markdown.tsx`）✅ |
| 钉图/工具栏 |纯原生 HTML，无 React ✅ |
| 语言包 |`electronLanguages` 只保留 zh-CN/en-US/en-GB（1.4 MB）✅ |
| 消息体截断 |工具输出 12k、参数 500 字符截断，防止 IPC 爆炸 ✅ |
| 粘贴板/划词 |关闭 selection-hook 的剪贴板模拟复制，避免 CLI/终端被杀 ✅ |
| 主进程 V8 上限 |`--max-old-space-size=512` 已有（与问题 6 相关但不冲突） |

---

## 四、与既有审查文档的印证 / 纠偏

仓库里已有三份性能文档，我「不采信、只对照」：

- `docs/PERF-AUDIT-AND-REFACTOR-0.8.1.md`：其关于 `win-unpacked` 589.7MB、`app.asar` 40.8MB/4277 文件、`unpacked` 319.7MB、onnxruntime 282.5MB、Portable 195.8MB 的**数字与我的独立实测一致**；「afterPack 只剪 selection-hook、漏掉 onnxruntime」的根因判断也正确。**结论可信**，可作为问题 1/2 的佐证。
- `docs/PERF-REVIEW-0.8.0.md`：包体积归属表基本准确（onnxruntime 284MB / electron 272MB / mermaid 83MB 与实测一致）。
## 五、是否需要重构？（面向「后续新增功能页面」）

### 总判断
**不需要推倒重来，但建议做一次「增量分层」重构**，且应排在「问题 1/2 体积瘦身」之后分阶段进行。当前工程的模块化程度其实不差（agent / mcp / translate / ocr / ai / shared 均已拆分，测试覆盖 316 例），真正阻碍新增页面的是三处**单体文件**和「一入口双窗口」的耦合：

| 文件 |行数（实测） |影响 |
| :--- | :--- | :--- |
| `src/main/index.ts` |1097 行 |所有窗口生命周期 + IPC + Agent 循环 + 压缩 + MCP 回调揉在一起；新增页面要在这里继续加 `BrowserWindow` 与 `ipcMain.handle` |
| `src/renderer/chat/ChatMode.tsx` |2334 行 / 101 KB |对话 + Agent 审批卡片 + 侧栏 + 扩展面板全在一个组件里；新增面板会继续恶化 |
| `src/renderer/settings/entry.tsx` |1412 行 |设置页四面板单文件，新增设置分区会长文档 |
| `src/renderer/styles.css` |3797 行 / 88 KB |全局样式，新增页面样式无归属 |

### 建议的落地方式（保持功能不破坏）
1. **主进程半服务化（不追求一步到位）**：把「窗口创建/复用/销毁」收敛进一个 `WindowService`（从 `index.ts`、`SelectionService`、`ScreenshotService` 提取通用窗口选项），IPC 按域拆成 `windowIpc.ts / settingsIpc.ts / aiIpc.ts / agentIpc.ts / [newPage]Ipc.ts`。每新增一个页面只需：在 `electron.vite.config.ts` 的 `renderer.build.rollupOptions.input` 注册 HTML 入口 → `WindowService` 注册规格 → 新增一个 `[feature]Ipc.ts`。`index.ts` 不再增长。
2. **ChatMode 拆分（增量）**：`MessageList / MessageItem（React.memo）/ Composer / Sidebar / ToolCards / store(hooks)`。每次拆一个 PR，跑 `pnpm test` 与手动流式回归即可。
3. **新页面两种接入模式（控制渲染进程数量，内存优先）**：
   - **A 类独立工作窗口**（如知识库、工作流编排）：独立 HTML 入口 + 独立 IPC 模块；生命周期按需创建 / 关闭销毁，参考「设置窗口」的处理（见问题 3）。
   - **B 类辅助面板**（如生词本抽屉、Prompt 库、详情面板）：优先用 `React.lazy` + Suspense 挂进现有设置/对话页，**不新增渲染进程**（每少一个渲染进程 ≈ 省 40~60 MB）。
4. **入口解耦（中期）**：把 chat 拆成独立 `chat.html` 入口，让 `selectionAction.html` 回归「划词结果窗」单职责；两个入口共享的模块会被 Vite 自动抽成公共 chunk，不会重复下载。

### 不建议做的事
- 迁移 Tauri：`selection-hook` 是 C++ 原生钩子，重写成本与回归风险远大于收益；且 Electron 的「托盘 + 划词钩子 + 多窗口」模型与现有功能深度绑定。
- 引入重型状态库/路由库：当前页面间无共享状态需求，Zustand/React Router 不是必须。

---

##  六、分阶段实施路线图（按收益排序，每阶段可独立交付）

```
阶段 0（纯构建层，1 个 PR，零业务代码改动，风险最低）
├─ 问题1: afterPack 增加 onnxruntime 平台 prune（win x64 先落）
├─ 问题2a: react/react-dom/marked 移 devDependencies + files 排除
└─ 验证: pnpm build && pnpm test && 打一个 portable 复测 OCR

阶段 1（内存优化，1~2 天）
├─ 问题3: 设置窗口惰性创建 + close 销毁（或 idle 销毁）
├─ 问题6: 截图 overlay init 后释放 currentCapture
└─ 验证: 托盘常驻内存测量

阶段 2（启动速度，0.5~1 天）
├─ 问题5: undici 惰性 import
└─ 验证: 启动耗时测量

阶段 3（架构分层，为新增页面铺路，1~2 周分批）
├─ WindowService + IPC 模块拆分
├─ ChatMode/设置页增量拆分
├─ chat.html 独立入口
└─ 新页面接入规范文档
```

### 每阶段的回归检查点
- `pnpm test`（316 例）与 `pnpm typecheck` 全绿；
- 手动走查：划词工具栏（Windows + macOS）、动作结果窗复用、聊天流式 + Agent 审批 + Mermaid、截图（overlay/保存/复制/钉图/OCR 复制）、翻译窗/生词本、设置保存与快捷注册；
- 首次 OCR 使用（模型下载 + 识别）在 **被打包后** 的环境验证一次——注意 `pnpm-workspace.yaml` 的 `allowBuilds.onnxruntime-node: true` 必须保留。

---

##  七、结论摘要

1. **最高性价比动作**：修 `after-pack` 漏剪 onnxruntime 跨平台二进制的问题 —— 安装包 / 解压目录 / node_modules 三处同时瘦身 230 MB 以上，且为零业务代码改动。
2. **内存**：设置窗口「隐藏不销毁 + 启动即建」是最大的可回收项（60~80 MB）；截图全帧驻留次之（10~25 MB）。
3. **速度**：主进程冷启动已是「懒加载 + 极小 bundle(239KB)」的健康状态；剩余可榨的主要是 undici 解析与窗口冷启动的取舍（预热池换内存不推荐）。
4. **重构**：不需要重写技术栈；建议按阶段 3 做「增量分层」为新页面积累健康的接入范式。



---

*审查者：Cline · 2026-09-03 · 基于实际代码与 dist/ 产物独立度量，未改动任何代码。*