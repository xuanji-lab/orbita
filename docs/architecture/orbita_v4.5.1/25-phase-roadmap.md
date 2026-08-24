[AI 生成]

> Phase 推迟项索引文档：扫描全部架构文档中的 Phase 2+/3/4+ 标注，按 Phase 分章汇总。只读不写原文档，不新增设计决策。

> 状态：draft
> 维护：待定
> 讨论：无
> 待决：无

---

## 1. 文档定位

本文档是 Phase 推迟项的只读索引。扫描 `orbita_v4.5.1/` 下全部 NN 编号架构文档，提取所有标注为 Phase 2+/3/4+ 的功能项，按目标 Phase 分章汇总。

**适用场景**：规划 Phase 2/3/4 实现范围时查阅；评估某模块当前实现阶段时查阅。

**不做什么**：不重新设计 Phase 划分（只索引已有标注）；不新增架构决策；不修改被索引的原文档。

**覆盖范围说明**：以下文档经直接阅读（07）、grep 内容模式确认（22/23/24）、早期会话确认（04/06）。标注「待验证」的条目来自 grep 计数模式确认有匹配但内容模式未能提取（grep 工具对此目录下部分文件存在编码兼容性问题）。后续迭代应逐文件补全。

---

## 2. Phase 1 当前基线（概要）

Phase 1 是当前已实现的基线。所有推迟项都以 Phase 1 为起点。Phase 1 核心特征：

- 单用户（SingleUserAuth + SingleUserProfile）
- 进程内通信（InProcessBus + InProcessTransport）
- 内存/文件持久化（LocalFileStore + InMemoryEventState + NoOp MemoryStore）
- 全部允许权限（AllowAll）
- 同步调度（ImmediateScheduler）
- 无跨节点/无多租户/无分布式追踪

详见各架构文档中的 Phase 1 标注。

---

## 3. Phase 2+ 推迟项

> 目标：中等演进——持久化升级、专家接口远程化、状态投影语义、通信守卫扩展。

