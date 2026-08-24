[AI 生成]

# Domain Pack 系统（Domain Pack）

> Domain Pack 系统：核心领域中立，领域能力通过可插拔 Pack 注入。
> 状态：stable
> 维护：@XZF（主笔）
> 讨论：无
> 待决：无

---

## 1. Domain Pack 是什么

璇玑 v4 是通用多用户多 Agent 协作底座。核心接口领域中立，不携带任何具体领域的语义字段（不出现 filePath、cwd、repoUrl、git 这类 coding 专属概念）。所有领域能力——工具、身份、技能、Loop、评估维度、工作区后端、完成守卫——通过可插拔的 **Domain Pack（领域包）** 注入。

类比 VSCode：核心代码是空核（编辑器内核），所有语言、调试、主题能力通过扩展注入。璇玑 同样如此——核心代码是空核（协作底座），所有领域能力通过 Pack 注入。第一个官方 Pack 是 **coding-pack**，让 璇玑 开箱即用就具备完整的代码协作能力。

### 1.1 为什么需要 Pack

| 问题（无 Pack） | 解决（有 Pack） |
|-----------------|-----------------|
| 核心接口含 `filePath`/`cwd`/`repoUrl`，绑定 coding | 核心接口领域中立，`Session.domainState` 是无类型容器，schema 由 Pack 定义 |
| 工具风险分级硬编码在核心（read=safe, write=moderate...） | 核心只保留 `ToolRiskLevel` 框架，具体映射由 Pack 注册声明 |
| 15 个内置身份硬编码在核心（security-reviewer 等） | coding-pack 自带，research-pack 自带研究身份，互不污染 |
| Worktree 三级隔离硬编码在核心 | coding-pack 提供 `GitWorktreeBackend`，核心只有 `WorkspaceBackend` 接口 |
| Tournament 评估权重硬编码在核心（功能30%/测试25%...） | Pack 提供 `defaultRubric`，不同领域不同权重 |

### 1.2 Pack 的核心承诺

- **核心领域中立**：核心代码不含任何领域语义字段。F3 检查（v3→v4 迁移）会强制验证核心无 `filePath`/`cwd`/`branchTemplate`。
- **内置即扩展**（决策 32 重新表述）：核心自带的 4 个框架机制工具（`dispatch_subagent`/`contact_main_agent`/`submit_output`/`search_catalog`）和 Pack 资产走完全相同的注册和执行路径，无特权通道。
- **空核开箱即用**：璇玑 npm 包默认依赖 `@璇玑/coding-pack` 并自动启用。用户安装 璇玑 即得完整 coding 协作能力，但核心代码是空核。

### 1.3 术语

| 中文 | 英文 |
|------|------|
| 领域包 | Domain Pack |
| 注册表 | PackRegistry |
| 渗剥点 | Migration Seam（v3 核心资产迁移到 Pack 的接缝） |
| 工作区后端 | WorkspaceBackend |
| 完成守卫 | CompletionGuard |
| 评估量规 | EvaluationRubric |
| 预设 | Preset |
| 领域状态 | domainState |

**相关决策**：71（Domain Pack 系统）、1（推翻，coding→通用底座）、32（重新表述，内置即扩展）、40（修改，工具分级框架留核心具体映射移 Pack）、50（修改，完成守卫接口留核心实现移 Pack）、84（Preset 归 Domain Pack）。

---

## 2. Pack 契约（TypeScript 接口）

接口先于实现。每个字段附 JSDoc 中文注释。

```typescript
/**
 * Domain Pack 契约。
 * 一个 Pack 是一组领域能力的打包：原料（注入四库 + Pattern）+ 配方（Preset）+ 领域定制（schema/backend/guard/rubric）。
 */
interface DomainPack {
  /** Pack 唯一标识，如 "coding"、"research"、"writing" */
  name: string;
  /** 语义化版本号，如 "1.0.0" */
  version: string;
  /** 依赖的其他 Pack 名称列表，如 ["coding"] 表示此 Pack 在 coding 之上扩展 */
  dependencies?: string[];
  /**
   * 注册原料到 PackRegistry。
   * 在此向四库（身份/架构提示词/技能/Loop）和 Pattern 注册表注入 Pack 自带的资产。
   * 这是 Pack 的"原料投放"入口。
   */
  register(registry: PackRegistry): void;
  /** Pack 提供的 Preset 集（配方），打包合法的 Coordination + Execution + 四维度默认值 */
  presets: Preset[];
  /** domainState 的 schema（Zod）。定义本领域 Session.domainState 的结构。核心不假设其内容 */
  sessionStateSchema?: ZodSchema;
  /** 工作区后端实现。coding-pack 提供 GitWorktreeBackend；其他领域可提供自己的后端 */
  workspaceBackend?: WorkspaceBackend;
  /** 完成守卫实现。coding-pack 提供 FileMutationGuard；其他领域可提供自己的守卫 */
  completionGuard?: CompletionGuard;
  /** 默认评估量规。竞功模式（Tournament）评功推官按此量规打分 */
  defaultRubric?: EvaluationRubric;

  // 新增（D10②）
  trustLevel?: "system" | "user" | "untrusted";  // 默认 "system"
  requestedPermissions?: PackPermission[];         // 声明需要的权限
}

/**
 * Pack 权限声明（Phase 1 仅记录不强制，Phase 2+ 强制）。
 * D10②
 */
interface PackPermission {
  type: "identity-inject" | "tool-register" | "loop-register" | "pattern-register" | "state-write" | "comm-broadcast";
  scope?: string;  // 作用域（如特定 namespace/tool 名）
}
```

### 2.1 PackRegistry 接口

Pack 通过 `register(registry)` 向各库注入资产。注册表是 Pack 与四库 + Pattern 注册表之间的唯一桥梁。

#### 2.1.1 Pack 注册资产条目类型

PackRegistry 各 register* 方法的参数类型定义如下。CoordinationPattern / ExecutionPattern 见 03-execution-modes.md，不在此重复。

```typescript
// Pack 注册时的资产条目类型

interface IdentityEntry {
  name: string;                    // 身份名（catalog key）
  role: string;                    // 角色标识
  systemPrompt: string;            // 系统提示词
  tools: string[];                 // 工具列表
  model: string;                   // LLM 模型
  skills?: string[];              // 技能列表
  capabilities?: string[];        // 能力声明
  outputSchema?: object;          // Zod schema（输出验证）
  source: "pack" | "builtin" | "user" | "project" | "group";
}

interface ArchitecturePromptEntry {
  name: string;                    // 提示词名（catalog key）
  content: string;                 // Markdown 内容
  applicableRoles?: string[];      // 适用角色
  source: "pack" | "builtin" | "user" | "project" | "group";
}

interface SkillEntry {
  name: string;                    // 技能名（catalog key）
  content: string;                 // 技能内容（注入 system prompt）
  applicableRoles?: string[];      // 适用角色
  source: "pack" | "builtin" | "user" | "project" | "group";
}

interface LoopEntry {
  name: string;                    // Loop 名（catalog key）
  loop: AgentLoop;                 // Loop 实现
  description?: string;
  tags?: string[];
  source: "pack" | "builtin" | "user" | "project" | "group";
}

interface ToolDescriptor {
  toolName: string;
  riskLevel: "safe" | "moderate" | "restricted" | "forbidden";
  description?: string;
  source?: string;
}
```

