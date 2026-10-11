# 单 agent 实现 guideline

> 状态：**已定稿**（2026-08-24，wafo 与 Claude 逐条 grill 后达成）。本文件是清洁分支的范围与架构真源；
> 与其它文档冲突时以本文件为准。改本文件必须单独成 PR。

## 为什么需要这份文档

`docs/architecture/orbita_v4.5.1/` 有 29 份架构文档，**没有一份是给单 agent 写的**。按"编排 / 委派 / 协同"
与"单 agent / 会话 / 消息链"的关键词密度统计：

| 类别 | 文档 |
|---|---|
| 纯多 agent（单 agent 近零） | `03-execution-modes`(144:5)、`17-moushi-modes`(104:0)、`16-moushi-overview`(101:5)、`15-sijian-batch`(90:2)、`12/13/14` 三个 mode(66:1 / 43:0 / 40:0)、`11-renshi`(56:7)、`09-seam-map`(50:3)、`22-communication`(46:5)、`01-overview`(59:2)、`02-layers`(66:5) |
| 有实质单 agent 内容 | 仅 4 份：`28-session-storage`(1:34)、`27-session-management`(39:30)、`06-core-engine`(22:29)、`20-harness-mapping`(29:14) |

单 agent 在旧体系里没有自己的规格，只作为多 agent 的退化情形零散寄生。**这是它长年"实现不干净"却无从对照的
制度原因**——编排有 20 份规格可查，主链一份也没有。本文件补上这一份。

## 范围基准

参照 **Proma v0.4.1**（其上游首个发布版本，2026-02-08）：

| | Proma v0.4.1 | 旧 orbita |
|---|---|---|
| ts/tsx 总行数 | **23,656**（148 文件） | desktop 83,543 + cell-base 49,879 |
| 内核 | `packages/core` **1,224 行**（仅 provider 适配 + SSE + 高亮） | cell-base **49,879 行** |
| agent 运行时 | **外部 SDK**，自己只写事件翻译层 987 行 | 自写循环 321 行 + 4.9 万行架构 |

基准是**体量参照**，不是功能对标——六个月过去，模型能力与标准都已提高。基准的作用是：
**当本分支的代码量开始逼近旧内核时，说明又在堆了。**

---

## 一、内核：仅使用 pi

- 运行时是 **`@earendil-works/pi-coding-agent`**，**精确锁版本**（`"0.84.2"`，不带 `^`），npm 安装。
- **不 vendored**。要改 pi 的行为走 patch 文件——Proma 用同一套内核做了六个月，补丁全文 **22 行**，
  内容是给几个 OpenAI 兼容网关补重试正则。锁版本已经等于 freeze；vendored 只会把 683 文件 / 144,642 行
  拖进 workspace，重蹈"每次开发浪费上下文"。
- **不自写 agent 循环。** 一个 agent 循环 = 一个 while：把「历史 + 系统提示 + 工具描述」发给模型 →
  回纯文本则结束、带工具调用则执行 → 结果回灌 → 回到第一步。全部复杂度在围着它的六件事上：
  终止判定、工具执行（串行 / 并行 / 超时 / 审批）、上下文压缩、错误分类与退避重试、abort 穿透与清理、
  截断消息的工具失败回填。**这六件在 pi 的 796 行循环里已是成品**，我们不重造。
- 旧 SDK（`cell-base` 49,879 行、`coding-pack` 4,018 行）**不进本分支**。cell-base 的循环只做了六件里的四件
  （缺并行工具执行与截断恢复）；coding-pack 的十个工具与 pi 内建的 `bash/edit/find/grep/ls/read/write`
  重叠八成。缺 `multi_edit` / `patch` 时补单个文件，不建包。

## 二、进程模型

**agent 跑在独立 utility 进程**（Proma 同款：单独 esbuild target，pi 三个包标 `--external`），第一天就拆。

1. **抢事件循环**：不是 bash 阻塞（那是 spawn），是工具结果的大字符串处理与 JSON 序列化。旧实现实测——
   40 轮会话在主进程里序列化了 **14.8 MB** JSON，那段时间窗口不响应。
2. **崩溃隔离**：内核抛未捕获异常或吃满内存不该带走窗口与未落盘的会话。
3. **最难后补**：主进程内写，代码会直接持有内核实例、直接读内存消息数组；等要拆时每一处跨边界读写都得改。
   旧 `AgentManager` 长到 2,937 行，一半是因为它什么都直接持有。

