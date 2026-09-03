# FlashAgent-assistant 性能审查报告

> 基准：v0.8.0（commit `e5fd9af`）· Electron 33 · React 18 · electron-vite
> 日期：2026-09-03 · 结论：**不做大重构**，只做低成本拆分；新功能页优先做懒组件而非新窗口
> 说明：只读审查，未改任何业务代码；数字为本机实测（Windows x64）

---

## 1. 实测基线

| 指标 | 数值 | 备注 |
|---|---|---|
| `node_modules` | 1.2 GB / 537 个顶层包 | `du -sh` |
| `onnxruntime-node` | 284 MB | 生产依赖，最大单包 |
| `electron`（dev） | 272 MB | 正常，不进安装包 |
| `mermaid` | 83 MB | devDeps 但打进 renderer bundle |
| `@napi-rs` | 37 MB | OCR 传递依赖 |
| `ppu-paddle-ocr` 本体 | 0.5 MB | 重的是 runtime，不是它自己 |
| `react` / `react-dom` | 0.4 MB / 4.4 MB | 小 |
| `electron-store` / `undici` / `selection-hook` | 0.4 / 1.6 / 3.1 MB | 小 |
| `marked` / `dompurify` | 0.5 / 1.8 MB | 小 |
| `@modelcontextprotocol/sdk` | 4.6 MB | 已懒加载 |
| `src` 总量 | ~928 KB | 源码不大，问题在依赖和窗口模型 |
| `dist` 旧产物（0.8.0） | Portable 90 MB / Setup 87 MB | 本次要对比的基线 |
| 最大单文件 | `ChatMode.tsx` 2425 行 / `settings/entry.tsx` 1502 行 / `OpenAICompatibleClient.ts` 1116 行 / `main/index.ts` 1154 行 | 重构切入点 |

---

## 2. 已经做对的地方（保持不动）

| 位置 | 做法 | 为什么好 |
|---|---|---|
| `src/renderer/Markdown.tsx:15,32` | mermaid 动态 `import()` + SVG 缓存（上限 50）+ 流式时跳过未闭合 fence | 1.5 MB 的 mermaid 不进首屏 |
| `src/main/mcp/McpManager.ts:51-67` | MCP SDK `Promise.all` 动态导入 | 不开 MCP 的用户零成本 |
| `src/main/ocr/index.ts:12-79` | OCR 单例懒加载 + 空闲 3 分钟销毁；ESM 用 `@vite-ignore` 绕过 CJS 打包 | 200 MB 级引擎只在用时存在 |
| `src/main/settingsStore.ts:19-24` | `normalizeSettings` 结果缓存 | 划词/鼠标高频路径不重复 merge |
| `src/renderer/action/entry.tsx:16-19` | `ChatMode` 用 `React.lazy` | 划词结果窗口不预付聊天窗口成本 |
| `src/main/index.ts:37-44` | 禁 occlusion 降质、V8 `--max-old-space-size=512`、IPv4 pin 5173 | 针对性修复真实坑 |

---

## 3. 问题详述与建议

### 3.1 运行速度

#### S1. 主进程启动即全量 import（最大启动项）

- **现象**：冷启动慢；加新功能会更慢。
- **位置**：`src/main/index.ts:1-32` 一次性 import `AgentTools`（695 行）、`OpenAICompatibleClient`（1116 行）、6 家翻译 provider（`src/main/translate/`）、TTS、vocabulary、skills、截图/划词服务，并在顶层 `new SelectionService` / `new ScreenshotService`（84-109 行）。
- **原因**：首屏（托盘 + 划词）不需要翻译/TTS/Agent，但它们都在启动路径上参与解析和执行。
- **建议**：按 IPC 路由懒加载 —— 翻译、TTS、vocabulary、Agent、WebSearch 改为 handler 内 `await import()`；顶层只留窗口/托盘装配。逐个文件搬运、逐个验证，不改行为。
- **预期**：启动时间下降最明显的一项；风险低。

#### S2. 6 个 renderer 入口各打一份 React

