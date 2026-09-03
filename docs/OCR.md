# OCR（截图文字识别）架构说明

> 0.9.0 新增的离线 OCR 能力：截图工具栏「识别文字」按钮 → 裁剪区域 → 本地 PP-OCR 推理 → 文本自动进剪贴板 → 系统通知确认。

## 技术选型

`ppu-paddle-ocr@6.4.3`（MIT）+ `onnxruntime-node@1.29.0`（peerDependency，必须显式安装）。

- 百度 PP-OCRv6 官方模型的纯 TypeScript 推理实现：无 Python、无子进程，进程内 ONNX Runtime CPU 推理
- 模型档位用 **v6-tiny**（det 1.8MB + rec 4.3MB + 字典 0.03MB ≈ 6.4MB），实测：初始化 ~200ms、单张截图识别 ~200ms–1s、中文 UI 文本平均置信度 0.95+，是精度/体积/内存的最佳平衡（深色终端小字场景若有错字，可热切换 v6-small，API 一致）
- 运行时资源：推理峰值 ~365MB、稳态 ~233MB——因此实现为**单例懒加载 + 3 分钟空闲自动销毁**（`src/main/ocr/index.ts`），不用则零占用

## 模型分发与缓存

- 首次 `initialize()` 会从 HuggingFace（`snowfluke/ppu-paddle-ocr-models`）下载模型到 `~/.cache/ppu-paddle-ocr/<sha256(URL)前12位>/<文件名>`
- **国内网络直连 HF 会失败**。预热方法：用 `hf-mirror.com` 镜像下载对应文件放入缓存目录，目录名 = `sha256(模型URL)` 前 12 位（缓存键与包版本无关）。应用主进程的全局 fetch 走 `proxy.ts` 设置的 undici dispatcher，配置了代理时可直接在线下载
- 断网时若缓存已存在则完全离线可用

## 数据流

1. 遮罩工具栏点「识别文字」→ `overlayConfirm({ action: 'ocr' })`
2. 主进程 `handleOverlayConfirm`：无标注走 `image.crop()`，有标注走渲染层光栅化图
3. `recognizeAndCopy(dataUrl, settings)`：dataUrl → ArrayBuffer → `service.recognize(ab, { flatten: true })`
4. `clipboard.writeText(text)` + Electron `Notification`（字符数 / 置信度 / 耗时；失败时提示检查网络/代理）
5. 应用 `will-quit` 时 `destroyOcr()` 释放 session

## 已知坑（均实测，详见 STranslate 仓库 MIGRATION_GUIDE_PPU_PADDLE_OCR.md）

- `recognize()` 只接受 ArrayBuffer/canvas，不能传文件路径
- pnpm 10 默认拦截构建脚本：`pnpm-workspace.yaml` 的 `allowBuilds.onnxruntime-node: true` 必须保留，否则 `initialize()` 报找不到原生绑定
- stderr 偶见 `The given version [29] is not supported` 告警——onnxruntime 版本协商噪音，不影响结果
- 打包必须 asarUnpack 原生模块（electron-builder.yml 已配置 onnxruntime-node / ppu-ocv / @napi-rs）；分发体积约 +45MB（单平台二进制 + tiny 模型）

## 扩展

- 换更高精度模型：`new PaddleOcrService({ model: V6_SMALL_MODEL })`（≈30MB），或运行时 `changeRecognitionModel()`
- 小语种：`V5_JAPANESE_MOBILE_MODEL` 等预设
- 结构化输出：`recognize(ab, { flatten: false })` 返回按行分组的 `{ text, score, box }`，可做翻译框选等后续功能
