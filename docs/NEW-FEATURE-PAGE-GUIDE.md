# 新功能页面接入规范（性能守则）

> 面向后续新增功能页面/面板的开发约束。每一条都来自 0.8.2 性能整改的实测结论，目的是让新功能默认就长在「体积小、内存低、不拖慢启动」的架构上，而不是事后返工。

## 1. 不新增 HTML 入口

Vite 的多 HTML 入口会让每个入口重复执行模块解析并各自引用公共 chunk。构建产物已证实 Rollup 会自动抽出共享 chunk（`useThemeMode-*.js` 含 React，被 4 个入口共用），但入口本身越多，冷启动要加载的 HTML/JS 图越大。

**规则**：新功能 = 现有窗口内的新 section/tab，组件用 `React.lazy(() => import(...))` 挂载（先例：`selectionAction.html` 里 ChatMode 的分流，`action/entry.tsx:16-18`）。只有"独立顶层窗口 + 完全独立的生命周期"才考虑新入口，且需在评审时说明。

## 2. 重依赖懒加载

任何"低频 + 重"的能力（图表渲染、大模型推理、复杂格式解析）不得静态 import 进主 bundle：

- ESM 大包：运行时 `await import(变量说明符) /* @vite-ignore */`（先例：mermaid `Markdown.tsx:32`、ppu-paddle-ocr `paddle.ts`）
- 配缓存上限：mermaid 用 LRU 50（`Markdown.tsx:57`），防止长会话内存爬坡
- 含原生 .node 的依赖：不要加入 `dependencies`——评估走**可选下载**模式（先例：`enginePack.ts`，npm registry 拉取 + sha512 校验 + 系统 tar 解包 + `engine.json` 原子标记）

## 3. 状态必须有界

- 长会话容器（Map/数组缓存）一律设上限或 LRU；请求级 Map 在 `finally` 与 abort 路径都要 delete（先例：`index.ts:861-871`）
- 事件负载有截断惯例：`RESULT_EVENT_MAX=12_000` / `ARGS_VALUE_MAX=500`（`index.ts:448-477`），新的 IPC 大负载照此办理
- 大字符串（图片 dataUrl 等）用完即释放，不挂在长生命周期对象上（先例：`ScreenshotService` overlay init 后立即释放 `currentCapture.dataUrl`）

## 4. 渲染隔离

- 长列表/转录类界面：条目组件 `React.memo` 化，且**所有传给它的回调必须引用稳定**（`useCallback`/`useMemo`），否则 memo 失效（先例：`AssistantTurnBody`，ChatMode.tsx）
- 流式/高频更新：批处理 + 定时 flush（先例：50ms `pendingItemsRef` 队列，`ChatMode.tsx:1207-1227`），不得每个 chunk 一次 setState
- 不提前引入状态库（0.8.1 审查共识）：当前规模 Context + 局部 state 足够

## 5. 窗口生命周期

- 隐藏不等于释放：隐藏的渲染进程常驻几十 MB。需要"关了还能秒开"的表面用 close→preventDefault→hide **加闲置销毁**（先例：settings 60s `index.ts`、toolbar 30s `SelectionService.ts`）；不需要秒开的窗口直接 close 销毁
- 新窗口一律 `sandbox: true` + `backgroundThrottling`；常显窗口（截图遮罩类）才允许 `backgroundThrottling: false` 并说明理由

## 6. 原生能力走零依赖 helper

Windows 原生能力优先用「C# 源码常量 + 本机 csc.exe 现场编译 + 缓存到 userData/bin」模式（先例：`capture.ts` 的 CaptureScreen.exe、`winrtHelper.ts` 的 WinRtOcr.exe），而不是引入原生 npm 依赖。注意：

- helper 保持无窗口（`windowsHide: true`）、有超时、stdin/stdout 传数据不落盘
- WinRT 互操作不要用 `System.Runtime.WindowsRuntime` 的 await 扩展（类型身份是 Win8 单体 winmd，Win10/11 分命名空间下编译不过）；用 `Completed` + `GetResults()` 阻塞等待
- 引用 winmd 需补 `System.Runtime.dll` facade（CS0012）；Win10/11 的 winmd 按命名空间拆分（Foundation/Globalization/Graphics/Media/Storage 各一个）

## 7. 依赖纪律

- 仅渲染器使用的库放 **devDependencies**（Vite 会打进 bundle，electron-builder 不再拷进 asar；先例：react/react-dom/marked/dompurify）
- 主进程真正运行时需要的才进 `dependencies`；每加一个都要评估：安装体积、asar 文件数（externalizeDepsPlugin 会整包散装进 asar）、是否含跨平台二进制
- **守卫**：`pnpm-workspace.yaml` 的 `nodeLinker: hoisted` 是 electron-builder 兼容所需，勿改回 symlink；`electronLanguages` 裁剪保留
- 双 lockfile 禁止回归：仓库只用 pnpm-lock.yaml

## 8. 提交前自检清单

- [ ] `pnpm typecheck` + `pnpm test` 全绿
- [ ] 新增依赖：确认进了 devDeps（渲染器专用）或有不可替代的运行时理由
- [ ] 新窗口：sandbox 开启、关闭策略明确（销毁 or hide+闲置销毁）
- [ ] 新 IPC：负载有上限、preload 返回退订函数
- [ ] 打包一次，对比体积表（docs/PERF-EXECUTION-PLAN-2026-09-03.md 附录），无解释的体积增长不接受