## 三、消息协议

- 内部协议**收编 pi 的 `AgentMessage` / `ContentBlock`——块数组**。
  Proma 的同款做法是收编 Claude SDK 的 `SDKMessage`（`message.content: SDKContentBlock[]`）当内部 UI 协议；
  后来换 pi 内核时 UI 一行没改，338 行适配层吃掉了全部差异。**收编一个真实内核的形状，比自创中立格式更省**——
  中立格式的每个字段语义都要自己想，而答案本来就写在上游里。
- **扁平列表态从块数组派生**，不是相反。旧实现只有扁平态（`ChatMessage.text: string`，工具是平级消息），
  块数组在整条链上从未存在，导致同一条 assistant 内 `[文本, 工具调用, 文本]` 被压成一段文本、块级顺序永久丢失。
- 适配层是唯一吸收内核差异的地方。换内核 = 改适配层，renderer 不动。
- **多 agent 字段只保留 `visibility`**（`user | internal | delegated`）——单 agent 自己就需要它：
  撤回消息（KDEL）、内部消息（压缩摘要、系统注入）。归属 id 与父子会话在单 agent 下永远是同一个值或空，
  留了就是没有消费者的字段。协议加字段是加法，不需要提前占位。

## 四、会话存储

- **我们自己存，JSONL。** 会话模型（列表、恢复、编辑重发、撤回）是**我们真正想拥有**的东西。
  `sessions/<id>.meta.json` + `sessions/<id>.jsonl` 是**记录的唯一真源**：界面上列什么、显示什么，
  只看它。换内核不影响已有记录。
- 规格照 `28-session-storage.md`——它是 29 份文档里唯一以单 agent 为主的一份。
  （**两处冲突，以本文件为准**：它 §12 选 `node:sqlite`，我们用 JSONL；
  它的三层锚点 / 压缩 / 批红是多 agent 的审计机制，单 agent 没有消费者，不做。）

### 续会话：pi 存它自己的本子（2026-08-26 修订）

原文写的是「pi 只当无状态循环——每轮把历史喂进去」。**这一条改掉。**

**改成**：pi 通过它自己的 `SessionManager` 维护一份自己的 session 文件，落在
`<userData>/pi-sessions/`；我们在会话 meta 里记住那个文件路径（`piSessionFile`）。
要续一条旧会话时，把那个文件还给 pi（`SessionManager.open`），而不是我们把历史重讲一遍。

**为什么这不是原文禁的那件事。** 原文担心的是「会话格式被上游绑死」——
指的是**我们的记录**成为上游的人质。现在不会：

| | 存在哪 | 归谁 | 上游改格式时 |
|---|---|---|---|
| 我们的记录（列表 / 显示 / 导出） | `sessions/*.jsonl` | 我们 | **不受影响** |
| pi 的上下文（只为续跑） | `pi-sessions/*.jsonl` | pi | 续不了，记录还在 |

爆炸半径从「整个会话档案作废」缩到「续会话这一个功能坏掉」。

**被否决的方案：自己写反向适配**（`TranscriptItem[]` → pi 的 `AgentMessage[]` 再灌回去）。
它要我们**第二次**翻译一个自己不拥有的格式——`transcript-adapter.ts` 已经翻了一遍
（pi → 协议），反向再翻一遍意味着 pi 每加一种内容块，我们就多一个静默丢内容的 bug。
而且那份翻译无法验证：灌进去的历史模型认不认，只有跑起来才知道。

**先例**：proma 用同一套做法跑了六个月——`AgentSessionMeta` 上是
`sdkSessionId` + `piSessionFile`，resume 那行就是
`SessionManager.open(sessionFile, piSessionDir, cwd)`。它也有「能读不能续」的会话，
用 `legacyTranscript.continuationRequired` 标出来。

**代价，写明白**：没有 `piSessionFile` 的会话（本条修订之前存的、或 pi 那份被删了的）
**只能读不能续**。这是可接受的——界面要如实说出来，不能让输入框看起来能打字。

## 五、工具

pi 内建开七个：`bash` / `edit` / `find` / `grep` / `ls` / `read` / `write`
（旧名单里的 `glob` 是 pi 0.84.3 根本没有的工具，已除名；真源在 `permission.ts` 的
`ENABLED_BUILTIN_TOOLS`，pi 的第八个 `powershell` 不启用）。
`bash` 全开的安全前提是**工具审批 UI 必须在第一版就有**（见下）。

