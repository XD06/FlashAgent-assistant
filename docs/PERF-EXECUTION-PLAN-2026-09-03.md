# 性能优化执行文档（四份审查整合·验证版）

> 日期：2026-09-03 ｜ 基准代码：HEAD `e5fd9af`（版本号 0.8.1）
> 说明：本文档由四份独立 AI 审查经「逐条对照代码核查」后整合而成。只保留经代码证据验证的条目；已证伪/过时的建议单列于第三节防止复踩。所有「估计」数字均与「实测」区分标注。
> 目标（沿用原审查要求）：不破坏现有功能的前提下，运行速度、依赖安装占用、内存占用尽可能低；为后续新增功能页面做好架构铺垫。

---

## 〇、四份审查文档可信度结论

| 文档 | 可信度 | 核查结论 | 主要硬伤（已修正） |
|---|---|---|---|
| PERF-AUDIT-AND-REFACTOR-0.8.1.md | 高 | 磁盘/文件数/行号类硬数据几乎全部实测命中（195.8MB、4,277 文件、逐字节吻合），是四份中数据最扎实的 | ① 建议 `setVisualSearchActive` —— **Electron 33 无此 API**；② 「@types 移 dev」——已在 devDeps，过时；③ 内存/延迟数字全部未注明测量方法；④ Base64 峰值 100~200MB 计算错误（编码的是已压缩 PNG，典型桌面截图仅数 MB） |
| PERF-INDEPENDENT-AUDIT-2026-09-03-Cline.md | 高 | 基线与 HEAD 完全一致，体积数字复测精确吻合，316 个测试复跑全绿；「已优化勿回改」清单 12 项全部验证为真 | ① 问题 6 主张错误：Confirm 路径**已**清空 currentCapture（ScreenshotService.ts:232/251），且其建议会破坏无标注裁剪（overlay 仅在有标注时回传 imageDataUrl，无标注时靠 image.crop()）；② undici 惰性 import 收益≈0（applyProxy 本就在启动时调用，index.ts:1095）；③ 行数统计偏旧 5~10% |
| PERF-REVIEW-0.8.0.md | 高 | 经 git 验证：0.8.0→0.8.1 仅为未提交的版本号变更，**无代码级过时**；24 条主张 19✅ 4⚠️ 1❌ | ① S2「React 重复打包 6 次」被构建产物**证伪**：Rollup 已自动抽出共享 chunk（useThemeMode-*.js，237KB，React 只打了一份，4 入口共用）；② M3「Map 无上限泄漏」不成立：请求 finally 与 abort 路径均已 delete（index.ts:861-871）；③ M4 对 settings 窗口 close+null 会改变现有 UX |
| PERF-REVIEW-0.8.1-2026-09-03-CodeBuddy.md | 很高 | 约 25 处文件/行号引用全部精确命中；红线清单 8 项全部验证为真，有长期保护价值 | ① react-dom asar 文件数写 62，实测 **34**；② 「git log 只引入 OCR」实为 11 个提交（但体积翻倍归因于 OCR 仍成立）；③ conf→ajv 是**静态** require（conf/dist/source/index.js:26），非「动态」；④ 「app-builder-bin 可按需下载」不可行，它是 electron-builder 硬依赖，只能 CI 缓存/清理 |

**跨文档矛盾裁定**（已由人工复核实物证据）：
- `@napi-rs` 是否跨平台泄漏 → **无泄漏**。打包产物中 @napi-rs/canvas 仅含 `canvas-win32-x64-msvc`（37MB）。asarUnpack 虽写了 `@napi-rs/**`，但 pnpm hoisted 布局下实际只拷了 win32-x64 一个平台包，无需处理。
- 「195.8MB vs 186.8MB」→ 同一个文件（195,847,380 字节）的十进制 MB / MiB 两种单位。本文档统一：**MB = 十进制（10⁶）**，需要时括注 MiB。

---

## 一、统一度量基线（已实测复核）