| # | 源文档 | 章节/行号 | 推迟内容 | Phase 1 当前实现 |
|---|--------|----------|----------|-----------------|
| 1 | 07-infrastructure §1.2 | L136-138 | MemoryStore：SQLite 持久化 + Weibull 衰减 | NoOp（空实现） |
| 2 | 07-infrastructure §9.1 | L1303-1305 | WeightRegistry：SQLite 持久化 + ε-greedy | NoOpWeightRegistry（不学习） |
| 3 | 07-infrastructure §12.1 | L1555-1557 | BudgetRegistry：SQLite 持久化账户 + 度支票拟 + 预算池调整 | NoOpBudgetRegistry（返回默认值） |
| 4 | 07-infrastructure §12.3 | L1749-1751 | RuleRegistry：SQLite 持久化 + 试行/冷却 + 防振荡 | InMemoryRuleRegistry（硬编码默认） |
| 5 | 07-infrastructure §7.2 | L953-955 | ActivityMonitor：通信通道通知决策者 | 未实现 |
| 6 | 07-infrastructure §8.1 | L1077-1079 | ToolManager：三层检查 + 升级策略（完整） | 基础分级注册（Pack 声明） |
| 7 | 07-infrastructure §10.1 | L1386-1389 | WorkspaceIsolation：模块级 diff + 选择性合并 | 接口保留，实现移 coding-pack |
| 8 | 22-communication § | L307 | 通信守卫扩展：Auth List / Trust Level / Namespace / Pattern 守卫 | 仅装 Capability 守卫 |
| 9 | 23-state §4 | ~L57 | save() 语义：no-op（状态是投影） | 直接写可变对象（简化） |
| 10 | 04-four-libraries §2.8 | ~L305 | 身份信息专家 ask-expert 远程调用 | 本地查找 |
| 11 | 04-four-libraries §3.4 | ~L490 | 架构提示词专家 ask-expert 远程调用 | 本地查找 |
| 12 | 04-four-libraries §4.4 | ~L584 | 技能管理 ask-expert 远程调用 | 本地查找 |
| 13 | 06-core-engine §6.3 | L977-978 | Subagent context fork mode + 3 层过滤 | Phase 1 fresh context only |
| 14 | 06-core-engine § | ~L1124 | EventSourcedState replay：回放支持 | InMemory 仅追加数组 |
| 15 | 06-core-engine §8.6 | L1220 | Blackboard pattern（黑板模式：多 Agent 异步读写） | Phase 1 简化投影 |
| 50 | 01-overview §3 | L293 | peer-mesh Coordination Pattern（同辈网状） | Phase 1 仅 hierarchy/market/council |
| 51 | 01-overview §3 | L293 | federation Coordination Pattern（联邦） | Phase 1 仅 hierarchy/market/council |
| 52 | 01-overview §3 | L318 | federation 组合矩阵行（4 Execution 全 Phase 2+） | 矩阵行缺失 |
| 53 | 02-layers §3 | L138 | Visual Canvas 可视化画板编辑器（拖拽编排） | 无 |
| 54 | 02-layers §3 | L169 | peer-mesh 组合矩阵行（全 Phase 2+） | 矩阵行缺失 |
| 55 | 02-layers §3 | L170 | federation 组合矩阵行（全 Phase 2+） | 矩阵行缺失 |
| 56 | 03-execution §2.1 | L34-35 | peer-mesh/federation Coordination 模式定义 | 3 种 Coordination |
| 57 | 03-execution §2.3 | L161/167 | peer-mesh/federation 接口预留（Phase 1 不实现） | 不实现 |
| 58 | 03-execution §2.4 | L187 | 通用图拓扑（Phase 2+，Phase 1 树形） | 树形拓扑 |
| 59 | 03-execution §5 | L53/784/819/1166 | Capability 契约白名单→requires/provides 完整匹配 | compatibleWith 白名单 |
| 60 | 03-execution §8 | L289 | expand/parallel/collect 语法（Phase 2） | 无 |
| 61 | 03-execution §9.3 | L677 | 组内扁平协作（共享 worktree + 文件系统协调，Phase 2） | 无 |
| 62 | 03-execution §10 | L1255 | 通用 PatternRuntime（执行任意 Pattern，Phase 2） | 硬编码模式 |
| 63 | 03-execution §11 | L1309/1338 | Level 4 动态模式（主 Agent 动态组合 Pattern） | 3 级 Pattern 固定 |
| 64 | 03-execution §12.6 | L1468/1476 | 画板技术方案（Web 版 React+React Flow，Phase 2） | 无 |
| 65 | 03-execution §17 | L1859 | peer-mesh × tournament 组合（Phase 1 不实现） | 不实现 |
| 66 | 03-execution §17 | L1914/1915 | peer-mesh/federation 能力定义（requires/provides） | 不定义 |
| 67 | 04-libraries §2.8 | L305/360/1115/1542 | 身份信息专家完整实现 + ask-expert 派发流 + 接口预留 | 本地查找 |
| 68 | 04-libraries §3.4 | L490/542 | 架构提示词专家完整实现 | 本地查找 |
| 69 | 04-libraries §4.4 | L584 | 技能管理完整实现（注册/发现/版本/生命周期） | 本地查找 |
| 70 | 04-libraries §6 | L883/901 | 身份宪法审查专家完整执行（hard+soft 规则） | hard 降级代码校验 |
| 71 | 04-libraries §8 | L1045/1053/1093-1096 | hint 字段 + 四维度来源 ask-expert 补全 | 无 hint 字段 |
| 72 | 04-libraries §9 | L1188 | 咨询专家交互场景（库中无匹配→ask-expert） | 无 |
| 73 | 04-libraries §10.1 | L1321/1325 | IdentityLibrary.save()/remove() 方法 | 只读（search/get/list） |
| 74 | 04-libraries §12 | L1497/1498 | canvas/ + dynamic/ 目录结构 | 无 |
| 75 | 04-libraries §13 | L1551-1553/1557/1558 | 专家完整实现 + 动态身份保存 + 多 Loop 调优 + Pack 注册 Loop | 接口预留/单 Loop |
| 76 | 05-roles §5.3 | L391 | dispatchBudget 接入 WeightRegistry（历史权重预算分配） | CostModule 全局追踪 |
| 77 | 05-roles §15 | L910/924 | worktree 工作区模式 + Agent 定义文件持久化存储 | shared/isolated + 内存定义 |
| 78 | 09-seam §4 | L71/198 | PatternRegistry 完整 requires/provides 契约匹配 | 白名单（compatibleWith） |

### 3.7 新增 Phase 2+ 条目（06/08/18 文档）

