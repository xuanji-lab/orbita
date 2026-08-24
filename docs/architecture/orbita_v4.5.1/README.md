[AI 生成]

# 璇玑（ORBITA）架构设计 v4 阅读指南

> **这是什么**：璇玑（ORBITA）是一个通用多用户多 Agent 协作底座。核心微内核领域中立，领域能力可插拔，内置朝廷/竞功/大明三套完整协作模式（+效率转模）。Slogan：璇玑运转，诸事得序（备选：群星在列，枢定之 / 以璇玑，齐万事）。2026-08 由代号 wuwo 更名，见决策 146。

> 本仓库收录璇玑（ORBITA）通用多用户多 Agent 协作底座的 v4 架构设计文档。v4 是完整版本，自包含可独立阅读。贡献前请先读 [AGENTS.md](./AGENTS.md)。

> 状态：stable
> 维护：@XZF（主笔）
> 讨论：无
> 待决：无

---

## v3 → v4 核心变化速览

v4 从 v3 的"coding 专用多 Agent 工具"升级为"通用多用户多 Agent 协作底座"。核心微内核领域中立，所有能力可插拔。v3 全部有效设计融入 v4 新架构，读者无需参考 v3。

| 维度 | v3 | v4 | 变化性质 |
|------|----|----|---------|
| 定位 | coding 内部架构 | 通用协作底座 | 推翻决策 1 |
| 领域能力 | 核心内置 coding | Domain Pack 可插拔 | 新增 |
| 库体系 | 三库（身份/提示词/技能） | 四库（+Loop 库） | 新增 |
| 角色 | 4 种固定枚举 | Identity 属性，架构只认 Agent | 降级 |
| 拓扑 | 硬编码 Main→Sub 树 | Coordination Pattern 可插拔 | 新增 |
| 执行 | 5 种执行模式 | Execution × Coordination 组合 | 重构 |
| 通信 | dispatch + contact 两条边 | 图状（点对点+发布订阅+频道） | 扩展 |
| 状态 | 可变对象 projectState | 事件溯源 + 命名空间 | 重构 |
| 监察 | Check + MetaCheck 两层 | 三层分离 + 暂停/恢复权分离 | 扩展 |
| 入口 | 直接给 Main Agent | 司礼监前置关口（翻译+过滤+代批） | 新增 |
| 学习 | 无（每次从零） | 军功簿（WeightRegistry 跨任务权重） | 新增 |
| 用户 | AuthContext 字段 | 一等公民（profile/memory/quota） | 升级 |
| 模式命名 | on-demand / swarm | 朝廷/竞功/大明三模式（+效率转模） | 重命名 |

**核心微内核 6 个一等概念**（v4 核心，详见 02-architecture-layers.md）：

| 一等概念 | 含义 | 可插拔 |
|---------|------|--------|
| Agent | 跑 Loop 的实体 | 是（由 Identity 定义） |
| Loop | Agent 内部执行引擎 | 是（四库之一） |
| User | 一等公民（profile/memory/quota） | 是（用户自管） |
| Communication | 图状通信（点对点+发布订阅+频道） | 是（Transport 实现） |
| State | 事件溯源共享状态+命名空间 | 是（StateBackend 实现） |
| Pattern | 两层：Coordination × Execution | 是（各自可注册） |

**v4 十大核心变化**：① 定位通用化（Domain Pack）② 四库体系（+Loop 库）③ Coordination × Execution 两层 Pattern ④ 三模式共享术语池 ⑤ 司礼监代批快速通道 ⑥ 军功簿学习闭环 ⑦ 通信图状化 ⑧ 状态事件溯源 ⑨ 监察分层+权力分离 ⑩ User 一等公民。

---

## 新人速查

### 5 分钟最小阅读路径
README（本文档）→ 01-overview → AGENTS.md。3 份文档建立基本认知。

### 贡献速查
| 操作 | 规范 | 入口 |
|------|------|------|
| commit 格式 | 共 4 种类型：`note`（学习笔记/草稿笔记/决策）、`spike`（实验代码）、`chore`（杂项）、`fix`（修 bug） | AGENTS.md §6.1 |
| PR 提交 | 使用 PR 模板 | .github/PULL_REQUEST_TEMPLATE.md |
| 文档头尾元数据 | 4 字段头 + 6 字段尾 | AGENTS.md §10.2 |
| 决策记录 | 统一五段式 | AGENTS.md §5.1 |
| 提交前自查 | 对照 AGENTS.md §12 统一清单逐项 | AGENTS.md §12 |