> **消歧注**：此处 ToolDescriptor（§2.1.1）≠ §4.3 ToolDescriptor。区分依据：§2.1.1 是 Pack 注册时的声明条目（toolName + riskLevel + source 追溯），§4.3 是核心内部展开的完整风险描述符（含 requiresVerification / requiresUserConfirmation / auditLog / mainAgentOnly 扩展字段）。注册时用 §2.1.1 简化版，核心内部展开为 §4.3 完整版。


```typescript
/**
 * PackRegistry：Pack 注册原料的唯一入口。
 * 各 register* 方法均走"四层加载"机制（pack < builtin < user < project < group），
 * Pack 注入的资产位于最底层，用户 project/group 级覆盖永远赢。
 */
interface PackRegistry {
  /** 向身份库注册一个身份（谁来做） */
  registerIdentity(entry: IdentityEntry): void;
  /** 向架构提示词库注册一个框架行为提示词（怎么做） */
  registerArchitecturePrompt(prompt: ArchitecturePromptEntry): void;
  /** 向技能库注册一个技能（额外能力） */
  registerSkill(skill: SkillEntry): void;
  /** 向 Loop 库注册一个执行引擎（用什么跑）。运行期只读，只能从已注册的选 */
  registerLoop(loop: LoopEntry): void;
  /** 注册一个 Coordination Pattern（agent 怎么组织） */
  registerCoordinationPattern(pattern: CoordinationPattern): void;
  /** 注册一个 Execution Pattern（任务怎么执行） */
  registerExecutionPattern(pattern: ExecutionPattern): void;
  /** 声明工具风险等级。核心保留 ToolRiskLevel 框架，具体工具的级别由 Pack 注册 */
  declareToolRisk(descriptor: ToolDescriptor): void;

  // ── Pack 生命周期管理（D3 接口预留，Phase 1 调用抛 Error） ──
  /**
   * Phase 2+：标记 Pack 不可用。disabled Pack 的资产查询时被跳过。
   * Phase 1：调用抛 Error('Pack lifecycle management is Phase 2+. In Phase 1, PackRegistry is frozen after bootstrap.')
   */
  disable(name: string): void;
  /**
   * Phase 2+：恢复 disabled 的 Pack 为可用。
   * Phase 1：调用抛 Error（同上）
   */
  enable(name: string): void;
  /**
   * Phase 3+：卸载 Pack（Node ESM 限制：仅清理注册引用，不卸载模块代码）。
   * Phase 1：调用抛 Error（同上）
   */
  unregister(name: string): void;
}
```

### 2.2 四层加载与 Pack 的位置

```mermaid
graph TD
    subgraph highest["最高优先级"]
        G[group<br/>临时组级覆盖]
    end
    subgraph project["项目级"]
        P[project<br/>.orbita/]
    end
    subgraph user["用户级"]
        U[user<br/>~/.orbita/]
    end
    subgraph builtin["核心内置"]
        B[builtin<br/>框架机制资产]
    end
    subgraph packLayer["Pack层"]
        PK[pack<br/>Domain Pack 注入]
    end
    G --> P
    P --> U
    U --> B
    B --> PK
    ```


**注**：用户 project/group 级覆盖永远赢；Pack 不能绑架用户。

Pack 是最底层的"内置"。用户在 project/group 级覆盖 Pack 提供的任何资产，永远赢。这保证用户对系统行为有最终控制权，Pack 不能"绑架"用户。

### 2.3 Pack 生命周期状态机（D3 接口预留）

PackRegistry 在 §2.1 预留了 `disable`/`enable`/`unregister` 三个生命周期方法。**Phase 1：bootstrap 完成后 PackRegistry 冻结，以上方法调用均抛 Error**。接口按终局形态设计（原则 2），Phase 2+/3+ 分阶段实现。

Pack 状态流转：

```mermaid
stateDiagram-v2
    [*] --> loaded: 静态 import
    loaded --> registered: register() 注册成功
    registered --> enabled: 默认状态 Phase 1
    enabled --> disabled: disable() 禁用 Phase 2+
    disabled --> enabled: enable() 恢复 Phase 2+
    enabled --> unloaded: unregister() 卸载 Phase 3+
    disabled --> unloaded: unregister() 卸载 Phase 3+
    unloaded --> [*]
```

| 状态 | 含义 | 资产查询 | Phase |
|------|------|----------|-------|
| loaded | 模块已 import，尚未注册 | 不可见 | Phase 1 |
| registered / enabled | 已注册，资产可用 | 可见可用 | Phase 1 |
| disabled | 已注册但标记不可用 | 跳过此 Pack | Phase 2+ |
| unloaded | 已卸载，引用已清理 | 不可见 | Phase 3+ |

> **D3 决策说明**：09-seam-map.md §3.12 记录 PackRegistry 约束为「注册只在 bootstrap 时发生，运行期不可变」。本节通过「接口预留 + Phase 1 报错」调和——终局需要 disable/enable 能力（原则 2 接口按终局形态设计），但 Phase 1 不实现（bootstrap 后冻结），避免过早引入运行期可变性。Phase 2+ 实现 disable/enable（资产查询跳过 disabled Pack），Phase 3+ 实现 unregister（受 Node ESM 模块卸载技术限制，仅清理注册引用不卸载代码）。

---

## 3. coding 渗剥点清单

v3 核心携带大量 coding 专属资产。v4 将这些资产全部迁移到 coding-pack，核心只保留领域中立的接口框架。下表是完整的渗剥点清单——每个从 v3 核心移出的资产都列出。