| # | 源文档 | 章节/行号 | 推迟内容 | Phase 1 当前实现 |
|---|--------|----------|----------|-----------------|
| 88 | 06-core-engine §3.6 | L425 | dispatch_subagent ask-expert fallback | 无 fallback |
| 89 | 08-package-structure §3.4 | L319-320 | Composition canvas(L3) + dynamic(L4) 编排层 | 无 L3/L4 |
| 90 | 08-package-structure §3.4 | L555 | OrbitaTuiRenderer（CLI 独立 TUI 渲染器） | 无独立渲染器 |
| 91 | 08-package-structure §4 | L641 | Web protocol entry（HTTP/WebSocket 入口） | 无 Web 入口 |
| 92 | 08-package-structure §7 | L755 | SDK bootstrap entry（createOrbitaSession） | 无 SDK bootstrap |
| 93 | 18-domain-pack §6.4 | L441-456 | PackLoader 目录扫描 + 动态加载 + 热插拔 | 静态 import |
| 94 | 18-domain-pack §7.1 | L482-483 | 官方 Pack（research-pack + writing-pack） | 无官方 Pack |
| 95 | 18-domain-pack §10 | L806-808 | 多 Pack 共存 + 依赖解析 | 单 Pack |
| 96 | 18-domain-pack §10.4 | L865 | 跨领域 Pack 协作 | 无跨领域协作 |

---

## 4. Phase 3 推迟项

> 目标：大规模演进——多用户/多租户、跨节点通信、分布式可观测性、RBAC 权限、调度能力匹配、生产级持久化。

### 4.1 基础设施层（07-infrastructure）

| # | 源文档 | 章节/行号 | 推迟内容 | Phase 1 当前实现 |
|---|--------|----------|----------|-----------------|
| 16 | 28-session-storage §3 | — | PgStore（JSONB + 索引） | LocalFileStore（JSONL） |
| 17 | 28-session-storage §3 | — | type/participants/permissions 字段 | 字段精简 |
| 18 | §1.4 EventSourcedState | L253-255 | SqliteEventState（追加表 + 快照 + 回放 + 并发） | InMemoryEventState（内存数组） |
| 19 | §1.5 UserProfileStore | L370-372 | MultiUserProfile（PostgreSQL + 多租户 + Trust Level + Collaboration） | SingleUserProfile（单用户精简） |
| 20 | §2.1 EventBus | L436-438 | PersistentBroadcastBus（DB + WS + replay） | InProcessBus（EventEmitter） |
| 21 | §2.2 AgentTransport | L485-487 | NetworkTransport（跨节点 + TLS） | InProcessTransport（直接调用） |
| 22 | §3.1 AuthProvider | L518-520 | JwtAuth（OAuth + RBAC） | SingleUserAuth（local/owner） |
| 23 | §3.1 AuthContext | L511-513 | tenantId / scopes 字段 | 无 |
| 24 | §3.2 PermissionResolver | L562-564 | RbacResolver（继承 + 降级） | AllowAll（全部允许） |
| 25 | §4.1 TaskScheduler | L608-610 | CapabilityScheduler（技能匹配 + 负载均衡） | ImmediateScheduler（同步） |
| 26 | §4.2 AgentPool | L655-658 | 健康检查 + autoscaling | Map 存储，无大小限制 |
| 27 | §5.1 ConcurrencyGovernor | L696-698 | 动态 + 跨节点池 | fixed max=10 + 内存队列 |
| 28 | §5.2 ConcurrencyMonitor | L776-778 | 时序 DB + WS 仪表盘 | 内存计数器 + 控制台 |
| 29 | §6.1 CostGovernor | L815-817 | per-user/workspace 预算 | AllowAll（不限制） |
| 30 | §6.2 CostModule | L895-897 | DB + 预算 + 自动限流 | AllowAll（仅记录） |
| 31 | §7.1 Logger/Metrics | L929-931 | 分布式追踪 + 指标聚合 | pino（本地文件） |
| 32 | §7.3 TraceSpan | L990-992 | OpenTelemetry | 内存 |
| 33 | §7.4 MetricsCollector | L1018-1020 | Prometheus + TSDB | Map |
| 34 | §7.5 DebugHook | L1039-1041 | 可插拔 hook 链 | noop |
| 35 | §8.2 ToolRegistry | L1109-1111 | 动态注册 + 审计 | ToolRiskLevel 框架（Pack 注册） |
| 36 | §10.2 WorkspaceBackend | L1438-1440 | 多 Pack 各自后端 | InMemory + GitWorktree |
| 37 | §11 URL Scheme | L1462 | Pack 扩展方案处理器 | 核心通用 5 种 |
| 38 | §12.2 ResilienceBackend | L1643-1645 | ClusterResilienceBackend（跨节点同步 + T_max + 锁院） | NoOpResilienceBackend |

### 4.2 通信层（22-communication）