### 常见入口路由
- 提想法 → GitHub Discussion
- 跟进任务 → GitHub Issue（使用模板）
- 提交改动 → PR（使用模板，含人类审查确认）
- 找决策 → 10-decisions.md
- 找未决 → 本文档「## 待决项总览」

---

## 阅读顺序指南

### 新手路径
README（本文档）→ 01-overview → 02-architecture-layers → 06-core-engine

适合第一次接触 璇玑 的读者。快速建立整体认知：通用定位、核心微内核 6 个一等概念、Loop 引擎与事件溯源状态。

### Phase 1 最小路径（实现者专用）
README（本文档）→ 01-overview → 06-core-engine → 07-infrastructure

> 如果你只需要实现 Phase 1，读完这 4 份即可。Phase 1 只需实现：
> - **Coordination**：hierarchy（朝廷）、market（竞功）、council（谋士）三种
> - **Execution**：dag、tournament 两种
> - **Loop**：react-loop 默认引擎
> - **基础设施**：SessionStore、EventBus、AgentTransport、ToolSlot、EventSourcedState
> - **司礼监**：代批快速通道（条陈 + 批红 + 四不变量）
> - **Domain Pack**：coding-pack（第一个官方 Pack）
>
> peer-mesh/federation Coordination、chain/fan-out Execution、多 Loop、军功簿持久化、多用户协作均属 Phase 2+。

### 通用化路径
README → 01-overview → 18-domain-pack → 04-four-libraries

适合关心"如何把 璇玑 用到 coding 之外领域"的读者。Domain Pack 是领域能力可插拔的关键，四库是资产管理体系。第一个官方 Pack 是 coding-pack。

### 编排路径
README → 01-overview → 03-execution-modes → 05-agent-roles

适合关心"Agent 怎么组织、怎么派发、怎么协作"的读者。重点看 Coordination × Execution 两层 Pattern 和七维度插件化。

### 模式路径
README → 01-overview → 12-chaoting-mode → 13-jinggong-mode → 15-sijian-batch → 14-daming-mode → 11-renshi-shared-base

适合关心"三套完整协作模式怎么运作"的读者。朝廷模式（hierarchy，文官体制）、竞功模式（market，军事体制）各自独立术语体系，大明模式混编朝廷+竞功并含效率转模；司礼监代批是日常请求的快速通道。

### 谋士型路径
README → 01-overview → 16-moushi-overview → 17-moushi-modes

适合关心"谋士型（council 协调拓扑）怎么运作、翰林格物学士横切增益、四模式怎么路由"的读者。

### 四库路径
README → 01-overview → 04-four-libraries

适合关心"身份、提示词、技能、Loop 怎么管理"的读者。四库体系是 璇玑 最独特的设计，Loop 库运行期只读。

### 参考路径
10-decisions（随时查阅）

决策文档收录所有架构决策（138 条）及理由，适合实现阶段反复查阅。

---

## 文档地图

v4 共 31 份文档（NN 编号文档 01-28 + AGENTS.md + CLAUDE.md + 卖点与进展方向.md），按编排类型分节标注。

### 任事型

| 文件名 | 内容 | 编排类型 | 何时阅读 |
|--------|------|----------|----------|
| 12-chaoting-mode.md | 朝廷模式完整定义（hierarchy，文官体制） | 任事型 | 模式路径 |
| 13-jinggong-mode.md | 竞功制模式完整定义（swarm，军事体制） | 任事型 | 模式路径 |
| 15-sijian-batch.md | 司礼监代批机制（条陈 + 批红 + 四不变量） | 横切 | 模式路径 |
| 14-daming-mode.md | 大明模式（朝廷+竞功混编，含效率转模） | 任事型 | 模式路径 |

### 谋士型

| 文件名 | 内容 | 编排类型 | 何时阅读 |
|--------|------|----------|----------|
| 16-moushi-overview.md | 谋士型模式系统总论（council 协调拓扑+翰林横切增益+四模式定位） | 谋士型 | 谋士型路径
| 17-moushi-modes.md | 谋士型四模式详解（门客/幕僚/帝皇/总智囊+朝会复合态） | 谋士型 | 谋士型路径

### 通用基础

