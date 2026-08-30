# 通用语言（Ubiquitous Language）

> **这份表逐条累积，不追求一次写全。**
> 收录规则：**某个词在两处指不同的东西、并且已经因此产生过一次真实的误解或 bug**，才加一行。
> 没撞过的词不预先收录——预先收录会让它变成一本没人读的字典，而不是一份事故清单。

## 为什么需要它

`docs/architecture/orbita_v4.5.1/` 那 29 份架构文档与「人说话时」用的是**两套词汇**，
但它们共用同一批单词。架构文档是冻结的参考资料，**不改**（改一份自己没吃透的文档只会引入熵）；
所以对齐的位置在这里：本表说的是**在 orbita 这个分支里、在对话里、在代码里**，一个词指什么。

**冲突时本表优先于架构文档。** 架构文档里的同名概念在本表中单列一行，注明它在那边指什么。

---

## 一、撞车的词

### workspace / 工作区

| | |
|---|---|
| **在 orbita 里指** | **用户面的命名容器**：用户添加进来的一个文件夹，可以起名、可以有多个、可以切换，每个记着自己的会话。 |
| **不指** | 并行 agent 的隔离执行副本。 |
| **架构文档里指** | 隔离执行副本。`07-infrastructure.md §10` 的 `WorkspaceIsolation` / `WorkspaceBackend` / `IsolatedWorkspace { path, branch, baseCommit }`：`createIsolated(basePath, count)` 开 N 份副本 → `collectAndMerge` / `discard`。解决的是「多个 agent 别互相踩」。 |
| **两者的关系** | 不是竞争，是**输入**：`createIsolated(basePath, …)` 里那个 `basePath` 正是本表意义上的 workspace。 |
| **代码里** | `WorkspaceStore` / `session.workspace`。隔离副本**本分支未实现**，也不要为它建接口。 |
| **撞过的地方** | 2026-08-25 排「命名工作区容器」这一刀的范围时，差点按架构文档去建 `WorkspaceBackend`——那是 Pack 层的领域特定实现，本分支没有 Pack，建了就是提前抽象。 |

**将来真要做隔离副本时，用 `worktree`（工作树），不要再用 workspace。** 理由：
- 架构文档自己的三级隔离策略就叫 `shared / isolated / **worktree**`；设计系统的图标词汇也写着 `git-branch = a worktree`。两边本来就用这个词指这件事。
- **不用 `sandbox`**：本仓 `SECURITY_INVARIANTS = { sandbox: true }` 已经占了这个词（Electron 渲染进程沙箱）。再给它第二个意思，正是这份表要治的病。
- **不用 `container`**：Docker 联想太强，而且中文「容器」已经被用来指本表意义上的 workspace（「命名工作区容器」）。

### task / session（任务 / 会话）

| | |
|---|---|
| **同一个东西** | 用户发起的一次对话。**界面上叫 task，代码里叫 session。** |
| **为什么会这样** | 设计系统自己就不一致：内容规范举例写 `"New Session"`，而侧栏按钮、`TASKS` 节点、`task-row status slot` 用的是 task；组件却叫 `SessionCard` / `SessionRow`。我们继承了这份不一致。 |
| **本分支的规则** | **用户看得见的文案一律 task；代码与 IPC 一律 session。** 两边不互相翻译——`sessionId` 不要改叫 `taskId`，UI 也不要出现 "New session"。 |
| **撞过的地方** | 侧栏空态曾在同一屏里既说 task 又说 session。 |

### mode / 模式

| | |
|---|---|
| **设计系统里指** | **Agent mode / Orchestrate** 这一对，即 `ModeChip`。`--color-mode-active-bg` / `-fg`（明蓝暗黄）是为它定的。 |
| **本分支扩展成** | 「一组互斥选项里的当前项」：模式芯片、权限档（Plan / Manual / Skip）、主题档（System / Light / Dark）、侧栏选中行，全部共用 `--color-mode-active-*` 与 `--color-bg-active`。 |
| **规则** | accent 只有两个去处：**主操作**与**当前项**。扩展到上述四处仍在这条规则内；再想给第五个东西上 accent 时，先回来改这一行。 |
| **注意** | 说「模式」时容易被理解成 Agent/Orchestrate。指权限时说**权限档**，指主题时说**主题档**。 |

### 日志 / log

| | |
|---|---|
| **在 orbita 里指** | **运行日志**：写到 stderr / 控制台的那种。 |
| **不指** | 会话的 `<id>.jsonl`。那个说 **transcript 文件**，或者直接说 `.jsonl`。 |
| **撞过的地方** | 2026-08-25 讲会话存储时我通篇管 `.jsonl` 叫「日志」（"日志里的半截行跳过"），wafo 问「日志是什么」——他理解成了运行日志，完全合理。 |

