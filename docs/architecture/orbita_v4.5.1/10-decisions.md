[AI 生成]

# 璇玑 架构决策参考

> 璇玑 架构决策参考：102 条决策按架构层级分组。决策编号 1-95 保持不变（v3 1-69 + v4 70-95），决策 96-102 为后续新增。
> 状态：stable
> 维护：@XZF（主笔）
> 讨论：无
> 待决：无


---

## 决策记录格式说明

决策 1-95：三段式（选择 / 理由 / 影响）保持原样，禁止回填五段式扩展（G3 防护）。
决策 96+：五段式（选择 / 理由 / 影响 + 讨论来源 + 实现 PR）。

```markdown
## 决策 N：标题

**选择**：xxx

**理由**：xxx

**影响**：xxx

**讨论来源**：Discussion/Issue 链接 或 #OPEN-N

**实现 PR**：#PR-N 或 无
```

禁止修改决策 1-95 以补齐五段式扩展（G3 防护）。
---

## 第一组：基础架构（决策 1-22）

这组决策定义了 璇玑 的基础架构骨架。

---

## 决策 1：底座定位

**选择**：璇玑 是内部架构，不是通用框架。接口可以携带 coding 语义（例如 filePath、repoUrl 等字段直接写在接口上）。

**理由**：底座面向的是 coding agent 场景，不是泛化的 agent 框架。带有领域语义的接口能让 Phase 1 实现更简单，调用方也更直观。

**影响**：接口设计不需要过度抽象。例如 Session 接口可以暴露 `getProjectState()` 而不是泛化的 `getMetadata(key)`。

> **v4 修改注记**：本决策被决策 70 推翻。v4 璇玑 改为通用多 Agent 协作底座，核心接口领域中立，不携带 coding 语义字段。领域能力通过 Domain Pack（决策 71）注入。原 coding 语义（filePath、repoUrl、projectState.files/cwd 等）迁移到 coding-pack。

---

## 决策 2：核心自研 + pi 横切复用（原「基于 Pi 调整」）

**选择**：璇玑 核心契约（微内核 6 一等概念：Agent/Loop/User/Communication/State/Pattern、图状通信、事件溯源 State、编排两层 Pattern、四库机制、User 一等公民）**自研实现**，由 璇玑 定义接口与语义；pi 的横切能力**分面复用**（详见决策 140）——有状态/行为类（LLM 层 pi-ai、单 Agent 运行时 pi-agent-core、传输 pi-client/pi-server、存储 pi-session-backend-sqlite-node）**经 Adapter Layer 适配**，纯类型/纯渲染叶依赖（契约层 pi-telemetry/pi-protocol、TUI pi-tui）**直接复用**。核心契约自研与 pi 横切复用边界清晰：璇玑 核心层不依赖 pi，pi 仅作为 Infrastructure/实现层的可选依赖注入；任何 璇玑 代码不直接 import 有状态/行为类 pi 包，统一经适配层桥接 璇玑 自有接口。

**理由**：璇玑 的核心价值在微内核与编排组装（多 Agent 协作底座），pi 没有也不会有这些能力，必须自研；而 pi 是成熟的分层 SDK（L0 契约→L1 AI→L2 运行时→L3 传输→L4 应用），其 LLM 接入、协议、存储等横切能力踩过大量 edge case，复用避免重复造轮子，把精力投入 璇玑 独有的一等概念与编排组装。复用方式采用分面适配（决策 140）：璇玑 fork pi 到 `璇玑/pi-sdk/` 需定期同步上游，适配层收敛依赖、隔离升级/替换风险，纯类型与纯渲染叶依赖直接复用省去无谓样板。

**影响**：原「所有代码原创、Pi 只作设计参考、不产生任何直接依赖」被推翻；原「代码实现全部建立在 pi 基础上」的表述同步修正为「核心自研 + pi 横切复用（分面适配）」。决策 19（pi-ai，经 Adapter Layer）/决策 20（pi-tui，直接复用）与本次修订一致。01-overview.md 原则 3、README.md 原则 3 同步更新。引入 pi 依赖的许可与版本耦合风险转为「评估项」；pi 仅作横切层，升级/替换仅影响适配层，核心契约零改动。

**变更记录**：v2.21 — 横切借鉴对象由 pi 转向 dsh（见决策 145「引用/借鉴 dsh + 核心自研」）；pi 现行 LLM Provider 实现暂保留。
**变更记录**：v2.19 — 复用方式细化为分面适配（决策 140）：有状态/行为类（pi-ai/pi-agent-core/传输/存储）经 Adapter Layer，纯类型/纯渲染叶依赖（pi-telemetry/pi-protocol/pi-tui）直接复用。
**变更记录**：v2.18 — 由「基于 Pi 调整」改为「核心自研 + pi 横切复用」：微内核/编排/通信/状态/用户/四库核心契约自研，pi 仅作横切能力复用（LLM/契约/存储/传输/TUI/单 Agent 运行时）。
**变更记录**：v4.15 — 由「与 Pi 完全独立」改为「基于 Pi 调整」，代码实现全部建立在 pi 基础上避免重复造轮子。

---

## 决策 3：接缝原则

**选择**：Phase 1 到 Phase 3 之间会变化的边界必须是接口。不变化的边界直接硬编码。

**理由**：接口是有成本的（理解成本、跳转成本、mock 成本）。只有预计会变的边界才值得引入接口。

**影响**：核心的 Agent Loop 逻辑在 Phase 1-3 之间不变，不抽象成接口。底层的存储、网络、调度等预计会变，必须抽象。

---

## 决策 4：两层接缝分离

**选择**：运行时扩展（6-slot）和基础设施接口完全分开。extensions 是 per-agent，infrastructure 是 system-wide。

**理由**：两者的变更频率和驱动因素完全不同。extensions 随 Agent 定义变化（一个 Session 内多个 Agent 可以有不同的 extensions），infrastructure 随部署环境变化（单机 vs 集群）。

**影响**：Core 层同时持有两组接口，但职责边界清晰。扩展系统在 Agent 创建时注入，基础设施在系统启动时注入。

> **v4 修改注记**：v4 扩展。不限制数量的原则升级为预算驱动的派发权限下沉（见决策 73）。架构不再硬编码递归深度，而靠 Identity.capabilities（"dispatch"/"contact"/"broadcast"）+ dispatchBudget 控制。架构硬兜底上限 10。

---

## 决策 5：Session 是对话容器（单 Agent 优先，协作叠加）

**选择**：Session 的首要职责是承载单个 Agent 的对话历史（持久化/恢复/分支），多 Agent 协作通过在核心对话容器上叠加共享字段（domainState/activityLog）实现，而非从「团队工作区」倒推定义接口。

**理由**：单 Agent 是 璇玑 的最小执行单元，Session 必须先满足单 Agent 的需求——消息持久化、上下文恢复、对话分支——再扩展到多 Agent 共享。「团队工作区」是多 Agent 的上层需求，不应决定底层接口的形态。没有单 Agent 的 Session 定义，就没有多 Agent 协作的基础（设计顺序：先单 Agent，后多 Agent）。

**影响**：
- Session.messages[] 是核心字段（对应三层上下文 Layer 2 Agent 私有对话，见 06-core-engine.md §4.1），每条消息以 sourceAgent 标记归属（单 Agent 场景恒为默认值）
- 协作字段（Layer 1：domainState / activityLog）为可选叠加，Phase 1 单 Agent 可不启用；对齐决策 80（projectState → domainState 事件投影）与决策 83（participants/owner/permissions）
- 多 Agent 共享同一 Session 时，通过 sourceAgent + namespace 区分归属
- 当前 cell-base 实现（Session.messages + context）与此一致

**变更记录**：v2.17 — 原「Session 是团队工作区」（不是单 Agent 对话历史）反转为「对话容器优先、协作叠加」：单 Agent 是执行单元，Session 先承载对话历史，多 Agent 共享字段叠加（对齐决策 80/83 与 06-core-engine.md §4.1 三层模型）

---

## 决策 6：主 Agent 数量

**选择**：Phase 1 只有 1 个主 Agent。架构预留支持多个主 Agent 的接缝。

**理由**：Phase 1 的场景是单用户单窗口。多主 Agent 是多人协作场景（Phase 3），不需要在 Phase 1 实现。

**影响**：UserMessageRouter 在 Phase 1 是 trivial 实现。Session 的 messages 接口设计时支持多主 Agent 标识。

---

## 决策 7：用户消息只给主 Agent

**选择**：用户消息只路由到主 Agent。主 Agent 负责所有用户会话，Subagent 不直接接收用户消息。

**理由**：用户交互的一致性需要单一入口。Subagent 是执行者，不是对话者。如果 Subagent 也接收用户消息，会产生交互混乱。

**影响**：Subagent 的 input 只有主 Agent 通过 SubagentInvocation 传递的 task。Subagent 的输出通过 SubagentReport 返回给主 Agent。

---

## 决策 8：三层上下文模型

**选择**：采用三层上下文模型：Session 共享层、Agent 私有层、Subagent 注入层。

**理由**：不同粒度的上下文需要不同的生命周期和访问控制。Session 共享层跨 Agent 存活，Agent 私有层跟随 Agent 生命周期，Subagent 注入层按需传递。

**影响**：Subagent 的 contextMode 可以灵活控制注入内容。Phase 1 简化为只使用 isolated 模式。

---

## 决策 9：Subagent 身份

**选择**：同时支持动态赋予和预定义两种方式。

**理由**：很多 Subagent 是临时性的（动态创建），也有很多是标准化的角色（预定义）。只支持一种会限制灵活性。

**影响**：SubagentInvocation 的 identity 字段需要 source 标记。预定义的 Agent 定义文件在 Phase 1 之后才需要持久化存储。

---

## 决策 10：Subagent 不自动共享 Session

**选择**：Subagent 不自动访问 Session 共享层。是否共享、共享多少，由 contextMode 决定。

**理由**：默认隔离可以避免 Subagent 意外修改共享状态。显式共享比隐式共享更安全。

**影响**：contextMode 的默认值是 isolated。主 Agent 需要明确选择 shared 或 custom 才能传递 Session 上下文。

---

## 决策 11：配对检查 Subagent 替代自检

**选择**：当主 Agent 派发任务给 Subagent 时，伴随创建检查 Subagent。任务 Subagent 完成后触发检查 Subagent 独立验证。检查 Subagent 有双重职责：(1)上下文屏障——将任务 Subagent 的大量产出压缩成精简报告（几百 token）给主 Agent，保护主 Agent 上下文；(2)独立验证——客观审查任务 Subagent 的工作质量。检查 Subagent 可在 maxRetries 内自动触发返工。自检模式废弃。验证模式只有 paired（默认）和 none。

**理由**：自检模式下 Subagent 检查自己的工作，容易出现 blind spot。paired check 引入独立视角，质量更高。同时检查 Subagent 负责压缩产出，解决主 Agent 上下文膨胀问题。两者结合，一个检查 Subagent 同时解决质量和上下文两个核心问题。

**影响**：Subagent 生命周期移除 self_checking 状态。新增 checkSubagent 字段在 SubagentInvocation 中。验证模式枚举：paired / none。SubagentReport 的来源从任务 Subagent 变为检查 Subagent 的压缩报告。

> **v4 修改注记**：v4 扩展。Check 双重职责升级为可配置三层监察（见决策 81）：过程监督 / 事后审计 / 高风险复核。Check Subagent 成为三层监察中"过程监督"的一种实现。ReviewPolicy 可配置触发策略。原"双重职责"作为 ReviewPolicy 的默认值保留。

---

## 决策 12：主 Agent 检查是自然行为

**选择**：主 Agent 对 SubagentReport 的检查是 Agent Loop 的自然行为，不需要特殊的验证器代码。

**理由**：如果主 Agent 收到报告后不能判断是否接受，说明主 Agent 的 system prompt 或工具设计有问题。底座不应该在核心逻辑里硬编码业务验证。

**影响**：SubagentReport 提供足够的结构化信息（status、output、artifacts、selfCheck），让主 Agent 可以根据业务逻辑判断。

---

## 决策 13：工作区模式

**选择**：三种工作区模式：shared（Phase 1 默认）、isolated（Phase 1+ 开关）、worktree（Phase 2+）。

**理由**：不同的任务对文件系统隔离的需求不同。简单读任务不需要隔离，写任务需要隔离，git 相关任务需要 worktree。

**影响**：workspace 字段是 SubagentInvocation 的必填项。Phase 1 只实现 shared 和 isolated，worktree 留到 Phase 2。

---

## 决策 14：打回重做

**选择**：主 Agent 可以打回 Subagent 任务，附带反馈重新执行。有 maxReworks 上限（默认 2）。

**理由**：Subagent 第一次执行往往不能完全满足要求。打回机制允许修正，但无限制重试会浪费资源。

**影响**：SubagentInvocation 需要 rework 字段。Subagent 的生命周期需要支持从 reported 状态重新进入 executing。

---

## 决策 15：不限制 Subagent 数量

**选择**：底座不限制 Subagent 总数。按资源（LLM 配额、内存、CPU）限制并发，不按数量限制。

**理由**：某些场景下可能需要大量 Subagent 并行（例如批量审查）。数量限制是人工约束，资源限制才是物理约束。

**影响**：新增 ConcurrencyGovernor 接口控制并发。新增 CostGovernor 接口控制 LLM 花费。AgentPool 不设大小上限。

> **v4 修改注记**：v4 扩展为 dispatchBudget 预算驱动（见决策 73）。"不限制数量"原则保留，但派发权限从架构硬编码深度下沉为 Identity.capabilities + dispatchBudget。架构硬兜底上限 10（防失控），其余由预算动态控制。

---

## 决策 16：并发 Agent 监视模块

**选择**：ConcurrencyMonitor 独立于 ConcurrencyGovernor。Governor 控制，Monitor 观察。

**理由**：控制和观察是两种不同的职责。Governor 负责准入控制，Monitor 负责实时快照、历史查询和告警。混在一起会导致单一职责违反。

**影响**：ConcurrencyMonitor 提供 snapshot()、subscribe()、query()、setAlert() 四个能力。Phase 1 用内存计数器实现，Phase 3 用时序数据库。

---

## 决策 17：成本模块

**选择**：CostModule 记录每次 LLM 调用的花费。按 user/workspace/session/agent 聚合。支持预算管理和超限告警（warn/throttle/block）。

**理由**：LLM 调用是主要成本来源。底座作为协作平台，需要提供成本可见性和控制能力。

**影响**：CostGovernor 负责准入控制（canSpend），CostModule 负责记录和查询（record、query）。Phase 1 只记录不限制，Phase 3 支持预算管理。

---

## 决策 18：Meta Check Agent（Meta Check Agent）

**选择**：主 Agent 的常驻伴随，检查主 Agent 自身的决策质量。检查三个维度：(1)子 Agent 任务完成情况（第二意见）；(2)主 Agent 给用户的回答（有没有幻觉/错误/遗漏）；(3)主 Agent 的任务分工（分配合不合理）。权限：correct——可直接改写主 Agent 的回答和分工方案，用户永远看到Meta Check Agent 改写后的版本。触发模式可配置：checkpoint（默认，关键决策点激活）或 persistent（每次决策都检查，高成本）。maxCorrections：默认 1，防止无限改写循环。Meta Check Agent 在单个决策点上最多改写 maxCorrections 次，超过后原样通过。confidenceThreshold：默认 0.8，Meta Check Agent 的置信度低于此值时不执行改写。模型：默认和主 Agent 同级（强模型保证可靠性），非关键检查点可配置轻量模型。Meta Check Agent 跟主 Agent 同生共死，是 Session 级别的常驻 Agent。这是系统的"保险"层。

**理由**：主 Agent 的输出质量直接影响用户体验。即使 Subagent 工作正常，主 Agent 的规划、回答和分工仍可能出现问题。Meta Check Agent 提供独立第三视角，在最终输出前拦截错误。

**影响**：Session 启动时同时创建主 Agent 和Meta Check Agent。Response 管道增加审查环节。correct 权限需要安全的回退机制：maxCorrections 限制单个决策点最多改写次数（默认 1），confidenceThreshold 确保只有高置信度判断才执行改写（默认 0.8），防止Meta Check Agent 和主 Agent 之间的无限改写循环。

> **v4 修改注记**：v4 修改。Meta Check 从 1:1 常驻伴随改为按策略触发（ReviewPolicy，见决策 81）。maxCorrections + confidenceThreshold 保留。新增透明化要求：改写标注来源（"改写自 MetaCheck"），用户可区分原话和改写版本。原"常驻"行为作为 ReviewPolicy=persistent 的一种配置保留。

---

## 决策 19：经 Adapter Layer 复用 pi-ai（原「直接复用 pi-ai」）

**选择**：经 Adapter Layer 复用 pi-ai 作为 璇玑 的 LLM 层（决策 140 分面适配：pi-ai 属有状态/行为类，走适配层）。pi-ai 的统一 LLM API（provider 工厂 + 适配器：Anthropic/OpenAI/Codex/Bedrock/Google/Vertex/Mistral/Azure）、自动 model discovery、OAuth、utils 原样引入，作为适配层内部依赖。璇玑 侧定义 `LlmProvider` 薄包装接口（`stream(req) → events`）与 `StreamFn` 接口，由适配层（`stream-fn/pi-ai.ts`，桥接 璇玑 StreamFn 与 pi-ai 的 `createModels()` + `models.stream()`）承载，供 Loop 消费（决策 35 fallbackModels 回退链逻辑保留在包装层）。辅助库 partial-json、tiktoken 随 pi-ai 自带。Phase 1 用 pi-ai 的 OpenAI + Anthropic 适配器，其余按需启用。