| 文件名 | 内容 | 编排类型 | 何时阅读 |
|--------|------|----------|----------|
| README.md | 阅读指南 + 文档地图 + 33 条原则速查 | 通用基础 | 首先阅读 |
| 01-overview.md | v4 概览、通用定位、核心微内核、两模式概览 | 通用基础 | 所有路径第一步 |
| 02-architecture-layers.md | 核心微内核 6 概念 + Pack 层 + 层间依赖 | 通用基础 | 新手路径 |
| 03-execution-modes.md | Coordination × Execution 两层 Pattern + Capability 契约 + 组合矩阵 | 通用基础 | 编排路径 |
| 04-four-libraries.md | 四库（身份/提示词/技能/Loop）+ Pack 资产归属 | 通用基础 | 四库路径 |
| 05-agent-roles.md | 角色=Identity 属性 + 七维度插件化总表 | 通用基础 | 编排路径 |
| 06-core-engine.md | Loop 引擎可插拔 + 事件溯源状态 + Compaction 不变量 | 通用基础 | 新手路径 |
| 07-infrastructure.md | 基础设施模块（+WeightRegistry +UserProfile +EventSourcedState） | 通用基础 | 深入实现 |

| 22-communication.md | 图状通信一等概念 L4 深度文档（EventBus/AgentTransport/Blackboard/守卫 Pipeline/core-invariants/NetworkTransport/Delegation 语义层） | 通用基础 | 深入实现 |
| 23-state.md | 事件溯源状态一等概念 L4 深度文档（事件溯源/namespace 层级；4 层存储模型见 28-session-storage.md §4） | 通用基础 | 深入实现 |
| 24-request-context.md | RequestContext 贯穿件 L4 深度文档（factory/生命周期/不变量/重建模式） | 通用基础 | 深入实现 |
| 08-package-structure.md | 包结构 + domain-packs/coding-pack + 通用化改造 | 通用基础 | 深入实现 |
| 09-seam-map.md | 接缝地图（+Pack +Loop +Pattern 注册接缝） | 通用基础 | 深入实现 |
| 10-decisions.md | 决策 1-138（含 9 条修改备注） | 通用基础 | 随时查阅 |
| 18-domain-pack.md | Domain Pack 系统设计 + coding 渗剥点清单 | 通用基础 | 通用化路径 |
| 11-renshi-shared-base.md | 任事型共享基础层（制度/交互/决策/规划/六部/皇帝直管/灾备/自校准/冷启动/外部反馈/通信/人类介入） | 通用基础（任事共享） | 深入实现 |
| 25-phase-roadmap.md | Phase 推迟项索引（汇总 106 处 Phase 2+/3+/4+ 标注，按 Phase 分章） | 通用基础 | Phase 演进查阅 |
| 26-entry-layer.md | Entry Layer 独立设计（接入点/EntryAdapter/Surface/bootstrap/Phase 演进） | 通用基础 | 深入实现 |
| 27-session-management.md | 会话管理总结重构（定位/生命周期/存储/命名空间/三层上下文/压缩/跨Session记忆/委托/并发提议） | 通用基础 | 深入实现 |
| 28-session-storage.md | 会话储存设计（**唯一权威**：SessionStore 接口/4层存储模型/压缩/索引实体分离/边界恢复/审计对账/本地SQLite落地，决策 141-144） | 通用基础 | 深入实现 |


### 参考

| 文件名 | 内容 | 编排类型 | 何时阅读 |
|--------|------|----------|----------|
| 19-minggong-frameworks.md | 明朝架构 + 竞功制参考框架归档（原始文档） | 参考 | 参考 |
| 20-harness-mapping.md | 开源 harness 论文 → 内阁制/竞功制映射分析 | 参考 | 参考查阅 |
| 21-glossary.md | 中英双语术语表（明朝隐喻 ↔ 英文简注） | 参考 | 术语对照 |

| AGENTS.md | v4.5 单文件规范：设计哲学、铁律、任务路由、6 类任务操作流程、写作规范、自查清单 | 通用基础 | 贡献前必读 |
| CLAUDE.md | 护城河（agent 始终上下文）：自包含核心规则（四支柱/铁律/G1-G10+G13等），完整规范见 AGENTS.md | 通用基础 | agent 始终上下文 |

---

## 贡献指南

详见 AGENTS.md §0-§12。所有规则（铁律、任务路由、操作流程、自查清单）整合于一份文件。

---

## 待决项总览

> 当前所有未决问题的集中索引。每项唯一编号 #OPEN-N。已决议项移至决策记录（决策 N）。