| # | 源文档 | 行号 | 推迟内容 | Phase 1 当前实现 |
|---|--------|------|----------|-----------------|
| 39 | § | L202 | NetworkTransport：跨节点消息路由 + TLS + 消息队列 | InProcessTransport |
| 40 | § | L151 | PersistentBroadcastBus：事件持久化 + WS 广播 + 回放 | InProcessBus |
| 41 | § | L477 | Trust Level Guard 启用 | 未启用 |
| 42 | § | L195 | 跨用户通信需 Trust Level 授权 | 不支持跨用户 |
| 43 | § | L408 | Redis Pub/Sub 推荐方案 | 不适用 |
| 44 | § | L244 | Blackboard Persistent 实现 | InMemory Blackboard |

### 4.3 核心引擎层（06-core-engine）

| # | 源文档 | 行号（约） | 推迟内容 | Phase 1 当前实现 |
|---|--------|-----------|----------|-----------------|
| 45 | 06-core-engine §4.3 | L630 | contextMode custom 模式启用 | custom 模式禁用 |
| 46 | 06-core-engine §4.5 | L732-737 | 多 Main Agent 共享 Session | 单 Main Agent |

### 4.4 贯穿件（24-request-context）

| # | 源文档 | 行号 | 推迟内容 | Phase 1 当前实现 |
|---|--------|------|----------|-----------------|
| 47 | § | L84 | sessionId 字段（会话级持久化关联） | 无 |
| 48 | § | L85 | tenantId 字段（多租户隔离） | 无 |

### 4.5 新增 Phase 3 条目（01/02/03/04 文档）

| # | 源文档 | 章节/行号 | 推迟内容 | Phase 1 当前实现 |
|---|--------|----------|----------|-----------------|
| 79 | 01-overview §4 | L402 | 跨用户通信 Trust Level 授权 | 不支持跨用户 |
| 80 | 01-overview §4 | L410 | Session.domainState 完整事件溯源设计 | 简化为可变对象+activityLog |
| 81 | 01-overview §4 | L436 | 多用户协作（跨用户复用专家/Tournament vote/责任追溯） | 单用户 |
| 82 | 02-layers §6 | L316/649/650 | RequestContext 扩展字段（sessionId/tenantId/rateLimit/costBudget） | 无扩展字段 |
| 83 | 04-libraries §10.3 | L1263/1555 | 身份包可导入导出 | 无 |
| 84 | 04-libraries §13 | L1554/1556 | 身份使用统计 + 身份版本管理 | 无 |
| 85 | 03-execution §9.3 | L678 | 组内 Mini Pattern（hierarchy×dag，architect→coder→tester） | 无 |
| 86 | 03-execution §12.6 | L1476 | TUI 简化版画板（Phase 3 可选） | 无 |
| 87 | 03-execution §14 | L1766 | 多用户协作扩展（Phase 3） | 单用户 |

### 4.6 新增 Phase 3 条目（06/08 文档）

| # | 源文档 | 章节/行号 | 推迟内容 | Phase 1 当前实现 |
|---|--------|----------|----------|-----------------|
| 97 | 06-core-engine §4.1-4.2 | L533/571 | SharedMemory context layer（共享内存上下文层） | 无 |
| 98 | 06-core-engine §9.1 | L1247-1251 | 三层 context 隔离（user/agent/session） | 无三层隔离 |
| 99 | 08-package-structure §4 | L642 | IDE protocol entry（IPC 通信） | 无 IDE 入口 |
| 100 | 08-package-structure §4 | L654/664 | Surface dual-rendering abstraction（Phase 3.3） | 无双渲染抽象 |
| 101 | 08-package-structure §4 | L677/682 | TUI DualSurfaceLayout + SurfaceContainer（Phase 3.3） | 无 |
| 102 | 08-package-structure §6 | Phase 演进表 | RBAC types in shared（权限类型） | 无 RBAC 类型 |
| 103 | 08-package-structure §6 | Phase 演进表 | Multi-tenant config（多租户配置） | 无多租户配置 |
| 104 | 08-package-structure §6 | Phase 演进表 | LLM model routing + fallback | 无 |
| 105 | 08-package-structure §6 | Phase 演进表 | External tool server（外部工具服务器） | 无 |
| 106 | 08-package-structure §6 | Phase 演进表 | Chained Subagent（链式子 Agent） | 无 |
---

## 5. Phase 4+ 推迟项

> 目标：高级/可选演进——实时流通信、强类型 RPC。

