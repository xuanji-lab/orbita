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
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import type { SessionPhase, TranscriptProgress } from "@earendil-works/pi-protocol";
import type { PermissionAnswer, PermissionMode } from "./permission.ts";
import type { ModelDecl } from "./provider.ts";
import type { CompactedRecord } from "./session.ts";

export const ipcChannels = {
  providerList: "provider:list",
  providerUpsert: "provider:upsert",
  providerRemove: "provider:remove",
  agentCreate: "agent:create",
  agentSubmit: "agent:submit",
  agentAbort: "agent:abort",
  /** 编辑排队中的消息：promote = 转插队（steer），cancel = 移出队列 */
  agentQueueEdit: "agent:queue-edit",
  /** 手动压缩上下文（输入框 `/compact`）。结果走 agent:event 的 compaction 链 */
  agentCompact: "agent:compact",
  agentSetMode: "agent:set-mode",
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

/** 主进程 → agent 进程 */
export type AgentCommand =
  | {
      type: "create";
      sessionId: string;
      cwd: string;
      /** provider 装配参数。内建 id（zai / deepseek…）只靠 apiKey 就够，
       *  自建网关必须带 baseUrl / api / models，否则 pi 不知道往哪发。
       *  models 上的可选参数字段是用户覆盖声明（用户 > pi 目录 > 兜底）。 */
      provider: {
        id: string;
        api: string;
        baseUrl: string;
        apiKey: string;
        headers?: Record<string, string>;
        models: ModelDecl[];
      };
      modelId: string;
      mode: PermissionMode;
      /**
       * pi 把自己的 session 文件放在哪。**由主进程给**——runtime 不做路径策略决定。
       */
      piSessionDir: string;
      /** 有值就让 pi 打开这份它自己的 session 文件（续），没有就新建（`SessionManager.open` vs `.create`） */
      piSessionFile?: string;
    }
  | { type: "submit"; sessionId: string; text: string }
  | { type: "abort"; sessionId: string }
  /**
   * 编辑 pi 的排队消息（pi 没有单条删/挪的 API，runtime 用 clearQueue + 重放实现）。
   * index 指 `[...steering, ...followUp]` 拼接视图的下标（UI 就是按这个顺序渲染的）；
   * text 是期望文本，与队列现状不符时（投递/并发编辑刚发生）操作落空、队列原样重放，
   * 等 queue 事件校准 UI。promote 只对 followUp 段有效——steering 段的项已在插队，no-op。
   * edit 改写目标条目的文本（保持它原属的队列与顺位），newText 为替换文本。
   */
  | {
      type: "queueEdit";
      sessionId: string;
      op: "promote" | "cancel" | "edit";
      index: number;
      text: string;
      newText?: string;
    }
  /**
   * 手动压缩。**结果不当场返回**：压缩是一次真实的 LLM 调用，
   * 忙碌态与界碑都走 `compaction_start` / `compaction` 事件那一条链。
   */
  | { type: "compact"; sessionId: string; instructions?: string }
  | { type: "listBuiltins" }
  | { type: "setMode"; sessionId: string; mode: PermissionMode }
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

/** agent 进程 → 主进程 → renderer（同一份形状，主进程只做转发） */
export type AgentEvent =
  | { type: "ready" }
  | { type: "builtins"; providers: BuiltinProvider[] }
  /** piSessionFile：pi 这一次用的那份 session 文件，主进程要把它记进会话 meta 里 */
  | { type: "created"; sessionId: string; piSessionFile: string | null }
  | { type: "progress"; sessionId: string; progress: TranscriptProgress }
  | { type: "phase"; sessionId: string; phase: SessionPhase }
  /**
   * 一份会话用量快照（token 分项 / 花费 / 上下文余量）。推送粒度与 pi 的数据粒度对齐
   * ——usage 跟着每次 LLM 响应落地，所以每条 assistant 消息完成（message_end）推一次；
   * 建会话后、每轮落定、压缩结束再各兜一次。单条消息流式期间 usage 还没回来，不推。
   * contextUsage.tokens 压缩后到下一次 LLM 响应前是 null，UI 如实显示未知。
   */
  | { type: "stats"; sessionId: string; stats: SessionStats }
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
  /**
   * 排队消息快照（pi 的 queue_update 翻译）。**全量**：每次入队、投递、清队后 pi 都重发整份，
   * renderer 直接覆盖槽里的值即可，不做增量合并。steering = 已插队、等当前轮的工具边界注入；
   * followUp = 等本轮结束作为下一轮投递。纯 ephemeral，不落盘。
   */
  | {
      type: "queue";
      sessionId: string;
      steering: readonly string[];
      followUp: readonly string[];
    }
  /** 工具执行前的请示。UI 要显示它并等用户回答（三档模式见 shared/permission.ts） */
  | {
      type: "permission";
      sessionId: string;
      requestId: string;
      toolName: string;
      input: unknown;
    }
  | { type: "failed"; sessionId: string | null; message: string };

export interface CreateAgentInput {
  cwd: string;
  /**
   * 续一条已有会话：**沿用它的 id**（新消息接着写进同一份记录），
   * 并把 pi 自己那份 session 文件还给 pi。null = 开新的一条。
   */
  resume: { sessionId: string; piSessionFile: string } | null;
  /** 这条会话属于哪个工作区；null = 不属于任何工作区（侧栏 TASKS 节点下那些） */
  workspaceId: string | null;
  providerId: string;
  modelId: string;
  mode: PermissionMode;
}