| 指标 | 数值 | 备注 |
|---|---|---|
| Portable-0.8.1.exe | 195,847,380 B = 195.8 MB（186.8 MiB） | 较 0.8.0（93.4 MB）**+110%** |
| win-unpacked/ | ≈591 MB | 其中主程序 exe ≈189 MB |
| app.asar | 42,784,316 B = 42.8 MB，**4,277 个条目** | 其中 4,191 个来自 node_modules（zod 641 / MCP 567 / hono 517 / ajv 403 / opencv 184 / undici 157…） |
| app.asar.unpacked | ≈320 MB | onnxruntime-node **283 MB** + @napi-rs/canvas 37 MB + ppu-ocv 0.1 MB |
| onnxruntime 分平台（unpacked 内） | darwin 84 MB + linux 67 MB + win32/arm64 ≈69 MB + win32/x64 63.3 MB | win32/x64 含 DirectML.dll 18.5 + dxcompiler.dll 18.0 + dxil.dll 1.5 = **37.99 MB**；CPU 推理真正需要的只有 onnxruntime.dll 28.0 + binding.node 0.3 = **28.3 MB** |
| node_modules（开发机） | ≈1.1 GB | electron 272 / onnxruntime-node 242 / app-builder-bin 207 / mermaid 83 / @napi-rs 37 / typescript 22 |
| out/（构建产物） | ≈7.5 MB JS/CSS | styles.css 88,860 B 被 6 个入口全量引用；mermaid 系懒加载 chunk ≈4~6 MB |
| 源码规模 | ChatMode.tsx 2,425 行 / index.ts 1,154 行 / settings entry 1,502 行 / OpenAICompatibleClient.ts 1,116 行 | ChatMode 含 28 个 useState、22 个 useEffect、消息项 **0 memo** |
| 测试基线 | vitest 24 文件 / 316 用例全通过 | 任何改动后的回归门槛 |

**未验证估计**（实施前必须先按阶段 0 建基线）：常驻 RSS 320~580MB、设置窗口隐藏驻留 40~80MB、划词弹窗延迟 300~600ms、每渲染进程 30~60MB、OCR 初始化 ~200MB RSS。这些数字方向合理但均无测量方法支撑。

---

## 二、已验证问题与优化项（按优先级）

### P0-1 打包泄漏 onnxruntime 跨平台二进制（四份文档一致发现，全部验证成立）★ 全局最高收益

- **根因有两处**（缺一不可）：
  1. `electron-builder.yml:17`：`asarUnpack: node_modules/onnxruntime-node/**` 把全部平台二进制解包进产物；
  2. `scripts/after-pack.mjs:4,8`：只调用了 prune-selection-hook-win.js 裁剪 selection-hook，未裁 onnxruntime（且非 win32 直接 return，mac/linux 打包同样带全平台）。
- **收益**（对 x64 构建）：
  - 保守方案（保留 win32/x64 整目录含 DirectML）：unpacked 320→66.5 MB，**−254 MB**；
  - 激进方案（再删 x64 的 DirectML 三件套 37.99 MB）：unpacked 320→28.4 MB，**−292 MB**。DirectML 只有切换 DML execution provider 才加载，而 ppu-paddle-ocr 默认 CPU EP（`node_modules/ppu-paddle-ocr/constants.js` `DEFAULT_SESSION_OPTIONS={executionProviders:["cpu"]}`，且 `src/main/ocr/index.ts:37` 无参构造未覆盖）。
  - 便携版预计 195.8 MB → **约 90~95 MB**（压缩率估算，以实际构建为准）。
- **实施要求**：
  - 必须按 `context.arch` / `context.electronPlatformName` 分支裁剪（package.json 存在 `dist:win:arm64` 脚本，arm64 构建需保留 win32/arm64 目录）；
  - 在 afterPack 裁剪（或收紧 asarUnpack 为 `**/bin/napi-v6/win32-x64/**` 类精确路径并按目标平台生成）；
  - 删 DirectML 后跑一次真实「截图→OCR 复制文字」回归（CPU EP 已从源码证实，回归是兜底）；
  - 若未来启用 DirectML GPU 推理需回补三件套（在 CHANGELOG 记录该前提）。

### P0-2 react/react-dom/marked 误放 dependencies（多份一致，已验证）