| # | v3 核心资产 | v4 归属 | 迁移说明 |
|---|------------|---------|---------|
| 1 | `ProjectState.files: Record<path, hash>` | coding-pack 的 `sessionStateSchema` | 核心改为 `Session.domainState: Record<string, unknown>`，files 字段由 schema 定义 |
| 2 | `ProjectState.cwd: string` | coding-pack 的 `sessionStateSchema` | cwd 是 coding 专属概念，核心不假设 |
| 3 | `ProjectState.repoUrl` 等元数据 | coding-pack 的 `sessionStateSchema` | 仓库元数据属领域 |
| 4 | `WorkspaceSlot` 的"文件系统/git worktree"语义 | coding-pack 的 `WorkspaceBackend`（GitWorktreeBackend） | 核心只保留 `WorkspaceSlot` 接口（mode + options），不含 branchTemplate |
| 5 | Worktree 三级隔离实现（shared/isolated/worktree） | coding-pack 的 `GitWorktreeBackend` 实现 | 核心保留 `WorkspaceBackend` 接口（决策 49 保留，实现移 Pack） |
| 6 | 工具分级表（read=safe/write=moderate/bash=moderate/browser=restricted/delete=forbidden） | coding-pack `declareToolRisk()` 注册时声明 | 核心保留 `ToolRiskLevel` 框架（safe/moderate/restricted/forbidden），具体工具映射移 Pack（决策 40） |
| 7 | 15 个内置身份（security-reviewer/frontend-dev/backend-dev...） | coding-pack `registerIdentity()` 自带 | 这些是 coding 身份，research-pack 会自带研究身份 |
| 8 | 内置技能（owasp-top-10/dependency-audit/pii-detection...） | coding-pack `registerSkill()` 自带 | coding 安全/审计技能属领域 |
| 9 | Tournament 评估权重（功能30%/测试25%/质量25%/安全10%/性能10%） | coding-pack 的 `defaultRubric` | 不同领域不同权重，核心只有 `EvaluationRubric` 接口 |
| 10 | 完成守卫（文件变异检测） | coding-pack 的 `CompletionGuard`（FileMutationGuard） | 核心保留 `CompletionGuard` 接口（决策 50），实现移 Pack |
| 11 | 内置工具实现（read/write/edit/bash/grep/glob/ls） | coding-pack 自带 | 这些是 coding 工具，核心只自带 4 个框架机制工具 |
| 12 | `WorkspaceIsolation` 的 GitWorktreeIsolation 实现 | coding-pack 的 `GitWorktreeBackend` | 隔离实现属领域，核心只定义后端接口 |
| 13 | 模块级 diff / 选择性合并（决策 62） | coding-pack 的 `GitWorktreeBackend` | git diff/cherry-pick 是 coding 操作 |

### 3.1 迁移不变量（F3 检查强制）

迁移后核心代码必须满足以下不变量，否则视为迁移不完整：

- 核心无 `filePath` / `cwd` / `repoUrl` / `branchTemplate` 等 coding 专属字段名
- `ProjectState` 类型不存在；替换为 `Session.domainState: Record<string, unknown>`
- 工具分级表不在核心代码（`tool-registry.ts` 只定义 `ToolRiskLevel` 枚举和 `ToolDescriptor` 接口）
- Worktree 三级隔离实现不在核心包（核心只有 `WorkspaceBackend` 接口）
- 15 个内置身份的 YAML 文件不在核心的 identity/builtin 目录

---

## 4. 核心保留的领域中立版

核心不携带领域语义，但保留所有"框架机制"的接口定义。这些接口是 Pack 实现的契约，核心提供最笨的默认实现（Phase 1）或空接口。

### 4.1 Session.domainState（容器）

```typescript
interface Session {
  id: string;
  workspaceId: string;
  userId: string;
  /** 领域状态容器。核心不假设其内容，schema 由 Pack 的 sessionStateSchema 定义 */
  domainState: Record<string, unknown>;
  /** 模式状态（status/agentCount/lastActivity）——领域中立 */
  state: SessionState;
  /** 事件溯源的活动日志（Phase 1 简化为可变对象，接口按事件溯源设计） */
  activityLog: ActivityEntry[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  endedAt?: Date;
}
```

`domainState` 是核心提供的无类型容器。coding-pack 的 schema 定义 `{ files, cwd, repoUrl, branchBase }`；research-pack 的 schema 定义 `{ papers: PaperRef[], hypotheses: string[], datasets: DatasetRef[] }`。核心对此一无所知。

#### 4.1.1 sessionStateSchema 验证机制

Pack 通过 `sessionStateSchema`（Zod schema）定义 domainState 的结构。核心提供验证框架，具体 schema 由 Pack 定义。

**验证时机与失败策略**：

| 时机 | 动作 | 失败策略 |
|------|------|----------|
| Pack 注册时 | 校验 schema 语法有效性（Zod schema 可正确 parse） | schema 无效 → 拒绝注册 + `Error('Pack ${name} sessionStateSchema is invalid: ${detail}')` |
| 运行期 domainState 变更 | 校验新值符合 Pack 的 sessionStateSchema | 值无效 → 回滚变更 + warning 日志（`domainState validation failed for pack ${name}`） |

**执行者**：核心 ZodValidator（领域中立，不假设 schema 内容）：

```typescript
interface StateValidator {
  validate(state: unknown, schema: ZodSchema): ValidationResult;
}

interface ValidationResult {
  success: boolean;
  errors?: string[];
}
```

**设计理由**：核心不假设 domainState 内容（原则 18 通用底座），但提供统一的验证执行框架。Zod 作为运行期 schema 校验库，Pack 注册时即绑定 schema，运行期每次 domainState 变更自动触发校验。

### 4.2 WorkspaceSlot 接口（领域中立版）

```typescript
/**
 * WorkspaceSlot：工作区配置槽位。
 * 核心只定义 mode 和 options，不含 branchTemplate/git 等 coding 语义。
 * 具体后端（GitWorktreeBackend）由 Pack 提供。
 */
interface WorkspaceSlot {
  /** 隔离模式：shared（共享主工作区）/ isolated（独立工作区）/ backend（由 Pack 后端决定） */
  mode: "shared" | "isolated" | "backend";
  /** 传递给 Pack 的 WorkspaceBackend 的选项。核心不解释其内容 */
  options?: Record<string, unknown>;
}

/**
 * WorkspaceBackend：工作区后端接口。
 * coding-pack 提供 GitWorktreeBackend；其他领域可提供自己的后端。
 */
interface WorkspaceBackend {
  /** 后端名称，如 "git-worktree" */
  name: string;
  /** 创建隔离工作区 */
  createIsolated(basePath: string, count: number): Promise<IsolatedWorkspace[]>;
  /** 收集差异并合并回主工作区 */
  collectAndMerge(workspace: IsolatedWorkspace): Promise<MergeResult>;
  /** 丢弃工作区（失败时） */
  discard(workspace: IsolatedWorkspace): Promise<void>;
  /** 清理 */
  cleanup(workspace: IsolatedWorkspace): Promise<void>;
}
```

### 4.3 ToolDescriptor（风险框架）