**理由**：决策 2（核心自研 + pi 横切复用）要求复用 pi 横切能力，避免重复造轮子。pi-ai 已内置 30+ provider 并踩过 edge case（流式消费、工具参数解析、thinking 格式差异），复用比自写适配器更早可用、覆盖更广。pi-ai 本身就是从零写的、不依赖第三方多提供商抽象库，符合 璇玑 可控性要求。适配层（决策 140）将 pi-ai 隔离在薄层之后：升级 pi-ai 或替换 LLM 实现时，璇玑 自有接口零改动。

**影响**：原「璇玑 自写 LLM 层、每个 provider 一个适配器、代码完全原创」被推翻。LlmProvider/StreamFn 薄包装接口保留（作为 璇玑 核心抽象，供 Loop/Identity 消费），实现层经适配层委托 pi-ai。Phase 1 即获得全部 pi-ai provider 能力。决策 35（fallbackModels 回退链）保留。

**变更记录**：v4.18 — 实现方式由「直接复用」细化「经 Adapter Layer（stream-fn/pi-ai.ts）适配，provider 工厂原样引入」，随决策 140 分面适配。
**变更记录**：v4.17 — 由「pi-ai 替换方案（自写）」改为「直接复用 pi-ai」，随决策 2 基于 Pi 调整。

---

## 决策 20：直接复用 pi-tui（原「pi-tui 替换方案」）

**选择**：直接复用 pi-tui 作为 璇玑 的 TUI Surface 实现（决策 105：TUI 是 CLI 接入点的具体渲染层，非新架构层）。pi-tui 的差分渲染引擎、组件系统、终端抽象、Markdown 渲染、键盘处理原样引入。璇玑 侧通过 Surface 抽象（26-entry-layer.md §6）包装 pi-tui 渲染层；CLI 接入点用 CliAdapter + protocol.ts 对齐（决策 104）。Phase 1 仍用 SimpleRenderer（stdout + readline 最简实现，聚焦验证核心流程），Phase 2 用 pi-tui 完整渲染。依赖：marked、get-east-asian-width（随 pi-tui 自带）。

**理由**：决策 2（核心自研 + pi 横切复用）要求复用 pi 横切能力，避免重复造轮子。pi-tui 只依赖 marked 与 get-east-asian-width 两个库，是纯渲染库无架构耦合，直接复用比自写更省成本、更早可用。

**影响**：原「参考 pi-tui 写 璇玑 自己的 TUI 引擎、代码完全原创」被推翻。TUI 不再独立自研，pi-tui 作为依赖引入。Surface 抽象保留（决策 103），pi-tui 是其 TUI 实现。Phase 1 SimpleRenderer / Phase 2 pi-tui 渲染。

**变更记录**：v4.16 — 由「pi-tui 替换方案（自写）」改为「直接复用 pi-tui」，随决策 2 基于 Pi 调整。

---

## 决策 21：Composition Layer（编排组装层）

**选择**：新增 Composition Layer，实现四级编排模式。Level 1 默认编排（系统自动选，零配置）。Level 2 预设模板（用户从模板库选）。Level 3 可视化组装（画板拖拽，类似 n8n）。Level 4 动态判断（主 Agent 按任务特征自动组装管道）。编排逻辑从 agent-core 抽出，Agent Loop 引擎只管执行单个 Agent。4 种内置角色变成默认模块，用户可定义新模块。Phase 1 实现 L1+L2，L3+L4 预留接口。Phase 2 实现可视化画板（React + React Flow）和动态组装。

**理由**：固定编排无法满足所有场景。有的任务追求速度（快速模式），有的追求质量（完整模式），有的需要多角度并行（多专家模式）。把编排逻辑从 agent-core 抽出来变成可定义的模式，让系统灵活适应不同场景。四级模式从最省力（默认）到最灵活（动态判断），覆盖从普通用户到高级用户的需求。n8n 的可视化工作流编排验证了这种模式的可行性和用户体验。

**影响**：新增 composition/ 包。agent-core 的编排逻辑移到 Composition Layer。Session 新增 patternMode 和 patternId 字段。dispatch_subagent 工具改为通知 PatternRuntime。10 个内置模块 + 4 个内置模式。Phase 1 交付 L1+L2 完整功能 + L3+L4 接口预留。

---

## 决策 22：身份信息库（Identity Library）

**选择**：新增身份信息库作为 Composition Layer 的子组件。身份库按类别组织（code-review、code-writing、testing、devops、analysis、advisor），每个身份是独立 YAML 文件（systemPrompt + tools + model + skills）。主 Agent 派发子 Agent 时三种身份来源：从库引用（source=library）、咨询身份专家（source=ask-expert，Phase 2+）、动态定义（source=dynamic）。身份信息专家是顾问型子 Agent，有身份设计规则，帮助主 Agent 设计新身份。身份库三级来源（内置 > 项目级 > 用户级），同名时高优先级覆盖。Phase 1 做身份库（目录 + 15 个内置身份 + catalog.yaml），身份专家 Phase 2 实现。

**理由**：主 Agent 每次从零写 system prompt 效率低且质量不稳定。身份库让常用角色可复用，团队可共享。身份专家提供设计规则，确保新身份质量。模块化设计让身份可插拔、类别可扩展、可导入导出。三级来源支持内置身份被项目/用户定制覆盖。

**影响**：新增 identity/ 子包在 composition/ 下。dispatch_subagent 工具增强为三种身份来源。IdentityLibrary 接口（search/get/list/save/remove）。15 个内置身份 YAML 文件。catalog.yaml 目录索引。Phase 2 新增身份专家 + 动态保存 + 统计。

---

## 第二组：编排与执行（决策 23-35）

这组决策来自 omp 和 pi-subagents 的借鉴，增强了编排和执行能力。

---

## 决策 23：模型目录与 LLM 客户端分离

**选择**：将 llm 包拆分为 llm（客户端逻辑）和 catalog（模型数据）两个独立包。catalog 包含 models.json（自动生成的模型清单）、provider descriptors、模型分类逻辑。llm 包含 Provider 接口、适配器实现、模型解析。llm 只从 catalog 导入类型，不导入值。

**理由**：模型清单是数据，会频繁变（新模型发布、价格调整）。LLM 客户端是逻辑，相对稳定。分开后更新模型清单不需要重新测试客户端逻辑，多个入口共享同一份模型数据。

**影响**：packages/ 下新增 catalog 包。llm 包依赖 catalog（仅类型）。详见 08-package-structure.md。

---

## 决策 24：模型分配由 Main Agent 指定 + 回退链

**选择**：不使用系统级角色路由。Main Agent 在 dispatch_subagent 时指定模型（覆盖 Identity 定义中的默认 model）。Identity 定义的 model 作为默认值。所有 Identity 和 dispatch 参数支持 fallbackModels 回退链：主模型失败（429/超时）时依次尝试备用模型。

**理由**：璇玑 的 Composition Layer 本身就是 Main Agent 驱动编排。Main Agent 根据任务复杂度动态决定模型，比预定义固定角色更灵活。回退链增强容错性。

**影响**：dispatch_subagent 参数新增 model（可选覆盖）。Identity 定义新增 fallbackModels 字段。LlmProvider 接口需支持回退逻辑。

---

## 决策 25：上下文压缩三规则

**选择**：Core Layer 的 compaction 实现三条规则：1) 工具调用/结果对作为原子单元，不可被独立裁剪。2) 被裁剪的内容生成摘要替代。3) 空间仍不足时执行激进裁剪（从最早摘要开始进一步压缩）。

**理由**：保留 tool_call 但裁剪对应 tool_result 会导致 LLM 困惑。配对保护是最基本的正确性保障。摘要替代比直接丢弃信息损失更小。

**影响**：agent-core/loop/compaction.ts 的核心策略。详见 06-core-engine.md。

---

## 决策 26：DAG + Wave 作为 PatternRuntime 执行引擎

**选择**：PatternRuntime 使用 DAG（有向无环图）+ Wave（拓扑排序的并行波次）作为执行引擎。Pattern 中的 Agent 依赖关系构建为 DAG，拓扑排序生成 Wave 列表。同一 Wave 内的 Agent 无依赖可并行，不同 Wave 之间串行。使用 Kahn 算法检测环。

**理由**：声明式依赖转执行计划的标准方法。Wave 内并行 + Wave 间串行最大化吞吐量。借鉴自 oh-my-pi Swarm Extension。

**影响**：PatternRuntime 核心执行逻辑。详见 03-execution-modes.md。

---

## 决策 27：Pattern 迭代支持

**选择**：Pattern 定义支持 iterations 字段（默认 1）。iterations > 1 时整个 Wave 序列重复执行。上一轮产出自然成为下一轮输入。Phase 1 接口预留，不实现。

**理由**：审查-修复-再审查是常见模式。与 Meta Check 的微观迭代（单 Agent 内部）互补，Pattern 迭代是宏观迭代（多 Agent 链整体重复）。

**影响**：Pattern 定义新增 iterations 字段。PatternRuntime 预留循环逻辑。

---

## 决策 28：MemoryStore 接口预留

**选择**：Infrastructure Layer 预留 MemoryStore 接口（retain/recall/reflect 三操作）。Phase 1 空实现（NoOpMemoryStore），Phase 2/3 接入 SQLite 实现。未来支持 Weibull 衰减曲线和 MMR 多样性召回。

**理由**：跨 Session 记忆是 Phase 3 多人协作的刚需。提前定义接口确保架构兼容。借鉴自 oh-my-pi Mnemopi。

**影响**：infrastructure 新增 memory.ts 接口。详见 07-infrastructure.md。

---

## 决策 29：内部 URL 方案

**选择**：定义统一的内部 URL 方案，所有工具透明解析。identity://（读取身份定义）、agent://（读取子 Agent 输出字段）、pattern://（读取 Pattern 定义）、session://（读取会话上下文）。read 工具统一处理所有 URL 方案。

**理由**：Agent 不需要为每种数据源学一个工具。一个 read 接口读文件、身份、Agent 输出、Pattern。降低 LLM 工具选择复杂度。借鉴自 oh-my-pi 内部 URL 方案。

**影响**：read 工具增强 URL 解析能力。详见 07-infrastructure.md。

---

## 决策 30：工具按需激活（BM25）

**选择**：Identity 定义区分 allowedTools（始终可用）和 indexedTools（索引但未激活）。Agent 执行中可通过 search_tool_bm25 按语义搜索并激活匹配的索引工具。Phase 2+ 实现。

**理由**：工具数量增多后全部塞进 system prompt 占用大量 token。按需激活让 Agent 先用轻量工具，遇到不熟悉任务时搜索更合适工具。借鉴自 oh-my-pi。

**影响**：Identity 定义新增 indexedTools 字段。ToolSlot 新增 search_tool_bm25 能力。

---

## 决策 31：状态持久化与崩溃恢复

**选择**：Composition Layer 执行 Pattern 时持久化状态到 .orbita/sessions/<session-id>/ 目录。包含 state/pattern.json（执行状态）、state/agents.json（Agent 实例状态）、logs/（日志）、artifacts/（产出物）。崩溃后可从断点恢复。

**理由**：编排过程可能很长（多轮、多 Agent）。崩溃导致进度丢失不可接受。借鉴自 oh-my-pi Swarm Extension。

**影响**：infrastructure 新增状态持久化逻辑。详见 07-infrastructure.md。

---

## 决策 32：扩展等权原则

**选择**：内置功能（工具、身份、Pattern）和用户自定义功能走完全相同的注册和执行路径。没有任何功能是保留给内置的特权通道。设计原则：内置即扩展（builtin is just extension）。

**理由**：用户/第三方可以构建和内置功能同等强大的扩展。不需要 fork 代码，不需要特殊权限。生态系统自然生长。借鉴自 oh-my-pi。

**影响**：写入 璇玑 设计原则。所有注册机制对内置和扩展一视同仁。

> **v4 修改注记**：v4 重新表述为两层内置。第一层：核心机制工具（dispatch_subagent、contact_main_agent、submit_output、search_catalog）属核心，通过同一 ToolSlot 注册，无特权路径。第二层：Domain Pack 内置资产（身份、技能、工具映射、CompletionGuard 实现等）和用户自定义资产走完全相同的注册和执行路径，无特权通道。两层都遵守"内置即扩展"精神，但归属不同。详见决策 71。

---

## 决策 33：多入口共享核心引擎

**选择**：所有入口（CLI、SDK、RPC）共享同一 bootstrap 函数和核心引擎。bootstrap 负责加载配置、初始化 Infrastructure 容器、创建 RequestContext、初始化 Composition Layer、返回 Session。Phase 1 实现 CLI 入口，预留 SDK/RPC 接口。

**理由**：同一套 Agent 能力从终端用、从代码调、从 RPC 驱动。不为每种入口重写逻辑。借鉴自 oh-my-pi 五入口共享引擎。

**影响**：Entry Layer 统一 bootstrap 设计。详见 08-package-structure.md。

---

## 决策 34：框架提示词外置

**选择**：所有框架级提示词（Main Agent 行为、Meta Check 协议、dispatch 协议等）存放在 composition/prompts/ 目录的 .md 文件中。禁止在代码中构建提示词字符串。动态内容用 Handlebars 模板。身份提示词已在 Identity Library 中，框架提示词独立管理。

**理由**：提示词放在 Markdown 文件里可版本控制、非程序员可修改、diff 清晰。借鉴自 oh-my-pi 提示词外置实践。

**影响**：composition/prompts/ 目录结构。详见 08-package-structure.md 和 04-four-libraries.md。

---

## 决策 35：回退链（fallbackModels）

**选择**：Identity 定义和 dispatch_subagent 参数支持 fallbackModels 字段。主模型失败（429/超时/配额耗尽）时依次尝试备用模型。LlmProvider 实现回退逻辑。

**理由**：单一模型是单点故障。回退链增强容错性。借鉴自 pi-subagents model-fallback。

**影响**：Identity 定义新增 fallbackModels。dispatch_subagent 参数新增 fallbackModels。LlmProvider 接口增强。

---

## 第三组：三库与宪法（决策 36-55）

这组决策建立了三库的约束体系——什么能改、什么不能改。从基础规则（36-45）到具体机制（46-55），覆盖身份、提示词、技能三库的完整约束链。

> v4 注：v4 从三库扩展为四库（新增 Loop 库，见决策 72）。本组决策覆盖身份/提示词/技能三库；第四库 Loop 见决策 72。四库对称点（catalog、三层加载、dispatch source）已在 04-four-libraries.md 统一描述。

---

## 决策 36：双宪法体系

**选择**：建立双宪法体系。架构提示词宪法（硬编码在 shared/core-invariants.ts，约束框架行为安全底线）和身份信息宪法（身份信息专家的审查依据，约束身份定义安全底线）。架构提示词宪法由代码强制执行，身份信息宪法由专家判断执行（Phase 1 降级为代码基础校验）。

**理由**：架构提示词修改风险高（影响所有 Agent），需要硬性约束。身份定义修改风险中（影响单个 Agent），需要灵活判断。两种风险级别适合两种执行机制。

**影响**：shared/core-invariants.ts 新增。身份信息专家职责扩展。详见 04-four-libraries.md。

---

## 决策 37：架构提示词 = 宪法约束（代码强制）

**选择**：架构提示词变更由 Meta Check Agent 依据核心不变量审查。核心不变量包括：配对检查强制、Meta Check 不可删除、递归深度硬上限、工具分级管控、安全操作需用户确认、工具调用/结果对保护。核心不变量硬编码在 TypeScript 代码中，任何专家或提示词都不可修改。

**理由**：修改规则的人不能同时是被规则约束的人（自引用问题）。核心不变量独立于架构提示词，解决自引用。架构提示词专家可以优化框架行为，但不能违反宪法。

**影响**：Meta Check Agent 职责扩展（审查架构提示词变更）。详见 04-four-libraries.md。

---

## 决策 38：身份信息 = 专家约束（专家判断）

**选择**：身份定义的审查由身份信息专家执行。身份信息宪法包含 hard 规则（专家必须拒绝，如身份必须有非空 systemPrompt）和 soft 规则（专家可警告并建议，如写工具身份不应设 verification: none）。Phase 1 无专家时，hard 规则降级为代码校验，soft 规则不检查。

**理由**：身份定义需要上下文判断（这个身份适不适合这个场景），不适合纯代码规则。专家可以理解上下文做出 nuanced 判断。

**影响**：身份信息专家职责定义。Phase 1 基础校验逻辑。详见 04-four-libraries.md。

---

## 决策 39：全局工具池

**选择**：Main Agent 创建动态身份时从全局工具池选择工具，不受 Main Agent 自身工具集限制。全局工具池包含所有已注册工具。Main Agent 可以授予子 Agent 自己没有的工具。

**理由**：Main Agent 可能不需要 bash 工具（它只做编排），但子 Agent 执行任务需要 bash。继承式限制会过度约束灵活性。

**影响**：dispatch_subagent 参数校验逻辑。ToolManager 模块。详见 07-infrastructure.md。

---

## 决策 40：工具风险四级

**选择**：全局工具池按风险分为四级。safe（read/grep/find/glob，自由授权）、moderate（write/edit/bash，需配对验证）、restricted（browser/ssh/web_search，需用户确认+审计日志）、forbidden（delete/sudo/install，仅 Main Agent 可用）。工具注册表定义在 shared/tool-registry.ts。

**理由**：不同工具的风险级别不同，需要差异化管控。safe 可以自由给，restricted 需要人确认，forbidden 不能给子 Agent。