## 六、Provider 与设置面

- `pi-adapter` 的 763 行（provider 契约 / 自定义 provider / 模型目录 / oauth / stream-fn）是真资产，
  但**降级为 `src/main/provider/` 目录，不是 workspace 包**——没有第二个消费者就不建包。
  `pi-agent-adapter`（1 文件 54 行，只为读图）直接删。
- 设置面**从极少的 tab 起步，但 UI 第一天就落**。顺序是**契约先行**：
  provider 契约（参考 `29-provider-schema-proposal.md`）→ main 侧 registry + 迁移 → IPC → UI 最后。
- 旧设置面之所以难用，是因为"provider"在代码里**根本没有定义**：四份类型形状互不相识、三个文件、
  一张 renderer 硬编码的 endpoint 表。先补定义，UI 才有得画。

## 七、UI

- **R6-04 五屏全做**：首页三卡 / 单 agent 任务 / 审批（waiting decision bar）/ 设置 + 模型 / 窄窗 + 暗色。
  每屏只做单 agent 用得到的**深度**（例如设置面只留 provider 一个 tab），但屏本身不缺。
- 审批屏不是装饰——它是 `bash` 全开的安全前提。
- 窄窗 + 暗色不是第五个屏，是前四屏的两个断面，设计系统里本来就是同一套 token；不做等于欠债。
- 全部按 `Orbita Design System/readme.md`，**无豁免区**（编排面将来也一样）。

## 八、仓库与协作

- **orphan 分支，同仓，零行代码起步。** 同仓意味着旧实现随时可查（`git show wip/home-view-zcode:<path>`），
  失去的只是 `git log --follow` 跨边界追单个文件。
- 种子内容：`AGENTS.md` + 本文件 + `Orbita Design System/` + `design/` +
  `docs/architecture/orbita_v4.5.1/`（只作参考）+ `.gitignore` / `package.json` / `bun.lock` 骨架。
- **走 PR，不写 progress 笔记。** PR 是唯一能在代码落地**前**拦住"天降 dead code"的机制——
  "这个新模块的调用点在哪"是 review 时一句话的事，不需要事后审计。大改动前写 `docs/plans/`（Proma 一年四份）。
- 两条旧分支（`wip/home-view-zcode` 38 commit、`origin/refactor/agent-phase-machine` 50 commit）**冻结，只作参考**。
  内核换成 pi 之后，它们之间那 18 个待决冲突大部分失去前提。三样后续单独捞：
  `auto-titler.ts`（LLM 会话标题）、五个 fixture **场景**、设计系统（本就是独立目录）。

## 明确不做

多 agent 编排 / 委派、飞书、桌宠、workflow 编辑器、
Codex / Claude / OpenCode 会话导入。设计资产保留在架构文档里，等单 agent 立住后逐个立项。

## 悬置（不是共识，不要当默认）

1. **「可发布」的具体门槛**——做到 wafo 认为可以为止，目前没有清单。
2. **Proma v0.4.1 那个程度具体是哪些功能**——只对了体量，没有逐条功能表。
3. **肖志锋如何参与清洁分支**——旧内核冻结是产品决定，由 wafo 与他当面谈，非技术判断。

## 附录：支撑上述决定的实测数字

| 数字 | 来源 |
|---|---|
| cell-base 49,879 行 / 导出 332 符号 / 生产消费 35 个 / 运行时 9 个 | barrel 解析 + 全仓引用统计 |
| 那 9 个里 6 个属编排（委派 / 并发 / atom 装配），单 agent 只需 3 个 | 按 import 点归类 |
| 传递闭包 41,426 行（83.1%）；任何路径都到不了 8,453 行 | 从生产入口做 import 闭包 |
| 测试 177 文件 / 2,349 用例，其中 22 文件 / 229 用例守着闭包外代码 | 测试 import 目标反查 |
| 旧协议 40 轮会话推送 14,865,600 B；单帧协议 171,890 B（省 98.8%） | `message-chain.transport.test.ts` 实测 |
| Proma 为驾驭 pi 自写 ~9,200 行（最大一块 `pi-agent-adapter.ts` 2,056 行） | `apps/electron/src/main/lib/adapters/` 统计 |
| Proma 对 pi-ai 的补丁全文 22 行 | `patches/@earendil-works%2Fpi-ai@0.84.2.patch` |
| pi 上游 683 文件 / 144,642 行（不 vendored 的理由） | `~/Documents/repo/pi` |