- `package.json:58-59`（react、react-dom）、marked 也在 dependencies；electron-builder 将其整包拷入 asar（react-dom 4.4 MB + react 0.36 MB + marked 0.46 MB）。
- 主进程与 preload **零 react/marked 引用**（out/main/index.cjs 顶层 require 恰好 10 处：undici/selection-hook/electron-store/electron + node 内置；preload 只 require electron）；渲染侧由 Vite 打进 bundle（React 已在共享 chunk `useThemeMode-D7XVI0HL.js`）。
- dompurify、@types/* 已在 devDependencies（部分文档建议过时，无需动）。
- **收益**：asar −5.2 MB、文件数 −60 上下；**风险**：低（dompurify 先例证明纯渲染依赖放 devDeps 可行）。注意 `externalizeDepsPlugin` 需确认不报错。

### P0-3 仓库与产物垃圾清理（零风险）

- `dist/` 内三代旧安装包（93.4 + 90.6 + 90.0 MB ≈ 274 MB）+ win-unpacked 中间产物滞留，干扰体积对比基线 → 清理并加入 .gitignore（如未含）。
- 双 lockfile 并存：`package-lock.json`（196 KB）与 `pnpm-lock.yaml`（219 KB）。CI（`.github/workflows/ci.yml`、`release.yml`）均为 `pnpm install --frozen-lockfile`，**已确认可安全删除 package-lock.json**。
- `ppu-ocv` 为纯 JS（无 .node），`electron-builder.yml` 中其 asarUnpack 条目可移除（收益微小，顺手做）。

### P1-1 截图管道的真实缺口（核查中新发现的实证 bug + 安全瘦身点）

- **`cleanupCaptureTemp()`（src/main/capture.ts:141-148）全仓库无任何调用点** —— `last-capture.png`（整屏截图）永久残留在 userData，既是磁盘占用也是隐私残留。必须接线：截屏流程结束（confirm/cancel 均含）后调用。
- `currentCapture` 的释放现状比 Cline 文档描述的好：Confirm 两分支均已置 null（ScreenshotService.ts:232/251）、cancel 也清（:107-110）。**真实可做的安全优化**：`ScreenshotOverlayReady` 发送 init payload 后，`currentCapture.dataUrl`（数 MB~数十 MB 字符串）已无用途，可立即置 null；**必须保留 `image`** 至 confirm/cancel —— 无标注裁剪依赖 `image.crop()`（ScreenshotService.ts:250），这正是 Cline 原建议会破坏的路径。
- `--max-old-space-size=512`（index.ts:44）是当前为大图 dataUrl 留余量的有意权衡，暂不动；若后续做管道重构可重估。

### P1-2 设置窗口常驻渲染进程（机制确凿，内存数字为估计）

- `src/main/index.ts:1140`：非 `--hidden` 启动即建设置窗口；`:178-183` close → preventDefault → hide，**永不销毁**。
- 建议方案：保持「启动即建 + 关闭转隐藏」（保住秒开），叠加**闲置 60s 自动销毁**；tray click（:330）、second-instance/activate（:1143-1144）都已走 createSettingsWindow，重建天然兼容。销毁时需清理引用与在途 IPC。
- 预期收益 ~40~80MB（**估计值**，阶段 0 建基线后量化）。

### P1-3 流式渲染粒度（频率问题已解决，粒度问题是真实的）

- 每 50ms flush 批处理**已存在**（ChatMode.tsx:1207-1227，token 先入 pendingItemsRef 队列）——Antigravity 的「每 chunk 一次 setState」说法已被 CodeBuddy 正确反驳，勿回改。
- 剩余问题：delta 到达仍调顶层 `setChat`（:1175/1241/1267/1278/1412），2,425 行组件树全量 re-render；`React.memo` 只包了 MarkdownView（Markdown.tsx:126），**消息气泡/侧栏/输入框均无 memo**。
- 第一刀（低风险）：MessageItem 组件化 + React.memo + 打字中的消息单独隔离为流式子组件，历史消息因已有 memo 不再重渲染。可选第二刀：流式 flush 30~50ms RAF 节流。

### P1-4 划词弹窗延迟（机制属实，数值为估计）

- `src/main/SelectionService.ts:208-220`：无可见窗口时每次 new BrowserWindow → 加载 → React 挂载 → ready-to-show；closeActionWindow（:222-224）真销毁。已有缓解：存在可见窗口时复用（:209-214）。
- 可选方案：预热隐藏单例池（transparent 窗口可安全预创建），展示延迟可到 1~3 帧（**16ms 是理想值，非承诺**）。
- **代价**：常驻一个隐藏渲染进程 ≈ +40~60MB（估计）——与 P1-2 的省内存方向**相反**，需按用户取向取舍（见决策 D3）。

### P2-1 主进程依赖 bundle 化（asar 文件数 4,277 → 数百）

- 根因 `electron.vite.config.ts:7` `externalizeDepsPlugin()` 把全部 dependencies 散装进 asar。
- 方案：主进程纯 JS 依赖改由 Rollup 捆绑，只 external 化含 .node 的依赖（selection-hook、onnxruntime-node 已在 unpacked）。已查实的坑：
  - `ppu-paddle-ocr` 是 **ESM-only**（已用变量名 + `@vite-ignore` 动态 import 规避，ocr/index.ts:21-22）；
  - `conf → ajv` 是**静态** require（可打），但 ajv 生态确有其他动态 require 案例，需逐包验证；
  - `undici` 打包有已知边角案例。
- **收益**（估计）：asar 42.8→约 20~28 MB、文件数→数百、冷启动或有小幅提升；**风险中**，必须回归 MCP/聊天/翻译/OCR 全链路。是否做、何时做见决策 D4。

### P2-2 依赖安装占用（node_modules 1.1GB）

- electron（272MB）、app-builder-bin（207MB）、mermaid（83MB）属构建工具链合理成本；app-builder-bin 为 electron-builder 硬依赖，「按需下载」不可行，只能 CI 缓存/定期清理。
- 真正的大头是 onnxruntime-node（242MB）+ @napi-rs（37MB）——由 ppu-paddle-ocr 拉入。**唯一根治路径是 OCR 双引擎**（见决策 D1）：默认 WinRT `Windows.Media.Ocr`，ppu-paddle-ocr 改可选下载。前置调研已存在（`ocr-winrt-test-result.md`，WinRT 1x 耗时 125ms/213ms、@2x 95ms/381ms——注意原文档把 @2x 数据标在了 1x 尺寸上）。实施时需处理：动态下载与模型管理、双引擎结果差异、`AvailableRecognizerLanguages` 语言覆盖检查。

### P3 架构与规范（面向后续新页面，共识：无需推倒重写，增量分层）

- `index.ts`（1,154 行）服务化分层：窗口/托盘/快捷键/IPC 注册/Agent 循环职责拆出；
- `ChatMode.tsx`（2,425 行）按域拆分（话题持久化、流式、注入队列、工具审批、Diff 视图已在单文件内聚齐）；
- **新页面接入规范**（最重要的预防性条款）：新功能**不加新 HTML 入口**，走现有入口 + React.lazy 组件（Rollup 共享 chunk 机制已被产物证实有效）；toolbar/pin 已是无 React 纯内联 JS 的最优实现，保持；
- styles.css（88.9KB 单体、6 入口全量引用）按域拆分，toolbar 可单独内联关键样式（收益低-中，新页面接入时顺路做）。
- 范围取舍见决策 D5。

---

## 三、已证伪 / 剔除的建议（勿再采信）

| 主张 | 出处 | 证伪证据 |
|---|---|---|
| `webContents.setVisualSearchActive(false)` 促使内存分页移出 | PERF-AUDIT S2.3 | Electron 33 的 electron.d.ts 全文检索零命中，API 不存在。可用替代只有 `session.clearCache()` 或直接采纳窗口销毁策略 |
| React 被重复打包 6 次，需开 vendor/manualChunks | PERF-REVIEW-0.8.0 S2 | 产物实证：Rollup 默认已抽共享 chunk `useThemeMode-D7XVI0HL.js`（237KB，含 React），4 入口共用一份。做 vendor chunk 收益≈0 |
| abortControllers / injectionQueues 等 Map 无上限泄漏 | PERF-REVIEW-0.8.0 M3 | 请求 finally 已 delete（index.ts:861-865）、abort 路径已 delete（:869-871）；ToolOutputStore/SnapshotStore 为落盘实现 |
| 确认截图后清空 currentCapture（image+dataUrl 都清） | Cline 问题 6 | Confirm 路径已清空；且清掉 image 会破坏无标注裁剪（overlay 仅在有标注时回传 imageDataUrl）。改为「init 后仅释放 dataUrl」 |
| undici 顶层 require 拖慢冷启动，改惰性 import 省「几十毫秒」 | Cline 问题 5 | `index.ts:1095` whenReady 第一步就 `void applyProxy(...)`，undici 仍在启动时加载，收益≈0 |
| @types/*、dompurify 移至 devDependencies | PERF-AUDIT S1.2 / Cline 问题 2 | 已在 devDependencies（package.json:63-77），过时 |
| mermaid 是用户侧性能问题（>100MB、40+ 分包） | PERF-AUDIT P2c | mermaid 是 devDependency 且懒加载 + LRU 50（Markdown.tsx:15/32/57），不进安装包、不出现即零成本。仅开发机磁盘成本，无用户侧动作 |
| Base64 dataUrl 造成 100~200MB 堆峰值 | PERF-AUDIT P3b | 编码对象是已压缩 PNG，典型桌面截图仅数 MB；方向（避免大字符串跨进程拷贝）对，数字作废 |
| 设置窗口 close+null（即刻销毁） | PERF-REVIEW-0.8.0 M4 | 与现有「隐藏保秒开」UX 冲突；采纳闲置 60s 销毁的折中方案 |
| 「git log 显示该版本只引入了 OCR」 | CodeBuddy P0 | 实为 11 个提交；体积翻倍归因于 OCR 引入的原生依赖仍成立 |

---

## 四、红线清单（已验证的既有优化，重构时勿回改）

以下 12+8 项经核查全部属实，是当前性能的基本盘：

1. OCR 单例懒加载 + 3 分钟空闲销毁（ocr/index.ts:12,19-25,56-79）；
2. MCP SDK 懒加载（McpManager.ts:51-67 动态 import）；
3. mermaid 动态 import + LRU 50 + 流式跳过未闭合 fence（Markdown.tsx:15,19-27,32,57）;
4. 流式 50ms 批处理 flush（ChatMode.tsx:1207-1227）；
5. Markdown 视图 React.memo + marked/DOMPurify（Markdown.tsx:2-3,126）；
6. ChatMode 以 React.lazy 分流进 selectionAction 入口（action/entry.tsx:16-18）；
7. toolbar/pin 窗口零 React 纯内联 JS + 按需创建/空闲销毁（SelectionService.ts:137-145）；
8. preload 8 个 on* 监听全部返回退订函数；
9. 全部窗口 sandbox:true + backgroundThrottling；划词剪贴板 fallback 已禁用（SelectionService.ts:26-29 注释明确）；
10. Electron 语言包裁剪（electron-builder.yml electronLanguages）；
11. 事件负载截断（RESULT_EVENT_MAX=12,000 / ARGS_VALUE_MAX=500，index.ts:448/460）；
12. `--max-old-space-size=512`（index.ts:44，大截图权衡，属有意为之）；
13. Exa 搜索手写 JSON-RPC 客户端（WebSearch.ts，未引入 SDK）。

**守卫条款**：`pnpm-workspace.yaml` 的 `nodeLinker: hoisted` 是为 electron-builder 兼容的有意配置（symlink 布局打不进包），**勿改回默认**；`allowBuilds.onnxruntime-node: true` 必须保留。

---

## 五、分阶段执行计划

### 阶段 0：建立测量基线（半天，先行）

多数运行时数字目前是「未验证估计」，先补测量再动手，否则无法证明收益：
- 启动耗时：主进程 `ready-to-show` 打点（设置窗口/划词窗口分别测）；
- 常驻 RSS：启动 1 分钟后采样主进程 + 各渲染进程（`process.memoryUsage()` / `app.getAppMetrics()`），重复 3 次取中位；
- 划词弹窗延迟：从选词到窗口可见打点 10 次取中位；
- 产物体积：以本文档第一节为基线，每次打包后更新对比表。
产出：基线数字追加到本文档附录。

### 阶段 1：打包瘦身（低风险，预期便携版 195.8 → 约 90~95 MB）

| # | 事项 | 依据 |
|---|---|---|
| 1.1 | onnxruntime 按 arch/平台裁剪（改 after-pack.mjs + 收紧 electron-builder.yml asarUnpack），DirectML 三件套去留按决策 D2 | P0-1 |
| 1.2 | react / react-dom / marked 移至 devDependencies | P0-2 |
| 1.3 | 删除 package-lock.json | P0-3 |
| 1.4 | 清理 dist 旧产物 | P0-3 |
| 1.5 | 移除 ppu-ocv 的 asarUnpack 条目 | P0-3 |

回归门槛：`pnpm typecheck` + `vitest run`（316 用例）+ 打包后实测体积 + 手工冒烟（划词问答、翻译、截图→OCR 复制文字、MCP 工具调用、设置页）。

### 阶段 2：内存与渲染（低风险）

| # | 事项 | 依据 |
|---|---|---|
| 2.1 | 接线 cleanupCaptureTemp（confirm/cancel 后清理临时 PNG） | P1-1 实证 bug |
| 2.2 | init payload 发送后仅释放 currentCapture.dataUrl（保留 image） | P1-1 |
| 2.3 | 设置窗口闲置 60s 销毁（保留启动即建 + hide 秒开）——按决策 D3 | P1-2 |
| 2.4 | MessageItem 组件化 + React.memo + 流式消息隔离——按决策 D5 范围 | P1-3 |
| 2.5 | OCR 空闲销毁 3min → 60~90s——按决策 D7 | P2-2 附带 |
| 2.6 | 划词窗口预热池——按决策 D3（与 2.3 方向相反，二选一或都做需明示取舍） | P1-4 |

### 阶段 3：中风险改造（需全链路回归）

| # | 事项 | 依据 |
|---|---|---|
| 3.1 | 主进程依赖 bundle 化——按决策 D4 | P2-1 |
| 3.2 | 聊天历史 vision 图缩略图化（当前全尺寸 dataUrl 存于 ChatTurn 状态，多轮识图内存爬坡）——核查中新发现 | 补充发现 |
| 3.3 | （可选）截屏 C# helper 改 stdout 直传像素，消除 PNG 落盘往返；实施前对比验证画质与耗时净收益 | P1-1 延伸 |

### 阶段 4：架构铺垫（面向新功能页面）

| # | 事项 | 依据 |
|---|---|---|
| 4.1 | index.ts 服务化分层（窗口/托盘/快捷键/IPC/Agent 循环拆出）——按决策 D5 范围 | P3 |
| 4.2 | ChatMode.tsx 按域拆分——按决策 D5 范围 | P3 |
| 4.3 | 固化新页面接入规范：不加 HTML 入口、React.lazy 组件、域模块、Map 上限模式 | P3 |
| 4.4 | styles.css 按域拆分（新页面接入时顺路） | P3 |

### 横向要求

- 每个阶段结束跑全量回归（typecheck + 316 用例 + 冒烟清单）；
- 涉及打包的阶段（1、3.1）必须对比体积表；
- 阶段 2/3 的内存与延迟收益用阶段 0 的基线复测验证，不引用任何「估计值」作为完成依据。

---

## 六、待决策事项（执行前需用户拍板）

| # | 决策 | 选项 | 推荐 |
|---|---|---|---|
| D1 | OCR 引擎策略 | A：维持 ppu-paddle-ocr 单轨，只做阶段 1 裁剪（包回到 ~90-95MB，工程量小，本次落地）；B：WinRT 默认 + paddle 按需下载（node_modules 再 −280MB、包可更小，但工程量大、识别质量有差异、需模型动态下载，适合作为下个版本目标） | 先 A 后 B |
| D2 | DirectML 三件套（x64 共 38MB） | 删（CPU EP 已证实，未来 GPU 推理时回补）/ 保留 | 删 |
| D3 | 速度 vs 内存取向 | 设置窗口闲置销毁（省内存 ~40-80MB，重开慢数百 ms）与划词窗口预热池（展示 <50ms，但常驻 +40-60MB）方向相反：只做省内存 / 只做提速 / 两个都做 | 只做省内存（用户目标明确写了内存要低） |
| D4 | 主进程依赖 bundle 化（asar 4,277→数百文件、−15~20MB） | 本次做 / 推迟到双引擎落地后 / 不做 | 推迟（风险中、收益低于 D1，避免一次改太多） |
| D5 | 架构拆分范围 | 最小：只固化新页面规范 + MessageItem memo 第一刀 / 完整：index.ts 服务化 + ChatMode 按域拆分 | 最小先行，完整拆分放在新页面需求明确后 |
| D6 | 杂项确认（默认全做） | 删 package-lock.json；清理 dist 旧产物；接线 cleanupCaptureTemp；dataUrl 早释放；ppu-ocv asarUnpack 移除；**删 electron-packager + pack:portable 脚本（需确认该打包路径不再使用）** | 除 electron-packager 项外默认执行；pack:portable 等用户确认 |
| D7 | OCR 空闲销毁时长 | 维持 3 分钟 / 缩至 60~90s | 缩至 90s |

---

## 附录 A：0.8.2 执行结果（2026-09-04 落地）

按第六节决策执行完毕（D1=B、D2/3/5/6/7 按推荐；D4 推迟）。注：D2（删 DirectML 三件套）随 D1=B 引擎移除一并自然解决——onnxruntime 整树不再进包，收益超过原计划。

| 指标 | 基线（0.8.1） | 0.8.2 | 变化 |
|---|---|---|---|
| 便携版（项目脚本 dist:win，压缩等级 1） | 195.8 MB | **89.6 MB** | **−54%** |
| 便携版（默认压缩，参考值） | — | 70.5 MB | — |
| Setup 安装包 | 90.6 MB（0.8.0） | 89.8 MB | 与 0.8.0 持平（功能净增） |
| win-unpacked | 591 MB | **252 MB** | −57% |
| app.asar | 42.8 MB / 4,277 项 | 22.5 MB / 3,566 项 | −48% / −17% |
| app.asar.unpacked | 320 MB | **304 KB**（仅 selection-hook） | −99.9% |
| node_modules（开发机） | 1.1 GB | 783 MB | −29% |
| 启动常驻 RSS（4 进程实测） | 320~580MB（未验证估计） | **≈363 MB**（主 80 + 渲染 46 + GPU 125 + utility 111） | 首个实测基线，便携版打包后测得 |

验证记录：
- 回归：typecheck 全绿；vitest 27 文件 / 332 用例全通过（较基线 +3 文件 +16 用例）。
- 系统引擎端到端（win32-only 测试，真机执行）：csc.exe 现场编译 helper → 识别 test1.png 含 "DevLog"；test1 322ms / test2 619ms（含进程启动）。
- 引擎包端到端（落地前实测）：32.3s 下载安装 334 MB 包树 → 从 userData 加载 ppu-paddle-ocr → 初始化 → 识别两样本，逐字质量优于系统引擎（"我是Eason"、"高质量、高性能" 全对）。
- 打包产物冒烟：0.8.2 便携版启动正常（4 进程）；设置窗口闲置销毁代码路径与 toolbar 30s 销毁同模式（isVisible 守卫验证启动可见窗口不被误杀）。

提交序列：`96b82a9` 依赖整理 → `aaf4f30` WinRT 系统引擎 → `8af32ee` 高精度引擎可选下载 → `b66ba8b` 内存三项 → `eaafa92` 转录 memo → `4895dcd` 发布文档。

遗留（按执行文档原阶段规划顺延）：
- 阶段 3：主进程依赖 bundle 化（D4 推迟）；聊天历史 vision 图缩略图化；截屏 stdout 直传像素（可选）。
- 阶段 4：ChatMode 完整拆分与 index.ts 服务化（新页面需求明确后）；user turn 编辑流 memo 化。
- 双引擎的 macOS 打包与引擎包 darwin 下载路径需在 mac 机器上实测（manifest 已支持 darwin-x64/arm64，未实机验证）。

## 附：与既有文档的关系

- 本文档取代四份审查作为唯一执行依据；四份原文保留供溯源。
- `REFACTOR-PERFORMANCE.md` 为 v0.6.2 归档快照，其 P0 多数已落地（toolbar/pin 去 React 有产物实证），不再作为待办来源。
