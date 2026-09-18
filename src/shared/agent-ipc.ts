/**
 * agent 域契约 —— IPC 四层的第 1 层。
 *
 * 两条边界共用这一份定义：
 *   主进程 ↔ agent utility 进程（parentPort 信封）
 *   主进程 ↔ renderer（ipcMain / contextBridge）
 * 两边搬运的载荷都是 **pi-protocol 的类型**，我们只定义信封（guideline §三）。
 *
 * sessionId 从第一天就贯穿所有消息：一个 agent runtime 进程要托管 N 个 session，
 * 事后再补这个参数意味着每一处状态读写都要回头改。
 */
import type { SessionPhase, TranscriptProgress } from "@earendil-works/pi-protocol";
import type { PermissionAnswer, PermissionMode } from "./permission.ts";
import type { McpServer, McpServerInfo } from "./mcp.ts";
import type { ModelDecl } from "./provider.ts";
import type { CompactedRecord } from "./session.ts";
import type { CompactionSetting } from "./settings.ts";

export const ipcChannels = {
  providerList: "provider:list",
  providerUpsert: "provider:upsert",
  providerRemove: "provider:remove",
  /** 拖拽排序的落盘：载荷是全量 id 的新顺序 */
  providerReorder: "provider:reorder",
  agentSubmit: "agent:submit",
  agentAbort: "agent:abort",
  /** 把排队中的某一条**立即**发出：打断当前轮（含正在跑的工具调用），它成为新一轮 */
  agentInterrupt: "agent:interrupt",
  /** 手动压缩上下文（输入框 `/compact`）。结果走 agent:event 的 compaction 链 */
  agentCompact: "agent:compact",
  agentSetMode: "agent:set-mode",
  /** 会话内换模型（C-4）：下一轮生效。结果走 agent:event 的 model / failed 事件 */
  agentSetModel: "agent:set-model",
  agentAnswerPermission: "agent:answer-permission",
  agentEvent: "agent:event",
  workspaceList: "workspace:list",
  /** 打开原生目录选择器并加为工作区 */
  workspaceAdd: "workspace:add",
  workspaceRename: "workspace:rename",
  workspaceRemove: "workspace:remove",
  /** 没有选定工作区时 agent 落在哪儿。渲染层要如实告诉用户这个兜底，不能让它是个隐形默认 */
  workspaceDefault: "workspace:default",
  providerBuiltins: "provider:builtins",
  providerDiscover: "provider:discover",
  providerTest: "provider:test",
  providerReveal: "provider:reveal",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  sessionList: "session:list",
  sessionLoad: "session:load",
  sessionRename: "session:rename",
  sessionPin: "session:pin",
  sessionArchive: "session:archive",
  /** 换归属工作区；null = 移出所有工作区，回到 TASKS */
  sessionMove: "session:move",
  /**
   * 从某条 agent 回答另起一支（C-2）：保留该回答及之前的全部，开出一条新会话。
   * 返回新会话 id；对不上账（罕见落账漂移）时以错误拒绝——宁可不分支，不切错位置。
   */
  sessionBranch: "session:branch",
  /** 导出成 Markdown，走原生保存对话框；取消返回 null */
  sessionExport: "session:export",
  sessionDelete: "session:delete",
  /** 中心存储里的全部 skill（含没链进任何集合的） */
  skillList: "skill:list",
  /** 把 skill 链进一个集合（global 或某个 workspace）；互斥规则见 SkillScope */
  skillLink: "skill:link",
  /** 把 skill 从一个集合里移出（只删链接，永不碰中心存储） */
  skillUnlink: "skill:unlink",
  /** 清掉一条 skill 的全部断链引用（missing 后的收尾动作） */
  skillClean: "skill:clean",
  /** 导入用户已有目录：主进程开目录选择框，store 条目做成指向真身的 symlink（4-1）。返回 slug，取消返回 null */
  skillImport: "skill:import",
  /** 读详情（已拆成 name / description / 正文）；不存在返回 null */
  skillRead: "skill:read",
  /** 改详情。缺席的字段不动，frontmatter 其它字段原样保留 */
  skillWrite: "skill:write",
  /** 在系统文件管理器里揭示该 skill 目录（新建 / 删除走这里，不自建 UI） */
  skillReveal: "skill:reveal",
  /** MCP server 列表与它们此刻的连接状态 */
  mcpList: "mcp:list",
  /** 用系统默认编辑器打开 mcp.json（加减 server 走文件，不做表单） */
  mcpOpenConfig: "mcp:open-config",
  /** 重读 mcp.json 并重连全部 server（已开任务的工具集不变，新任务拿新集） */
  mcpReload: "mcp:reload",
  /** 加一台 server（4-2）：写 mcp.json 后自动重连 */
  mcpAdd: "mcp:add",
  /** 删一台 server（4-2）：写盘后自动重连 */
  mcpRemove: "mcp:remove",
  /** 启停一台 server（4-2）：改 disabled 字段后自动重连 */
  mcpSetDisabled: "mcp:set-disabled",
} as const;