**影响**：shared/tool-registry.ts 新增。ToolManager 执行分级管控。详见 07-infrastructure.md。

> **v4 修改注记**：v4 修改。工具分级框架（safe/moderate/restricted/forbidden 四级 + ToolDescriptor.riskLevel 字段）保留在核心。具体工具到风险级别的映射移 Domain Pack 声明（见决策 71）。例如 read/write/bash 的具体映射由 coding-pack 注册时声明。原"工具注册表定义在 shared/tool-registry.ts"的硬编码映射部分迁移到 pack。

---

## 决策 41：一个架构提示词专家

**选择**：只需一个架构提示词专家（Phase 2+）。不需要第二个约束专家。架构提示词专家负责优化框架行为，Meta Check Agent 负责审查变更安全性（依据核心不变量）。

**理由**：核心不变量层解决了自引用问题。架构提示词专家是写的人，Meta Check Agent 是检查的人，核心不变量是检查标准。三人分工完整，不需要第四个角色。

**影响**：专家体系保持精简。详见 04-four-libraries.md。

---

## 决策 42：不设工具专家 Agent

**选择**：不设独立的工具专家 Agent。工具管理由 ToolManager 基础设施模块处理（规则驱动，非 LLM 驱动）。Main Agent 在 dispatch_subagent 时声明升级策略（auto_grant/require_confirmation/deny），子 Agent 运行时请求工具由 ToolManager 依据策略自动处理。

**理由**：工具授权是规则匹配问题（查风险等级+查策略），不是判断问题（需要 LLM 推理）。ToolManager 作为基础设施模块比 Agent 更高效、更可预测。不需要额外的 LLM 调用开销。

**影响**：infrastructure 新增 ToolManager 模块。dispatch_subagent 参数新增 tool_escalation。详见 07-infrastructure.md。

---

## 决策 43：派发时声明升级策略

**选择**：Main Agent 在 dispatch_subagent 时声明工具升级策略。auto_grant（子 Agent 请求时自动授予，不打扰 Main Agent）、require_confirmation（暂停并通过 intercom 询问 Main Agent，Main Agent 回 yes/no 约 10 token）、deny（此任务不允许）。升级策略一次性声明，后续不需要 Main Agent 参与（auto_grant 部分）。

**理由**：平衡灵活性和 Main Agent 上下文保护。auto_grant 完全不打扰 Main Agent，require_confirmation 只需极简回复。

**影响**：dispatch_subagent 参数新增 tool_escalation。ToolManager 执行策略。

---

## 决策 44：工具授权三层检查

**选择**：工具授权执行三层检查。第一层全局分级（safe/moderate/restricted/forbidden）。第二层升级策略（auto_grant/require_confirmation/deny）。第三层宪法约束（moderate 需配对验证等）。三层都通过才授予。

**理由**：多层检查确保安全。全局分级是基础约束，升级策略是任务级约束，宪法是系统级约束。三层互补。

**影响**：ToolManager 核心逻辑。详见 07-infrastructure.md。

---

## 决策 45：Phase 2+ 工具审查由身份信息专家兼任

**选择**：Phase 2+ 需要智能判断的工具请求（如子 Agent 请求 browser 但 web_search 可能足够），由身份信息专家兼任审查。不新增工具专家类型。身份信息专家本身理解身份的能力边界，扩展到工具审查是自然的。

**理由**：边缘场景的工具请求需要 LLM 判断（web_search 够不够，是否需要完整 browser）。但这类请求不频繁，不值得专门创建一个专家类型。身份信息专家的能力范围自然覆盖。

**影响**：Phase 2+ 身份信息专家职责扩展。不新增专家类型。

---

## 决策 46：验证深度自动推断

**选择**：verification: "auto" 时，系统根据 Identity 角色和任务内容自动推断验证深度。只读任务（scout/researcher 角色）跳过 Check Subagent。写操作（worker 角色）走 paired check。高风险任务（含 security/migration/release 关键词）走 paired check + Meta Check persistent 模式。显式配置不能降低推断级别（安全兜底）。

**理由**：不是所有任务都需要相同深度的验证。只读任务不需要 Check Subagent（没有修改需要验证）。高风险任务需要更严格验证。自动推断免去用户手动配置。借鉴自 pi-subagents 验收门控自动推断。

**影响**：Check Subagent 验证逻辑增强。详见 05-agent-roles.md。

---

## 决策 47：Intercom（子到父双向通信）

**选择**：Task Subagent 获得 contactMainAgent 工具，可主动联系 Main Agent。两种模式：need_decision（阻塞型，子 Agent 暂停等待回复）和 progress_update（非阻塞型，仅汇报）。Main Agent 回复只需约 10-20 token，对上下文影响极小。

**理由**：子 Agent 执行中遇到阻塞问题时，不需要失败返回。可以向上请求决策后继续执行，减少失败率和无效返工。借鉴自 pi-subagents contact_supervisor。

**影响**：extensions ToolSlot 新增 contactMainAgent 工具。Task Subagent 默认注入。详见 05-agent-roles.md。

---

## 决策 48：链式变量绑定

**选择**：Pattern 定义中每步支持 as（输出命名）和变量引用。{outputs.xxx} 引用前序步骤命名输出，{previous} 引用上一步全部输出。PatternRuntime 执行每步前自动解析变量引用，将前序输出注入当前 Agent 的 task。绑定验证：引用的名称必须在前序步骤中已声明。

**理由**：多步 Pattern 中后续 Agent 需要前序 Agent 的产出。变量绑定让数据流声明式化，不需要代码硬编码。借鉴自 pi-subagents chain-outputs。

**影响**：Pattern 定义格式增强。PatternRuntime 新增变量解析逻辑。详见 03-execution-modes.md。

---

## 决策 49：Worktree 三级隔离

**选择**：dispatch_subagent 支持 isolation 参数（none/task/parallel）。none 直接在主工作区执行（零开销，适合只读）。task 每个任务获得独立 git worktree，完成后 diff 合并回主工作区，失败时丢弃（安全回滚）。parallel 同一批并行任务各有独立 worktree，每个完成后依次合并，下一个 Wave 看到合并后状态。Infrastructure 新增 WorkspaceIsolation 接口。Phase 1 实现 GitWorktreeIsolation。

**理由**：并行写操作会冲突。任务级隔离提供失败安全保障。三级策略平衡安全性和开销。借鉴自 pi-subagents worktree 隔离，增强为三级。

**影响**：Infrastructure 新增 WorkspaceIsolation 接口。dispatch_subagent 新增 isolation 参数。详见 07-infrastructure.md。

---

## 决策 50：完成守卫

**选择**：Check Subagent 验证逻辑中加入完成守卫检查。推断任务是否预期修改文件（基于 Identity 角色和任务内容），检测子 Agent 是否实际调用了写工具。预期修改但未修改时标记验证失败。

**理由**：LLM 有时声称完成任务但实际只做了分析没有修改。完成守卫自动检测这种情况。借鉴自 pi-subagents completion-guard。

**影响**：Check Subagent 验证逻辑增强。详见 05-agent-roles.md。

> **v4 修改注记**：v4 修改。完成守卫接口（CompletionGuard）留在核心作为领域中立抽象。具体实现（文件变异检测、写工具调用检测）迁移到 Domain Pack（见决策 71）。coding-pack 提供 coding 专用 CompletionGuard 实现（检测文件修改、git diff）。其他领域 pack 可提供自己的实现。核心只定义 CompletionGuard 接口和调用时机。

---

## 决策 51：动态扇出

**选择**：Pattern 定义支持 expand/parallel/collect 语法。expand 从前序步骤的结构化输出中提取数组，parallel 为每个元素创建并行子 Agent，collect 汇总结果。maxItems 必须指定（防无限扩展）。不允许嵌套动态扇出。Phase 1 接口预留，Phase 2 实现。

**理由**：数据驱动的并行扩展。不是预先定义几个并行任务，而是根据前一步输出动态决定并行多少个。适合批量审查、批量修复场景。借鉴自 pi-subagents dynamic-fanout。

**影响**：Pattern 定义新增 expand/parallel/collect 语法。PatternRuntime 预留扇出逻辑。详见 03-execution-modes.md。

---

## 决策 52：Skills 系统

**选择**：新增 Skills 库（与 Identity Library 和 Architecture Prompt Library 并列的第三个库）。每个 Skill 是 Markdown 文件，被注入 Identity 的 system prompt 作为 XML 块。Identity 定义引用 skills 字段指定需要的技能。三层加载（builtin < user < project）。缓存 TTL 5000ms。编排技能只注入给 Main Agent，子 Agent 在边界被过滤。Phase 1 做 Skills 库（目录 + 内置技能 + catalog），Phase 2+ 做技能管理。

**理由**：技能是可复用的能力扩展。不是每个身份都从头写所有指令，而是引用已有技能。技能可被多个身份共享。借鉴自 pi-subagents SKILL.md 系统。

**影响**：composition/ 新增 skills/ 子目录。Identity 定义 skills 字段生效。详见 08-package-structure.md。

---

## 决策 53：长时间运行守卫

**选择**：Infrastructure 新增 ActivityMonitor 模块。监控子 Agent 活跃度，主动通知 Main Agent。三个阈值：needsAttentionAfterMs（默认 60 秒无活动）、activeNoticeAfterMs（默认 240 秒运行）、failedToolAttemptsBeforeAttention（默认 3 次工具失败）。追踪变异工具连续失败次数。触发时通过 Intercom 通知 Main Agent。Phase 2 实现。

**理由**：子 Agent 可能卡住（死循环、反复失败操作）。主动通知让 Main Agent 及时干预。借鉴自 pi-subagents long-running-guard。

**影响**：Infrastructure 新增 ActivityMonitor 模块。详见 07-infrastructure.md。

---

## 决策 54：Fork 上下文边界过滤

**选择**：ContextBuilder 构建子 Agent 上下文时执行三层过滤。项目上下文过滤（inheritProjectContext: false 时移除项目指令）、技能过滤（inheritSkills: false 时移除编排技能）、消息过滤（移除编排指令和 dispatch 工具调用记录）。注入边界声明（你是子 Agent，继承的对话仅供参考）。Phase 1 用 fresh 模式，Phase 2+ 实现 fork 模式 + 过滤。

**理由**：子 Agent 需要父 Agent 上下文理解任务背景，但不应该被编排指令污染。过滤让子 Agent 获得有用信息同时保持角色边界。借鉴自 pi-subagents fork 上下文过滤。

**影响**：ContextBuilder 新增过滤逻辑。Identity 定义新增 inheritProjectContext 和 inheritSkills 字段。详见 06-core-engine.md。

---

## 决策 55：结构化输出 + Schema 验证

**选择**：Identity 定义支持 outputSchema 字段（JSON Schema）。子 Agent 通过 submit_output 工具提交结构化 JSON 输出。系统用 Schema 验证输出格式。验证通过的结构化输出可用于动态扇出和链式变量绑定。Phase 2 实现。

**理由**：有些场景需要结构化数据（动态扇出需要 JSON 数组，验证需要特定字段）。Schema 验证确保输出格式正确。借鉴自 pi-subagents structured-output。

**影响**：Identity 定义新增 outputSchema 字段。工具系统新增 submit_output 工具。详见 04-four-libraries.md。

---

## 第四组：竞争与协作模式（决策 56-69）

这组决策定义了 P0 之后的扩展模式——个体竞争和团队竞争，以及 v3 收口期的若干澄清性决策。

---

## 决策 56：Tournament 模式（竞争执行）

**选择**：dispatch_subagent 支持 mode: "tournament"。Main Agent 为同一任务创建 N 个独立竞争者，各自在独立 worktree 中完成。全部完成后 Check Subagent 评估排名，最优方案合并到主分支。支持三种选择策略（best/merge/vote）。竞争对手可使用不同模型或身份增加差异化。适合核心功能、安全相关代码、多方案探索场景。不适合简单任务、时间敏感任务、只读任务。

**理由**：同一任务多个独立方案天然产生差异化。选最优等于自然选择，质量提升显著。单个 Agent 可能走偏，N 个独立方案中至少好的概率远高于一个。Phase 3 多人协作中，两人碰巧做同一模块时，竞争选优比"谁覆盖谁"更合理。这是 璇玑 区别于其他 AI 编码 Agent 的差异化能力，pi-subagents 和 oh-my-pi 都没有。

**影响**：dispatch_subagent 新增 mode: "tournament"。Check Subagent 新增比较排名能力。Pattern 步骤支持 mode: "tournament"。详见 03-execution-modes.md 和 05-agent-roles.md。

---

## 决策 57：三种选择策略

**选择**：Tournament 模式支持三种选择策略。best：选评分最高的方案，直接合并到主分支（大多数场景，复杂度低）。merge：从多个方案中提取优点融合（方案各有所长时，复杂度高）。vote：多个 Check Subagent 独立投票选出最优（需要最高客观性时）。默认策略为 best。

**理由**：不同场景需要不同策略。简单场景选最好的就够了。复杂场景可能需要融合多个方案的优点。高争议场景需要多评估者投票消除单一评估者偏差。

**影响**：Check Subagent 评估逻辑支持三种模式。merge 策略需要智能合并能力（Phase 2+）。详见 05-agent-roles.md。

---

## 决策 58：增量竞争（成本控制）

**选择**：Tournament 默认不启用。启用时有三种成本控制策略。按重要性自动决定竞争者数：低优先级 1 个（不竞争）、中优先级 2 个、高优先级 3 个。模型差异化降低成本：强模型 + 弱模型组合，弱模型偶尔带来创新思路。增量竞争：先跑 1 个 Agent，如果完成质量低（Check 评分低于阈值）再派第 2 个，大多数情况下只需 1 个。

**理由**：Tournament 成本是普通模式的 N 倍。不是每个任务都需要竞争。成本控制让 Tournament 在重要任务上才启用，避免浪费。

**影响**：dispatch_subagent 新增 priority 参数。PatternRuntime 支持增量竞争逻辑。详见 03-execution-modes.md。

---

## 决策 59：模式开关（on-demand / swarm）

**选择**：Session 级别支持两种操作模式，可运行中切换。on-demand（按需派发，默认）：Main Agent 按需派发子 Agent，一个接一个或小批量并行，DAG + Wave 执行，当前行为。swarm（群 Agent）：Main Agent 创建 N 个组，每组是完整团队在隔离 worktree 中独立工作，差异化策略，组完成后选优或融合合并。模式切换不需要重启 Session，切换时 Main Agent 重新加载对应模式的架构提示词。

**理由**：不同任务复杂度需要不同协作模式。简单任务用按需派发高效省成本。复杂重要任务用群 Agent 获得更高质量。模式开关让 Main Agent 灵活选择。借鉴 Tournament 模式（决策 56）扩展到团队级别。

**影响**：Session 新增 mode 字段。Main Agent 行为根据模式变化。Architecture Prompt Library 新增 swarm 专用提示词。详见 03-execution-modes.md。

---

## 决策 60：群 Agent（团队竞争）

**选择**：swarm 模式下 Main Agent 创建 N 个组（AgentGroup），每组在隔离 worktree 中独立工作。每组是一个完整团队（多个角色 Agent），组内按 Pattern 执行。全部完成后 Meta Check 评估整体方案，选最优组或融合多组优点合并到主线。与 Tournament（决策 56，个体竞争）互补：Tournament 是单任务多 Agent 竞争，群 Agent 是复杂目标多团队竞争。

**理由**：复杂目标需要多角色协作（架构师+编码+测试）。单个 Agent 无法完成完整方案。多团队独立产出完整方案后选优，质量远高于单团队。映射真实世界多团队开发模式。

**影响**：新增 AgentGroup 接口。dispatch_group 函数。组内 Pattern 执行。详见 03-execution-modes.md。

---

## 决策 61：差异化机制（三库覆盖）

**选择**：每个组通过覆盖三库（架构提示词库/身份信息库/技能库）实现策略差异化。架构提示词覆盖：追加策略倾向指令（如"在所有决策中优先考虑安全性"）。身份覆盖：使用策略专属身份（如 security-architect 替代 generic-architect）。技能覆盖：注入策略相关技能（如 owasp-top-10, performance-tuning）。每组创建临时的、局部的库覆盖，不影响全局三库。

**理由**：差异化不需要新基础设施。三层调整全部是现有三库体系的覆盖机制。每组临时覆盖是架构提示词库三层加载（builtin < user < project）的自然扩展——组级覆盖优先级最高。

**影响**：三库加载新增组级覆盖层。Identity Library 支持部分覆盖。Architecture Prompt Library 支持追加指令。Skills Library 支持技能集替换。详见 04-four-libraries.md。

---

## 决策 62：三种合并策略增强（best / merge / hybrid）

**选择**：群 Agent 和 Tournament 的选择策略扩展为三种。best：选总分最高组的完整方案，直接合并到主分支（各组质量差异大时）。merge：从不同组提取不同模块融合（各组各有所长时）。hybrid：选最好组为基础，合入其他组的特定改进（大部分好但有局部短板时）。hybrid 是最实用策略，类似 git cherry-pick。

**理由**：不同场景需要不同合并策略。best 最简单但可能浪费其他组的亮点。merge 最灵活但合并复杂度高。hybrid 平衡实用——以最佳为基础，只合入亮点。

**影响**：Check Subagent / Meta Check 评估支持三种合并模式。WorkspaceIsolation 新增模块级 diff 和选择性合并能力。详见 05-agent-roles.md 和 07-infrastructure.md。

---

## 决策 63：SubagentDispatcher 接口反转

