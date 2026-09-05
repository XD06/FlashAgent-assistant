# 快速翻译 / 语音合成 / 生词本 架构说明

> 本文面向后续开发，描述 0.8.0 新增的快速翻译窗口、TTS 语音合成与生词本（生词收集）三大能力的实现结构。
> 上游协议参考 `STranslate` 仓库根目录的 `PORTING_GUIDE_TYPESCRIPT.md`（含各协议的端到端实测记录）。

## 功能总览

- **快速翻译窗口**：全局快捷键呼出（默认 `Command/Ctrl+Shift+T`，`shortcuts.translate` 可配）。输入回车翻译（Shift+Enter 换行），源/目标语言下拉 + 交换；内置多个免费翻译服务**并行**请求，结果按设置顺序以卡片展示；单词场景附加词典卡片（金山词霸 / 有道，后者含短语与双语例句，例句可播放原始录音、无原音回退 TTS）；窗口高度随内容自适应。
- **语音合成**：OpenAI `/v1/audio/speech` 兼容端点（Edge TTS 音色），翻译窗口的输入框与各译文卡片可一键朗读。
- **生词本**：查询英文单词时可自动或手动收录（存单词 + 金山词典数据快照），设置侧边栏「生词本」子页预览 / 搜索 / 详情弹层 / 导出 Markdown / 清空。

## 模块地图

| 文件 | 职责 |
|---|---|
| `src/shared/translate.ts` | 语言表（`TRANSLATE_LANGUAGES`，code + 原生名）、各服务语言码映射（微软 `zh-Hans`、金山 `cht`、DeepLX 大写）、`isSingleWord`（词典触发条件）、`detectLanguageHeuristic`（脚本启发式识别，仅用于展示） |
| `src/main/translate/microsoft.ts` | 微软翻译。**主模式 = legacy HMAC-SHA256 签名**（`api.cognitive.microsofttranslator.com`，签名只覆盖**不带 `https://` 的路径**，密钥硬编码见文件内注释）；Edge Token 模式（`edge.microsoft.com/translate/auth`）作回退，**失败后退避 10 分钟**（该端点部分地区已 404） |
| `src/main/translate/iciba.ts` | 金山翻译（`dictionary.iciba.com/dictionary/fy/batch`，MD5 固定盐签名 + Origin/Referer/UA 三头必带）与词典（抓 `iciba.com/word?w=` 解析 `__NEXT_DATA__`，校验返回词与查询一致） |
| `src/main/translate/youdao.ts` | 有道词典（0.8.4，可选服务）：`dict.youdao.com/jsonapi` POST 查词，零依赖移植自有道词典 API 参考实现；返回音标/分词性释义（每词性取前 3 条、最多 3 行）/词形/短语（前 3）/双语例句（前 2，含原始配音地址）。dictvoice 音频被有道阻断直链，经 `translate:youdao-audio` 主进程代理换 data URL（LRU 50） |
| `src/main/translate/deeplx.ts` | DeepLX 兼容端点（LibreTranslate 格式 `POST {base}/v1/translate`），端点在设置中配置 |
| `src/main/translate/tts.ts` | TTS 合成：`POST {tts.endpoint}`，body `{ input, voice, speed(数字), pitch(必须字符串!), style }` → MP3 → data URL |
| `src/main/translate/index.ts` | `registerTranslateIpc`：并行跑所有启用服务（每服务 15s 超时、独立 AbortController，重跑自动中止旧请求），按服务回传 chunk；**生词本自动记录钩子**在 icibaDict / youdaoDict 成功分支内 |
| `src/main/vocabulary.ts` | 生词本存储（`userData/vocabulary.json`，内存索引去重）、Markdown 导出构建、IPC 注册（list/add/remove/clear/export） |
| `src/renderer/translate/entry.tsx` | 翻译窗口 UI：回车翻译、语言选择/交换（localStorage 记忆）、服务卡片（占位条→加载→结果）、词典卡（含生词本按钮 + toast）、`ResizeObserver` 上报内容高度 |
| `src/renderer/settings/entry.tsx` | 设置「翻译」分区（服务开关/排序、DeepLX 端点、TTS、自动记录开关、快捷键）与「生词本」子页（网格 chips、搜索、详情弹层、导出/清空） |
| `electron.vite.config.ts` | `translate` 渲染入口注册 |