| 编号 | 问题 | 状态 | 责任人 | 链接 |
|------|------|------|--------|------|
| 暂无 | 暂无待决项 | - | - | - |

**状态枚举**：讨论中 / 已决议待写入 / 已写入决策（移除）/ 已弃用

**分配协议**：新增 #OPEN-N 前 grep 本表确认下一未占用编号；顺序分配。状态变更时同步更新本文档表 + 各文档头的「待决」字段。

---

## 原则速查（33 条）

原则 1-17 来自 v3，措辞适配 v4；原则 18-33 为 v4 新增。引用时只写编号，如"原则 19"。

**分组**：原则 1-3 为不变性约束（边界/接口/核心自研 + 引用/借鉴 dsh）；原则 4-17 为 v3 核心机制（数量/上下文屏障/身份/宪法/工具池/库体系/通信/隔离/竞争/模式/覆盖），v4 保留并适配；原则 18-33 为 v4 新增设计（通用底座/四库/两层 Pattern/两模式/代批/军功簿/监察分层/User/Preset+渐进推断/谋士型（术语三族不交叉）/翰林横切增益/朝会复合态/三模式共享术语池）。

**三模式共享术语池（原则 33，原原则 21 已推翻）**：朝廷/竞功/大明三模式共享同一套术语体系，不再因模式切换而改名；谋士型术语仍独立。原原则 21 两模式不交叉规则已由原则 33 推翻，见原则 33。

原则 1：边界即接口。Phase 1 到 Phase 3 之间会变的边界必须是接口。不变的就硬编码。

原则 2：接口按最终形态设计，Phase 1 提供最笨实现。核心逻辑从第一天就只依赖接口，三个阶段零改动。终局目标为多人在线 + 海量 agent + 复杂拓扑预留接缝。

原则 3：核心自研 + 引用/借鉴 dsh。璇玑 核心契约（微内核/编排/通信/状态/用户/四库）自研；横切基建借鉴 dsh 设计（决策 145）：LLM registry/Agent 生命周期/Typert 工具协议/session 分层/沙箱为设计参考，抄类型/协议形状、不引运行时；pi 现行 LLM Provider 实现暂保留。

原则 4：不限制 Subagent 数量（v4 改预算驱动）。底座按资源（LLM 配额、内存、CPU）限制并发，不按数量限制。派发权限下沉靠 Identity.capabilities（dispatch/contact/broadcast）+ dispatchBudget，架构硬兜底上限 10。

原则 5：Check 是上下文屏障。Task Subagent 的全部产出经过 Check 压缩后，以精简报告（几百 token）到达 Main Agent，Main Agent 永远不看原始产出。v4 扩展为三层监察（见原则 24），Check 属过程监督层。

原则 6：Meta Check 是系统保险（v4 按策略触发）。Main Agent 的输出经审查后到达用户。从 1:1 常驻改为按 ReviewPolicy 触发，改写标注来源（用户可区分原话与改写）。maxCorrections + confidenceThreshold 保留，fail-closed 可选。

原则 7：编排可组装。编排逻辑在 Composition Layer，不在 agent-core。v4 演进为 Coordination × Execution 两层 Pattern 独立可组合（见原则 20）。

原则 8：身份可复用。子 Agent 身份不每次从零写，从身份库引用。库按类别组织，可插拔。身份专家帮助设计新身份（Phase 2+）。

原则 9：内置即扩展（v4 两层表述）。核心机制工具（dispatch_subagent 等）属核心，走同一 ToolSlot 注册无特权路径；Pack 内置资产（身份/提示词/技能/工具）和用户自定义走完全相同的注册和执行路径，没有任何功能是保留给内置的特权通道。

原则 10：双宪法体系。架构提示词宪法（代码强制）和身份信息宪法（专家判断）分别约束框架行为和身份定义的安全底线。v4 宪法不变量含司礼监代批四条（见原则 22）。

原则 11：全局工具池。Main Agent 从全局工具池选工具派发子 Agent，不受自身工具集限制。工具按风险四级管控（safe/moderate/restricted/forbidden）框架留核心，具体映射由 Domain Pack 注册时声明。

原则 12：三库对称（v4 扩为四库）。身份信息库（谁来工作）、架构提示词库（怎么工作）、技能库（额外能力）三个库完全对称，各自多层加载，各自专家管理。v4 新增 Loop 库，四库统一见原则 19。