**选择**：在 shared 包定义 SubagentDispatcher 接口。dispatch_subagent 工具（在 extensions）通过此接口调用 PatternRuntime（在 composition）。PatternRuntime 实现接口。bootstrap 运行时注入具体实现。extensions 不直接依赖 composition 包。

**理由**：dispatch_subagent 需要触发编排级动作（创建子 Agent、配套 Check Agent），但它住在 extensions（被 agent-core 依赖）。如果 extensions 直接 import composition，会形成 composition → agent-core → extensions → composition 的循环依赖。接口反转打破循环：接口在 shared（中立位置），extensions 和 composition 都依赖 shared，互不依赖。

**影响**：shared 新增 subagent-dispatcher.ts。extensions/dispatch-subagent.ts 改为工厂函数 createDispatchSubagentTool(dispatcher)。composition/PatternRuntime 实现 SubagentDispatcher。bootstrap 负责注入。详见 08-package-structure.md 和 06-core-engine.md。

---

## 决策 64：dispatch_subagent 统一 Schema + 三库 catalog 增强

**选择**：dispatch_subagent 工具参数的唯一权威定义放在 04-four-libraries.md §7。三维度（identity / architecturePrompt / skills）各自独立选来源（source = library | ask-expert），结构完全对称。去掉 dynamic / predefined / default / overrides。Phase 1 只实现 library，ask-expert 接口预留。三库 catalog 统一增强 when_to_use / when_not_to_use 字段，帮 LLM 快速定位和判断是否派发。其他文档（01/03/06）改为引用 04，不重新定义。

**理由**：原设计中 dispatch_subagent 在 5 个文档有 5 个互不兼容的参数定义，导致实现者会写出互相打架的代码。三维度对称设计呼应三库体系哲学。去掉 dynamic 强制一切经过库或专家，保证定义质量。catalog 增强让 LLM 能在派发前做出好的判断，避免过度派发。

**影响**：04 §7 成为权威定义。05 §2 SubagentInvocation 改用 ResolvedIdentity。01/03/06 简化为引用。三库 catalog 格式增强。详见各文档。

> v4 注：v4 扩展为四维度（+loop，见决策 72）。四维度（identity / loop / architecturePrompt / skills）各自独立选 source，结构完全对称。

---

## 决策 65：执行模式三层分离

**选择**：废弃"五种执行模式"的混淆说法。拆分为两个层级：(1) Session 模式（2 种：on-demand / swarm），Session 级别，运行中可切换；(2) 执行模式（5 种：single / parallel / chain / fan-out / tournament），on-demand Session 模式下的派发方式。dispatch_subagent 的 mode 参数改名为 execution，值改为 "single" | "tournament"，swarm 移除（它是 Session 模式不是 dispatch 参数）。

**理由**：原设计把三个不同维度的概念混叫"五种执行模式"——Session 模式（on-demand/swarm）、执行模式（single/parallel/chain/fan-out）、璇玑 增强（tournament）。不同文档写 2 种、3 种、5 种，互相矛盾。分层后每个维度有明确含义，不再歧义。single/parallel/chain/fan-out 来源于 pi-subagents，tournament 是 璇玑 独创，swarm 来源于 oh-my-pi。dispatch_subagent 的 execution 参数只保留 single 和 tournament（per-dispatch 级别），parallel/chain/fan-out 通过 Pattern 语法实现，swarm 通过 Session 模式切换。

**影响**：01 §4 重构为分层结构。03 §1 重构。04 §7 mode→execution。README/AGENTS.md 术语对齐。详见各文档。

> **v4 修改注记**：v4 进一步分层为 Coordination × Execution 两层 Pattern（见决策 73）。Session 模式（on-demand/swarm）升级为 Coordination Pattern（hierarchy/market），执行模式升级为 Execution Pattern（dag/tournament/chain/fan-out）。两层独立可组合，通过 Capability 契约（决策 85）约束合法组合。原"Session 模式"概念映射为 Coordination Pattern，原"执行模式"概念映射为 Execution Pattern。

---

## 决策 66：Meta Check Agent 归属 Core Layer

**选择**：Meta Check Agent 是 Core Layer 的角色（跑 Agent Loop，有 LLM 调用，有 identity），不是 Composition Layer 的模块。其触发逻辑（checkpoint/persistent、maxCorrections）在 Composition Layer 管理。

**理由**：Meta Check 通过 Agent Loop 执行，有 systemPrompt 和 model，符合 Core Layer 角色定义。与 Task Subagent 相同：角色在 Core，派发逻辑在 Composition。之前文档中"Meta Check 是 Composition Layer 内置验证模块"的描述自相矛盾。

**影响**：02 §3 Meta Check 描述修正。详见 02-architecture-layers.md。

---

## 决策 67：workspace 命名统一为 shared/isolated/worktree

**选择**：全文档统一使用 shared/isolated/worktree 三级命名。废弃 none/task/parallel 命名。

**理由**：璇玑_2 原本统一使用 shared/isolated/worktree。璇玑_3 迁移时在决策 49 和 07 WorkspaceIsolation 中引入了 none/task/parallel，造成两套并行命名系统。统一回 shared/isolated/worktree。

**影响**：07 WorkspaceIsolation 命名更新。原则 14 术语对齐。

---

## 决策 68：递归深度从 3 改为 2

**选择**：recursion-limit 核心不变量从 3 改为 2。深度 2 = Main Agent → Task Subagent。

**理由**：Task Subagent 不能派生子 Agent。最大链路就是 Main → Sub = 深度 2。深度 3 暗示可以 Main → Sub1 → Sub2，与角色定义矛盾。Phase 2+ 如果允许嵌套派生，可提升至 3。

**影响**：04 §5.1 recursion-limit 值更新。

> v4 注：v4 派发权限下沉（见决策 73），递归深度不再是固定数字，而由 dispatchBudget + Identity.capabilities 控制。架构硬兜底上限 10。本决策的"深度 2"作为 Phase 1 默认配置保留。

---

## 决策 69：Tournament 模式 CheckReport 放宽至 1500 token

**选择**：execution: "tournament" 时 CheckReport 上限从 500 token 放宽至 1500 token。普通模式保持 500 token。

**理由**：Tournament 模式下 Check Subagent 需要评估 N 个竞争者（5 维度 × N 方案 + 排名 + 推荐），500 token 不足。1500 token 足够评估 3 个竞争者。

**影响**：05 CheckReport 说明更新。

---

## 第五组：v4 通用化与协作模式扩展（决策 70-85）

这组决策是 璇玑 v4 的核心新增。v4 把 璇玑 从"coding 专用多 Agent 工具"升级为"通用多用户多 Agent 协作底座"——核心微内核领域中立，所有能力可插拔，内置内阁制与竞功制两套完整协作模式。这 16 条决策覆盖：通用定位、Domain Pack、四库、两层 Pattern、角色降级、两模式、司礼监代批、军功簿、通信图状化、事件溯源、监察分层、紧急通道、User 一等公民、Preset、Capability 契约。

---

## 决策 70：定位通用化（推翻决策 1）

**选择**：璇玑 是通用多用户多 Agent 协作底座。核心接口领域中立，不携带任何具体领域的语义字段。领域能力（工具/身份/技能/Loop/评估维度/工作区后端）通过可插拔的 Domain Pack 注入。第一个官方 Pack 是 coding-pack。终局目标是多人在线 + 海量 agent + 复杂拓扑协作；核心微内核为终局预留接缝，Phase 1 给最笨实现。

**理由**：v3 决策 1 把 璇玑 锁定为 coding 专用，接口直接携带 filePath、repoUrl、projectState.files/cwd 等语义字段。这让 璇玑 无法复用于其他领域（研究、写作、运维、数据分析）。领域语义渗入核心接口导致每次扩展都要改核心，违反开闭原则。通用化让核心稳定、领域能力可插拔，是 璇玑 演进到通用协作平台的必要前提。coding-pack 作为第一个官方 Pack 保留开箱即用的体验。

**影响**：推翻决策 1。核心接口去领域化：Session.projectState 改为 Session.domainState: Record<string,unknown>（schema 由 Pack 定义）；WorkspaceSlot 的文件系统/git worktree 语义迁移到 WorkspaceBackend（coding: GitWorktreeBackend）；15 个内置身份迁移到 coding-pack；工具分级具体映射（read/write/bash）迁移到 Pack 注册时声明。核心保留领域中立版：WorkspaceSlot 接口（mode+options）、ToolDescriptor（riskLevel 框架）、CompletionGuard 接口、EvaluationRubric 接口。详见 01-overview.md §1、18-domain-pack.md。

---

## 决策 71：Domain Pack 系统

**选择**：核心领域中立，所有领域能力通过 Domain Pack 注入。每个 Pack 声明 name、version、dependencies、register（注入四库+Pattern）、presets（打包好的合法组合）、sessionStateSchema（domainState 的 schema）、workspaceBackend、completionGuard、defaultRubric。从 v3 核心迁移到 coding-pack 的渗剥点：ProjectState.files/cwd、WorkspaceSlot 文件系统/git worktree 实现、工具分级具体映射、15 个内置身份、内置技能（owasp-top-10 等）、Tournament 评估权重、完成守卫文件变异检测。四层加载优先级：pack < builtin < user < project < group。璇玑 npm 包默认依赖 @璇玑/coding-pack 并自动启用，核心是空核但开箱即用。

**理由**：领域能力和框架机制必须分离。框架机制（Loop 引擎、Agent 生命周期、三库机制、双宪法、事件系统、Pattern 注册表）属核心，任何领域任何模式都需要。领域细节（coding 的文件系统、研究的引用管理、写作的版本管理）属 Pack，按需注入。分离后核心稳定可复用，新领域只需写新 Pack 不动核心。四层加载保证用户 project 级覆盖永远赢过 Pack 内置。npm 默认依赖 coding-pack 保留开箱即用体验。

**影响**：新增 18-domain-pack.md 详述 Pack 系统。08-package-structure.md 新增 domain-packs/ 目录。核心接口全面去领域化（见决策 70）。决策 32 重新表述为两层内置。决策 40 工具分级框架留核心、具体映射移 Pack。决策 50 完成守卫接口留核心、实现移 Pack。coding-pack 自带 15 个内置身份 + 内置技能 + GitWorktreeBackend + coding CompletionGuard + coding EvaluationRubric。

---

## 决策 72：Loop 库（四库之一，运行期只读）

**选择**：从 v3 三库（身份/架构提示词/技能）扩展为四库，新增 Loop 库。Loop 库定义 Agent 内部执行引擎。Loop 库和其他三库对称的部分：都可被 Main Agent 通过 catalog 选择、各自三层加载（builtin < user < project < group）、各自 catalog.yaml + when_to_use/when_not_to_use、dispatch_subagent 四维度各自独立选 source（library | ask-expert）。Loop 库和其他三库不对称的部分：Loop 是命令式代码（vs 其他三库是声明式数据）；运行期只读（只能从已注册的 Loop 选，不能运行期创建）；无 Loop 专家（vs 身份有专家可运行期造）；新 Loop 注册是开发期行为（写代码 + 审计 + 发布）。v3 的 react-loop（双层循环）作为默认 Loop 保留。

**理由**：Loop 是 Agent 的执行引擎，不同任务可能需要不同执行策略（react 推理-行动循环、plan-then-execute 先规划后执行、streaming 流式执行、batch 批量执行）。把 Loop 硬编码为单一实现限制了能力扩展。但 Loop 是命令式代码，运行期动态生成风险高（代码注入、审计困难、正确性无法保证）。所以 Loop 库设计为运行期只读——只能选已注册的，不能运行期造。这和身份库（可运行期通过专家造）形成合理不对称：身份是声明式数据可安全动态生成，Loop 是命令式代码必须开发期注册。

**影响**：04 文档从 three-libraries 重命名为 four-libraries。新增 Loop 库章节。dispatch_subagent 参数从三维度扩展为四维度（identity / loop / architecturePrompt / skills）。决策 64 四维度对称。Loop 注册接缝在 09-seam-map.md 新增。v3 的 Agent Loop 双层循环作为默认 Loop 保留（详见 06-core-engine.md）。Phase 1 只实现 react-loop，其他 Loop 接口预留。

---

## 决策 73：Coordination × Execution 两层 Pattern

**选择**：Pattern 拆分为两层独立可组合。Coordination Pattern（agent 怎么组织）：hierarchy（层级，内阁制）、market（市场竞争，竞功制）、peer-mesh（同辈网状 Phase 2+）、federation（联邦 Phase 2+）。Execution Pattern（任务怎么执行）：dag（DAG+Wave）、tournament（竞争择优）、chain（链式）、fan-out（动态扇出）。兼容机制用 Capability 契约（Phase 1 白名单简化版）。Phase 1 组合矩阵：hierarchy×dag（内阁制默认）、hierarchy×tournament、hierarchy×chain、hierarchy×fan-out、market×dag、market×tournament（竞功制默认）、market×fan-out。peer-mesh 全部 Phase 2+。派发权限下沉：不靠架构硬编码递归深度，靠 Identity.capabilities（"dispatch"/"contact"/"broadcast"）+ dispatchBudget（预算驱动）。架构硬兜底上限 10。

**理由**：v3 把 Session 模式（on-demand/swarm）和执行模式（single/parallel/chain/fan-out/tournament）混叫"执行模式"，不同维度概念混淆（见决策 65 修改注记）。v4 把 agent 组织方式（Coordination）和任务执行方式（Execution）分离为两个正交维度，独立可组合。hierarchy/market 是组织拓扑，dag/tournament/chain/fan-out 是执行策略，两者组合产生丰富模式。两层独立让系统灵活适应不同场景：层级协商配 DAG 执行（内阁制日常）、市场竞争配 tournament（竞功制攻关）。派发权限从硬编码深度下沉为预算驱动，避免一刀切限制扼杀合理用例，硬兜底防失控。

**影响**：03-execution-modes.md 重构为两层 Pattern。决策 65 进一步分层。决策 4/15 升级为 dispatchBudget。Capability 契约见决策 85。两层 Pattern 注册接缝在 09-seam-map.md 新增。PatternRuntime 同时支持两层。v3 DAG+Wave（决策 26）成为 Execution Pattern=dag 的实现。

---

## 决策 74：角色降级为 Identity 属性

**选择**：Main/Worker/Reviewer 等角色不再是架构枚举，降级为 Identity.role: string。架构只理解 Agent（跑 Loop 的实体）。Loop 行为差异通过 Identity 配置的 hooks/slots 实现，不靠 switch(role)。Identity 新增 capabilities 字段声明能力（"dispatch"/"contact"/"broadcast"/"submit"/"review" 等）。核心自带工具（框架机制工具，领域中立）：dispatch_subagent、contact_main_agent、submit_output、search_catalog。这些工具走同一 ToolSlot 注册路径，无特权通道。Phase 1 提供 4 个 Identity 模板（对应 v3 的 4 角色）作为默认，用户可定义任意角色。

**理由**：v3 把 Main/Task/Check/MetaCheck 作为架构级枚举，导致核心代码遍布 switch(role)。每加一个角色都要改核心，违反开闭原则。角色本质是 Identity 的属性（systemPrompt + tools + capabilities 的组合），不是架构概念。降级为属性后，核心只认 Agent，角色差异通过 Identity 配置表达。capabilities 字段让权限声明式化（谁能派发、谁能通信、谁能广播），取代硬编码角色判断。Phase 1 的 4 模板保留 v3 体验，终局支持任意角色。

**影响**：02-architecture-layers.md 角色枚举移除。05-agent-roles.md 重写为 Identity.role + capabilities。核心代码移除 switch(role)。Identity 定义新增 capabilities 字段。dispatchBudget（决策 73）读取 capabilities 判断派发权限。七维度插件化总表中"角色"维度接口形态为 Identity.role + capabilities。

---

## 决策 75：内阁制模式完整定义

**选择**：内阁制（技术名 on-demand，Coordination=hierarchy）是文官体制隐喻的协作模式。七层角色：交互审核 Agent（司礼监，InteractiveReviewAgent，翻译+过滤+代批）、总控 Agent（皇帝，SupremeController，最高裁决+紧急通道降级）、规划 Agent（内阁大学士，PlanningAgent，各出票拟携带置信度）、首席规划 Agent（首辅，ChiefPlanner，加权裁决+恢复权）、功能执行 Agent（六部，ExecutionAgent，各负责一个领域）、监督 Agent（六科给事中，SupervisionAgent，过程合规+暂停权无恢复权）、审计 Agent（都察院，AuditAgent，事后审计仅建议性）、复核 Agent（大理寺，ReviewAgent，高风险裁决强制力）、协作总线（CollaborationBus，订阅发布+授权列表+日志审计）。核心机制：多规划者协商+首辅加权裁决（规划可配 single | deliberate）；三层监督分离（过程/事后/高风险）；暂停权与恢复权分离（六科暂停，首辅/总控恢复）；紧急通道降级（规划失效时预设 EmergencyFallback）；司礼监代批（见决策 77）。工作流程：用户→司礼监→总控→[内阁票拟+首辅裁决]→六部执行→[三层监察]→司礼监最终审查→用户。

**理由**：v3 的 on-demand 是简化版（单一 Main Agent 派发），缺乏规划协商、监察分离、紧急降级等关键能力。复杂任务需要多规划者协商（避免单一规划者盲点）、三层监察分离（过程/事后/高风险各有强制力）、暂停与恢复权分离（防止监察者滥权）、紧急通道（规划失效时不现场 improvisation 而用预设方案）。文官体制隐喻（明朝内阁+六科+都察院+大理寺）天然映射这些机制，术语鲜明不与竞功制混用。替代 v3 on-demand 简化版。