## IPC 通道（`src/shared/ipc.ts`）

| 通道 | 方向 | 说明 |
|---|---|---|
| `translate:run` | R→M | `{ requestId, text, from, to }`；主进程读设置里启用的服务并行执行 |
| `translate:chunk` | M→R | `{ requestId, serviceId, state: done/error, text?, dict?, detected?, vocabSaved?, vocabJustSaved?, error?, elapsedMs? }`，按服务粒度推送 |
| `translate:abort` | R→M | 中止该 requestId 的全部服务请求 |
| `translate:youdao-audio` | R→M | 有道 dictvoice 音频代理：校验 URL 白名单 → 主进程带 UA/Referer 拉取 → base64 data URL（例句原音与单词发音共用） |
| `tts:synthesize` | R→M | 文本 → audio/mpeg data URL（渲染层 `<audio>` 播放；主进程请求以继承代理链） |
| `vocab:list/add/remove/clear/export` | R→M | 生词本 CRUD；export 弹保存对话框写 Markdown 并在资源管理器定位 |
| `window:adjust-height` | R→M | 翻译窗口高度自适应：渲染层上报文档高度，主进程夹取 [380, 工作区-40] 后 `setBounds`（顶边固定） |

Preload 暴露：`window.assistantLite.translate.*`、`tts.*`、`vocabulary.*`、`windowControls.adjustHeight`。

## 关键数据流

1. **翻译一次的生命周期**：输入 → 回车 → `translate.run(requestId)` → 主进程并行发起启用服务（互不阻塞）→ 每个服务完成即回 chunk → 渲染层按 `serviceId` 更新对应卡片。重新发送会先 abort 旧 requestId。
2. **自动记录生词**：icibaDict 服务成功且 `isEnglishWord(text)` 且 `settings.vocabulary.autoRecord` → `addVocabulary(dict)`（内部大小写去重）→ chunk 带 `vocabSaved`（当前是否已收录）与 `vocabJustSaved`（**本次**新收录，渲染层据此弹 toast；重复查询已收录的词不弹）。
3. **手动记录**：词典卡片 ＋/✓ 按钮 → `vocabulary.add/remove(dict)`（乐观更新 + toast）。`vocabSaved` 由主进程随 chunk 下发，保证按钮初始状态准确。
4. **高度自适应**：渲染层 ResizeObserver 监听 `#root` → `documentElement.scrollHeight` 变化超过 1px 即上报 → 主进程调整外层窗口高度（内容高度含 18px 阴影边距，正好等于窗口外框高度）。宽度仍由用户调整并持久化；高度不持久化。

## 设置项（`AppSettings`）

```ts
translate: {
  // 「已添加」服务，顺序即请求与展示顺序；未添加的内置服务在设置「可选服务」
  // 区列出，点「添加」后进入该列表（移除则回到可选区）。全新安装默认添加：
  // 微软、金山词霸词典、腾讯。目录全集见 shared/translate.ts 的
  // TRANSLATE_SERVICE_IDS（含金山翻译/Yandex/DeepLX）。
  services: Array<{ id: 'microsoft' | 'iciba' | 'icibaDict' | 'tencent' | 'yandex' | 'deeplx', enabled: boolean }>
  deeplxEndpoint: string        // 默认 https://ts.203065.xyz（公共实例，上游故障时 503）
  tencentClientKey: string      // 空 = 内置共享 key；腾讯轮换 key 时在设置中热更新
}
tts: { endpoint: string, voice: string, speed: 0.5–2, pitch: -50–50 }
vocabulary: { autoRecord: boolean }   // 默认 false
shortcuts.translate: string           // 默认 CommandOrControl+Shift+T
translateWindowWidth?: number         // 仅宽度持久化
```

