# 系统原生 OCR（Windows.Media.Ocr）试跑结果

- 方法：`WinRtOcrTest.exe`，C# 调用系统内置 `Windows.Media.Ocr`，用本机自带 `csc.exe` 现场编译，**零第三方依赖、零下载**
- 引擎：`zh-Hans-CN`（本机可用语言：`en-US, zh-Hans-CN`）
- 耗时含引擎首次加载；二次调用会更快

## test1.png（53.0 KB，526x509，耗时 125ms）

```text
Ding's DevLog 关 于 我 《 About Me 、 你 好 ， 我 EEason Dingo 专 注 于 构 建 高 质 匣 、 局 性 能 的 数 字 核 心 目 标 ： 通 过 极 简 的 设 计 与 硬 核 的 代 码 解 决 杂 问 题 ， 致 力 于 打 造 极 致
```

## test2.png（42.4 KB，1480x680，耗时 213ms）

```text
0 思 考 生 扌 寺 续 了 78 秒 画 面 里 文 本 比 原 始 帧 大 约 2 倍 且 发 车 欠 一 一 亻 象 是 图 片 被 放 大 显 示 。 查 CSS 里 是 否 有 zoo m / 缩 放 相 关 规 则 ： 终 端 cd "C:\Users\dsk\Desktop\FIashAgent-assistant" & & grep 一 n "zoom\lscale(" src/renderer/styles.css 》 head ． 1 0 电 脑 控 制 生 2 个 事 亻 牛 ， 0 条 氵 肖 息 0 思 考 生 扌 寺 续 了 14 秒 行 亮 度 剖 面 的 互 相 关 直 接 氵 则 出 罩 窗 凵 显 示 图 像 的 缩 放 系 数 （ 内 容 无 关 ） 终 端 cd "C:\Users\dsk\Desktop\FIashAgent-assistant" & & python -c " from PIL import lmage import numpy a s n p im 0 思 考 生 扌 寺 续 了 1 3 6 秒 方 差 对 比 被 “ 选 区 内 / 外 “ 几 何 扌 高 混 了 。 像 素 比 值 冬 直 接 定 位 罩 的 实 际 暗 化 区 域 ， 然 后 只 在 真 正 的 选 区 内 评 估 洁 晰 度 终 端 cd "C:\Users\dsk\Desktop\FIashAgent-assistant" & & python -c " from PIL import lmage import numpy a s n p F 3 个 事 件 ， 1 条 消 息
```

## 追测：2x 放大预处理（同一引擎）

把图用高质量双三次插值放大一倍再识别：

### test1.png @2x（1052x1018，95ms）

```text
Ding's DevLog 关 于 我 丨 About Me 你 好 ， 我 是 Eason Dingo 专 注 于 构 建 高 质 更 、 局 性 能 的 数 字 核 心 目 标 ： 通 过 极 简 的 设 计 与 硬 核 的 代 码 解 决 复 杂 问 题 ， 致 力 于 打 造 极 致
```

相对 1x 修复：`我是`、`复杂`；残留：`质更`、`丨`。

### test2.png @2x（2960x1360，381ms）

```text
思 考 · 持 续 了 78 秒 画 面 里 文 本 比 原 始 帧 大 约 2 倍 且 发 软 一 一 亻 象 是 图 片 被 放 大 显 示 。 查 CSS 里 是 否 有 z 。 。 m / 缩 放 相 关 规 贝 刂 ： 终 端 cd "C:\Users\dsk\Desktop\FlashAgent-assistant" & & grep · n "zoom\lscale(" src/renderer/styles.css | head · 1 0 & 电 脑 控 制 · 2 个 事 件 ， 0 条 消 息 0 思 考 · 持 续 了 14 秒 用 行 亮 度 剖 面 的 互 相 关 直 接 测 出 遮 罩 窗 囗 显 示 图 像 的 缩 放 系 数 （ 内 容 无 关 ） · 终 端 cd "C:\Users\dsk\Desktop\FIashAgent-assistant" & & python " from PIL import lmage import numpy as n P im 0 思 考 · 持 续 了 1 36 秒 方 差 对 比 被 " 选 区 内 / 外 " 几 何 搞 混 了 。 用 像 素 比 值 图 直 接 定 位 遮 罩 的 实 际 暗 化 区 域 ， 然 后 只 在 真 正 的 选 区 内 评 估 清 晰 度 ： 终 端 cd "C:\Users\dsk\Desktop\FIashAgent-assistant" & & python " from PIL import lmage import numpy as n p F ： 3 个 事 件 ， 1 条 消 息 >
```

相对 1x 修复：`持续`、`遮罩`、`评估清晰度`、`FlashAgent`（一处）、`&&`、`|`、`搞`；残留：`像→亻象`、`规则→规贝刂`、`zoom→z。。m`、`lmage`。

### 结论

主因是**字形太小**，不是模型不行。2x + 事后去掉中日韩字符间空格（一个正则），可读性达 gist 可用；部首级误识（`亻象`/`规贝刂`）是引擎上限，修不掉但低频。

##  verdict（供决策）

- 英文和数字基本全对；中文大意可读，但小字和标点错误多（持继→"生扌寺"、消息→"氵肖息"、Image→"lmage"、Flash→"FIash"、`&&`→"& &"、`|`→"》"），且中英文之间有多余空格
- 结论：** gist 级可用，逐字复制不可靠** —— 明显低于 PP-OCRv6 的水平
- 速度 100-200ms，比 PP-OCR 快；体积 +0M，离线可用