**影响**：新增 11-renshi-shared-base.md 详述内阁制。决策 59 on-demand 升级为 Coordination=hierarchy。决策 77 司礼监代批、决策 81 监察分层、决策 82 紧急通道分别详述核心机制。内阁制术语严格不与竞功制混用（见决策 76）。首辅加权裁决可读取军功簿（决策 78）。

---

## 决策 76：竞功制模式完整定义

**选择**：竞功制（技术名 swarm，Coordination=market）是军事体制隐喻的协作模式。七层角色：军情转译使（MilitaryTranslator，翻译军令+保留原始战报+最终审查）、总督 Agent（Governor，复制分发+最高裁决+haltBranch/acceptBranch/mergeBranches）、各路提督 Agent（Commander，独立攻关+不同战术+产出完整战果）、评功推官（MeritJudge，功赏指标评分+择优/融合+挂载主分支）、监军御史 Agent（MilitarySupervisor，实时监控资源/超时/违规+白旗暂停仅暂停）、军功勘验使（MeritInspector，事后复盘+评分+updateWeights 学习闭环）、塘报旗牌使（DispatchMessenger，点对多分发+固定频道独立上报+接收清单防篡改）。核心机制：复制分发（replicateTask 创建 N 个 worktree 分支）；禁止横向通信（公平性不变量：竞争者间不得通信）；评功四策略（best/merge/hybrid/vote）；功赏指标外置（MeritMetrics 由 pack 定义，不硬编码）；监军御史仅暂停（权力分离）；军功勘验影响权重（updateWeights，见决策 78）；接收清单防篡改（confirmAllReported 才融合）。工作流程：用户→军情转译使→总督(replicateTask N份)→塘报旗牌使分发→提督×N并行(worktree隔离)→监军御史实时监控→全部回报→评功推官评估择优→挂载主分支→军情转译使审查→军功勘验使复盘+updateWeights→用户。

**理由**：v3 的 swarm 是简化版（N 个组团队竞争），缺乏禁止横向通信不变量、功赏指标外置、过程监察、权重闭环、接收清单防篡改等关键保障。军事体制隐喻（明朝总督+提督+评功推官+监军御史+军功勘验使）天然映射市场竞争机制，术语鲜明不与内阁制混用。禁止横向通信是公平性核心不变量（竞争者互通会破坏独立性）。功赏指标外置让不同领域用不同评估标准。军功勘验权重闭环让系统越用越聪明。替代 v3 swarm 简化版。

**影响**：新增 13-jinggong-mode.md 详述竞功制。决策 59/60 swarm 升级为 Coordination=market。决策 78 军功簿、决策 79 通信图状化（塘报旗牌使）、决策 81 监军御史分别详述核心机制。两个模式不交叉规则：内阁制文档/代码/对话只出现内阁制术语，竞功制只出现竞功制术语，同一职能在两个模式下有不同名字，严格不混用。Session 切换模式时称呼随之切换。

---

## 决策 77：司礼监代批机制

**选择**：司礼监（InteractiveReviewAgent）是有有限代批权的前置关口，不只是翻译层。代批权来自总控预授权的"条陈"（BatchApproveCharter）。三重职责：① 前置过滤（prefilter）——超出能力/违反策略/格式错误则不受理或驳回（过滤非代决策）；② 翻译（translate）——InternalCommand + 保留原始映射，可逆；③ 代批判断——命中条陈+简单低风险则代批，复杂/高风险/不在条陈则呈送总控。条陈是代批授权清单，由总控预先授权，司礼监不得自行扩充；每条指定匹配条件+handler+必须是 minimal 风险。代批流程：命中条陈→校验条陈条目→调用 handler→打"批红"标签→同步审计 Agent 后验→直接返回用户（不经内阁）。呈送标准（任一命中即必须呈送，不得代批）：多 steps / 依赖外部资源 / 涉及修改数据 / 非最低风险 / 不在条陈范围。架构宪法四不变量（代码强制）：sijian-no-arbitrary-approve（代批必须有据）、sijian-must-be-traceable（批红标签+审计）、sijian-escalate-complex（复杂不得代批）、sijian-charter-immutable（条陈只能总控授权修改）。

**理由**：v3 用户消息直接路由到 Main Agent，所有请求走完整流程（规划→执行→监察），95% 的日常简单请求浪费完整流程开销。司礼监代批让简单低风险请求走快速通道（命中条陈直接代批），复杂请求才呈送总控走完整流程。代批权受限（条陈由总控预授权、司礼监不得扩充）防止权力滥用。批红标签+审计后验保证可追溯。四不变量代码强制保证代批不失控。明朝司礼监"批红"机制天然映射这种有限代批权。

**影响**：新增 15-sijian-batch.md 详述司礼监代批。决策 7（用户消息只给主 Agent）升级：用户消息先经司礼监关口，代批的直接返回，呈送的转总控（主 Agent）。shared/core-invariants.ts 新增四个 sijian-* 不变量。BatchApproveCharter 接口在 infrastructure 新增。条陈由总控（SupremeController）预授权，存 Session 级配置。

---

## 决策 78：军功簿（WeightRegistry 跨任务学习闭环）

**选择**：WeightRegistry 是跨任务学习闭环基础设施，与 MemoryStore 并列。记录每个 Identity/Agent 历史表现评分。后续 dispatch 按权重推荐/选择。表现稳定则升权，不佳则降权。保留探索比例（ε-greedy 防过早收敛）。模式别名：竞功制下叫"军功簿"，内阁制下叫"考绩簿"，核心接口名统一 WeightRegistry。内阁制映射：首辅加权裁决读取 WeightRegistry（不再依赖自报置信度）。竞功制映射：军功勘验使 updateWeights 直接写入；总督下次 replicateTask 按权重选提督。Phase 1 NoOp 实现，Phase 2+ SQLite 持久化。

**理由**：v3 每次任务从零开始，Identity 选择和首辅裁决依赖自报置信度（不可靠）。WeightRegistry 让系统越用越聪明：历史表现好的 Identity 升权，下次 dispatch 优先选择。ε-greedy 保留探索比例防止过早收敛到局部最优。竞功制军功勘验使的 updateWeights 是权重来源（事后复盘评分写入），内阁制首辅裁决读取权重（加权决策）。两个模式共享同一基础设施，别名区分语境。v4 提升为核心 Infrastructure（不只竞功制，内阁制也用）。

**影响**：07-infrastructure.md 新增 WeightRegistry 接口。决策 75 首辅加权裁决、决策 76 军功勘验 updateWeights 分别引用。Phase 1 NoOp 不影响功能，Phase 2+ SQLite 持久化。与 MemoryStore（决策 28）并列，职责不同：MemoryStore 记忆事实，WeightRegistry 记录表现评分。

---

## 决策 79：通信图状化

**选择**：从 v3 树形单链路（dispatch + contactMainAgent）扩展为图状通信。三种通信模式：① 点对点 send_message(to, ...)（基于权限）；② 发布订阅 publish/subscribe(topic, ...)（EventBus 暴露为工具）；③ 频道/主题（多 Agent 异步协作，黑板模式底层）。内阁制实现：协作总线（CollaborationBus）——订阅发布+总控授权列表+日志审计。竞功制实现：塘报旗牌使（DispatchMessenger）——点对多分发+固定频道独立上报+接收清单。通信权限：Identity 声明能发给谁/订阅什么。核心不变量：market Coordination 下竞争者间禁止横向通信（公平性保障）。跨用户通信（Phase 3）需 Trust Level 授权。

**理由**：v3 只有两条通信边（dispatch 父→子、contactMainAgent 子→父），无法支持多 Agent 复杂协作（多规划者协商、多团队竞争、异步黑板协作）。图状通信提供三种模式覆盖所有协作场景：点对点（定向请求）、发布订阅（广播通知）、频道（异步协作）。权限声明式化（Identity 声明能发给谁）取代硬编码角色判断。禁止横向通信不变量保障竞功制公平性（竞争者互通会破坏独立性）。跨用户通信需信任授权保障多用户安全。

**影响**：07-infrastructure.md 新增 AgentTransport 接口（点对点）、EventBus 接口（发布订阅）、Blackboard 接口（频道）。决策 47 contactMainAgent 保留为点对点的一种。决策 75 协作总线、决策 76 塘报旗牌使分别是两模式实现。Identity 定义新增 communicationScope 字段。market Coordination 禁止横向通信写入 core-invariants.ts。

---

## 决策 80：状态事件溯源

**选择**：从 v3 可变对象 projectState 改为事件溯源（EventSourcedState）。核心模型：所有状态变更是 append-only 事件；状态是事件的投影；天然支持审计（谁改了什么）、回放（Replay）、并发（事件不冲突，投影才冲突）。命名空间/作用域：共享状态分区，Agent 只看自己有权的分区（与 Identity scope 联动）。黑板模式：事件流之上提供 Blackboard 抽象，多 Agent 异步读写。Session.domainState：核心只提供 Record<string,unknown> 容器，schema 由 Domain Pack 定义。底层是事件投影。Phase 1 简化为可变对象+activityLog，接口按事件溯源设计。

**理由**：v3 projectState 是可变对象，并发修改冲突难解、审计困难、崩溃恢复靠快照不可回放。事件溯源天然解决：append-only 事件不冲突（并发友好），投影可重算（回放友好），事件流带 userId/timestamp（审计友好）。命名空间分区让 Agent 只看有权区域（安全）。黑板模式在事件流之上提供异步协作抽象。Phase 1 简化实现但接口按终局设计（原则 2 延伸），后续升级换实现不改接口。

**影响**：07-infrastructure.md 新增 EventSourcedState 接口、EventStore 接口、Blackboard 接口。决策 5 Session 工作区：projectState 改为 domainState（事件投影）。决策 31 状态持久化升级为事件流持久化。决策 11/18 监察审计读取事件流。Session.domainState schema 由 Pack 定义（决策 71）。Phase 1 内存可变对象+activityLog，接口已按事件溯源。

---

## 决策 81：监察分层 + 权力分离

**选择**：从 v3 Check+MetaCheck 两层扩展为可配置三层+权力分离。三层监察：过程监督（内阁制六科给事中/竞功制监军御史，仅暂停权）、事后审计（内阁制都察院/竞功制军功勘验使，建议性/权重影响）、高风险复核（内阁制大理寺/竞功制无对应，强制推翻）。权力分离原则（核心不变量）：暂停权与恢复权分离（过程监督可暂停不可恢复，恢复需更高层）；监察者被谁监察（改写/暂停记录进事件流，可被更高层采样复审）；fail-closed 选项（监察失败可选 fail-open 原样通过或 fail-closed 拒绝）。MetaCheck 改造：从 1:1 常驻伴随改为按策略触发（ReviewPolicy：checkpoint/persistent/never）。maxCorrections+confidenceThreshold 保留。透明化：改写标注来源（用户可区分原话和改写）。

**理由**：v3 两层监察（Check Subagent + MetaCheck）职责单一且 MetaCheck 1:1 常驻开销大。复杂场景需要三层分离：过程监督（实时暂停权）、事后审计（复盘权重）、高风险复核（强制推翻）。权力分离防止监察者滥权：暂停权与恢复权分属不同层（过程监督可暂停但恢复需高层），监察者行为记录进事件流可被复审。MetaCheck 按策略触发取代 1:1 常驻，降低开销。透明化让用户知道哪些是原话哪些是改写，增强可信度。

**影响**：决策 11 Check 双重职责升级为三层监察的一种（过程监督默认实现）。决策 18 MetaCheck 从 1:1 常驻改为 ReviewPolicy 触发+透明化。05-agent-roles.md 监察角色重写。07-infrastructure.md 新增 ReviewPolicy 接口。core-invariants.ts 新增权力分离不变量（suspend-recover-separation、reviewer-auditable、fail-closed-option）。决策 75/76 两模式分别实现三层监察。

---

## 决策 82：紧急通道降级

**选择**：规划/执行失效时，决策者不现场 improvisation，直接下发预设降级方案（EmergencyFallback）。内阁制实现：总控 emergencyFallback——规划超时/冲突时直接下发预设方案到执行层。竞功制实现：总督 haltBranch——一路出问题时直接采纳已完成分支或中止。EmergencyFallback 契约：triggerCondition（超时/冲突级别）+ fallbackValue（预设兜底）+ defaultBehavior（默认行为描述）。预定义优于 improvisation（系统初始化时声明，不现场创造）。

**理由**：v3 规划/执行失效时无降级机制，要么卡死要么 Main Agent 现场 improvisation（质量不可控）。预设降级方案在系统初始化时声明（已经评审过），比现场 improvisation（未评审、可能错误）可靠。内阁制总控的 emergencyFallback 覆盖规划失效，竞功制总督的 haltBranch 覆盖竞争者失效。"预定义优于 improvisation"是核心原则——降级方案必须是预先评审过的，不是失败时临时创造的。

**影响**：07-infrastructure.md 新增 EmergencyFallback 接口。决策 75 内阁制总控、决策 76 竞功制总督分别实现。EmergencyFallback 在系统初始化时声明（bootstrap 阶段），存 Session 级配置。triggerCondition 监控由 ActivityMonitor（决策 53）触发。

---

## 决策 83：User 一等公民

**选择**：User 从 v3 的 AuthContext.userId 字符串升级为一等实体。UserProfile 包含：identity（画像/偏好/专业领域）、permissions（跨资源权限）、quotas（并发/成本/存储配额）、memory（跨 session 记忆）、agents（常驻 Agent 注册表）、sessions。Session 扩展：type: "personal" | "shared"；participants: UserRef[]；owner；permissions: SessionACL。多用户协作涌现（Phase 3）：跨用户复用专家、多用户 Tournament vote（真人投票）、协作 Session 责任追溯（事件流带 userId）。信任模型：Trust Level（none/read-only/invoke/delegate/full-control）。Phase 1 简化：单用户，UserProfile 存在但字段精简。

**理由**：v3 把 User 降级为 AuthContext.userId 字符串，无法支持多用户协作（跨用户复用专家、真人投票、责任追溯）。v4 终局目标是多人在线协作，User 必须是一等实体。UserProfile 整合用户所有上下文（画像/权限/配额/记忆/Agent），让系统理解用户。Session 扩展支持 shared 类型为多用户协作铺路。信任模型（Trust Level）控制跨用户通信授权。Phase 1 单用户简化，但 UserProfile 接口按终局设计，后续扩展不改接口。

**影响**：07-infrastructure.md 新增 UserProfile 接口、SessionACL 接口、TrustLevel 枚举。决策 5 Session 工作区扩展 participants/owner/permissions。决策 79 跨用户通信需 TrustLevel 授权。决策 80 事件流带 userId 支持责任追溯。Phase 1 单用户 UserProfile 字段精简，Phase 3 多用户协作。

---

## 决策 84：Preset + 渐进推断

**选择**：解决 Main Agent 决策负担（四维度+两层 Pattern+Domain Pack 过多选择）。Preset 归 Domain Pack（不是第五个库），每个 Pack 提供自己的 Preset 集。Preset 契约：coordination（固化 Coordination）+ execution（固化 Execution）+ defaults（四维度默认值 identity/loop/prompt/skills）+ infer（渐进推断规则）。派发流程：选 Preset（或系统按 catalog.when_to_use 推荐）→ 只填 task + 可选 identity → 系统按 infer 补齐其余 → dispatch_subagent。决策负担从 7-8 个降到 2-3 个。

**理由**：v4 四维度（identity/loop/prompt/skills）+ 两层 Pattern（Coordination/Execution）+ Domain Pack 导致 Main Agent 派发时要做 7-8 个决策，认知负担过重。Preset 把常用合法组合打包（coordination+execution+defaults 固化），用户只填 task 即可派发。infer 规则按任务特征渐进推断剩余维度（如只读任务自动选 dag execution、低风险身份）。Preset 归 Pack 而非第五个库，因为 Preset 是 Pack 的"配方"（打包 Pack 自己的资产），不是独立可注册资产。决策负担从 7-8 个降到 2-3 个（选 Preset + 填 task + 可选 identity）。

**影响**：决策 71 DomainPack.presets 字段生效。dispatch_subagent 新增 preset 参数。catalog.yaml 新增 presets 索引。04-four-libraries.md 新增 Preset 章节（归 Pack 不归库）。infer 规则由 Pack 定义，核心提供 infer 引擎。Phase 1 coding-pack 自带若干 Preset（如 code-review-preset、code-write-preset）。

---

## 决策 85：Capability 契约

**选择**：Pattern 兼容性机制用 Capability 契约。每个 Pattern 声明 provides（提供的能力）+ requires（依赖的能力）+ compatibleWith（Phase 1 白名单）。Phase 1 用白名单简化版：每个 Coordination 声明 compatibleExecutions 白名单。Phase 2+ 演进到完整 requires/provides 契约匹配（Coordination provides 的 Capability 满足 Execution requires 的 Capability 才能组合）。Phase 1 白名单推导的组合矩阵：hierarchy×{dag, tournament, chain, fan-out}、market×{dag, tournament, fan-out}、peer-mesh 全部 Phase 2+。

**理由**：两层 Pattern（决策 73）独立可组合，但并非所有组合都合法（如 market×chain 竞争者链式依赖破坏公平性）。需要机制约束合法组合。Phase 1 用白名单最简（每个 Coordination 声明允许的 Execution 列表），足够覆盖已知合法组合。Phase 2+ 演进到 Capability 契约（provides/requires 匹配）支持新 Pattern 自动发现合法组合，无需改白名单。两阶段设计遵循原则 2（接口按终局设计，Phase 1 提供最笨实现）。