```typescript
type ToolRiskLevel = "safe" | "moderate" | "restricted" | "forbidden";

/**
 * ToolDescriptor：工具描述符。
 * 核心保留风险等级框架，具体工具的 riskLevel 由 Pack 在 declareToolRisk() 时声明。
 */
interface ToolDescriptor {
  name: string;
  description: string;
  /** 风险等级。核心定义四级枚举，具体映射由 Pack */
  riskLevel: ToolRiskLevel;
  requiresVerification?: boolean;      // moderate: 需配对验证
  requiresUserConfirmation?: boolean;  // restricted: 需用户确认
  auditLog?: boolean;                  // restricted: 审计日志
  mainAgentOnly?: boolean;             // forbidden: 仅 Main Agent
}
```

### 4.4 CompletionGuard 接口

```typescript
/**
 * CompletionGuard：完成守卫接口。
 * 子 Agent 声明完成时，守卫校验领域特定的完成条件。
 * coding-pack 提供 FileMutationGuard（检测预期文件是否真的被修改）。
 */
interface CompletionGuard {
  /** 守卫名称 */
  name: string;
  /**
   * 校验子 Agent 完成声明。
   * @returns 通过则 null；不通过则返回原因列表
   */
  check(claim: CompletionClaim, context: GuardContext): Promise<string[] | null>;
}

interface CompletionClaim {
  agentId: string;
  /** 子 Agent 声明完成的证据（由 Pack schema 定义具体结构） */
  evidence: Record<string, unknown>;
}

interface GuardContext {
  sessionId: string;
  domainState: Record<string, unknown>;
  workspace: WorkspaceSlot;
}
```

### 4.5 EvaluationRubric 接口

```typescript
/**
 * EvaluationRubric：评估量规接口。
 * 竞功模式评功推官按此量规给各路提督的战果打分。
 * coding-pack 提供五维度量规（功能/测试/质量/安全/性能）。
 */
interface EvaluationRubric {
  /** 量规名称 */
  name: string;
  /** 评估维度列表 */
  dimensions: RubricDimension[];
  /** 聚合策略：加权求和 / 取最低 / 混合 */
  aggregate: "weighted-sum" | "min" | "hybrid";
}

interface RubricDimension {
  /** 维度名称，如 "functionality"、"tests" */
  name: string;
  /** 权重（0-1，所有维度权重和应为 1） */
  weight: number;
  /** 该维度的评分标准描述（供评功推官 LLM 理解） */
  criteria: string;
}
```

核心自带 4 个框架机制工具（领域中立，属核心但走同一 ToolSlot 注册路径，无特权）：

| 工具 | 用途 |
|------|------|
| `dispatch_subagent` | 派发子 Agent |
| `contact_main_agent` | 子 Agent 向主 Agent 请求 |
| `submit_output` | 提交结构化输出 |
| `search_catalog` | 搜索四库 catalog |

---

## 5. 四层加载优先级

四库资产（身份/架构提示词/技能/Loop）共享同一套四层加载机制。Pack 注入的资产位于最底层，与 builtin/user/project/group 共同决定最终生效的资产。

```
┌─────────────────────────────────────────────────────────────┐
│  group（临时组级覆盖）  优先级最高 —— 竞功模式差异化用         │
├─────────────────────────────────────────────────────────────┤
│  project（.orbita/）  项目级覆盖                              │
├─────────────────────────────────────────────────────────────┤
│  user（~/.orbita/）  用户级覆盖                               │
├─────────────────────────────────────────────────────────────┤
│  builtin（核心自带）  框架机制资产                           │
├─────────────────────────────────────────────────────────────┤
│  pack（Domain Pack 注入）  最底层"内置"  ← Pack 资产位置     │
└─────────────────────────────────────────────────────────────┘
        ▼ 用户覆盖永远赢；Pack 不能绑架用户
```

**关键规则**：
- Pack 资产是"内置的延伸"，与核心自带资产等权，走完全相同的注册和执行路径（决策 32 重新表述）。
- 用户 project/group 级覆盖永远赢——这保证用户对系统行为有最终控制权。
- 同名资产按优先级覆盖：`project/security-reviewer.yaml` 覆盖 `pack/security-reviewer.yaml`。

**核心自带的 4 个框架机制工具**不属 pack 层，它们属 builtin 层（核心自带），但通过同一 `ToolSlot` 注册路径，无特权通道。

---

## 6. Pack 发现与加载

### 6.1 加载流程（ASCII 框图）

```
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ 1. 读取配置      │───►│ 2. 解析依赖      │───►│ 3. 按序静态 import│
│ packs:           │    │ 拓扑排序 pack    │    │ 每个 pack 调用    │
│  @璇玑/coding-   │    │ 依赖关系         │    │ register(registry)│
│  pack            │    │                  │    │ 注入四库+Pattern  │
└──────────────────┘    └──────────────────┘    └────────┬─────────┘
                                                         │
                                                         ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ 6. 用户覆盖生效  │◄───│ 5. builtin 注入  │◄───│ 4. 冲突检测      │
│ project/group 覆 │    │ 核心自带 4 工具  │    │ 同名资产后者覆盖 │
│ 盖 pack 资产     │    │ + builtin 资产   │    │ bootstrap warning│
└──────────────────┘    └──────────────────┘    └──────────────────┘
```

### 6.2 Phase 1：配置文件显式声明

Phase 1 采用最笨实现——配置文件显式声明 Pack 列表，静态 import 注册。

```yaml
# 璇玑.config.yaml
packs:
  - "@璇玑/coding-pack"
  # Phase 2+ 可加多个：
  # - "@璇玑/research-pack"
```

```typescript
// bootstrap.ts（Phase 1）
async function bootstrap(config: OrbitaConfig) {
  const registry = new PackRegistryImpl();

  // 1. 按配置顺序加载 Pack
  for (const packName of config.packs) {
    const pack = await import(packName);           // 静态 import
    const instance: DomainPack = pack.default;

    // 2. 依赖检查
    if (instance.dependencies) {
      for (const dep of instance.dependencies) {
        if (!loadedPacks.has(dep)) {
          throw new Error(`Pack ${instance.name} 依赖 ${dep}，但 ${dep} 未加载`);
        }
      }
    }

    // 3. 注册
    instance.register(registry);
    loadedPacks.set(instance.name, instance);
  }

  // 4. builtin 注入（核心自带的框架机制工具等）
  registry.registerCoreTools([dispatchSubagent, contactMainAgent, submitOutput, searchCatalog]);

  // 5. 用户覆盖层加载（user/project/group）
  await loadUserOverrides(registry);
}
```

### 6.3 冲突处理

两个 Pack 注册同名资产时：
- **按加载顺序，后者覆盖**。`璇玑.config.yaml` 中靠后的 Pack 覆盖靠前的。
- **bootstrap warning**：检测到覆盖时输出警告，告知用户哪个 Pack 覆盖了哪个资产。
- **用户显式覆盖永远赢**：用户在 project 级定义同名资产，覆盖所有 Pack 的资产。