export type IpcChannel = (typeof ipcChannels)[keyof typeof ipcChannels];

/**
 * pi 内建 provider 目录里的一条。目录由 pi 维护、每 4 小时从 pi.dev 刷新覆盖层，
 * 我们零维护——用户选中名字就拿到官方 baseUrl / 协议 / 模型清单。
 */
export interface BuiltinProvider {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  models: BuiltinModel[];
}

/**
 * 目录模型自带的官方参数（费率单位 $ 每百万 token；pi 的分段计价 tiers 剥掉——无消费者）。
 * 只服务设置面的展示与占位：真正建会话时 runtime 直接从 pi 注册表取活值。
 */
export interface BuiltinModel {
  id: string;
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * 一次自动重试的等待态。对话主链路（auto_retry）与压缩/摘要的 LLM 调用
 * （summarization_retry）共用同一份形状。startedAt 由 agent 进程盖时间戳——
 * renderer 据此算活倒数，切走再切回不重启；事件不落盘，旧会话没有历史重试。
 */
export interface RetryStatus {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  /** 等待开始的时刻（epoch ms，agent 进程时钟） */
  startedAt: number;
  errorMessage: string;
}

/**
 * 一条会话到此刻的用量。**pi 的 `SessionStats` 只搬界面要显示的那几项**（D1，2026-09-03）。
 *
 * 为什么不直接透传 pi 的类型：
 * 1. 透传会把 `@earendil-works/pi-coding-agent` 漏进 shared 契约，而 AGENTS.md 的架构边界
 *    写的是「适配层吸收内核差异，换内核时 renderer 不动」。
 * 2. 它要**落盘**（`SessionMeta.stats`）。落盘的形状必须是我们自己拥有、能逐字段校验的，
 *    不能是 pi 随时可能加字段的结构。
 * 3. pi 的 `SessionStats` 里我们只用 3/10 个字段（sessionFile / sessionId / 四个计数都无消费者）。
 *
 * 口径随 pi：跨整条 session 累计，**包含已经被压缩掉的那些历史**——那些 token 是真花了钱的。
 */
export interface AgentStats {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** 累计花费（美元）。provider 没有价目表时是 0——**0 不是免费，是不知道** */
  cost: number;
  /**
   * 上下文占用。**压缩刚做完、下一次模型响应之前 pi 自己也不知道**，那时 `tokens` 是 null，
   * 界面要如实留白而不是显示 0（显示 0 会让人以为上下文被清空了）。
   * `null` 本体 = 连窗口都不知道（pi 的 `contextUsage` 缺席）。
   */
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
}

/**
 * create / setModel 共用的 provider 装配载荷。**明文密钥只在主进程 → agent 进程
 * 这一跳出现，永不进 renderer**——renderer 侧只报 id，主进程负责装配。
 * 内建 id（zai / deepseek…）只靠 apiKey 就够，自建网关必须带 baseUrl / api / models，
 * 否则 pi 不知道往哪发。models 上的可选参数字段是用户覆盖声明（用户 > pi 目录 > 兜底）。
 */
export interface ProviderSecrets {
  id: string;
  api: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  models: ModelDecl[];
}

/**
 * 一轮 agent 调用的完整开工上下文（runtime 无状态化后每次都要带）：
 * pi 只当无状态循环，每轮开 → 跑 → 销毁，「建会话」不再是独立的一步——
 * 原本 create 需要的全部上下文，随每次 submit / interrupt / compact 一起给。
 * renderer 只报 providerId，明文密钥由主进程装配（ProviderSecrets）后发给 agent 进程。
 */
export interface AgentTurnContext {
  sessionId: string;
  cwd: string;
  /** 这条会话属于哪个工作区；null = 不属于任何工作区（侧栏 TASKS 节点下那些）。首次 submit 时主进程用它建 meta */
  workspaceId: string | null;
  /**
   * 续跑 pi 的本子：把它自己的 session 文件路径还给 pi（`SessionManager.open`）；
   * null = 开新本子（`.create`）。
   */
  resume: { piSessionFile: string } | null;
  providerId: string;
  modelId: string;
  mode: PermissionMode;
}

/** 发一轮（renderer → 主进程的载荷） */
export interface SubmitAgentInput extends AgentTurnContext {
  text: string;
}

/** 手动压缩（renderer → 主进程）。压缩是一次真实的 LLM 调用，同样要带全套开工上下文 */
export interface CompactAgentInput extends AgentTurnContext {
  instructions?: string;
}

/** 主进程 → agent 进程 */
export type AgentCommand =
  | {
      /**
       * 开一轮：open（piSessionFile 有值就续，没有就新建）→ prompt → 跑完销毁。
       * 同一会话已在跑时 agent 进程抛 already running。
       */
      type: "submit";
      sessionId: string;
      text: string;
      cwd: string;
      provider: ProviderSecrets;
      modelId: string;
      mode: PermissionMode;
      /**
       * pi 把自己的 session 文件放在哪。**由主进程给**——runtime 不做路径策略决定。
       */
      piSessionDir: string;
      /**
       * 工具永不许写的目录（会话账本 sessions/ 与 pi 的本子 pi-sessions/）。
       * **主进程定，agent 进程只收数据**（同 piSessionDir 的纪律）：tool_call 闸门
       * 在权限档判定**之前**拦——「会话记录不可变」是全档不变量，Skip 也抬不掉。
       */
      protectedPaths: string[];
      /**
       * skill 的链接集合目录（2-1 起是数组：global 恒在，当前工作区再加一条）。
       * **路径由主进程给**（同 `piSessionDir`）：哪个集合对该会话生效是主进程的策略，
       * agent 进程只收数据。目录里是指向中心存储的 symlink，pi 的加载器跟符号链接。
       *
       * 目录不存在不是错，当作一个 skill 都没链（pi 内部先 existsSync 拦一道）。
       */
      skillsDirs: string[];
      /**
       * MCP server 配置。**传解析好的而不是文件路径**：读文件与讲错误是主进程的事
       * （跟 skillsDir 同一条纪律），而且 env 里往往有密钥，路径传过去等于让
       * agent 进程自己去读一份我们已经读过的敏感文件。
       *
       * **连接是进程级的**：同一个 agent 进程里只连一次，后续会话共享已连上的
       * 那批工具——每条会话都拉起一份 `npx some-server` 会让子进程数量随会话线性增长。
       */
      mcpServers: Record<string, McpServer>;
      /** 有值就让 pi 打开这份它自己的 session 文件（续），没有就新建（`SessionManager.open` vs `.create`） */
      piSessionFile?: string;
      /**
       * 自动压缩偏好（A-1）。**主进程从设置装配**，renderer 的开轮载荷不携带；
       * runtime 开轮时按本轮模型的窗口换算成 pi 的 reserveTokens / keepRecentTokens
       * 覆盖进去。缺席（理论上不发生，主进程兜 COMPACTION_DEFAULT）= pi 出厂默认。
       */
      compaction?: CompactionSetting;
    }
  /**
   * 用 text（一条用户消息）异步生成会话标题（C-3）。**结果不当场返回**：标题
   * 生成是一次独立的小 LLM 调用，成功经 `title` 事件回传；失败/模型拒答不发事件，
   * 门禁（meta 的 titleSource 仍是 derived）不变，下一条用户消息自然重试。
   */
  | { type: "generateTitle"; sessionId: string; text: string }
  | { type: "abort"; sessionId: string }
  | {
      /** 立即发送排队中的某一条：abort 当前轮（含正在跑的工具调用）→ 这条作为新一轮 submit */
      type: "interrupt";
      sessionId: string;
      /** 要发的文本。**队列在 renderer 一侧**，这里只负责「停下当前这一轮、发这句话」 */
      text: string;
      cwd: string;
      provider: ProviderSecrets;
      modelId: string;
      mode: PermissionMode;
      piSessionDir: string;
      /** 会话文件不可变（2026-09-18）：主进程定的工具禁区，全档拦截，语义同 submit */
      protectedPaths: string[];
      /** 开轮环境，语义同 submit（skill 集合目录 + MCP 配置）——无状态化后每轮开机都要带全 */
      skillsDirs: string[];
      mcpServers: Record<string, McpServer>;
      piSessionFile?: string;
      /** 自动压缩偏好（A-1），语义同 submit */
      compaction?: CompactionSetting;
    }
  /**
   * 手动压缩。**结果不当场返回**：压缩是一次真实的 LLM 调用，
   * 忙碌态与界碑都走 `compaction_start` / `compaction` 事件那一条链。
   */
  | {
      /** 手动压缩：开（或续）本子 → compact → 销毁。忙碌态与界碑走事件链，不当场返回 */
      type: "compact";
      sessionId: string;
      instructions?: string;
      cwd: string;
      provider: ProviderSecrets;
      modelId: string;
      mode: PermissionMode;
      piSessionDir: string;
      /** 会话文件不可变（2026-09-18）：主进程定的工具禁区，全档拦截，语义同 submit */
      protectedPaths: string[];
      /** 开轮环境，语义同 submit（skill 集合目录 + MCP 配置）——无状态化后每轮开机都要带全 */
      skillsDirs: string[];
      mcpServers: Record<string, McpServer>;
      piSessionFile?: string;
      /** 手动压缩轮不走阈值，但轮内的自动压缩（threshold/overflow）照此生效 */
      compaction?: CompactionSetting;
    }
  | { type: "listBuiltins" }
  /**
   * 重读 mcp.json 后重连（1-1 热重载）。servers 由主进程读好传进来——读文件与
   * 讲错误是主进程的事（与开轮命令里的 mcpServers 同一条纪律）。重连是进程级的：
   * 已开会话的 customTools 在开机时已定格，不受影响；下一轮开机拿新工具集。
   */
  | { type: "mcpReload"; servers: Record<string, McpServer> }
  /** 4-3：主进程对 skillWriteRequest 的回执（同 permissionAnswer 的 requestId 模式） */
  | {
      type: "skillWriteResult";
      requestId: string;
      ok: boolean;
      /** 成功时的中心存储路径 */
      path?: string;
      error?: string;
    }
  /** 4-3：主进程对 mcpWriteRequest 的回执 */
  | {
      type: "mcpWriteResult";
      requestId: string;
      ok: boolean;
      /** 重连后这台 server 的状态（ready / failed …），给模型看连接结果 */
      status?: { kind: "ready" | "failed" | "disabled" | "connecting"; message?: string };
      error?: string;
    }
  /** B-1：主进程对 readTaskRequest 的回执（requestId 问答的第三对） */
  | ({ type: "readTaskResult"; requestId: string } & ReadTaskOutcome)
  | { type: "setMode"; sessionId: string; mode: PermissionMode }
  /**
   * 会话内换模型（C-4）。provider 是主进程装配好的完整载荷（create 同款）。
   * **对正在跑的轮无效**：pi 在轮启动时快照模型，当前轮用旧模型跑完，
   * 下一次 prompt 起新模型。结果不当场返回：成功经 `model` 事件、失败经 `failed` 事件。
   */
  | { type: "setModel"; sessionId: string; provider: ProviderSecrets; modelId: string }
  /**
   * pi 侧分支（C-2）：把源 pi 本子裁一份只含「锚点回答及之前」的新文件。
   * sessionId 是主进程先生成好的**新会话 id**（此刻 record/meta 都还没落盘）。
   * roles 是我们这本账前缀（含锚点）的 user/assistant 角色序列——两本账没有
   * id 映射（pi-ai 的 Message 没有 id），按位对账是唯一桥梁；对不上 runtime
   * 直接抛错。成功经 `created` 事件回传新 pi 文件路径。
   */
  | {
      type: "branch";
      sessionId: string;
      sourcePiSessionFile: string;
      cwd: string;
      roles: readonly ("user" | "assistant")[];
    }
  /** 用户对一次工具审批的回答，按 requestId 对回去 */
  | { type: "permissionAnswer"; requestId: string; answer: PermissionAnswer }
  | { type: "dispose"; sessionId: string };

/**
 * B-1：read_task 读到的「这是一条什么 task」。**只给 UI、不入模型上下文**——
 * 走 pi ToolResult 的 `details` 通路（adapter 对它明写「不入模型上下文，只给
 * UI 与日志」，edit 的 diff 是同款先例）：模型拿 text 全文，renderer 拿它
 * 渲染任务卡与点击跳转（openSession）。
 */
export interface ReadTaskCard {
  /** 被读 task 的 session id。renderer 跳转就跳它 */
  sessionId: string;
  /** 被读 task 的标题；空标题（一条消息都没发过）由调用方填占位 */
  title: string;
  /** briefing = 头部 + 目录 + 最近轮全文；rounds = 指定轮全文 */
  mode: "briefing" | "rounds";
  /** rounds 模式下模型给的轮号串（原样回显，卡片副标用） */
  rounds?: string;
  /** 目标 task 的 user 轮总数 */
  roundCount: number;
}

/** readTaskRequest 的回执载荷：主进程组装，agent 进程翻成工具结果。 */
export type ReadTaskOutcome =
  | { ok: true; card: ReadTaskCard; text: string }
  | { ok: false; error: string };

/** agent 进程 → 主进程 → renderer（同一份形状，主进程只做转发） */
export type AgentEvent =
  | { type: "ready" }
  | { type: "builtins"; providers: BuiltinProvider[] }
  /**
   * MCP 连接结果。**没有 sessionId**：连接是进程级的，不属于哪一条会话。
   * 主进程接住它当缓存，管理面查的就是这份快照（连接状态是运行时事实，不落盘）。
   */
  | { type: "mcp"; servers: McpServerInfo[] }
  /**
   * 4-3：agent 工具 create_skill 的写盘请求。**写盘在主进程**（agent 进程
   * 不碰 userData）——主进程调 SkillStore 后回 skillWriteResult。
   * scope 的 workspace 一侧由主进程按会话归属解析（agent 不知道 workspaceId）。
   */
  | {
      type: "skillWriteRequest";
      requestId: string;
      sessionId: string;
      slug: string;
      name: string;
      description: string;
      body: string;
      scope: "global" | "workspace";
    }
  /** 4-3：agent 工具 add_mcp_server 的写盘请求（MCP 无 workspace 语义） */
  | {
      type: "mcpWriteRequest";
      requestId: string;
      name: string;
      server: McpServer;
    }
  /**
   * B-1：agent 工具 read_task 的读盘请求。**读在主进程**（agent 进程不碰
   * userData，skillWriteRequest 的同一条边界）：主进程解析引用 → 读
   * SessionStore → 组简报 → 回 readTaskResult。rounds 缺席 = 简报
   * （目录 + 最近轮全文）；有值 = 只取目录里那些轮号的全文。
   */
  | { type: "readTaskRequest"; requestId: string; sessionId: string; task: string; rounds?: string }
/**
 * 4-3：skills 磁盘状态变了（主进程写完广播）。Skills 面板开着就刷新——
 * 没有 sessionId：归属是全局事实，不属于哪条会话（同 mcp 事件）。
 */
| { type: "skillsChanged" }
  /** piSessionFile：pi 这一次用的那份 session 文件，主进程要把它记进会话 meta 里 */
  | { type: "created"; sessionId: string; piSessionFile: string | null }
  | { type: "progress"; sessionId: string; progress: TranscriptProgress }
  /**
   * 模型生成的会话标题（C-3 的 `generateTitle` 命令翻译而来）。**只在成功时发**：
   * 主进程落 meta（title + titleSource = auto）并转给 renderer 刷新侧栏；失败静默，
   * 侧栏保留首句截断。
   */
  | { type: "title"; sessionId: string; title: string }
  /**
   * 会话内模型切换成功（C-4 的 `setModel` 命令翻译而来）。主进程落 meta
   * （providerId / modelId——分支继承与重开恢复都读它）并转给 renderer 对齐
   * 模型显示与新任务默认。失败不发本事件（`failed` 事件说明原因），meta 不动。
   */
  | { type: "model"; sessionId: string; providerId: string; modelId: string }
  | { type: "phase"; sessionId: string; phase: SessionPhase }
  /**
   * 一份会话用量快照（token 分项 / 花费 / 上下文余量）。推送粒度与 pi 的数据粒度对齐
   * ——usage 跟着每次 LLM 响应落地，所以每条 assistant 消息完成（message_end）推一次；
   * 建会话后、每轮落定、压缩结束再各兜一次。单条消息流式期间 usage 还没回来，不推。
   * contextUsage.tokens 压缩后到下一次 LLM 响应前是 null，UI 如实显示未知。
   */
  | {
      type: "stats";
      sessionId: string;
      stats: AgentStats;
      /**
       * 这一帧该不该落盘（A1-Q1）。
       *
       * **推送很密、落盘很稀是故意的**：界面要跟着每条消息走（`message_end`），
       * 而磁盘只需要「上一次跑完时的快照」。不分的话，一轮 30 个工具就是 30 次原子写。
       * 缺席 = 只给界面看，recorder 不落盘。
       */
      persist?: true;
    }
/**
 * 上下文压缩完成，附边界记录（摘要 + tokensBefore）。pi 只经 `compaction_end`
 * 事件暴露压缩，摘要不在任何 TranscriptItem 里——我们在这里把它变成一条落盘的界碑。
 */
  | { type: "compaction"; sessionId: string; record: CompactedRecord }
  /**
   * 自动重试进行态（pi 的 auto_retry_* / summarization_retry_* 翻译而来）。
   * status 非 null = 正在等下一次重试；null = 清除。纯 ephemeral，不落盘。
   * 清除信号**不依赖本事件**：重试尝试真正开跑时 pi 会再发一次 agent_start，
   * runtime 翻成 phase 事件，renderer 的重试槽随任何 phase 事件一并清空（自愈）。
   */
  | { type: "retry"; sessionId: string; status: RetryStatus | null }
  /** 工具执行前的请示。UI 要显示它并等用户回答（三档模式见 shared/permission.ts） */
  | {
      type: "permission";
      sessionId: string;
      requestId: string;
      toolName: string;
      input: unknown;
    }
  /**
   * 回合级失败的标记（如重试耗尽）：true = 这一轮没跑成，renderer 把文案标注进
   * 该会话的槽、挂在这轮没送出去的消息下面（转录末尾）；缺省 = 操作级失败
   * （建会话 / 压缩 / 分支对账拒绝），仍报在输入框上方的全局红字里。
   */
  | { type: "failed"; sessionId: string | null; message: string; turn?: true };