**影响**：03-execution-modes.md 新增 Capability 契约章节+组合矩阵。Pattern 接口新增 provides/requires/compatibleWith 字段。09-seam-map.md 新增 Pattern 注册接缝（声明 Capability）。Phase 1 白名单硬编码在 core，Phase 2+ 演进到契约匹配引擎。决策 73 两层 Pattern 合法性由本决策约束。

---

## 决策 86：council 注册为第 5 协调拓扑

**选择**：在 PatternRegistry 中注册 `council` 作为第 5 个 Coordination Pattern（与 hierarchy / market / peer-mesh / federation 并列），不新增一等概念。

**理由**：council 的定义性机制是谋士议会式协作——多个专精谋士角色以议会形态分工，4 个执行策略（fan-out/chain/tournament/dag）作为独立可选模式；其中 dag（总智囊）是 opt-in 融合模式，内部诊断后调用前三者或激活朝会复合态。路由分发是总智囊 的内部行为，非 council 拓扑的定义。此机制与现有四种拓扑（hierarchy/market/peer-mesh/federation）正交，需独立注册。复用 PatternRegistry 现有缝（只校验 provides/requires/compatibleWith，不查 execution 字段），不改框架接口。

**影响**：02-architecture-layers.md §8.1 六一等概念表的 Pattern 行，Coordination 枚举从 hierarchy/market/peer-mesh/federation 扩展为含 council（显示名议会/谋士式）。03-execution-modes.md §1.2 Coordination 表加 council 行（机制描述=谋士议会式协作），§1.4 矩阵加 council 行，council 内 4 个 Execution（fan-out/chain/tournament/dag）作为独立可选模式并列注册。

---

## 决策 87：翰林格物学士为横切增益模块（非关卡非一等概念）

**选择**：翰林格物学士（HanlinEnricher）定义为「横切增益模块」，区别于司礼监「关卡模块」（gate）。增益模块只增加上下文、不拦截、可跳过；关卡模块能拒绝/绕过。不新增一等概念，走新增的「横切增益模块注册」缝。

**理由**：翰林与司礼监职能不重叠（一个增益、一个过滤），混为关卡会丧失增益的可跳过性。增益模块是 v4 新增模块类型，与关卡模块、Pattern 模块三分天下。

**影响**：09-seam-map.md 新增「横切增益模块注册」缝（仿现有 §3.14 PatternRegistry 缝）。07-infrastructure.md 不新增一等概念，仅注册缝说明。02-architecture-layers.md §3 七层栈说明补翰林增益模块位置（司礼监后、Composition 前）。

---

## 决策 88：术语重命名（经筵学士·圣裁Agent）+ 不交叉规则扩三族

**选择**：帝皇模式内原稿「翰林学士」重命名为**经筵学士**（JingyanScholar，帝皇讲席，区别于翰林格物学士）；「批红Agent」重命名为**圣裁Agent**（DihuangSynthesizer，帝皇裁决，区别于司礼监批红标签）。不交叉规则（原则 21）从两族扩展为三族：内阁制（文官）/竞功制（军事）/智囊团（谋士）。

**理由**：原命名与全局「翰林格物学士」和司礼监「批红」标签撞名，导致术语跨模式漂移。三族不交叉是 v4 核心术语规范，智囊团作为第三独立族必须明确边界。

**影响**：智囊团文档（17/18）禁用「翰林学士」「批红Agent」等撞名。AGENTS.md §3（元数据）+ .agents/rules/write-new-doc.md v4 术语规范补「第三族=智囊团」段落。17-zhinang-modes.md §3 帝皇详解用经筵学士/圣裁Agent/谏院御史/资源御史。
**注**：本决策引用的原则 21 已被原则 33 推翻（三模式共享术语池），术语规则见原则 33。

---

## 决策 89：朝会为 council 复合运行态，不占矩阵单元

**选择**：朝会（Chaohui）是 council 路由器的运行态组合（内部串行调用 fan-out→chain→tournament），不是第 5 个 Execution 模式，不注册为 Pattern，不占 Coordination×Execution 矩阵的任何单元。

**理由**：朝会没有独立的 execution 语义，它是 council 特有的「混合诊断向量激活的组合执行路径」。若将其列为独立 Execution，矩阵会膨胀且语义重复（朝会内部就是三策略的组合）。

**影响**：03-execution-modes.md §1.4 矩阵 council 行标注 fan-out/chain/tournament/dag（可路由），下方加脚注：「朝会为 council 协调拓扑的复合运行态，非独立 Execution，不占矩阵单元。」17-zhinang-modes.md §5 朝会专题说明此定位。

---

## 决策 90：智囊团经过司礼监关口

**选择**：智囊团默认经过司礼监关口（与内阁制/竞功制一致）。司礼监代批（命中条陈+低风险）→ 直接返回用户，绕过翰林与 council；司礼监呈送（复杂/多步/涉数据）→ 进入翰林增益 → council 路由。

**理由**：司礼监是通用入口，所有模式共享。智囊团作为新模式族不破坏通用入口设计。翰林增益在呈送后注入，不参与代批判断，保持司礼监代批路径不变。

**影响**：智囊团数据流明确「司礼监 → 翰林 → council 路由」顺序。司礼监四不变量（sijian-no-arbitrary-approve / sijian-must-be-traceable / sijian-escalate-complex / sijian-charter-immutable）同样适用于智囊团。15-sijian-batch.md 文档无需修改，智囊团复用现有代批机制。

---

## 决策 91：门客映射 council-menke + fan-out Execution

**选择**：门客型 Agent 池注册为 `council-menke` Pattern，声明 `coordination: "council"` + `execution: "fan-out"`。

**理由**：fan-out 的「数据驱动动态扩展，expand/parallel/collect 三阶段」与门客「多人格并行发散，追求不可能思路」的职责完全匹配。creativeIdea 是门客的原子输出，对应 fan-out 的 collect 阶段产物。

**影响**：门客成为 council 拓扑下第一个合法 Execution 组合单元。PatternRegistry 仅校验 `compatibleWith`，不查 `execution` 字段，registration 直接通过。

---

## 决策 92：幕僚映射 council-muliao + chain Execution + 冲突升级规则

**选择**：幕僚型小组注册为 `council-muliao` Pattern，声明 `coordination: "council"` + `execution: "chain"`。分歧度 ≥6/10 触发升级到帝皇 tournament 或用户确认。

**理由**：chain 的「步骤顺序串联，输出变量绑定传递」与幕僚「合规→钱粮→文案→调度」的线性审查流程匹配。两轮迭代上限防止 chain 无限循环。

**影响**：幕僚的 chain 依赖上游客栈（门客创意列表）作为输入，输出物为可审计的 ExecutionPlan + RiskRegister。升级规则打破 chain 闭环，引入 tournament 竞争。

---

## 决策 93：帝皇映射 council-dihuang + tournament Execution + 术语重命名

**选择**：帝皇智囊中枢注册为 `council-dihuang` Pattern，声明 `coordination: "council"` + `execution: "tournament"`。内部角色「翰林学士」重命名为「经筵学士」，「批红Agent」重命名为「圣裁Agent」。

**理由**：tournament 的「N 个个体/团队同任务竞争，评功选优合并」与帝皇「多方案审议+强制反对+择优裁决」匹配。术语重命名避撞全局「翰林格物学士」（增益模块）和司礼监「批红」标签。

**影响**：帝皇成为 council 拓扑下第三个合法 Execution 组合单元。经筵学士/圣裁Agent 成为智囊团专用术语，不进入内阁制/竞功制术语空间。

---

## 决策 94：总智囊路由不变量

**选择**：总智囊（ZhinangRouter）作为 `council-zhinang` Pattern 的 entry ModuleInstance，编排深度 ≤3 层，路由失败回退幕僚，不得递归调用自身。总智囊为 opt-in 融合模式，用户主动选择才进入；门客/幕僚/帝皇 可独立直选。

**理由**：dag 执行模式的「DAG 建图 + Wave 拓扑排序」适合总智囊的「诊断→路由→执行→审计」编排流程。不变量防止 council 路由器形成循环依赖或无限递归。

**影响**：总智囊的 `conveneChaohui` 方法朝会复合态调用计入编排深度，朝会内部的 fan-out→chain→tournament 串联不额外增加路由器深度。

---

## 决策 95：朝会复合态运行规则

**选择**：朝会为 council 路由器的复合运行态，不注册为 Pattern，不占 Coordination×Execution 矩阵单元。

**理由**：朝会是「council 协调拓扑特有」的运行态组合，内部串行调用 fan-out→chain→tournament，不是独立 Execution。council 的定义性机制是谋士议会式协作——4 个执行策略独立可选，dag（总智囊）为 opt-in 融合。朝会复合态是总智囊 的内部运行态组合，路由是总智囊 内部行为，非 council 族定义；若将朝会注册为独立 Pattern，将与「4 执行策略独立可选 + 总智囊 opt-in 融合」的机制相冲突。

**影响**：03-execution-modes.md 矩阵中 council 行标注为「fan-out / chain / tournament / dag（可路由）」，加脚注说明朝会复合态。17-zhinang-modes.md §5 作为朝会专题详述。

---

## 决策 96：编排类型二分类（任事型/谋士型）+ 废弃模式族分类层级

**选择**：璇玑 v4 顶层模式分类从「3 模式族（内阁/竞功/智囊）」重构为「2 编排类型」——任事型（Renshi type, task-execution，内阁制 hierarchy + 竞功制 market，产出交付物）与谋士型（Moushi type, strategist，智囊团 council 四模式，产出谋议/分析）。废弃「模式族」分类层级叙事，统一为「编排类型」（orchestration type）。

**理由**：内阁制与竞功制职责同质（把事办成/产出交付物），原「3 模式族并列」未能体现此共性；谋士型（智囊团）产出的是分析/谋议而非交付物，职责异质需独立成类。古典对仗「任事之臣 vs 谋士」（如萧何 vs 张良）使二分类直观。命名避「执行型」以与现有 Execution 执行模式（两层 Pattern 之一）区分。

**影响**：原则 30 重写为「谋士型（第二编排类型）」；17-zhinang §1「第二编排类型」补全为谋士型；03-execution-modes §1.5/§1.6 成为编排类型技术落点；全局页脚决策总数 95→96。术语规则见原则 33（原原则 21 已推翻，三模式共享术语池）——三模式（朝廷/竞功/大明）同属任事型，术语统一共享，不再因模式切换而改名。

**讨论来源**：无<!-- TODO: 人工确认链接 -->

**实现 PR**：Phase 1 全激活
**变更记录**：v2.11 — 实现PR字段回填（Phase annotation, T8 §14.4 反向回流）

---

## 决策 97：任事型编排替换为三模式+效率转模

**选择**：将原任事型两模式（内阁制 on-demand hierarchy + 竞功制 swarm market）直接替换为三模式（朝廷 Chaoting / 竞功 Jinggong / 大明 Daming）+ 效率转模机制。内阁制重命名为朝廷模式，竞功制重命名为竞功模式，新增大明模式承载大型异构任务的混合编排，效率转模作为模式切换触发策略（非第四独立模式）。

**理由**：原两模式无法覆盖「同一任务内部确定性分级」场景（部分子任务确定性强、部分模糊多解）。三模式+效率转模使规划层可对子任务做确定性评分，高确定性走朝廷、低确定性剥离转竞功、结果回归汇总。大明模式复用朝廷+竞功全部角色，不新增微内核一等概念。

**影响**：11-renshi-shared-base.md 重命名为 12-chaoting-mode.md 并重写；13-jinggong-mode.md 重写；新增 14-daming-mode.md / 11-renshi-shared-base.md；全局术语级联（21文件）；原则21废除（术语三族不交叉→三模式共享术语池，见决策98）。

**讨论来源**：无<!-- TODO: 人工确认链接 -->

**实现 PR**：Phase 1 全激活
**变更记录**：v2.11 — 实现PR字段回填（Phase annotation, T8 §14.4 反向回流）

---

## 决策 98：废除原则21，新增原则33三模式共享术语池

**选择**：废除原则21（内阁制/竞功制术语三族不交叉规则），新增原则33（三模式共享术语池）。朝廷/竞功/大明三模式共享同一套术语体系，不再因模式切换而改名。智囊团（谋士型）术语仍独立（谋士型术语族不变）。原则21编号保留不重排，标注「已推翻见原则33」。

**理由**：原术语三族不交叉规则在三模式下导致同一职能需三个名字，增加认知负担且无实际收益。三模式共享术语池简化术语管理，模式切换不再伴随称呼变更。谋士型（智囊团）因产出类型异质（谋议vs交付物），术语仍独立。

**影响**：AGENTS.md §3（元数据）+ .agents/rules/write-new-doc.md 术语规则更新；README 原则速查更新（原则21标已推翻+原则33新增）；全局「内阁制」作为现役模式名清零（历史说明除外）。

**讨论来源**：无<!-- TODO: 人工确认链接 -->

**实现 PR**：Phase 1 全激活
**变更记录**：v2.11 — 实现PR字段回填（Phase annotation, T8 §14.4 反向回流）

---

## 决策 99：新Agent全部映射Identity.role，财政/灾备为Infrastructure扩展（不新增微内核一等概念）

**选择**：三模式引入的全部新Agent（律例/档籍/考功司/户部/太仓库/内承运库/御马监/锦衣卫/东厂等）映射到 Identity.role 值。财政体系（户部+太仓库）→ Infrastructure 层 BudgetRegistry 扩展；灾备（行在六部+锁院）→ Infrastructure 层 ResilienceBackend 扩展；律例 → Infrastructure 层 RuleRegistry 扩展；档籍 → EventSourcedState；考功 → WeightRegistry。不新增微内核一等概念（Agent/Loop/User/Communication/State/Pattern 六个之外）。

**理由**：保持微内核领域中立（原则18）。新体系作为 Infrastructure 层接口实现，不污染核心6一等概念。Identity.role 是角色扩展点，新Agent天然映射。

**影响**：07-infrastructure.md 新增 BudgetRegistry/ResilienceBackend/RuleRegistry 模块；05-agent-roles.md 角色表扩展；11-renshi-shared-base.md §14 微内核对接章节定义全部映射。

**讨论来源**：无<!-- TODO: 人工确认链接 -->

**实现 PR**：Phase 1 全激活
**变更记录**：v2.11 — 实现PR字段回填（Phase annotation, T8 §14.4 反向回流）

---

## 决策 100：司礼监代批 delta 扩展

**选择**：15-sijian-batch.md 扩展 7 项 delta（急递通道/分层压缩/封驳偏离度评分/问策入口/三模式共享定位/战略必亲批清单引用/锁院暂停），保留原有条陈/批红/四不变量核心。

**理由**：原司礼监仅处理入口代批，缺乏执行中急递、上下文分层压缩、驳回质量评分、用户反馈入口等能力。delta 扩展使司礼监覆盖完整交互关口职责。

**影响**：15-sijian-batch.md 状态 stable→draft，版本主版本+1；新增对 11-renshi-shared-base.md §12 人类介入点的引用。

**讨论来源**：无<!-- TODO: 人工确认链接 -->

**实现 PR**：Phase 1 全激活
**变更记录**：v2.11 — 实现PR字段回填（Phase annotation, T8 §14.4 反向回流）

---

## 决策 101：人类关键介入点

**选择**：定义 7 类必亲批决策清单（模式切换/效率转模触发、诏狱启用/锦衣卫隔离、灾备部行在六部激活/锁院熔断、大额拨付/国库调整、御马监出动、永久降权/考功最终裁定、律例根本性修改）。设审批时限，超时采保守默认（拒绝/维持现状）。

**理由**：AI 自主决策需有边界。7 类涉及模式根本变更、安全隔离、灾备熔断、大额资源、永久惩罚、规则根本修改的决策必须人类亲批，防止 AI 自我扩权或不可逆操作。

**影响**：11-renshi-shared-base.md §12 定义完整清单；15-sijian-batch.md delta 引用此清单（司礼监不得代批这7类）；总控 Agent 人类亲批清单更新。

**讨论来源**：无<!-- TODO: 人工确认链接 -->

**实现 PR**：Phase 1 全激活
**变更记录**：v2.11 — 实现PR字段回填（Phase annotation, T8 §14.4 反向回流）

## 决策 102：CLAUDE.md 作为护城河 + AGENTS.md 作为法典（两文件职责分离）

**选择**：确立两文件职责分离架构——CLAUDE.md = 护城河（agent 始终上下文，自包含最核心不可违反的规则：四根支柱/原则零/五层可变性模型/哲学对齐检查/七条铁律/G1-G10+G13防护/任务路由速查），AGENTS.md = 法典（完整规范：设计哲学全文/任务操作流程/写作规范/自查清单）。CLAUDE.md 内容是 AGENTS.md 核心规则的忠实浓缩（非纯指针），允许与 AGENTS.md 核心节有受控重叠。

**理由**：多工具混用场景下，opencode 自动读 AGENTS.md，Claude Code 自动读 CLAUDE.md。CLAUDE.md 作为"护城河"自包含核心规则，确保 agent 无论用哪个工具，最不可违反的底线始终在上下文。AGENTS.md 保持完整规范作为"法典"按需查阅。虽引入 CLAUDE.md 与 AGENTS.md 核心规则的重叠维护，但核心规则（四支柱/铁律）高度稳定、变更频率低，维护负担可控；且"始终上下文"的收益远大于此。此设计修正了初版规划的 POINTER-ONLY 方案（该方案会让 Claude Code 用户看不到核心规则全文）。