`shared/actions.ts` 的 `mergeSettings` 对以上结构做归一化（未知服务 id 不破坏默认顺序、数值夹取等）；旧版本设置缺字段时回退 `shared/defaults.ts` 默认值。

## 生词本数据结构

`userData/vocabulary.json`：

```jsonc
[{
  "word": "flash",
  "addedAt": 1756..., 
  "phonetics": [{ "label": "uk|us|zh", "phonetic": "/flæʃ/", "audioUrl": "http://res.iciba.com/..." }],
  "meanings": [{ "partOfSpeech": "n.", "means": ["闪耀", "闪光"] }],
  "exchange": { "plurals": ["flashes"], "pastTense": ["flashed"] }  // 全部可选
}]
```

收录条件（自动记录）：`isSingleWord(text)` && `isEnglishWord(text)`（纯拉丁字母，允许 `'`/`-`）&& 词典查询成功。中文词也可手动加入（词典卡有拼音音标），但自动记录只收英文。

## 已知行为与坑

- **`pnpm dev` 不带 `--watch`**：主进程/preload 改动不会自动重建，需重启 dev（渲染层走 vite HMR 不受影响）。
- **词典卡片可见性**：仅 `isSingleWord(input)`（无空白、≤40 字符、含字母）；输入句子时该卡隐藏（占位条也隐藏），空输入时占位条恢复显示。
- **服务分层（已添加 vs 可选）**：`services` 数组只存「已添加」服务，运行时全集是 `TRANSLATE_SERVICE_IDS`，差集即设置页「可选服务」区。归一化（`normalizeTranslateSettings`）**必须保留数组顺序**——曾因按默认顺序重建导致排序箭头失效；未知 id 会被过滤。0.8.0 的全目录顺序（microsoft,iciba,icibaDict,tencent,yandex,deeplx）会被一次性迁移为三服务默认，自定义过顺序的设置原样保留。
- **微软 Edge auth 端点**（`edge.microsoft.com/translate/auth`）在部分地区已 404，因此 legacy 签名是主路径；若 401 优先排查签名 URL 是否带协议头（不应带）。
- **DeepLX 公共实例**可能整体 503（Worker 活着但上游 DeepL 挂），客户端协议无问题；自建参考 `github.com/XD06/deeplx`。
- **TTS `pitch` 必须是字符串**（`"0"` 而非 `0`），`speed` 是数字——edge-tts 桥接协议的约定。
- **低内存机器打包**：electron-builder 7z 打包默认 `-mx=9` 需约 1GB 提交内存，会报 `Can't allocate required memory`；`scripts/dist-win.cjs` 已默认设 `ELECTRON_BUILDER_COMPRESSION_LEVEL=1`（可用环境变量覆盖）。
- 翻译窗口 Esc = 关闭窗口；朗读用同一 `<audio>` 实例，切换播放自动停止上一个。

## 扩展：新增一个翻译服务

1. `src/main/translate/<name>.ts`：实现 `(text, from, to, fetchImpl, signal) => Promise<{ text, detected? }>`，用 `fetchImpl`（`net.fetch`，自动走应用代理链）。
2. `shared/types.ts`：`TranslateServiceId` 加 id。
3. `shared/translate.ts`：语言码映射函数；`shared/defaults.ts`：`defaultTranslateServices` 加默认项（含 enabled 初值）。
4. `main/translate/index.ts`：`runService` 加分支（记得 `withElapsed` 包裹）。
5. `settings/entry.tsx` 的 `translateServiceName` 与 `renderer/i18n.ts` 补服务名词条；需要额外配置项时扩展 `TranslateSettings` 并在设置分区加行。
6. 单测：语言码映射进 `shared/translate.test.ts`，纯函数逻辑放服务文件旁的 `.test.ts`。