- **现象**：每个窗口都是独立 renderer 进程 + 独立 bundle；新窗口 = 新 React 副本 + 新进程（30-60 MB）。
- **位置**：`electron.vite.config.ts:55-66`，6 个 `input`（settings / selectionAction / selectionToolbar / screenshotOverlay / screenshotPin / translate），无 `manualChunks` / vendor 共享。
- **原因**：默认配置下公共库（react、styles、i18n、icons、hooks）被重复打包 6 次。
- **建议**：开 vendor 共享 chunk；更重要的是**新功能不再加 HTML 入口**，做成现有窗口内的懒路由/懒 Tab（见 §5）。只有 overlay/pin 级别的独立窗口行为才允许新入口。
- **预期**：安装包和各窗口首开时间下降；风险低（纯构建配置）。

#### S3. 流式 Markdown 全量重排（O(n²) 风险）

- **现象**：AI 流式输出时每 50ms 级 flush 都可能触发重渲染。
- **位置**：`src/renderer/Markdown.tsx:139-144`（`marked.parse` + `DOMPurify.sanitize`）+ `useEffect:146-214`（扫 `pre`/`a`/mermaid）。
- **原因**：当前 turn 的每次增量都会对**全文**做 parse+sanitize+DOM 后处理；历史 turn 已 memo，问题只在活动 turn。
- **建议**：flush 合并节流（如 150ms）；流式中（`pending=true`）只做纯文本追加，mermaid 升级和链接后处理等 turn 结束再跑一次（现在 mermaid 已有守卫，见 19-27 行，继续保持）。
- **预期**：长回答流式卡顿下降；风险低。不要换更重的 markdown 库，`marked` 0.5 MB 是对的选型。

#### S4. 截图链路的 base64 三重拷贝

- **现象**：4K 截图一次几十 MB，内存瞬间翻倍。
- **位置**：`src/main/capture.ts:105-135`（落盘 `last-capture.png` 又 `createFromPath`）→ `ScreenshotService` 的 `currentCapture` + dataUrl → renderer 再持一份。
- **原因**：dataUrl 比二进制大 33%，且 NativeImage / main / renderer 各存一份。
- **建议**：主进程内裁剪完直接传文件路径（或 objectURL），renderer 按需读；关闭窗口即置 null + 调 `cleanupCaptureTemp()`。GDI helper 单次编译缓存（`capture.ts:50-68`）是对的，保持。
- **预期**：截图峰值内存降一半以上；风险中（改传参形态，需端到端测 overlay→pin→OCR→识图）。

### 3.2 依赖安装占用

#### D1. `onnxruntime-node` 284 MB（唯一大头）→ **定案：OCR 双轨（2026-09-04）**

- **现象**：`node_modules` 1.2 GB 里它占近 1/4；`electron-builder.yml:14-20` 还把它 `asarUnpack`（不压缩直接散放），Portable 0.8.0→0.8.1 实测 +97 MB（90→187 MB，见 §6）。
- **位置**：`package.json:56` 生产依赖；`src/main/ocr/index.ts` 实际使用。
- **原因**：OCR 是低频功能（bursts），却让所有用户付全价；且精度/体积/依赖三者无兼得方案（GitHub 已翻遍：所有 Paddle 系小库都要外带一个 ort runtime，瓶颈不在库）。
- **决策（双轨，不二选一）**：
  - **轨 1——Win 默认：系统 OCR（`Windows.Media.Ocr`）+ 2x 放大 + CJK 去空格，秒出草稿**。已实测（证据：`ocr-winrt-test-result.md`）：test1（526px）95ms 近乎全对；test2（1480px）381ms gist 可用（`持续/遮罩/复杂/FlashAgent/&&` 全对，残留 `像→亻象`、`规则→规贝刂` 级）。+0 MB、离线。Helper 复用 `capture.ts` 的 csc 现场编译模式（`OcrHelper.exe`，引用分包 winmd + GAC facade 即可编过）。注意：中文能力依赖系统按需功能 `Language.OCR~~~zh-CN`，中文系统一般自带；必须先查 `AvailableRecognizerLanguages`，缺失时提示用户（装包需管理员权限，不能静默装）。
  - **轨 2——高精度 + mac/Linux 后盾：PP-OCR 切 `onnxruntime-web`（wasm）**。`ppu-paddle-ocr` 原生支持 `/web` 入口，只换 backend，不换库不重写调用；eSearch（同类截屏 OCR）已是这条路。备选：runtime 用时下载（`optionalDependencies` + 首次下载解到 userData，复用现有代理/toast；首次用本来就要联网下模型，不新增约束）。