**影响**：确立两文件职责分离原则；CLAUDE.md 内容变更必须与 AGENTS.md 核心节保持一致（核心规则变更时双文件同步）；AGENTS.md 不再含"始终遵守"精华区（职责已迁移至 CLAUDE.md）；最多 2 入口政策（AGENTS.md + CLAUDE.md），新增其他工具入口需新决策。

**讨论来源**：无（本次规划决策）

**实现 PR**：Phase 1 全激活
**变更记录**：v4.9 — 描述同步至 CLAUDE.md v1.3（G1-G8→G1-G10+G13、移除 v4 约束、四支柱→四根支柱、七铁律→七条铁律、五层可变性→五层可变性模型、移除"最多 2 入口"冗余表述）
**变更记录**：v2.11 — 实现PR字段回填（Phase annotation, T8 §14.4 反向回流）

> 文档版本：v4.18
> 本版变更（累积最近 3 条，最新在上）：
>   - v4.18：路径引用更新：璇玑/cell-base→璇玑/orbita-sdk/cell-base（old 目录改名 orbita-sdk）
>   - v4.17：决策 19 由「pi-ai 替换方案（自写）」改为「直接复用 pi-ai」——LlmProvider 薄包装保留，实现委托 pi-ai，随决策 2 基于 Pi 调整
>   - v4.16：决策 20 由「pi-tui 替换方案（自写）」改为「直接复用 pi-tui」——随决策 2 基于 Pi 调整
> 基于：璇玑 v3 10-decisions.md（决策 1-69）+ 璇玑 v4 新增决策 70-102
> 决策总数：105 条（v3 1-69 + v4 70-105，含 103-105 T8 回流补录）
> 文档总数：25 份
> 原则总数：33 条

---

## 决策 103：Surface 抽象定位（Entry 层共享渲染抽象，非微内核一等概念）

**选择**：Surface 作为 Entry Layer 的共享渲染抽象，定义于 cell-base/src/entry/surface.ts，提供 6 个类型/接口。不作为微内核一等概念。

**理由**：准入评估不满足条件 3（仅 Entry 层使用）和条件 4（不改微内核接口）。Surface 是 Entry 层内部实现抽象，支持双 Surface 布局。

**影响**：cell-base/src/entry/surface.ts 定义；orbita-cli/src/tui/layouts/surface-container.ts 消费。

**讨论来源**：T8 三层闭环报告 B2 断链 + Phase 3.3 progress（2026-07-12）

**实现 PR**：Phase 3 ABCD 全激活
**变更记录**：v2.11 — 实现PR字段回填（Phase annotation, T8 §14.4 反向回流）

## 决策 104：EntryEvent 协议定义（Entry Layer 核心契约，9 种事件类型）

**选择**：EntryEvent 作为 Entry Layer 核心协议契约，9 种事件类型 discriminated union。6 核心（text_delta/tool_start/tool_result/subagent_status/turn_complete/error）+ 3 透明性（meta_check/permission_request/batch_approved）。

**理由**：Entry Layer 需要 protocol.ts 对齐层将 Cell 内部事件翻译为 UI 可消费标准事件流。

**影响**：cell-base/src/entry/protocol.ts 定义；orbita-cli/src/tui/streaming.ts consumeEntryEvents 消费。text_delta 扩展可选 thinking 字段。

**讨论来源**：T8 报告 B3 断链 + Phase 3.3 progress

**实现 PR**：Phase 3 ABCD 全激活
**变更记录**：v2.11 — 实现PR字段回填（Phase annotation, T8 §14.4 反向回流）

## 决策 105：TUI 渲染层定位（CLI 接入点的具体实现，非新架构层）

**选择**：TUI 渲染层（orbita-cli/src/tui/）是 Entry Layer CLI 接入点的具体实现，非新架构层。

**理由**：02-architecture-layers.md Entry Layer 已列出 CLI/Web/IDE/SDK/RPC 五种接入点，TUI 是 CLI 的终端渲染实现。同层内不应再分层。

**影响**：orbita-cli/src/tui/ 全部代码归 Entry Layer 管辖。双 Surface 布局 + alpha/beta/gamma 三模式是 CLI 接入点 UX 实现选择。

**讨论来源**：T8 报告 B8 断链

**实现 PR**：Phase 3 ABCD 全激活
**变更记录**：v2.11 — 实现PR字段回填（Phase annotation, T8 §14.4 反向回流）

## 决策 106：Factory-with-deps Wiring 模式

**选择**：工具工厂签名 `createTool(deps?: ToolDeps): Tool`，有 deps 走真实路径，无 deps 走 stub 返回。

**理由**：
1. 显式声明依赖（不靠全局 singleton）
2. 无 deps 时退化为 stub（向后兼容 demo/test）
3. cell-base 演示路径与 orbita-cli 生产路径各取所需

**影响**：当前使用点 search-catalog + dispatch-subagent；文档同步 06-core-engine.md §12.1；后续 Pack 注册路径如需多实现切换沿用此模式。

**讨论来源**：T8 反向回流（Phase 2 收尾）

**实现 PR**：Phase 2 全激活
**变更记录**：v2.11 — 实现PR字段回填（Phase annotation, T8 §14.4 反向回流）

---

## 决策 107：wrapEmit Observability 模式

**选择**：在 cell.ts doRun 的 emit 构造链加一层 observability wrap，闭包维护 turn/tool span 关联，metrics 计数 + traceSpan 父子关系。

**理由**：
1. 零侵入 emit 透传（不改 react-loop.ts）
2. 可组合（baseEmit → logger wrap → observability wrap）
3. services 缺失时返回原 emit（向后兼容）

**影响**：当前使用点 cell.ts emit 构造链；文档同步 06-core-engine.md §12.2；解锁 Phase 3+ OTel/Prometheus exporter 接入。

**讨论来源**：T8 反向回流

**实现 PR**：Phase 2 全激活
**变更记录**：v2.11 — 实现PR字段回填（Phase annotation, T8 §14.4 反向回流）

---

## 决策 108：Hook Chain Variadic 设计

**选择**：chainBeforeToolCall/chainAfterToolCall 采用 variadic hook 链（auth → permissions → toolManager → userHook），任一返回 block=true 短路退出。

**理由**：
1. 多个关注点（auth/perm/risk/user）独立组合不耦合
2. 高优先级拒绝后低优先级不执行（避免错误状态）
3. 全 Promise 接口一致

**影响**：当前链路 cell.ts L402-410；文档同步 06-core-engine.md §12.3；向后兼容 toolManager 可选缺失退化为三级链。

**讨论来源**：T8 反向回流

**实现 PR**：Phase 2 全激活
**变更记录**：v2.11 — 实现PR字段回填（Phase annotation, T8 §14.4 反向回流）


## 决策 109：跨节点只传 traceId + userId，接收端用 factory 重建

**选择**：跨节点（RPC / 远程 dispatch）不允许序列化整个 RequestContext。只传 `traceId + userId`，接收端用 factory 重建完整 ctx。

**理由**：
1. RequestContext 包含实时状态（budget 快照），序列化后 stale
2. 权限在不同节点可能有不同解析结果
3. budget 应该由各自 Governor 独立跟踪，避免跨节点竞态

**影响**：跨节点传递只传 traceId + userId；接收端通过 RequestContextFactory.create() 重建完整 ctx；traceId 保持连续性，userId 允许重新解析身份和权限；workspaceId/permissions 由接收端 AuthProvider/PermissionResolver 重新计算；rateLimit/costBudget 由接收端 Governor 独立跟踪。

**讨论来源**：无

**实现 PR**：无

---

## 决策 110：created → propagating → consuming → discarded 四状态机

**选择**：RequestContext 随一次 dispatch 创建，随 dispatch 完成回收。状态机定义 4 个阶段：created → propagating → consuming → discarded。

**理由**：明确生命周期便于追踪、审计和 GC。

**影响**：一次 dispatch 只创建一个 RequestContext；子 Agent dispatch 透传同一个 ctx；每层创建自己的 TraceSpan；执行完成后 ctx 变为 discarded，由 GC 回收；不允许"复活" discarded 的 ctx。

**讨论来源**：无

**实现 PR**：无

---

## 决策 111：整体不可变 + 外部 Governor 跟踪实时状态

**选择**：RequestContext 设计为整体不可变对象。所有字段在创建后不可修改。实时状态通过外部 Governor 跟踪。

**理由**：
1. 透传时无拷贝开销
2. 并发 dispatch 无竞态条件
3. 审计日志只需记录创建时的快照
4. 子 Agent 无法篡改父 Agent 的上下文

**影响**：RequestContext 本身不存储预算余额/速率限制，只存初始值；CostGovernor 实时递减；ConcurrencyGovernor 实时计算；domainState 由 Pack 内部管理。

**讨论来源**：无

**实现 PR**：无

---

## 决策 112：统一 factory + RawRequest，Entry Layer 不直接构造 ctx

**选择**：Entry Layer 不直接构造 RequestContext，而是提交原始请求材料，由 RequestContextFactory 统一处理认证、权限、配额计算，输出只读的 RequestContext。

**理由**：统一创建逻辑，便于审计和维护；Entry Layer 不持有创建逻辑，职责分离。

**影响**：Entry Layer 只提交 RawRequest；RequestContextFactory 统一创建 ctx；Factory 依赖 3 个 Infrastructure 服务（AuthProvider/PermissionResolver/UserProfileStore），均为可选接口，Phase 1 NoOp。

**讨论来源**：无

**实现 PR**：无

---

## 决策 113：司礼监贴黄模式修正

**选择**：IntentBriefing.emperorMessage 改为 Markdown 压缩格式，不是 JSON 也不是原始用户输入。

**理由**：主Agent 需要压缩后的主要信息，不是原始数据。Markdown 可读性好，主Agent 有疑问时通过 forwardQuery 向司礼监追问。

**影响**：03-execution-modes.md §0.6, 15-sijian-batch.md。

**讨论来源**：无

**实现 PR**：无

---

## 决策 114：六部内部协调机制

**选择**：侍郎有独立上奏权（escalate 绕尚书直送皇帝），郎中日常自主（autoApproveScope），不越级 dispatch 不变量（no-skip-dispatch）。

**理由**：明朝六部内部有制衡——侍郎不是尚书的简单下属，有独立上报权。

**影响**：12-chaoting-mode.md §5.6a。

**讨论来源**：无

**实现 PR**：无

---

## 决策 115：模式选择 A+B

**选择**：主Agent 逐步 dispatch（A）+ 皇帝选 Preset 审批（B），保留 C 接口。

**理由**：两种编排方式都需要——最小编排用逐步 dispatch，朝廷模式用 Preset 审批。

**影响**：03-execution-modes.md §0。

**讨论来源**：无

**实现 PR**：无

---

## 决策 116：司礼监代批可中止

**选择**：条陈预授权 + 批红可追溯 + 复杂必呈送。

**理由**：司礼监有有限代批权，但不得自行扩充。命中条单+简单低风险→代批，复杂→呈送主Agent。

**影响**：15-sijian-batch.md, 22-communication.md。

**讨论来源**：无

**实现 PR**：无

---

## 决策 117：司礼监编排协调中枢

**选择**：司礼监升级为编排协调中枢（7 职责全程参与 + SijianCompositionBridge 4 方法 + 方案 B）。

**理由**：司礼监不只是入口/出口，全程参与：过滤/代批/双向通道/进度上报/异常上报/成本追踪/上下文压缩。

**影响**：02-architecture-layers.md, 15-sijian-batch.md, 03-execution-modes.md §0.4a。

**讨论来源**：无

**实现 PR**：无

---

## 决策 118：密奏通道扩大

**选择**：子监督越级直通主Agent + 反坐制度（虚假越级→权重降低）。

**理由**：明朝密奏制度——绕过中间层直达最高层，但频次有上限、内容事后可审计、虚假密奏触发反坐。

**影响**：03-execution-modes.md §0.7b, §0.7c。

**讨论来源**：无

**实现 PR**：无

---

## 决策 119：AgentGroup 编组

**选择**：AgentGroup 是 Composition 层概念，不升为一等概念。

**理由**：AgentGroup 满足"跨模式通用"和"可插拔"，但不满足"改变核心契约"——它只是编排层的组织方式，不改变微内核接口。

**影响**：11-renshi-shared-base.md §23。

**讨论来源**：无

**实现 PR**：无

---

## 决策 120：历史验证整合

**选择**：3 修正 + 5 新发现写入架构文档。

**理由**：明朝参考文档验证后发现部分设计需要修正（如给事中封驳权、都察院汇总功能等）。

**影响**：11-renshi-shared-base.md §24, 12-chaoting-mode.md, 13-jinggong-mode.md。

**讨论来源**：无

**实现 PR**：无

---

## 决策 121：PatternRuntime = 主Agent

**选择**：PatternRuntime 不需要独立接口，主Agent 就是最大的 Agent（dispatch 任务给 subagent）。

**理由**：主Agent 通过 dispatch_subagent 工具派发任务，Loop 引擎执行，不需要单独的 PatternRuntime 接口。

**影响**：03-execution-modes.md §0。

**讨论来源**：无

**实现 PR**：无

---

## 决策 122：最小编排原子

**选择**：定义最小编排原子 = 司礼监 + 规划Agent + 主Agent + 执行Agent + 监督Agent。所有复杂编排模式是这个原子的递归组合。

**理由**：需要一个最小执行单位作为所有模式的基础。复杂模式（朝廷/竞功/大明）由原子递归组合。

**影响**：03-execution-modes.md §0（初始版本，后续 D126-D135 持续演进）。

**讨论来源**：无

**实现 PR**：无

---

## 决策 123：皇帝审批制协调链路

**选择**：皇帝（主Agent）审批制——批红两次 + 再议 + 三角制衡 + 各层 TS 接口。

**理由**：明朝皇帝是审批制不是逐步 dispatch——选 Preset + 审批。内阁票拟→皇帝批红→六科封驳三角制衡。

**影响**：12-chaoting-mode.md §4a。

**讨论来源**：无

**实现 PR**：无

---

## 决策 124：武官系统协调机制

**选择**：文武分工边界 + 主客路协调 + GovernorDistribute 接口 + 日常报告体系 + 九边坐镇频道。

**理由**：明朝军事体系中文臣统兵（总督）不亲自下场，武将（提督）负责战术执行。主客路之间禁止横向通信（market 公平性）。

**影响**：13-jinggong-mode.md §5a。

**讨论来源**：无

**实现 PR**：无

---

## 决策 125：叠加协调机制

**选择**：六模式同时运行 + PhaseTransitionContext 上下文传递 + 多层兜底 FallbackChain + 五条协调铁律。

**理由**：大明模式是朝廷+竞功混编，需要同时运行六种协调模式（垂直/横向/制衡/元监察/差遣/议政）。

**影响**：14-daming-mode.md §5a。

**讨论来源**：无

**实现 PR**：无

---

## 决策 126：规划Agent 增加

**选择**：最小编排原子增加规划Agent（4→5 角色），所有模式统一为"规划→审批→执行→监督"。

**理由**：主Agent 不自己想办法，规划Agent 产出方案，主Agent 审批。这样所有模式结构统一。

**影响**：03-execution-modes.md §0.7a。

**讨论来源**：无

**实现 PR**：无

---

## 决策 127：层级监督

**选择**：监督拆为两层——子监督（检查单个完成）+ 总监督（汇总全局 + 对照方案）。子监督不直接跟主Agent 说话，汇报给总监督。

**理由**：两层压缩确保主Agent 只看一份精简报告。对应明朝给事中→都察院→皇帝。

**影响**：03-execution-modes.md §0.7b。

**讨论来源**：无

**实现 PR**：无

---

## 决策 128：司礼监全程 7 职责

**选择**：司礼监在最小编排原子中全程履行 7 项职责（过滤/代批/双向通道/进度上报/异常上报/成本追踪/上下文压缩）。

**理由**：司礼监不只是入口/出口，中间执行过程也要参与（进度上报、异常上报、成本追踪）。

**影响**：03-execution-modes.md §0.4, §0.4a。

**讨论来源**：无

**实现 PR**：无

---

## 决策 129：闭环互锁监督

**选择**：监督体系改为闭环互锁——子监督↔总监督互察 + 子监督越级直通主Agent。

**理由**：灵感源自明朝厂卫互监——"谁监察监察者"的终极解法不是找第三个人，而是让两者互察+都直达最高层。

**影响**：03-execution-modes.md §0.7b。

**讨论来源**：无

**实现 PR**：无

---

## 决策 130：Agent 生命周期

**选择**：编排层角色（司礼监/主Agent/规划/总监督/复核/审计）模式激活时创建 idle 待命，执行层角色（执行/子监督）按需创建销毁（差遣）。

**理由**：编排模式 = 预建制团队。灵感源自明朝差遣协调——本职常驻，差遣临时授权任务结束回收。

**影响**：03-execution-modes.md §0.5。

**讨论来源**：无

**实现 PR**：无

---

## 决策 131：分层上报 + 返工机制

**选择**：四层上报（小问题自己处理/中问题总监督/大问题主Agent/系统性问题越级直通）+ 返工区分补正（小问题原 Agent 修）vs 重审（大问题销毁重建）。

**理由**：主Agent 只看大问题。灵感源自明朝——给事中驳正退回（小事自己处理）、巡按"小事立断大事奏裁"。

**影响**：03-execution-modes.md §0.7c。

**讨论来源**：无

**实现 PR**：无

---

## 决策 132：超时 + 子监督双模式 + 方案讨论通道

**选择**：DispatchInput 增加 deadline + supervisionMode(passive/active) + 主Agent↔规划Agent 讨论通道（PlanClarifyRequest/PlanSupplement）。