原则 13：通信双向（v4 图状化）。向下派发（父→子）与向上请求（子→父）两个方向缺一不可。v4 从树形单链路扩展为图状通信（点对点 + 发布订阅 + 频道），市场 Coordination 下竞争者间禁止横向通信（公平性不变量）。

原则 14：隔离可选。工作区隔离分三级（none/task/parallel），按任务风险选择。只读零开销，写操作安全回滚，并行写互不干扰。WorkspaceBackend 接口留核心，git worktree 等具体实现移 coding-pack。

原则 15：竞争选优。重要任务可用 Tournament 让多个执行者独立完成，评估排名，最优方案合并到主线。v4 Tournament 作为 Execution Pattern，评估指标（defaultRubric）由 Pack 定义不硬编码，增量竞争控制成本。

原则 16：模式可切换（v4 重命名）。Session 支持三种模式运行。朝廷模式（文官体制，hierarchy Coordination，默认高效模式）↔ 竞功模式（军事体制，market Coordination，复杂任务模式）。大明模式为朝廷+竞功混编，含效率转模（见 14-daming-mode.md）。运行中可切换朝廷/竞功，大明模式为混编稳态；术语随之切换。

原则 17：组级覆盖。群 Agent 模式下每组通过覆盖资产库实现策略差异化。组级覆盖优先级最高（pack < builtin < user < project < group），临时生成，组结束后丢弃。v4 从三库扩展为四库组级覆盖。

原则 18：通用底座。核心微内核领域中立，不携带任何具体领域语义字段（无 filePath、repoUrl、cwd 等）。领域能力（工具/身份/技能/Loop/评估维度/工作区后端/完成守卫）通过 Domain Pack 可插拔注入。第一个官方 Pack 是 coding-pack。

原则 19：四库体系。身份库、架构提示词库、技能库、Loop 库四库对称，各自多层加载（pack < builtin < user < project < group），各自 catalog.yaml + when_to_use/when_not_to_use。Loop 库特殊：命令式代码，运行期只读（只能从已注册的选，不能运行期创建），无 Loop 专家，新 Loop 注册是开发期行为。

原则 20：两层 Pattern。Coordination Pattern（agent 怎么组织：hierarchy/market/peer-mesh/federation）× Execution Pattern（任务怎么执行：dag/tournament/chain/fan-out）独立可组合。兼容性靠 Capability 契约，Phase 1 用 compatibleExecutions 白名单简化，Phase 2+ 演进到 requires/provides 契约匹配。

原则 21：内阁制/竞功制。两个模式各自独立术语体系，严格不交叉。on-demand=朝廷模式（hierarchy，文官体制：首辅/六部/都察院...），swarm=竞功模式（market，军事体制：总督/提督/评功推官/军功勘验使...）。同一职能在两模式下有不同名字，Session 切换模式时称呼随之切换。**[已推翻]** 见原则 33。

原则 22：司礼监代批。前置关口（司礼监）有有限代批权，条陈（BatchApproveCharter）由总控预授权，司礼监不得自行扩充。命中条单 + 简单低风险 → 代批打"批红"标签 + 审计后验 → 直接返回用户。复杂/多 steps/涉数据修改/非最低风险必须呈送总控不得代批。四不变量：代批有据、批红可追溯、复杂必呈送、条陈不可擅改。

原则 23：军功簿学习闭环。WeightRegistry 记录每个 Identity/Agent 历史表现评分，跨任务影响调用权重。表现稳定升权，不佳降权，保留探索比例（ε-greedy 防过早收敛）。内阁制下叫考绩簿，竞功制下叫军功簿，核心接口名统一 WeightRegistry。Phase 1 NoOp，Phase 2+ 持久化。

原则 24：监察分层+权力分离。三层监察：过程监督（仅暂停权，无恢复权）/事后审计（建议性或权重影响）/高风险复核（强制推翻）。权力分离：暂停权与恢复权分离（恢复需更高层），监察者被谁监察（改写/暂停记录进事件流，可被更高层采样复审），fail-closed 可选。

原则 25：User 一等公民。UserProfile 有 identity（画像/偏好/专业领域）、permissions（跨资源权限）、quotas（并发/成本/存储配额）、memory（跨 session 记忆）。多用户协作是一等场景（Phase 3）：跨用户复用专家、多用户 Tournament vote、协作 Session 责任追溯。跨用户通信需 Trust Level 授权（none/read-only/invoke/delegate/full-control）。

