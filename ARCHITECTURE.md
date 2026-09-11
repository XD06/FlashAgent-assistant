# 系统架构全景 (Architecture Overview)

> 本文只记录"看代码看不出来"的内容：系统全景、模块职责边界、跨模块依赖规则与关键数据链路。函数级细节以源码为准。
> 更新时机：进程模型、模块边界或核心数据流变化时（并按 AGENTS.md 的文档同步红线执行）。

## 1. 系统全景架构

```mermaid
graph TD
    subgraph Renderer ["渲染进程（全部 sandbox:true，经 preload 桥通信）"]
        Settings["settings.html<br/>设置窗口"]
        Action["selectionAction.html<br/>划词结果 / 对话（ChatMode lazy）"]
        Translate["translate.html<br/>快速翻译"]
        Overlay["screenshotOverlay.html<br/>截图遮罩"]
        Pin["screenshotPin.html<br/>钉图（零 React）"]
        Toolbar["selectionToolbar.html<br/>划词工具栏（零 React）"]
    end

    subgraph Preload ["preload（contextBridge，唯一桥梁）"]
        Bridge["assistantLite API"]
    end

    subgraph Main ["主进程（全部 IO 与系统集成）"]
        Win["窗口 / 托盘 / 全局快捷键"]
        Sel["SelectionService<br/>（selection-hook 原生模块）"]
        Shot["ScreenshotService<br/>+ GDI 截图 helper"]
        Ocr["OCR 双引擎<br/>系统 WinRT / paddle 引擎包"]
        Trans["translate 服务组<br/>微软/金山/有道/腾讯/Yandex/DeepLX"]
        Agent["AiStream Agent 循环<br/>工具 / 审批 / 快照"]
        Mcp["MCP 管理器（SDK 懒加载）"]
        Store["settingsStore<br/>（electron-store + 归一化缓存）"]
    end

    subgraph External ["外部"]
        AI["AI 服务商<br/>OpenAI-compatible / Anthropic"]
        Up["翻译 / 词典上游<br/>微软·金山·有道·腾讯·Yandex·DeepLX"]
        Reg["npm registry<br/>高精度 OCR 引擎包"]
        OS["Windows 系统能力<br/>csc 现场编译 helper / WinRT"]
    end

    Renderer --> Bridge --> Main
    Win --- Sel
    Win --- Shot
    Shot --> Ocr
    Trans --> Up
    Ocr --> Reg
    Sel --> OS
    Shot --> OS
    Agent --> AI
    Mcp --> AI
```

## 2. 模块划分与依赖边界

- **`src/renderer/`（渲染进程）**：6 个 HTML 入口对应 6 个窗口。只通过 `window.assistantLite`（preload 暴露）与主进程通信，**没有任何直连 Node 或网络的能力**（sandbox 开启）。工具栏与钉图窗口刻意保持零 React 纯内联 JS，以求毫秒级打开；其余窗口共享 React（Rollup 自动抽共享 chunk）。新功能不加 HTML 入口，用 `React.lazy` 组件挂进现有窗口。
- **`src/preload/`（唯一桥梁）**：`contextBridge.exposeInMainWorld('assistantLite', api)`，全部 IPC 调用的类型出口（`AssistantLiteApi`）。事件监听一律返回退订函数。渲染器代码出现 `ipcRenderer` 即为越界。
- **`src/main/`（主进程）**：所有文件、网络、系统集成与常驻状态的归属地。按域分文件（`SelectionService`、`ScreenshotService`、`ocr/`、`translate/`、`agent/`、`mcp/`、`ai/`），IPC 注册集中在各域的 register 函数与 `index.ts`。
- **`src/shared/`（双端共享）**：类型定义、IPC 通道名常量、纯函数（设置归一化、翻译语言映射、上下文计量等）。**禁止 import electron 或 Node API**——它被 vitest 直接测试，也被渲染端引用。
- **依赖方向规则**：renderer → preload API → main；shared 被三者引用但不引用三者。主进程域模块之间允许调用，但设置读取统一走 `settingsStore.getSettings()`（带归一化缓存），禁止各自直读 electron-store。

## 3. 关键数据流向 (Core Data Flow)