**理由**：超时机制源自六科注销监督（deadline+超时检查）。passive/active 源自给事中（事后）vs 监军御史（实时）。讨论通道源自皇帝与内阁面议。

**影响**：03-execution-modes.md §0.7, §0.7d, §0.7e。

**讨论来源**：无

**实现 PR**：无

---

## 决策 133：审计Agent + 复核Agent（四层监督）

**选择**：最小编排原子增加审计Agent 和复核Agent（6→8 角色），建立四层监督体系（过程监督→全局汇总→结果复核→事后审计）。

**理由**：与明朝监察体系完全对齐——子监督=给事中、总监督=都御史、复核=大理寺、审计=考功司。四层各有关注点不重叠。

**影响**：03-execution-modes.md §0.7f, 11-renshi-shared-base.md §7a。

**讨论来源**：无

**实现 PR**：无

---

## 决策 134：复核两种时机

**选择**：复核Agent 有两种介入时机——事中复核（执行中途关键节点，防止跑偏）+ 事后复核（总监督后主Agent前，结果安全网）。

**理由**：解决 03（事后）和 11-renshi（事中）的矛盾——两种都保留，互补。

**影响**：03-execution-modes.md §0.7f。

**讨论来源**：无

**实现 PR**：无

---

## 决策 135：审计经验记录（则例机制）

**选择**：审计Agent 增加经验记录职责（TaskRecord），两阶段存储：Phase 1 存入 EventSourcedState，Phase 2+ 新增 CaseLibrary（则例库，向量检索）。

**理由**：灵感源自明朝则例——各部维护的案例集"以前类似事务怎么处理的"。WeightRegistry 记录"谁表现好"，CaseLibrary 记录"怎么做的好"。

**影响**：03-execution-modes.md §0.7f, 07-infrastructure.md。

**讨论来源**：无

**实现 PR**：无

---

## 决策 136：12-chaoting 监察层对齐明朝

**选择**：朝廷模式监察层角色对齐明朝实际——监督→子监督(给事中)、审计(都察院)→总监督(都察院都御史)、新增审计=考功司。

**理由**：明朝都察院的核心职能是汇总管理（都御史审查弹劾），不是事后审计。事后审计对应考功司（京察大计）。

**影响**：12-chaoting-mode.md §2, §3, §6.1, §9。

**讨论来源**：无

**实现 PR**：无

---

## 决策 137：通政使拆分

**选择**：交互审核 Agent（三机构混合）拆分为通政使 Agent（通政使司，收文/翻译/贴黄）。模式判定 Agent 的明朝映射从掌院学士改为通政使。

**理由**：通政使司本职是收文/传达/判定呈递路径。掌院学士是翰林院学术领袖，不管路由。按明朝实际职务细分，不混合三个机构。

**影响**：12-chaoting-mode.md §2, §3, §4, §5, §6, §9。05-agent-roles.md §2, §3。

**讨论来源**：无

**实现 PR**：无

## 决策 138：CheckAgent 共享监督引擎设计

**选择**：CheckAgent 作为所有监督角色（子监督/总监督/复核/审计/东厂）共用的压缩屏障+通信引擎，不作为微内核一等概念，是 Core Engine 内部机制。通过 CheckerRole 参数化实现 5 种角色不同配置。

**理由**：原则 5（Check 是上下文屏障）之前没有形式化实现契约。散落在 03/05/06 中的 Check 相关设计需要统一。明朝多层通信模型（覆奏/塘报/密奏三通道+层层筛选）提供了完整的通信框架。

**影响**：06-core-engine.md §3a 新增完整章节。Phase 1 只实现 completion+alignment 两种角色。

**讨论来源**：无

**实现 PR**：无

## 决策 139：司礼监增设通政司 subagent

**选择**：司礼监关口层增设通政司 subagent（组合模式持有：SijianGate 组合 TongzhengAgent）。通政司专司收文登记、查看工作区文档（读文件→贴黄摘要）、分类、分发；不决定内容对错——条陈匹配/呈送判断/驳回判断/代批执行全留司礼监。用户仍与司礼监交流，入口不变。

**理由**：用户交流时可能附带大量工作区文档，司礼监逐文件读取会打断与用户的专注交流。按明朝通政司定位（只分类、登记、分发，不决定内容对错），把机械性收文与文档读取工作下放给司礼监的 subagent，让司礼监专注代批判断与用户交流。决策 137 已拆翻译职能给通政使 Agent，本决策将其落位为司礼监的组合 subagent 并扩展工作区文档读取职责（查看工作区文档→贴黄摘要）。

**影响**：02-architecture-layers.md §3（关口层组件结构）、15-sijian-batch.md（架构图/角色表/三重职责）、12-chaoting-mode.md、14-daming-mode.md、16-moushi-overview.md、05-agent-roles.md（通政使从属司礼监）、21-glossary.md；代码 cell-base governance 层新增 TongzhengAgent（组合模式），最小编排单元 minimal-atom 接通政司环节。

**讨论来源**：无

**实现 PR**：无

---

## 决策 140：pi 横切复用经 Adapter Layer（分面适配）

**选择**：pi 横切复用分两档（分面适配，细化决策 2 的「直接复用」）：

- **经 Adapter Layer 适配**（有状态/行为类）：LLM 层 pi-ai（`stream-fn/pi-ai.ts` 桥接 璇玑 StreamFn 接口与 pi-ai 的 `createModels()` + `models.stream()`）、单 Agent 运行时 pi-agent-core（作为 Loop 库默认实现来源与参考）、传输 pi-client/pi-server（AgentTransport 实现）、存储 pi-session-backend-sqlite-node（SessionStore 实现）。璇玑 自有接口（StreamFn / AgentLoop / AgentTransport / SessionStore）定义在适配层之外；pi 仅作为适配层内部依赖，任何 璇玑 代码不直接 import 有状态/行为类 pi 包，统一经适配层。
- **直接复用**（纯类型/纯渲染叶依赖）：pi-telemetry 的 vendor-neutral 遥测类型（span/event schema）、pi-protocol 的 CBOR 会话协议（纯数据结构）、pi-tui（纯渲染库，仅依赖 marked 与 get-east-asian-width，无架构耦合）。

**理由**：璇玑 fork pi 到 `璇玑/pi-sdk/` 需定期同步上游，「直接复用」在实现层散落 import 点——升级 pi API 变更需满仓改调用处，逐步替换某块能力时无边界可循。Adapter Layer 把对 pi 的依赖收敛为薄层：升级只改适配层、替换只重写对应适配器、增量迁移一次一个。分面适配避免过度设计——纯类型/纯渲染叶依赖写适配器是白付样板代码成本。代码 `stream-fn/pi-ai.ts` 已是适配层先例（T8 回流：实现先于文档）。

**影响**：决策 2「pi 横切能力直接复用，不重写」细化为「分面适配：有状态/行为类经 Adapter Layer，纯类型/纯渲染叶依赖直接复用」；决策 19（pi-ai）实现方式由「直接复用」细化「经 Adapter Layer 适配」；决策 20（pi-tui）保持不变（本就属直接复用档）。不新增一等概念、不新增一等架构层、不新增接缝——Adapter Layer 是落在既有接缝（LLM Provider/ProviderSlot、Loop 库、AgentTransport、SessionStore）内的实现组织方式，升级/替换风险收敛到适配层，核心契约零改动。01-overview.md 原则 3、README.md 原则 3、08-package-structure.md、07-infrastructure.md、09-seam-map.md 同步更新。

**讨论来源**：无

**实现 PR**：无

## 决策 141：活跃度分级作为 State 实现策略（正交维度）

**选择**：活跃度（热 hot/温 warm/冷 cold）作为 **State 实现策略**维度吸收（免疫记忆分级启发，28-session-storage.md §4），与 4 层存储内容模型（28-session-storage.md §4，决策 S0）**正交**：活跃度决定「一个会话整体放哪一层/加载多快」，4 层内容模型决定「会话内部内容怎么分」。热=内存常驻（第 3 层）、温=SQLite 落库+元数据可常驻、冷=只留摘要+原件入档籍（第 0 层）。

**理由**：免疫记忆分级（T_CM/T_EM/T_RM/LLPC）给的是「活跃度」维度而非「内容」维度——4 层内容模型是多年沉淀的内容骨架，不应被替换；活跃度补上「放哪、加载多快」的答案。LLPC 元数据常驻缓存对应「常用会话列表/元数据常驻内存」，不纳入 MVP（会话量小时 SQLite 足够快，缓存引入失效一致性成本），记 Phase 2+。

**影响**：Session 数据结构增 `activity` 状态字段（hot/warm/cold）；StateBackend 按活跃度分派存储策略。**不新增一等概念**（不满足 §0.5 准入条件）、不新增一等架构层——活跃度是落在既有 State 实现内的策略维度。

**讨论来源**：无

**实现 PR**：无

## 决策 142：会话持久化 MVP 范围（事件流 + 元数据 + 摘要）

**选择**：MVP 落库边界 = **事件流 + 会话元数据 + 摘要（贴黄）**；投影/快照不落库，靠 replay 重建。摘要存**同库新表** `session_summaries`（与事件流同 SQLite 文件、事务内同步）；摘要锚定事件区间（`start_seq`/`end_seq`）、更新走新版本插入（不覆盖）。

**理由**：两段式加载（先摘要后回放）是免疫「二次应答更快更强」的映射——大会话秒开摘要、细节按需回放，值得进 MVP。投影不落库呼应 23-state §11「索引可重建，实体不可重建」，保持单一事实源（事件流）。摘要与事件流一致性靠区间锚定 + 新版本插入保障（28 §5.3）。压缩心智模型采用「事件流=DNA 永不物理删除、压缩=改变表达（沉默）」，第 2 层裁剪保留为存储膨胀兜底（28 §5.2）。

**影响**：持久化 schema 含三表（sessions/session_events/session_summaries，见决策 144）；压缩流程触发点生成摘要；重放/审计按区间校验摘要一致性。不新增一等概念。

**讨论来源**：无

**实现 PR**：无

## 决策 143：本地会话存储默认后端 node:sqlite

**选择**：桌面本地会话存储 MVP 默认后端 = **node:sqlite**（Node 22.5+ 内置、Electron 38 可用）；替代候选 better-sqlite3；**否决 sql.js**（无 WAL，整个库一次性落盘，违背「数据基础设施可信性」）。后端经 `StateBackend` 接口（23-state §3）可插拔切换。

**理由**：node:sqlite 零打包负担（无 .node 二进制、无需 electron-rebuild）、WAL 支持（事件流可信底座硬要求）、同步 API 匹配 session 存取自然模型。实验特性风险（API 可能变动）由 StateBackend 可插拔接口吸收——API 变动时仅需换实现类。Electron 38 内实际可用性标注「待验证」，实现时确认。

**影响**：无新增一等概念/一等层/接缝——落在既有 StateBackend 接缝内。sql.js 维持现状用途（XuePromptManager 提示词管理），不用于会话存储。

**讨论来源**：无

**实现 PR**：无

## 决策 144：本地存储单文件 + 内部分表

**选择**：本地会话存储 = **单 SQLite 文件 + 内部分表**（`sessions` / `session_events` / `session_summaries` 三表），文件路径 `~/.orbita/data/orbita.db`，`userId`/`workspaceId` 为列（权限隔离靠 SQL WHERE 过滤）。每 workspace 一文件记 Phase 3+（触发条件：按 workspace 独立备份/分享硬需求，或单文件超大 >数百 MB 需物理分拆）。

**理由**：本地单用户桌面场景，多 workspace 是组织会话的分类而非租户隔离，无文件级隔离需求；单文件全量备份/迁移最符合桌面用户心智；一套 schema 复杂度最低。跨 workspace 查询一条 SQL 完成（多文件则跨文件查询麻烦）。

**影响**：备份 = 拷贝 `~/.orbita/data/orbita.db`；迁移 = 复制数据目录。多用户场景（Phase 3 PgStore）走 server 端，不受本决策影响。

**讨论来源**：无

**实现 PR**：无

## 决策 145：横切基建借鉴对象由 pi 转向 dsh（引用/借鉴 dsh + 核心自研）

**选择**：横切基建借鉴对象由 pi 转为 dsh（deepseek-harness）——「引用/借鉴 dsh + 核心自研」：璇玑 协作编排核心（微内核 6 一等概念 / 编排两层 Pattern / 通信 / 状态 / 用户 / 四库）**自研**；dsh 的横切基建（LLM adapter registry / Agent 生命周期事务 / Typert 工具协议 / session 持久化分层 / 沙箱策略）作为**设计参考**借鉴，纯类型/协议形状抄入 璇玑 类型层，**不引入 `@deepseek-ai/dsh-*` 运行时依赖**。pi 的 LLM Provider 现行实现（决策 19/140）暂保持不变，代码迁移待 dsh 在具体接缝落地后评估。

**理由**：dsh 的横切基建成熟度高于 pi（LLM 多 provider registry + 模型发现 + 重试策略、Agent 生命周期事务回滚、Typert 工具协议、session 投影/检查点），借鉴设计可省大量自研试错；但 dsh 核心服务 `peerDependencies` 强绑 Cordis 且全 0.1.0-rc.6 未冻结，直接 import 需 boot 整个 harness 底座，违背原则 3（核心自研）与支柱 1（可插拔）。借鉴设计 + 核心自研可复用其成熟度而不承担运行时耦合。

**影响**：决策 2「pi 横切复用」追加变更记录标注「横切借鉴对象转向 dsh，pi 现行实现暂保留」；原则 3 更新为「核心自研 + 引用/借鉴 dsh」；01-overview §15 参考来源表新增 dsh 行。不新增一等概念/一等层/接缝——dsh 借鉴落在既有接缝（LLM Provider / ToolSlot / session / Agent 生命周期）的实现内。代码迁移待后续：dsh 在具体接缝落地后，再按 T3 决策推翻 4 步评估 pi 相关决策（19/20/140）的降级。

**讨论来源**：无

**实现 PR**：无

**实现 PR**：无

## 决策 146：项目更名 wuwo → 璇玑（ORBITA）

**选择**：项目正式定名——中文名「璇玑」、英文名「ORBITA」、仓库名「orbita」。Slogan 主位「璇玑运转，诸事得序」，备选「群星在列，枢定之」「以璇玑，齐万事」。全仓活文档与代码做一次性品牌替换：代码/路径/标识符用 orbita 系（OrbitaConfig、orbita-sdk、orbita-desktop、orbita://、com.orbita.desktop、ORBITA_* env、~/.orbita/data/orbita.db），文档散文品牌语境用「璇玑（ORBITA）」。历史记录（progress/ 日志、_archive/、历史 UPDATE_NOTES）保留原貌不改。

**理由**：项目从个人代号走向正式命名。璇玑为北斗魁四星与古代天文仪器，喻「多星在列、枢纽定序」——与多 Agent 列位协作 + 微内核枢纽的架构定位同构；ORBITA 取「轨道」意象呼应运转。纯品牌更名，架构本体（一等概念/一等层/决策语义）零变化，故各活文档仅次版本 +1，不升主版本、不触发铁律 5 架构自检。

**影响**：① 本决策即一次性全文品牌替换的授权记录（G3 合规：旧决策正文中品牌名/路径/标识符随全局替换，语义未变；git 历史与 progress/ 归档保留原名）。② 代码兼容：wuwo:// 会话路径解析端双读（orbita:// 优先、wuwo:// 回退）；~/.wuwo 数据目录与旧库文件启动时探测迁移（旧名存在且新名不存在→复制）。③ 架构目录 wuwo_v4.5.1 → orbita_v4.5.1。④ GitHub 仓库更名 orbita（旧 URL 自动重定向）。

**讨论来源**：无

**实现 PR**：无

## 附录：决策按实现阶段分组

| 阶段 | 涉及决策 | 核心内容 | 说明 |
|------|---------|---------|------|
|| **Phase 1** | 1-44（基础架构+编排核心）+ 52（Skills库）+ 56-62（Tournament/Swarm）+ 70-85（v4通用化）+ 96-101（任事型/谋士型/人类介入）+ 138（CheckAgent共享监督引擎） | 微内核、四库基础、hierarchy+market+council Coordination、dag+tournament Execution、react-loop、司礼监代批、EventSourcedState、coding-pack | 约 70 条需实现 |
| **Phase 2+** | 45-49（Infrastructure 高级模块）+ 50-51（完成守卫/Fan-out）+ 53-55（长时间运行/Fork/Multi-Main）+ 63-69（Swarm高级+组级覆盖+专家系统） | peer-mesh/federation Coordination、chain/fan-out Execution、多 Loop、军功簿持久化、可视化画板、多用户协作、联邦 | 其余约 30 条 |

> **各决策自身的 Phase 标注**：多数决策正文已注明 Phase 1 / Phase 2+ 实现时间，请以正文为准。本表仅提供宏观分组导航。

---

> 文档版本：v2.22
> 本版变更（累积最近 3 条，最新在上）：
>   - v2.22：新增决策146（项目更名wuwo→璇玑ORBITA，品牌替换授权+兼容迁移），全文品牌/路径替换，总数145→146
>   - v2.20：新增决策141-144（活跃度正交维度/MVP持久化范围/node:sqlite后端/单文件分库，会话储存专题），决策总数140→144
> 决策总数：146 条（v3 1-69 + v4 70-146，含 103-105 T8 回流补录 + 109-112 R1-R4 设计提议 + 113-139 多Agent协调演进+通政司subagent + 140 pi适配层 + 141-144 会话储存专题 + 145 dsh横切借鉴 + 146 项目更名）