- **待办 spike（半天）**：装 `onnxruntime-web` 只引 wasm EP → `du` 实测增量 + test1/test2 精度回归 + 与 node 版耗时对比，数据出来再动手。
- **预期**：包回 ~90 MB，精度不丢，离线可用；风险中。

#### D2. 双 lockfile + 双打包器

- **现象**：`package-lock.json`（192K）和 `pnpm-lock.yaml`（215K）并存；`electron-packager` 和 `electron-builder` 并存。
- **原因**：历史残留。实际只用 pnpm + builder（`scripts/package-portable.cjs` 的 packager 路径已是备用）。
- **建议**：删 `package-lock.json`，只留 pnpm；删 `electron-packager` 依赖。CI 缓存 `~/.cache/electron` 即可。
- **预期**：安装确定性提高，体积减少有限但维护成本降；风险极低。

#### D3. `mermaid` 83 MB、`dompurify` 放错区

- **现象**：`mermaid` 在 `devDependencies` 却打进生产 bundle；`dompurify` 被 renderer 生产使用却也在 `devDependencies`。
- **位置**：`package.json:63-77`；`Markdown.tsx:2-3`。
- **建议**：`dompurify` 移到 `dependencies`（正确性）；`mermaid` 保持懒加载但改子集导入（如 `mermaid.core.mjs`，按实际图表类型裁剪），或接受现状（它已懒加载，83 MB 只影响开发者安装，不影响运行包）。
- **预期**：`pnpm install --prod` 正确；bundle 可能再小几百 KB；风险低。

#### D4. `undici` 1.6 MB（可删但优先级最低）

- **现象**：主链路已用 Electron `net.fetch`（`index.ts:61`），只有 `proxy.ts:2,62` 用 `undiciFetch` 做一次连通性探测。
- **建议**：用 `net.fetch` 替代探测后删除；不值得单独发版，顺手做。
- **预期**：-1.6 MB；风险极低。

### 3.3 内存占用

#### M1. OCR 空闲 3 分钟偏长

- **现象**：用一次 OCR 后 200 MB 级 RSS 再待 3 分钟。
- **位置**：`src/main/ocr/index.ts:12`。
- **建议**：改 60-90s；单次 `recognizeAndCopy` 场景用完即毁，连续截图/批量识别时才靠单例复用。
- **预期**：-100~200 MB 常驻（OCR 用户）；风险低。

#### M2. 大图 dataUrl 常驻

- **现象**：overlay/pin/识图链路上 base64 字符串在关闭后仍可能被 `currentCapture` / `pinWindows` / 历史消息持有。
- **位置**：`ScreenshotService.ts:51-74`（`currentCapture`、`pinWindows`）、各窗口 close 路径。
- **建议**：审计每个 close/destroy：overlay 确认后即释 `currentCapture`；pin 关闭删 Map 条目；聊天历史图片只留最近 N 张且存压缩缩略图。`--max-old-space-size=512` 上限保留。
- **预期**：多轮识图/多 pin 场景内存不再爬坡；风险中（需逐路径验证，不改行为只加释放）。

#### M3. 长会话 Map 无上限

- **现象**：`abortControllers` / `injectionQueues`（`index.ts:57-60`）、`ToolOutputStore` / `SnapshotStore`（落盘是对的，但内存侧）随请求数增长。
- **建议**：请求结束必 `delete`；历史 tool 输出加条数/TTL 上限；`mermaidCache` 已有 50 上限（好，照抄这个模式）。
- **预期**：防慢泄漏；风险低。

#### M4. 窗口进程数

- **现象**：settings/chat/translate/toolbar/overlay/pin 可并存，每多一个可见窗口多一个 renderer 进程。
- **建议**：沿用现有复用（action 窗口复用做 vision 是对的）；非活跃窗口 `close+null` 而非 `hide` 常驻；toolbar 保持按需创建（P0-2 已做，不要回退）。
- **预期**：空闲进程数最少化；风险低。

---

## 4. 是否需要重构