```typescript
// 冲突检测伪代码
declareToolRisk(descriptor: ToolDescriptor): void {
  const existing = this.tools.get(descriptor.name);
  if (existing && existing.source !== descriptor.source) {
    logger.warn(
      `工具 ${descriptor.name} 风险等级被覆盖：` +
      `${existing.source}:${existing.riskLevel} -> ${descriptor.source}:${descriptor.riskLevel}`
    );
  }
  this.tools.set(descriptor.name, descriptor);
}
```

### 6.4 Phase 2+：目录扫描与动态加载

Phase 1 用配置显式声明。Phase 2+ 演进到：
- 目录扫描：扫描 `node_modules/@璇玑/*-pack` 自动发现。
- 动态加载：按 Session 上下文动态启用 Pack（如检测到 git 仓库自动启用 coding-pack）。
- 接口预留：运行期 disable/enable/unregister（§2.3 已预留签名，Phase 1 冻结，Phase 2+ 实现 disable/enable，Phase 3+ 实现 unregister——受 Node ESM 模块卸载技术限制，unregister 仅清理注册引用不卸载代码）。

接口形态（Phase 1 已预留）：

```typescript
interface PackLoader {
  /** Phase 1：从配置显式加载 */
  loadFromConfig(config: OrbitaConfig): Promise<DomainPack[]>;
  /** Phase 2+：目录扫描发现 */
  discover(): Promise<DomainPackManifest[]>;
  /** Phase 2+：动态加载 */
  load(manifest: DomainPackManifest): Promise<DomainPack>;
}
```

### 6.5 Pack 加载失败处理（D10③）

**Phase 1 策略：fail-fast**

bootstrap 过程中，任何一个 Pack 的 `register()` 抛异常、依赖缺失、版本冲突，系统启动**立即失败**并输出明确错误：

```
[PACK-LOAD-ERROR] Pack "coding-pack" v1.0.0 failed to register:
  Reason: Dependency "@璇玑/core-tools" not found
  Action: Install missing dependency or remove Pack from bootstrap list
```

Phase 1 不支持优雅降级（跳过失败的 Pack 继续启动），因为：
- Phase 1 只有官方 coding-pack，失败 = 环境问题
- 跳过 Pack 可能导致依赖它的其他 Pack 失败（级联错误更难诊断）

**Phase 2+ 策略：依赖解析 + 优雅降级**

```
bootstrap:
  1. 解析所有 Pack 的 dependencies 字段，构建依赖图
  2. 拓扑排序（Kahn 算法 + 环检测，见 §10.2）
  3. 按拓扑序依次 register
  4. 某个 Pack 失败：
     a. 检查是否有其他 Pack 依赖它
     b. 无依赖 → 跳过 + 记录警告 → 继续
     c. 有依赖 → 标记所有依赖它的 Pack 为 "degraded" → 询问用户是否继续
```

---

## 7. 发行方式

璇玑 npm 包（`@璇玑/core`）默认依赖 `@璇玑/coding-pack` 并自动启用。核心代码是空核，但开箱即用。

### 7.1 包结构

```
@璇玑/core              ← 核心微内核（空核，领域中立）
  ├── 依赖 @璇玑/coding-pack（peerDependency，默认自动启用）
  └── 核心 6 概念 + 四库机制 + 双宪法 + Pattern 注册表

@璇玑/coding-pack       ← 第一个官方 Domain Pack
  ├── identities/       ← 15 个 coding 身份
  ├── skills/           ← owasp-top-10 等技能
  ├── workspaces/       ← GitWorktreeBackend
  ├── guards/           ← FileMutationGuard
  ├── rubrics/          ← 五维度评估量规
  └── presets/          ← code-review-session 等 Preset

@璇玑/research-pack     ← Phase 2+ 官方 Pack（示例）
@璇玑/writing-pack      ← Phase 2+ 官方 Pack（示例）
```

### 7.2 开箱即用

用户安装 `@璇玑/core` 即得完整 coding 协作能力，无需额外配置：

```yaml
# 默认配置（用户不写也生效）
packs:
  - "@璇玑/coding-pack"   # 自动启用
```

### 7.3 自定义领域

用户可发布自己的 Pack（如 `@my-org/legal-pack` 法律领域 Pack），在配置中启用：

```yaml
packs:
  - "@璇玑/coding-pack"
  - "@my-org/legal-pack"   # 自定义 Pack
```

---

## 8. Preset 归 Pack（不是第五个库）

### 8.1 为什么 Preset 不独立成库

四库（身份/架构提示词/技能/Loop）是对称的、领域中立的库机制。Preset 不同——Preset 是"配方"，打包特定领域的合法组合，强绑定领域语义。code-review-session 这个 Preset 只有 coding-pack 知道它意味着什么。

因此 **Preset 归 Domain Pack**（决策 84），不是第五个库。每个 Pack 提供自己的 Preset 集。

### 8.2 Preset 契约

```typescript
/**
 * Preset：打包好的合法组合（配方）。
 * 固化 Coordination + Execution + 四维度默认值 + 渐进推断规则。
 * Main Agent 选 Preset 而非逐项选，决策负担从 7-8 降到 2-3。
 */
interface Preset {
  /** Preset 唯一标识，如 "code-review-session" */
  name: string;
  /** 一句话描述（供 catalog 展示和 Main Agent 选择） */
  description: string;
  /** 何时用此 Preset（帮 LLM 判断） */
  whenToUse: string;
  /** 何时不用此 Preset */
  whenNotToUse: string;
  /** 固化的 Coordination Pattern，如 "hierarchy"、"market" */
  coordination: string;
  /** 固化的 Execution Pattern，如 "dag"、"tournament" */
  execution: string;
  /** 四维度默认值：身份/架构提示词/技能/Loop */
  defaults: PresetDefaults;
  /** 渐进推断规则：用户只填 task（+可选 identity），系统按规则补齐其余 */
  infer: InferRules;
}

interface PresetDefaults {
  /** 默认身份来源（library 名 / dynamic） */
  identity?: string;
  /** 默认架构提示词来源 */
  architecturePrompt?: string;
  /** 默认技能列表 */
  skills?: string[];
  /** 默认 Loop（执行引擎），如 "react-loop" */
  loop?: string;
}

interface InferRules {
  /** 根据 task 文本推断 identity 的规则 */
  identity?: InferRule;
  /** 根据 task 推断 skills 的规则 */
  skills?: InferRule;
  /** 推断失败时的兜底默认值 */
  fallback: PresetDefaults;
}

interface InferRule {
  /** 关键词匹配 -> 推荐值 */
  patterns: Array<{ keywords: string[]; value: string | string[] }>;
}
```