`.jsonl` **是**一个 append-only log，所以叫它日志不算错；问题是这个词在一个同时有
`console.error("[session] 落盘失败")` 的代码库里有第二个所指。谁的所指更常用谁留着，
所以让给运行日志。

### rail / 栏条

设计系统里 **rail 有两个**，别混：

| 英文 | 中文 | 是什么 |
|---|---|---|
| **icon rail** | 图标条 | 侧栏折叠后的 48px 竖条（未做） |
| **action rail** | 动作条 | 内容面右侧的 32px 竖条，放会话动作 |

### 核 / SDK

| | |
|---|---|
| **核在 orbita 里指** | **不含 IO 的判定逻辑文件**。它被单独成文件的理由只有一个：**混在 IO 里没法单测**。边界是文件（不许 import pi），不是包。 |
| **核不指** | 分发单位。核没有版本号、没有导出契约、没有「对外 API」；**功能删了它跟着删**。 |
| **两者的分界** | **核为「当前这个功能」存在；SDK 为「未来的消费者」存在。** 谁决定它该不该存在：核是正在做的功能，SDK 是架构文档。 |
| **要说分发单位时** | 说**包**或 **SDK**，不要说核。要说可单测的纯函数文件时说**核**。 |
| **代码里** | 核落在 `src/orchestration/*.ts`（纯函数 + 同名 `.test.ts`）。**本分支无包**；提包的触发条件是「某个核出现第二个真实调用方（测试不算），且跨进程或应用边界」。 |
| **撞过的地方** | 2026-08-30 讨论多 agent 路线时，我说「每个功能反推出一个核」，wafo 理解成「每个功能都要改 SDK」——于是得出「你不就论证了 SDK 确实需要被改吗」。两边说的不是同一件事。 |

旧内核长到 49,879 行而运行时只消费 9 个符号，病因就在这个区分上：
**你无法对一个 SDK 说「没有第二个消费者就不建包」，因为 SDK 存在的理由就是假设有人要用。**
核没有这个问题：没有调用点的核，删掉成本是零。

### visibility

同一个字段名在架构文档里指**两件不相干的事**，而我们只要其中一件：

| | 值 | 指什么 | 出处 |
|---|---|---|---|
| **我们要的** | `user` \| `internal` \| `delegated` | **会话可见性**：这条记录该不该进用户视图。撤回、压缩摘要、系统注入、将来的委派消息靠它区分 | `27-session-management.md §6.4`；`docs/single-agent-guideline.md §三` |
| **我们不要的** | `private` \| `topic` \| `broadcast` | **通信范围**：pub/sub 的消息派发权限 | `22-communication.md §5`；`07-infrastructure.md L431` |

**在 orbita 里说 `visibility` 一律指前者。** 后者本分支不做——
`22 §5b` 的 Delegation 协议自己就写「不搞广播，所有通信点对点」，与 `§4/§5` 的 pub/sub 体系互相削弱。

| | |
|---|---|
| **代码里** | 将落在 `TranscriptItem` 与 `SessionMeta` 上（G2 那一刀）。**单 agent 自己就需要它**，不是为多 agent 预留的字段。 |
| **为什么现在就要定** | 它是**投影规则**（决定哪些记录进用户视图），不是普通字段。现在加是 1 个字段，编排期加要回填全部历史 `.jsonl` 才能判断旧记录该不该显示。 |
| **撞过的地方** | 2026-08-27 盘点架构文档时，子 agent 报告里同一节内两个 `visibility` 指两件事，需要额外一轮核对才能分清哪个是 `guideline §三` 要的那个。 |

---

## 二、部件译名（外壳）

不是冲突，是固定译名。说话、注释、commit 一律用这一列。

| 部件 | 英文（设计系统原词） | 中文 | 代码 | 层 |
|---|---|---|---|---|
| 整个半透明窗口 = app 的边界 | app boundary | **边界卡** | `.layer` | layer 1 |
| 左边 288px 那栏 | sidebar | **侧栏** | `Sidebar` | 无面 |
| 中间那张大卡 | content pane | **内容面** | `.pane` | layer 2 |
| 右边 32px 细条 | action rail | **动作条** | `ActionRail` | 无面 |
| 输入框 | composer | **输入卡** | `Composer` | layer 3 |
| 侧栏折叠后的 48px | icon rail | **图标条** | — | 未做 |
| 右侧 320px 抽屉 | drawer | **抽屉** | — | 未做 |

「无面」= 不填色、不描边、不分割线，直接坐在边界卡上（设计系统 *Layout*：both sidebars are unbounded）。
