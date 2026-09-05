# OCR（截图文字识别）架构说明

> 截图工具栏「识别文字」按钮 → 裁剪区域 → OCR 推理 → 文本自动进剪贴板 → 系统通知确认。
> 0.8.2 起为**双引擎**：默认走 Windows 系统引擎（零下载、最快），高精度 PP-OCR 引擎改为按需下载的可选组件（不再随安装包分发）。

## 引擎选择

设置 → 功能模型 →「文字识别引擎」（`AppSettings.ocrEngine`，默认 `system`）：

| 引擎 | 实现 | 精度 | 成本 |
|---|---|---|---|
| `system`（默认，仅 Windows） | `Windows.Media.Ocr`，C# helper 由本机 .NET Framework csc.exe 现场编译（`src/main/ocr/winrtHelper.ts`），与 CaptureScreen.exe 同一套零依赖模式 | 英文/数字基本全对；中文 gist 级可用，小字有部首级误识（实测见 `docs/archive/2026-09-03-ocr-winrt-test-result.md`（本地归档）） | +0 MB、~100-300ms、无常驻内存（每次识别一个短命进程，PNG 走 stdin 不落盘） |
| `paddle`（可选下载） | `ppu-paddle-ocr@6.4.3` + `onnxruntime-node@1.29.0`，进程内 CPU 推理（`src/main/ocr/paddle.ts`） | 逐字复制可靠，中文 UI 文本置信度 0.95+ | 引擎包约 130 MB 下载 / 334 MB 装在 userData；运行峰值 ~365MB、稳态 ~233MB——单例懒加载 + 90 秒空闲自动销毁 |

非 Windows 平台 `system` 不可用，运行时自动回落 `paddle`（未下载则 toast 提示去设置下载）。

### 系统引擎实现要点（src/main/ocr/winrtHelper.ts）

- 小图自动 2x bicubic 放大后再识别（字形太小是 WinRT OCR 的主要误差源）；≤1600px 触发
- 识别结果去掉 CJK 字符间被 WinRT 插入的空格（`textCleanup.ts`，仅两侧均为 CJK 时）
- **刻意不用 `System.Runtime.WindowsRuntime` 的 await 扩展**：其类型身份仍指向 Win8 时代的单体 `Windows.winmd`，在 Win10/11 的分命名空间 winmd 布局下无法统一（CS0012/CS1503）。改用 `Completed` 事件 + `GetResults()` 阻塞等待，编译只需 5 个 winmd + System.Drawing
- 语言：app 语言映射 `zh-Hans-CN` / `en-US`，失败逐级回落（用户配置语言 → 第一个可用识别器）；设置页显示本机可用语言列表

## 高精度引擎的分发（src/main/ocr/enginePack.ts）

- 包清单（版本随应用内置 manifest 固定）：`ppu-paddle-ocr` + `ppu-ocv` + `onnxruntime-node` + `@napi-rs/canvas` + 平台 canvas 二进制（win32-x64/arm64、darwin-x64/arm64、linux-x64-gnu）+ `@techstark/opencv-js`
- 从 npm registry 下载（npmmirror 兜底，走 `proxy.ts` 的全局 dispatcher，代理可用），逐包 sha512 完整性校验，用系统 `tar`（Win10 1803+ 自带 `C:\Windows\System32\tar.exe`）解包到 `<userData>/ocr-engine/node_modules/`；`engine.json` 标记版本，最后写入（原子性：半装状态视为未安装）
- 加载：`import(pathToFileURL(...))` 变量说明符 + `/* @vite-ignore */`（主进程 CJS 引 ESM-only 包的经典解法，类型用本地结构化接口）
- 模型缓存独立于引擎包：首次 `initialize()` 从 HuggingFace 下载到 `~/.cache/ppu-paddle-ocr/<sha256(URL)前12位>/`。**国内直连 HF 会失败**，可用 hf-mirror.com 镜像预热（缓存键与包版本无关）；配置代理后可在线下载；断网时缓存已存在则完全离线
- 设置页提供 下载（含进度）/ 取消 / 删除；删除会先卸载运行中的引擎实例

## 数据流

1. 遮罩工具栏点「识别文字」→ `overlayConfirm({ action: 'ocr' })`
2. 主进程 `handleOverlayConfirm`：无标注走 `image.crop()`，有标注走渲染层光栅化图
3. `recognizeAndCopy(dataUrl, settings)` 按 `settings.ocrEngine` 分发到对应引擎
4. `clipboard.writeText(text)` + 系统通知（字符数 / 置信度或引擎标识 / 耗时）
5. `will-quit` 时 `destroyOcr()` 释放 paddle session（系统引擎无常驻状态）

## 已知坑（均实测）

- `recognize()` 只接受 ArrayBuffer/canvas，不能传文件路径
- stderr 偶见 `The given version [29] is not supported` 告警——onnxruntime 版本协商噪音，不影响结果
- 引擎包下载后首次 `initialize()` 仍需联网拉模型（见上），错误 toast 已提示
- **经典坑：主进程 CJS 引入 ESM-only 包**——动态导入必须用「变量模块名 + /* @vite-ignore */」防止 bundler 改写回 require；删除依赖后 ppu-paddle-ocr 的 `.d.ts` 不再可引用，paddle.ts 用本地结构化类型
- **经典坑：pnpm v10 默认拦截依赖构建脚本**——本项目引擎包改为运行时下载后，`allowBuilds.onnxruntime-node` 已从 pnpm-workspace.yaml 移除；若将来把引擎重新列为开发依赖需恢复

## 扩展

- 换更高精度模型：`new PaddleOcrService({ model: V6_SMALL_MODEL })`（≈30MB），或运行时 `changeRecognitionModel()`
- 小语种：`V5_JAPANESE_MOBILE_MODEL` 等预设
- 结构化输出：`recognize(ab, { flatten: false })` 返回按行分组的 `{ text, score, box }`，可做翻译框选等后续功能
- 系统引擎语言包缺失：Windows 设置 → 时间和语言 → 添加中文/英文「基本键入」即可获得对应 OCR 识别器