### 8.3 决策负担降低

无 Preset 时，Main Agent 派发子 Agent 需逐项选择 7-8 个维度：identity、architecturePrompt、skills、loop、coordination、execution、verification、workspace。

有 Preset 后，Main Agent 只需选 Preset（1 个决策）+ 填 task（必填）+ 可选 identity（1 个决策）。系统按 `infer` 规则补齐其余。**决策负担从 7-8 降到 2-3**。

派发流程：

```
1. 选 Preset（或系统按 catalog.whenToUse 推荐）
2. 填 task（必填）+ 可选 identity
3. 系统按 infer 补齐其余维度
4. dispatch_subagent
```

---

## 9. coding-pack 完整设计示例

本节给出 coding-pack 的完整设计，作为 Pack 实现的参考范本。

### 9.1 Pack 定义

```typescript
// @璇玑/coding-pack/index.ts
import { z } from "zod";
import type { DomainPack, PackRegistry, Preset } from "@璇玑/core";

const codingPack: DomainPack = {
  name: "coding",
  version: "1.0.0",
  dependencies: [],

  register(registry: PackRegistry): void {
    // ── 身份库：注册 15 个 coding 身份 ──
    registry.registerIdentity(securityReviewer);
    registry.registerIdentity(performanceAnalyzer);
    registry.registerIdentity(styleChecker);
    registry.registerIdentity(generalReviewer);
    registry.registerIdentity(frontendDev);
    registry.registerIdentity(backendDev);
    registry.registerIdentity(databaseExpert);
    registry.registerIdentity(apiDesigner);
    registry.registerIdentity(unitTestWriter);
    registry.registerIdentity(e2eTestWriter);
    registry.registerIdentity(testReviewer);
    registry.registerIdentity(dockerExpert);
    registry.registerIdentity(ciCdExpert);
    registry.registerIdentity(k8sExpert);
    registry.registerIdentity(requirementsAnalyst);

    // ── 技能库：注册 coding 技能 ──
    registry.registerSkill(owaspTop10);
    registry.registerSkill(dependencyAudit);
    registry.registerSkill(piiDetection);

    // ── 工具风险声明（核心保留框架，具体映射在此） ──
    registry.declareToolRisk({ name: "read",  riskLevel: "safe" });
    registry.declareToolRisk({ name: "grep",  riskLevel: "safe" });
    registry.declareToolRisk({ name: "glob",  riskLevel: "safe" });
    registry.declareToolRisk({ name: "write", riskLevel: "moderate", requiresVerification: true });
    registry.declareToolRisk({ name: "edit",  riskLevel: "moderate", requiresVerification: true });
    registry.declareToolRisk({ name: "bash",  riskLevel: "moderate", requiresVerification: true });
    registry.declareToolRisk({ name: "browser", riskLevel: "restricted", requiresUserConfirmation: true, auditLog: true });
    registry.declareToolRisk({ name: "delete", riskLevel: "forbidden", mainAgentOnly: true });
  },

  presets: [
    codeReviewSession,
    featureImplementation,
    securityAudit,
    bugfixSession,
  ],

  // ── domainState schema：定义 coding 领域状态结构 ──
  sessionStateSchema: z.object({
    files: z.record(z.string()),           // path -> content hash
    cwd: z.string(),                        // 当前工作目录
    repoUrl: z.string().optional(),         // 仓库地址
    branchBase: z.string().optional(),      // worktree 基线分支
  }),

  // ── 工作区后端：GitWorktreeBackend ──
  workspaceBackend: new GitWorktreeBackend(),

  // ── 完成守卫：FileMutationGuard ──
  completionGuard: new FileMutationGuard(),

  // ── 默认评估量规：五维度 ──
  defaultRubric: {
    name: "coding-default",
    aggregate: "weighted-sum",
    dimensions: [
      { name: "functionality", weight: 0.30, criteria: "功能是否完整实现需求" },
      { name: "tests",         weight: 0.25, criteria: "测试覆盖率与边界用例" },
      { name: "quality",       weight: 0.25, criteria: "代码可读性、结构、命名" },
      { name: "security",      weight: 0.10, criteria: "安全漏洞（OWASP/依赖）" },
      { name: "performance",   weight: 0.10, criteria: "复杂度、N+1、内存" },
    ],
  },
};

export default codingPack;
```

### 9.2 GitWorktreeBackend（WorkspaceBackend 实现）

```typescript
/**
 * GitWorktreeBackend：coding-pack 的工作区后端。
 * 实现三级隔离（shared/isolated/worktree），基于 git worktree。
 */
class GitWorktreeBackend implements WorkspaceBackend {
  name = "git-worktree";

  async createIsolated(basePath: string, count: number): Promise<IsolatedWorkspace[]> {
    // 为每个并行任务创建独立 worktree 分支
    // 基于决策 49 的 Worktree 三级隔离
  }

  async collectAndMerge(workspace: IsolatedWorkspace): Promise<MergeResult> {
    // git diff 收集变更，合并回主分支
    // 支持模块级 diff（决策 62）和选择性合并
  }

  async discard(workspace: IsolatedWorkspace): Promise<void> {
    // 失败时丢弃 worktree，主工作区不受影响
  }

  async cleanup(workspace: IsolatedWorkspace): Promise<void> {
    // 清理 worktree 和临时分支
  }
}
```

### 9.3 FileMutationGuard（CompletionGuard 实现）

```typescript
/**
 * FileMutationGuard：coding-pack 的完成守卫。
 * 子 Agent 声明完成时，校验预期文件是否真的被修改。
 */
class FileMutationGuard implements CompletionGuard {
  name = "file-mutation";

  async check(claim: CompletionClaim, context: GuardContext): Promise<string[] | null> {
    // claim.evidence.expectedFiles: 子 Agent 声明修改的文件列表
    // 对比 domainState.files 的实际变更
    // 未变更的文件返回为"未完成原因"
    return reasons.length > 0 ? reasons : null;
  }
}
```

### 9.4 Preset 示例