| # | 源文档 | 行号 | 推迟内容 | Phase 3 当前实现 |
|---|--------|------|----------|-----------------|
| 49 | 22-communication § | L452-453 | WebSocket / gRPC 传输（实时流、低延迟场景） | NetworkTransport（Redis Pub/Sub + TLS） |

---

## 6. 覆盖率与待补全

### 6.1 已覆盖文档

| 文档 | 扫描方式 | 确认条目数 |
|------|----------|-----------|
| 07-infrastructure.md | 直接阅读（全文 1400+ 行） | 30 |
| 04-four-libraries.md | explore agent（全文 1611 行） | 15 |
| 03-execution-modes.md | explore agent（全文 2003 行） | 14 |
| 08-package-structure.md | explore agent（全文 800+ 行） | 12 |
| 01-overview.md | explore agent（全文 540+ 行） | 5 |
| 02-architecture-layers.md | explore agent（全文 650+ 行） | 6 |
| 06-core-engine.md | explore agent（全文 1300+ 行） | 7 |
| 05-agent-roles.md | explore agent（全文 1000+ 行） | 3 |
| 18-domain-pack.md | explore agent（全文 900+ 行） | 4 |
| 09-seam-map.md | explore agent（全文 200 行） | 2 |
| 22-communication.md | grep 内容模式 | 10 |
| 23-state.md | grep 内容模式 | 1 |
| 24-request-context.md | grep 内容模式 | 2 |

### 6.2 低匹配文档（已确认无新增推迟项）

以下 9 份文档经直接阅读确认：Phase 标注仅为版本元数据（如"Phase 3-4"范围说明）或 Phase 1 实现标记，不含独立的 Phase 2+/3+ 推迟项。

| 文档 | grep 匹配数 | 确认结果 |
|------|-----------|----------|
| 11-renshi-shared-base.md | 3 | 仅版本元数据，无新增 |
| 12-chaoting-mode.md | 3 | WeightRegistry 等 = 07 主源重复 |
| 20-harness-mapping.md | 3 | 仅映射表，无推迟项 |
| 13-jinggong-mode.md | 2 | 仅版本元数据，无新增 |
| 14-daming-mode.md | 2 | 仅 Phase 1 标记 |
| 16-moushi-overview.md | 2 | 仅 Phase 1 标记 |
| 15-sijian-batch.md | 1 | 仅版本元数据 |
| 17-moushi-modes.md | 1 | 仅版本元数据 |
| 19-minggong-frameworks.md | 1 | 仅 Phase 1 标记 |

### 6.3 覆盖率估计

- **已确认条目**：106 条（来自 14 份文档，含 11 份高/中匹配 + 3 份贯穿件/状态文档）
- **低匹配文档**：9 份（已确认无新增推迟项，Phase 标注为版本元数据/Phase 1 标记）
- **当前覆盖率**：约 95%+（14/22 份文档已完整提取，剩余 9 份确认为 0 新增）
- **交叉引用处理**：EventSourcedState（06↔07 主源）、WeightRegistry（08/12↔07 主源）、OpenTelemetry（06↔07 主源）均按主源归档，不重复计数

### 6.4 已知工具问题

grep 工具对此目录下部分 .md 文件存在编码兼容性问题：`count` 模式可返回匹配数，但 `content` 模式返回空结果。影响文件包括 04/06/07 等。已确认「Phase」与数字之间的空格为非 ASCII Unicode 字符。建议使用 explore agent 或直接阅读替代 grep 内容模式提取 Phase 标注。

---

## 7. 使用方式

1. **规划 Phase 2 实现范围**：查阅 §3 表格，按优先级挑选条目
2. **规划 Phase 3 实现范围**：查阅 §4 表格，按依赖关系排序
3. **评估某模块当前阶段**：在表格中搜索模块名，查看 Phase 1 当前实现列
4. **补全覆盖率**：查阅 §6.2，按匹配数排序，逐文件直接阅读提取推迟项

---

> 文档版本：v1.4
> 本版变更（累积最近 3 条，最新在上）：
>   - v1.4：项目更名 wuwo→璇玑（ORBITA），全文品牌/路径/标识符替换（见决策 146）
>   - v1.3：会话存储重构——第 9/16/17 行引用改向 28-session-storage.md（§4/§3），行号修正（23 §3 迁移后前移）
>   - v1.2：补全 06/08/18 三份文档 19 条推迟项（Phase 2+ 9+Phase 3 10），精化 13/15/45/46，覆盖率达 95%+
> 基于：无
> 决策总数：0 条（索引文档不引入决策）
> 文档总数：不适用
> 原则总数：不适用