| 选项 | 判断 |
|---|---|
| 大重构（Tauri / 合并窗口 / overlay 改 Canvas） | **不需要**。旧文档 `docs/REFACTOR-PERFORMANCE.md` 是 v0.6.2 快照，其 P0 多数已落地（sandbox/去 React/marked/窗口复用）；重来一次收益小、回归风险大 |
| 小拆分（推荐） | **需要，但很小**：① `main/index.ts` 按域拆 IPC（translate/agent/screenshot 各一个模块，index 只装配）；② 新页面走懒组件。每次只搬一个域，搬完跑 `typecheck+test+手动` |
| 什么都不做直接加页面 | 不推荐。`ChatMode` 2425 行 + `settings/entry` 1502 行已是大组件，再叠新页面会让 bundle 和回归成本继续涨 |

---

## 5. 新功能页面接入规范（给后续开发）

1. 默认做成**已有窗口内的懒组件**（settings 新 section / chat 新 Tab / action 新模式），用 `React.lazy`。
2. 只有需要独立窗口行为（全局快捷键常驻、overlay 截屏、pin 置顶）才允许新 HTML 入口，且入口内禁止直接 import 重型库，一律动态 `import()`。
3. 主进程新增 IPC 必须进独立域模块并在 `index.ts` 只做一行注册；大数据（图片/长文本）走文件路径，不走 IPC dataUrl。
4. 任何内存 Map 必须带上限或 TTL（参照 `mermaidCache` 50 条）。
5. OCR 走双轨（见 §3.2-D1）：Win 先调系统 OCR（helper 内做 2x 预处理，结果去 CJK 间空格），失败或非 Win 再走 wasm PP-OCR；helper 与模型均按需加载，不进启动路径。

---

## 附：测量方法（可复现）

```powershell
# 依赖体积
du -sh node_modules/mermaid node_modules/marked node_modules/onnxruntime-node node_modules/ppu-paddle-ocr
# 旧包体积
ls -lh dist/*Portable* dist/*Setup*
# 源码规模
wc -l src/main/index.ts src/renderer/chat/ChatMode.tsx src/renderer/settings/entry.tsx
```

---

## 6. 打包对比：0.8.0 → 0.8.1（2026-09-03 实测）

本次将最新代码（`e5fd9af`，含 OCR 功能）升版至 0.8.1 并用同一脚本
（`node scripts/dist-win.cjs --win portable --x64 --publish never`）打出便携包。

| 产物 | 体积 | 说明 |
|---|---|---|
| `FlashAgent-assistant-Portable-0.8.0.exe`（旧，dist 存量） | 90 MB | 2026-08-31 构建，**不含 OCR** |
| `FlashAgent-assistant-Portable-0.8.1.exe`（新） | **187 MB（+97 MB）** | 含 OCR 栈 |
| `out/`（本次构建） | 7.5 MB | 源码 bundle 本身很小 |
| 新包内 `app.asar` | 41 MB | 业务代码 + 打包依赖，正常 |
| 新包内 `app.asar.unpacked` | 320 MB | 全部增量在这里 |

`app.asar.unpacked` 明细（`asarUnpack` 散放、不压缩）：

| 包 | 体积 |
|---|---|
| `onnxruntime-node` | 283 MB |
| `@napi-rs` | 37 MB |
| `ppu-ocv` | 0.1 MB |
| `selection-hook` | 0.3 MB |

### 判断

- **+97 MB 几乎全部来自 9 月 3 日新增的 OCR 功能**（commit `36b4a30`，旧包构建于 8 月 31 日，早于它）。
  其余代码三天内的变化对体积无影响（`out/` 仅 7.5 MB，`app.asar` 41 MB）。
- 次要因素：8 月 31 日 `ea309be` 把 7za 压缩等级默认降到 1（低内存机器打包不爆内存），
  320 MB 原生二进制在 level 1 下几乎没压住，也放大了 exe 体积。
- 这正是 §3.2-D1 的现实版：OCR 让**所有用户**为低频功能付 ~100 MB 安装包 + ~200 MB 运行时。
  定案见 D1 双轨（Win 系统 OCR 默认 + PP-OCR 切 wasm 后盾），目标把便携包打回 ~90 MB。