```typescript
const codeReviewSession: Preset = {
  name: "code-review-session",
  description: "代码审查会话：安全/性能/风格多维并行审查",
  whenToUse: "审查现有代码的安全、性能、风格问题",
  whenNotToUse: "开发新功能（用 feature-implementation）",
  coordination: "hierarchy",     // 朝廷模式
  execution: "dag",              // DAG 并行
  defaults: {
    identity: "general-reviewer",
    skills: ["owasp-top-10"],
    loop: "react-loop",
  },
  infer: {
    identity: {
      patterns: [
        { keywords: ["安全", "漏洞", "owasp"], value: "security-reviewer" },
        { keywords: ["性能", "复杂度", "内存"], value: "performance-analyzer" },
        { keywords: ["风格", "命名", "可读性"], value: "style-checker" },
      ],
    },
    fallback: { identity: "general-reviewer", skills: [], loop: "react-loop" },
  },
};

const featureImplementation: Preset = {
  name: "feature-implementation",
  description: "功能实现：竞功模式多路攻关择优",
  whenToUse: "实现复杂功能，需多方案竞争择优",
  whenNotToUse: "简单单步任务（直接 dispatch）",
  coordination: "market",        // 竞功模式
  execution: "tournament",       // 竞争择优
  defaults: {
    identity: "backend-dev",
    loop: "react-loop",
  },
  infer: {
    identity: {
      patterns: [
        { keywords: ["前端", "UI", "React", "Vue"], value: "frontend-dev" },
        { keywords: ["数据库", "SQL", "索引"], value: "database-expert" },
        { keywords: ["API", "REST", "GraphQL"], value: "api-designer" },
      ],
    },
    fallback: { identity: "backend-dev", loop: "react-loop" },
  },
};

const securityAudit: Preset = {
  name: "security-audit",
  description: "安全审计：OWASP + 依赖漏洞 + PII 全栈扫描",
  whenToUse: "全面安全审计",
  whenNotToUse: "单一维度审查（用 code-review-session）",
  coordination: "hierarchy",
  execution: "dag",
  defaults: {
    identity: "security-reviewer",
    skills: ["owasp-top-10", "dependency-audit", "pii-detection"],
    loop: "react-loop",
  },
  infer: {
    fallback: { identity: "security-reviewer", skills: ["owasp-top-10"], loop: "react-loop" },
  },
};
```

### 9.5 coding-pack 资产汇总

| 资产类型 | 数量 | 示例 |
|---------|------|------|
| 身份 | 15 | security-reviewer, frontend-dev, backend-dev... |
| 技能 | 3+ | owasp-top-10, dependency-audit, pii-detection |
| 工具风险声明 | 9 | read=safe, write=moderate, browser=restricted... |
| Preset | 4+ | code-review-session, feature-implementation, security-audit, bugfix-session |
| WorkspaceBackend | 1 | GitWorktreeBackend |
| CompletionGuard | 1 | FileMutationGuard |
| EvaluationRubric | 1 | coding-default（五维度） |
| sessionStateSchema | 1 | { files, cwd, repoUrl, branchBase } |

---

## 10. 多 Pack 共存（Phase 2+）

Phase 1 只有 coding-pack。Phase 2+ 支持多 Pack 同时启用，覆盖更多领域。

### 10.1 多 Pack 启用示例

```yaml
# 璇玑.config.yaml（Phase 2+）
packs:
  - "@璇玑/coding-pack"
  - "@璇玑/research-pack"
```

用户可在 coding 会话中临时调用研究能力（如查阅论文辅助技术决策），或在研究会话中调用 coding 能力（如复现论文代码）。

### 10.2 Pack 间依赖解析

Pack 可声明 `dependencies`。加载器做拓扑排序，确保依赖先加载。

```typescript
// research-pack 依赖 coding-pack（复现代码需要 coding 工具）
const researchPack: DomainPack = {
  name: "research",
  version: "1.0.0",
  dependencies: ["coding"],   // 依赖 coding-pack
  register(registry) {
    // 注册研究身份（paper-reviewer, experiment-runner...）
    // 注册研究技能（arxiv-search, citation-graph...）
  },
  // ...
};
```

加载器检测到 `research` 依赖 `coding`，先加载 coding-pack，再加载 research-pack。若依赖缺失，启动失败并报错。

#### 依赖解析算法

加载器按以下 4 步解析 Pack 依赖关系：

**① 构建依赖图**：读取每个 Pack 的 `dependencies` 字段，构建有向图（节点 = Pack，边 A→B 表示 A 依赖 B）。

**② Kahn 算法拓扑排序**（加载顺序 = 拓扑序）：

```typescript
function resolveLoadOrder(packs: DomainPack[]): DomainPack[] {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const p of packs) {
    inDegree.set(p.name, p.dependencies?.length ?? 0);
    for (const dep of p.dependencies ?? []) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), p.name]);
    }
  }
  const queue = packs.filter(p => (inDegree.get(p.name) ?? 0) === 0);
  const sorted: DomainPack[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    sorted.push(cur);
    for (const d of dependents.get(cur.name) ?? []) {
      const deg = (inDegree.get(d) ?? 0) - 1;
      inDegree.set(d, deg);
      if (deg === 0) { const dp = packs.find(p => p.name === d); if (dp) queue.push(dp); }
    }
  }
  return sorted;
}
```

**③ 环检测**：拓扑排序后，若 `sorted.length < packs.length`，说明存在环——有节点入度永远不为 0：

```typescript
if (sorted.length < packs.length) {
  const cyclic = packs.filter(p => !sorted.includes(p)).map(p => p.name);
  throw new Error(`Circular dependency detected: [${cyclic.join(' → ')}]`);
}
```

**④ semver 版本约束**：`dependencies` 支持 semver 范围表达式（`semver` 库解析）：

| 表达式 | 含义 |
|--------|------|
| `coding@^1.0` | 兼容 1.x（>=1.0.0 <2.0.0） |
| `coding@~1.0` | 兼容 1.0.x（>=1.0.0 <1.1.0） |
| `coding@>=1.0 <2.0` | 显式范围 |
| `coding`（无版本） | 任意版本 |

**冲突仲裁**：同一 Pack 多版本共存时，高版本优先 + bootstrap warning：

```typescript
logger.warn(`Pack ${name} 多版本共存：${v1} vs ${v2}，选用高版本 ${v2}`);
```

### 10.3 资产命名空间

多 Pack 共存时，同名资产冲突通过命名空间避免：

- **身份**：catalog 按类别分区，Pack 自带的身份归入 Pack 专属类别（如 `coding/code-review/security-reviewer` vs `research/paper-reviewer`）。
- **技能**：技能名加 Pack 前缀（如 `coding:owasp-top-10` vs `research:arxiv-search`）。
- **Preset**：Preset 名加 Pack 前缀（如 `coding:code-review-session` vs `research:literature-review`）。
- **工具风险**：工具名全局唯一（read/write/bash 是通用工具名），但 Pack 可注册领域专属工具（如 `coding:git-log`、`research:arxiv-fetch`）。

冲突时按加载顺序后者覆盖 + bootstrap warning（见 §6.3）。用户 project 级覆盖永远赢。

### 10.4 跨领域协作

多 Pack 启用后，Main Agent 可在单次 dispatch 中混用不同领域的资产：