原则 26：监察分层+权力分离。三层监察+暂停/恢复权分离（决策 81）。**[已降级]** 内容并入原则 24，保留编号不回收。

原则 27：紧急通道降级。预设 EmergencyFallback 优于 improvisation（决策 82）。

原则 28：User 一等公民。UserProfile（profile/memory/quota）（决策 83）。**[已降级]** 内容并入原则 25，保留编号不回收。

原则 29：Preset + 渐进推断。归 Domain Pack，决策负担降到 2-3 个（决策 84）。

原则 30：谋士型为第二编排类型。谋士型（council 协调拓扑）属谋士型编排，与任事型（朝廷模式 hierarchy、竞功模式 market）并列；术语三族不交叉（朝廷/竞功/谋士各自术语体系独立不混用，见原则 33）。

原则 31：翰林格物学士为横切增益模块。默认启用可「跳过格物」，位于司礼监关卡之后、council 路由之前；增益非关卡（只读上下文、不拦截/不拒绝），区别于司礼监代批权。

原则 32：朝会为 council 复合运行态。不占 Coordination×Execution 矩阵单元；总智囊路由器在混合诊断向量时串行调用 fan-out（门客）→chain（幕僚）→tournament（帝皇）。

原则 33：三模式共享术语池。朝廷/竞功/大明三模式共享同一套术语体系，不再因模式切换而改名；谋士型术语仍独立。

---

## 快速索引

| 我想了解... | 去看文档 |
|-------------|----------|
| 璇玑 v4 是什么、通用定位、微内核、三模式概览 | 01-overview.md |
| 核心微内核 6 概念、Pack 层、层间依赖 | 02-architecture-layers.md |
| Coordination × Execution 两层 Pattern、组合矩阵 | 03-execution-modes.md |
| 四库（身份/提示词/技能/Loop）怎么管理 | 04-four-libraries.md |
| 角色=Identity 属性、七维度插件化 | 05-agent-roles.md |
| Loop 引擎、事件溯源状态、Compaction 策略 | 06-core-engine.md |
| 基础设施模块（WeightRegistry/UserProfile/EventSourcedState） | 07-infrastructure.md |
| 包结构、domain-packs、技术栈 | 08-package-structure.md |
| 扩展接口、接缝设计（Pack/Loop/Pattern 注册） | 09-seam-map.md |
| 某条架构决策（1-138）的来龙去脉 | 10-decisions.md |
| 朝廷模式（hierarchy，文官体制）完整定义 | 12-chaoting-mode.md |
| 竞功制模式（swarm，军事体制）完整定义 | 13-jinggong-mode.md |
| 司礼监代批（条陈/批红/快速通道） | 15-sijian-batch.md |
| Domain Pack 系统、coding 渗剥点清单 | 18-domain-pack.md |
| 明朝架构 + 竞功制参考框架（原始归档） | 19-minggong-frameworks.md |
| 哪些开源论文映射到内阁制/竞功制 | 20-harness-mapping.md |
| 谋士型模式系统（council 协调拓扑、翰林增益、四模式路由） | 16-moushi-overview.md
| 谋士型四模式详解（门客/幕僚/帝皇/总智囊+朝会复合态） | 17-moushi-modes.md
| 大明模式（朝廷+竞功混编，含效率转模） | 14-daming-mode.md |
| 任事型共享基础层（制度/交互/决策/规划/六部/皇帝直管/灾备/自校准/冷启动/外部反馈/通信/人类介入） | 11-renshi-shared-base.md |
| v4 文档写作规范、术语、提交约定 | AGENTS.md |
| 明朝隐喻术语中英对照 | 21-glossary.md |
| 所有原则速查 | 本文档 33 条原则 |

---

> 文档版本：v4.32
> 本版变更（累积最近 3 条，最新在上）：
>   - v4.32：项目更名 wuwo→璇玑（ORBITA）：品牌定义句+Slogan，全文品牌/路径替换（见决策 146）
>   - v4.30：会话存储重构——28 改为唯一权威（收纳 07 §1.1 + 23 §3/§7/§9/§10/§11 + 27 §4），23 描述同步指向 28 §4
> 基于：璇玑 v3 阅读指南 + v4 设计总纲（璇玑-v4.md Part 1-3）
> 决策总数：145 条（v3 1-69 + v4 70-145）
> 文档总数：31 份
> 原则总数：33 条