- **划词问答**：`selection-hook`（原生全局钩子）→ `SelectionService`（主进程）→ 划词工具栏窗口 → 用户选动作 → `SelectionProcessAction` IPC → 复用 action 窗口（`selectionAction.html`）→ `AiStream` IPC → 主进程 Agent 循环调 AI 服务商 → chunk 流式回传。
- **截图识别文字**：热键 → `ScreenshotService.startCapture` → GDI helper exe（`csc.exe` 现场编译，写临时 PNG，读入内存后立即删除）→ 全屏遮罩选区 → confirm 后主进程裁剪 → 按 `settings.ocrEngine` 分发：系统引擎（`WinRtOcr.exe`，PNG 走 stdin）或 paddle 引擎包（userData 内按需下载）→ 文本进剪贴板 + toast。
- **快速翻译与语音合成**：回车 → `translate:run` → 主进程**并行**执行所有启用服务（每服务独立 15s 超时与 AbortController）→ 逐服务回 `translate:chunk` → 渲染层按 `serviceId` 更新卡片；中英文双向智能互切；词典卡片附带生词本自动收录钩子；全局语音合成（TTS）根据设置调度 Edge TTS 或小米 MiMo 大模型规范播音服务。
- **Agent 工具调用与执行流**：模型工具调用 → 未闭合 JSON 启发式参数流式解析（`parseStreamingToolArgs`）与实时字符计数/展开动效 → 基于 `(round, index)` 轮次物理隔离的稳定 Call ID 派发 → `validateAgentToolArgs` → 连续只读工具并发批处理（`Promise.all`）加速读取 → 细粒度风险分级（内置与 MCP 工具均评估：`forbidden` 毁灭性指令直接拦截 / `dangerous` 危险操作即便在全权限模式也强制暂停审批 / 普通操作全权限自动放行）→ 动态防幻觉守护（拦截虚假测试报告与无工具调用的伪完成声明）→ 编辑后验证引导（自动提示跑测试/构建检查）→ 执行并落盘快照（可回退）与工具输出（截断至 12k 回传）；主进程全局未捕获异常/拒绝拦截与 IPC 4000 字符流式文本有界截断保证进程常驻稳定。
- **对话上下文与历史压缩流**：默认注意力预算 200k tokens（保留区 85% ~170k，触发线 95% ~190k）；长任务单轮/多轮采用死锁破局退避，在发送前或用户点击输入框左下角圆环就地压缩；旧历史经由结构自愈的 `IPC.AiSummarize` 提炼为 5 节复工文档（Recap Doc），若指定压缩模型 404 则无缝降级当前聊天模型；UI 视图完整保留全部轮次，线路层以「复工文档 + 保留区轮次 + 刚输入指令」按需组装重放。

## 4. 核心抽象与设计模式

- **IPC 契约三件套**：`shared/ipc.ts` 通道名常量 + `shared/types.ts` 载荷类型 + preload 的类型化封装。新增通道必须三处同步。
- **设置归一化**：`shared/actions.ts` 的 `normalizeSettings` 是所有设置读取的唯一入口（mergeSettings + 字段级白名单），损坏的 settings.json 不应导致崩溃；`settingsStore` 缓存归一化结果，仅在写回时失效。
- **词典数据快照**：`DictEntry` 是生词本保存的最小完整快照（音标/释义/词形，有道额外含短语与例句）；显示层裁剪（如释义取前 3 条）只发生在渲染层，快照保存完整数据。
- **可选重能力 = 按需下载**：高精度 OCR 引擎包不随安装包分发，运行时从 npm registry 拉取（sha512 校验 + 系统 tar 解包 + `engine.json` 原子标记）到 userData；加载用「变量说明符 + `@vite-ignore`」的运行时动态 import 绕过 CJS/ESM 边界。
- **Windows 原生能力 = 零依赖 helper**：截屏与系统 OCR 都用「C# 源码常量 + 本机 .NET Framework csc.exe 现场编译 + 缓存到 userData/bin」模式；WinRT 互操作不用 `System.Runtime.WindowsRuntime` 的 await 扩展（类型身份是 Win8 单体 winmd，Win10/11 编译不过），用 `Completed` + `GetResults()` 阻塞等待。

## 5. 外部依赖与集成点

- **AI 服务商**：OpenAI-compatible（`/chat/completions` 流式）与 Anthropic；请求层统一采用 Node 原生 / undici 栈（挂接全局 dispatcher，配置 64 连接池、15s 连接超时与 30s Headers Timeout），零 Chromium 跨进程 IPC 缓冲，支持 `[DONE]` 毫秒级流终止与指数退避重试；渲染器仍通过 Chromium 代理。
- **渲染视图与实时预览**：代码块采用 highlight.js 高亮与自适应高度折叠，HTML/SVG 支持无缝切入独立沙箱 iframe 实时预览与全屏覆盖，采用虚拟隐藏与 DOM 缓存杜绝 RenderFrame 重建卡顿。
- **翻译/词典/TTS 上游**：均为 Web API，各自需要签名或固定请求头；Edge TTS 补充请求头防盗链绕过，小米 MiMo TTS 走 OpenAI 兼容聊天补全端点合成音频；有道 dictvoice 音频有防盗链，经主进程代理换 data URL。
- **MCP**：`@modelcontextprotocol/sdk` 懒加载（首次连接才 import），远程 MCP 走 undici 代理。
- **OS 集成**：`selection-hook`（划词，Windows/macOS 双实现）、`csc.exe` 编译的 helper、`Windows.Media.Ocr`、系统托盘与全局快捷键。

## 6. 技术债务与已知取舍

- **主进程依赖散装进 asar**（`externalizeDepsPlugin`，约 3,500 文件）：改为捆绑可再减体积并小幅加快冷启动，但 MCP/undici/conf→ajv 打包有坑，已决定推迟。
- **ChatMode 单文件约 2,400 行**：已做消息体级 memo 化，完整按域拆分等新功能页面需求明确后进行。
- **darwin 引擎包路径未实机验证**：引擎包 manifest 支持 macOS，但没有 macOS 机器跑过完整下载→加载→识别链路。
- **速度 vs 内存取舍**：设置窗口隐藏 60s 后销毁（省内存，重开数百 ms）；划词结果窗口未做预热池（避免常驻渲染进程）。托盘常驻依赖 `window-all-closed` 处理器，勿删。
- **`--max-old-space-size=512`**：为 4K 截图 dataUrl 预留的有意上限，非泄漏症状。