```typescript
dispatch_subagent({
  task: "复现这篇论文的实验代码",
  identity: { source: "library", name: "research:experiment-runner" },
  skills: { source: "library", names: ["coding:owasp-top-10"] },  // 复用时检查代码安全
  preset: "coding:feature-implementation",
});
```

这种跨领域混用是 Phase 2+ 的能力，Phase 1 单 Pack 不涉及。

### 10.5 跨领域状态共享

多 Pack 共存时，每个 Pack 的 domainState 默认隔离，通过显式声明实现有限共享。

**默认隔离**：每个 Pack 的 domainState 存储在独立命名空间 `pack:{name}:state`，Pack 间互不可见。coding-pack 的 `{ files, cwd }` 和 research-pack 的 `{ papers, hypotheses }` 互不干扰。

**显式共享**：Pack 可声明 `sharedStateKeys: string[]`，这些键对其他 Pack **可读不可写**：

```typescript
// Pack 契约扩展（Phase 2+，非核心字段变更）
interface DomainPack {
  // ... 已有核心字段不变 ...
  /** 声明哪些 domainState 键对其他 Pack 可读（跨领域共享，Phase 2+） */
  sharedStateKeys?: string[];
}
```

例：coding-pack 声明 `sharedStateKeys: ["repoUrl"]`，research-pack 可读取 `pack:coding:state.repoUrl` 获取仓库地址用于复现实验，但不能修改。

**跨 Pack 身份解析**：多 Pack 共存时，身份按 namespace 前缀隔离。`coding:reviewer` ≠ `research:analyst`。IdentityLibrary.search 支持按 namespace 过滤：

```typescript
// 搜索时指定 namespace，避免跨领域身份混淆
identityLibrary.search({ query: "reviewer", namespace: "coding" });
// → 返回 coding:security-reviewer / coding:style-checker
// → 不返回 research:paper-reviewer
```

这保证了多 Pack 共存时身份不冲突、状态不污染，同时允许显式声明的跨领域协作。

---

## 11. 在架构中的位置

```
┌─────────────────────────────────────────────────────────────┐
│                      Domain Pack 层                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ coding-pack  │  │research-pack │  │ writing-pack │  ...  │
│  │ identities   │  │ identities   │  │ identities   │       │
│  │ skills       │  │ skills       │  │ skills       │       │
│  │ workspaces   │  │ workspaces   │  │ workspaces   │       │
│  │ guards       │  │ guards       │  │ guards       │       │
│  │ rubrics      │  │ rubrics      │  │ rubrics      │       │
│  │ presets      │  │ presets      │  │ presets      │       │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘       │
│         │  register(registry)                  │             │
└─────────┼──────────────────────────────────────┼─────────────┘
          ▼                                      ▼
┌─────────────────────────────────────────────────────────────┐
│              PackRegistry（注册表）                          │
│  registerIdentity / registerArchitecturePrompt /             │
│  registerSkill / registerLoop / declareToolRisk /            │
│  registerCoordinationPattern / registerExecutionPattern      │
└─────────────────────────┬───────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   核心微内核（空核）                         │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌───────────┐ │
│  │ 四库机制   │ │ Pattern    │ │ 双宪法     │ │ 6 一等概念│ │
│  │ (身份/提示 │ │ 注册表     │ │ (架构/身份)│ │ Agent/Loop│ │
│  │  词/技能/  │ │            │ │            │ │ /User/... │ │
│  │  Loop)     │ │            │ │            │ │           │ │
│  └────────────┘ └────────────┘ └────────────┘ └───────────┘ │
│  核心自带 4 工具：dispatch_subagent / contact_main_agent /   │
│                   submit_output / search_catalog             │
└─────────────────────────────────────────────────────────────┘
```

### 11.1 包结构（v4）

```
packages/
├── shared/              ← 核心类型 + 接口定义（领域中立）
├── core/                ← 核心微内核实现（空核）
├── llm/                 ← LLM 适配器
├── extensions/          ← 6-slot 扩展系统
├── composition/         ← 编排层（四库机制 + Pattern 注册表）
├── agent-core/          ← Loop 引擎
├── infrastructure/      ← 基础设施最笨实现
├── cli/                 ← 命令行入口
└── domain-packs/        ← ★ v4 新增：Domain Pack 目录
    └── coding-pack/     ← 第一个官方 Pack
        ├── index.ts            ← DomainPack 实现
        ├── identities/         ← 15 个身份 YAML
        ├── skills/             ← coding 技能
        ├── workspaces/         ← GitWorktreeBackend
        ├── guards/             ← FileMutationGuard
        ├── rubrics/            ← 五维度量规
        └── presets/            ← code-review-session 等
```

---

## 12. Phase 演进

| 能力 | Phase 1 | Phase 2+ |
|------|---------|----------|
| Pack 加载 | 配置显式声明 + 静态 import | 目录扫描 + 动态加载 + disable/enable/unregister（Phase 2+/3+） |
| 官方 Pack | coding-pack | + research-pack, writing-pack |
| 多 Pack 共存 | 单 Pack（coding） | 多 Pack 同时启用 + 依赖解析 |
| Preset | coding-pack 自带 4+ | 各 Pack 自带 + 用户自定义 |
| 冲突处理 | 加载顺序后者覆盖 + warning | 命名空间 + 依赖仲裁 |
| 自定义 Pack | 不支持（接口预留） | 用户发布自己的 Pack |

---

## 13. 相关文档

- 01-overview.md — 全景概览（通用定位 + 微内核 + Pack）
- 02-architecture-layers.md — 核心微内核 6 概念 + Pack 层
- 04-four-libraries.md — 四库体系（Pack 资产注入四库）
- 03-execution-modes.md — Coordination × Execution 两层 Pattern
- 07-infrastructure.md — WorkspaceBackend / CompletionGuard / EvaluationRubric 接口
- 08-package-structure.md — domain-packs/ 目录组织
- 10-decisions.md — 决策 71（Domain Pack）、32（内置即扩展）、40（工具分级）、50（完成守卫）、84（Preset 归 Pack）

---

> 文档版本：v1.14
> 本版变更（累积最近 3 条，最新在上）：
>   - v1.14：项目更名 wuwo→璇玑（ORBITA），全文品牌/路径/标识符替换（见决策 146）
>   - v1.13：路径引用更新：璇玑/cell-base→璇玑/orbita-sdk/cell-base（old 目录改名 orbita-sdk）
>   - v1.12：D10②③ PackManifest 加 trustLevel/PackPermission + Pack 加载失败处理（Phase1 fail-fast / Phase2+ 优雅降级）
> 基于：璇玑 v4 设计总纲 §1/§3/§4/§15、决策 71/32/40/50/84
> 决策总数：102 条
> 文档总数：25 份
> 原则总数：33 条
