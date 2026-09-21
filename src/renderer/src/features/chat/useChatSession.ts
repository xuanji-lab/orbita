import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { selectTranscript } from "@earendil-works/pi-coding-agent/client";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { api } from "../../api";
import {
  EMPTY_ENTRY,
  dequeue,
  applyAgentEvent,
  enqueue,
  createSessionStates,
  moveQueued as moveQueuedIn,
  parseCompactCommand,
  removeApproval,
  nextDeliverable,
  removeSessionEntry,
  seedFromDisk,
  setEntryPhase,
  type PendingApproval,
  type QueuedMessage,
  type SessionEntry,
  type SessionStates,
} from "./session-states.ts";
import { LOADING, READY, failed, type LoadState } from "./load-state.ts";
import { createProgressCoalescer } from "./progress-coalescer.ts";
import { recordToolFrame } from "./tool-results.ts";
import { appendWithdrawn } from "./withdraw-draft.ts";
import { recordAssistantStart } from "./stats-format.ts";
import type { PermissionAnswer, PermissionMode } from "@shared/permission";
import type { ThinkingLevel as PiThinkingLevel } from "@earendil-works/pi-protocol";
import { isThinkingLevel, type ThinkingLevel } from "@shared/thinking";
import type { AgentEvent, AgentStats, RetryStatus, SubmitAgentInput } from "@shared/agent-ipc";
import type { ProviderDto } from "@shared/provider";
import { usableProviders } from "../settings/model-menu";
import {
  CLOSING_SCAN_PROMPT,
  CLOSING_SCAN_TIMEOUT_MS,
  collectScanAnswer,
  locateMessageRange,
  parseCarryoverResponse,
  scanTurnModel,
  type CarryoverDraft,
} from "./carryover-parse.ts";
import { buildCarryoverFollowUp, buildCarryoverSeed } from "./carryover-resume.ts";
import type { Carryover, CompactedRecord, SessionCompletion, SessionMeta } from "@shared/session";
import type { Workspace } from "@shared/workspace";

/**
 * 会话状态。**逻辑原样自 ChatView 上提**，一行未改语义——上提的唯一理由是
 * app shell 里左栏（会话列表 / 工作区）与中卡（聊天面）需要读同一份状态，
 * 而它们在 DOM 上是兄弟，状态没法再留在中卡里。
 *
 * transcript / phase / 审批**按会话分槽**（session-states.ts）：事件无条件进自己的槽，
 * 切走正在跑的会话不再丢更新——「看哪条」只是显示问题，不再决定「记不记」。
 * transcript 归约仍是 **pi 自带的归约器**，我们不写第二份归约逻辑（guideline §三）。
 *
 * ## 引擎 + 查看槽（right-drawer-X 拆分，2026-09-11）
 *
 * 右抽屉要**并排**看另一条会话，「正在看」从单份变成两份（主槽 + 抽屉槽）。
 * 原来一只大 hook 里的状态按归属拆成两层：
 *
 * - **引擎**（`useChatSessionEngine`）：与「正在看哪条」无关的共享真源——事件泵、
 *   分槽状态、会话/工作区列表、会话级意图账本。全应用只有一份。
 * - **查看槽**（`useSessionView`）：某个「正在看」的全部——session id、草稿、
 *   模型/权限档意图、绑住本槽的 send/stop/…。主槽与抽屉槽各一份，互不串。
 *
 * 拆分与无状态 runtime（submit 每轮带全套开工上下文）是一体的：引擎持有
 * `buildTurn` 与会话级意图账本（它们按会话 id 记账，天然多槽安全）；
 * 查看槽的每轮 submit 显式带上自己槽内的 model / mode / cwd。
 */
export interface ChatSession {
  sessionId: string | null;
  transcript: readonly TranscriptItem[];
  /** 压缩界碑（与 transcript 分开记账）；显示时由 applyCompactionBoundary 合成 */
  compactions: readonly CompactedRecord[];
  /** turn = 这一轮还在跑；compaction = 上下文压缩中；idle = 可以发下一句 */
  phase: "idle" | "turn" | "compaction";
  /** 自动重试等待态：非 null 时重试行替换 Responding（或补在压缩行下） */
  retry: RetryStatus | null;
  /**
   * 回合级失败标注（重试耗尽）：渲染在转录末尾——这轮没送出去的那条用户消息下面。
   * 新一轮开跑自动清除。操作级失败（建会话 / 压缩 / 分支被拒）仍在 error 上。
   */
  turnError: string | null;
  /**
   * 最近一次用量快照（token / 花费 / 上下文余量），每轮落定时由 runtime 推来。
   * null = 还没有：纯浏览的旧会话不起 runtime session，等说话唤醒后才有数字。
   */
  stats: AgentStats | null;
  /**
   * 按 id 查某条会话的运行态（槽里有真相）。侧栏每行要显示**它自己**的转圈/完成，
   * 与「当前看哪条」无关——后台在跑的会话切走了也照样转圈。
   */
  phaseOf: (id: string) => SessionEntry["phase"];
  /** 按 id 查回合失败标注（槽里有真相）——侧栏失败图标用，与「当前看哪条」无关 */
  turnErrorOf: (id: string) => string | null;
  error: string | null;
  /** 当前查看会话的输入框草稿——**按会话隔离**，切换 / 新开会话互不带走 */
  draft: string;
  /** 写当前查看会话的草稿 */
  setDraft: (value: string) => void;
  mode: PermissionMode;
  changeMode: (next: PermissionMode) => void;
  /** 当前查看会话的思考档（意图；clamp 真值经事件自动纠） */
  thinkingLevel: ThinkingLevel;
  changeThinkingLevel: (next: ThinkingLevel) => void;
  /** 模型支持的思考档（开轮事件回的真值）。null = 还没开过轮，未知 */
  thinkingSupported: readonly PiThinkingLevel[] | null;
  approvals: PendingApproval[];
  /** 侧栏列的工作区（落盘、跨会话）。 */
  workspaces: Workspace[];
  addWorkspace: () => void;
  renameWorkspace: (id: string, name: string) => void;
  removeWorkspace: (id: string) => void;
  /**
   * 这个任务实际跑在哪儿。**null = 没选，落在 `defaultCwd`**——
   * 工作区与「这一单用哪个目录」是两件事：New task 建的是不属于任何工作区的任务，
   * 点工作区的 + 建的才是这个工作区里的任务。
   */
  cwd: string | null;
  /** 这个任务属于哪个工作区；与 cwd 永远同进同出 */
  workspaceId: string | null;
  /** 没选工作区时的兜底（今天是 home）。UI 必须如实显示它，不能让它是个隐形默认。 */
  defaultCwd: string;
  /** 至少声明了一个模型且**配置好**（有密钥，能真正发起请求）的 provider——没有它就发不出消息 */
  usable: ProviderDto[];
  /**
   * 当前模型的意图：新任务的默认，也是会话内切换（C-4）的目标。
   * 活会话切换成功后由 `model` 事件回环对齐——不乐观，失败时 chip 不动。
   */
  model: { providerId: string; modelId: string } | null;
  chooseModel: (providerId: string, modelId: string) => void;
  /** 立刻压一次上下文（用量菜单里那一项）。只在 phase 为 idle 时可用 */
  compact: () => void;
  /** 落盘的会话列表，新的在前。侧栏 TASKS 节点列的就是它。 */
  sessions: SessionMeta[];
  /**
   * 两份列表各自读到哪一步了。**读失败不等于空**（D-3）：
   * 失败时 `sessions` / `workspaces` 保留上一份，错误由这里带出去，侧栏原地显示并给重试。
   */
  loads: { sessions: LoadState; workspaces: LoadState };
  reloadSessions: () => void;
  reloadWorkspaces: () => void;
  /** 会话列表的第一读是否已落定（首页会话卡的骨架态只在这一读期间显示） */
  sessionsLoaded: boolean;
  /** 正在从磁盘恢复某条会话的历史（openSession 的 load 在途） */
  loadingHistory: boolean;
  /**
   * 正在看/正在续的那条会话（从磁盘打开的）。
   * **打开就把它的 transcript 种进状态**，所以聊天面不需要第二条渲染路径——
   * 续上之后新消息接着往下追加，自然衔接。
   */
  opened: SessionMeta | null;
  /**
   * 这条会话只能读不能续：pi 没有它的本子（本功能之前存的，或那份被删了）。
   * 界面要如实说出来，不能让输入框看起来能打字（guideline §四写明的代价）。
   */
  readOnly: boolean;
  openSession: (id: string) => Promise<void>;
  /** 改名。空名字会退回从第一条用户消息推导——侧栏不留看不见的行 */
  renameSession: (id: string, title: string) => void;
  pinSession: (id: string, pinned: boolean) => void;
  /** 星标：价值标记，与置顶正交——不置顶，只给侧栏标识与筛选 */
  starSession: (id: string, starred: boolean) => void;
  /**
   * 完成状态：done / done_with_todos 记关闭时刻，reopen（回 open）清空。
   * 纯 meta 操作——不碰 transcript、不起 runtime，只读会话同样可用。
   */
  setCompletionSession: (id: string, completion: SessionCompletion) => void;
  /** 把所有已完成且未归档的会话批量归档（清理动作，一次计算目标、一次刷新） */
  archiveDoneSessions: () => void;
  /**
   * 遗留事项（收尾仪式收割）：全部记录，真源在主进程 carryovers.jsonl，
   * 这里只是缓存。角标、面板与「Has todos」筛选都从它现算。
   */
  carryovers: readonly Carryover[];
  /** 刷新遗留事项缓存（创建 / 翻转后由各写操作自动带上） */
  refreshCarryovers: () => void;
  /** 翻转一条遗留事项的状态（面板勾选） */
  setCarryoverStatus: (id: string, status: Carryover["status"]) => void;
  /**
   * 方案 A：以一条遗留事项为种子**新开一单**带上下文开工（面板「Continue with
   * context」）。cwd / 归属跟随来源会话；完成与否不回写——勾选办结留给用户手动。
   */
  startCarryoverTask: (item: Carryover) => void;
  /**
   * 方案 B：以遗留事项为用户消息**续跑原会话**（同一个按钮的右键备选；
   * 来源会话无 pi 本子时面板不提供入口）。在跑就排队，闲着就无状态续跑。
   */
  continueCarryoverInSource: (item: Carryover) => void;
  /** 归档：从主列表移走，**不是删除** */
  archiveSession: (id: string, archived: boolean) => void;
  moveSession: (id: string, workspaceId: string | null) => void;
  /**
   * 从某条 agent 回答另起一支（C-2）：新会话 = 该回答及之前的全部，原会话不动
   * （在跑的话照跑，槽里继续涨）。成功后切过去；两本账对不上时主进程以错误拒绝，
   * 报到 error 上——宁可不分支，不切错位置。
   */
  branchFrom: (anchorItemId: string) => void;
  /** 导出成 Markdown；取消时什么都不做 */
  exportSession: (id: string) => void;
  removeSession: (id: string) => void;
  /**
   * —— 收尾仪式（carryover）——
   * 依次是：发起扫描（注入内部 prompt）、扫描中标记、待确认清单、确认 / 取消、
   * 降级提示。详见 useSessionView 里 closingScan 的注释。
   */
  /** 当前查看会话的扫描进行态：按钮转圈与禁用的依据 */
  closingScan: boolean;
  /** 扫描完成待确认的清单；正在查看发起会话时在 footer 显示确认卡 */
  scanResult: { sessionId: string; drafts: CarryoverDraft[] } | null;
  /** 点「Mark task done」：正常路径发扫描，只读（无 pi 本子）降级为纯标记 */
  startClosingRitual: () => void;
  /** 确认清单：勾选项落盘 + setCompletion(done_with_todos)；全不勾 = done */
  confirmCarryovers: (picked: readonly CarryoverDraft[]) => void;
  /** 取消（已过二次确认）：丢弃清单，setCompletion(done) */
  cancelCarryovers: () => void;
  /** 扫描降级 / 结果的一句反馈；下一次发起扫描或打开会话时清 */
  scanNotice: string | null;
  /**
   * 读不懂扫描结果时的重试（重发同一条扫描消息）。null = 没有可重试的失败。
   * 解析失败不再只留一句「已标完成」就完事——那是把失败变成死胡同。
   */
  retryClosingScan: (() => void) | null;
  send: () => void;
  /** 打断当前这一轮。pi 的 abort 走的是与工具审批不同的一条路，不需要等审批答复 */
  stop: () => void;
  /** 排队队列（当前槽），按显示顺序。唯一真源，操作一律按 id */
  queued: readonly QueuedMessage[];
  /** 立即发送：停下当前这一轮，把这条作为新一轮发出去 */
  sendQueuedNow: (id: string) => void;
  /** 撤回：移出队列，文字落回 composer 草稿 */
  withdrawQueued: (id: string) => void;
  /** 拖拽排序：把 sourceId 放到 targetId 的前 / 后 */
  moveQueuedTo: (sourceId: string, targetId: string, placement: "before" | "after") => void;
  /** 不属于任何工作区的新任务：落在 defaultCwd */
  newTask: () => void;
  /** 这个工作区里的新任务：cwd 与 workspaceId 一起按它填好 */
  newTaskIn: (workspace: Workspace) => void;
  answerApproval: (requestId: string, answer: PermissionAnswer) => void;
}

/** 查看槽回踩引擎用的窄接口——避免引擎与视图互相持有完整类型 */
interface ViewHandle {
  readonly sessionRef: Readonly<{ current: string | null }>;
  /** model 事件回环对齐（C-4）：只对齐正看着那条会话的槽 */
  alignModel(event: { providerId: string; modelId: string }): void;
  alignThinking(event: { level: PiThinkingLevel }): void;
  /** 正在看/正打开的那条被删了：本槽退回首页 */
  handleRemoved(id: string): void;
  /** 正开着的那条换了归属工作区：meta 与作用域芯片跟着变 */
  handleMoved(id: string, targetWorkspaceId: string | null): void;
  /** 工作区被移出：本槽的新任务不再落在这个工作区 */
  handleWorkspaceRemoved(id: string): void;
  /** 会话列表刷新后同步「正开着的那条」的 meta（改名 / 模型标题要能换掉顶栏） */
  syncOpened(list: readonly SessionMeta[]): void;
}

/**
 * 引擎——与「正在看哪条」无关的共享真源。全应用一份，主槽与抽屉槽都从它读。
 */
export interface SessionEngine {
  /** 分槽状态（渲染值）。查看槽从这里按自己的 session id 取 entry。 */
  readonly states: SessionStates;
  /** 已挂载的查看槽名册：model 事件路由 / 删除通知 / meta 同步按它来 */
  readonly views: Set<ViewHandle>;
  /** 与 states 同步的镜像（见 statesRef 的历史注释，引擎内即时写） */
  readonly statesRef: Readonly<{ current: SessionStates }>;
  /** 幂等应用一次状态变更（并同步镜像）——查看槽的队列操作走这里 */
  applyStates(fn: (prev: SessionStates) => SessionStates): void;
  /**
   * 各槽把自己的 UI 选择推进引擎的投递兜底：deliverNext 对拿不到会话级意图
   * 与 meta 的新会话（极少：排队首条发出时 meta 已落盘），只能拿「最近的 UI 选择」。
   */
  syncIntent(patch: {
    model: { providerId: string; modelId: string } | null;
    mode: PermissionMode;
    thinkingLevel: ThinkingLevel;
    cwd: string | null;
    workspaceId: string | null;
  }): void;
  /** 会话级意图账本（按会话 id 记账）——查看槽写入，openSession 读 */
  readonly sessionIntent: Readonly<{
    current: ReadonlyMap<
      string,
      {
        mode?: PermissionMode;
        model?: { providerId: string; modelId: string };
        thinkingLevel?: ThinkingLevel;
      }
    >;
  }>;
  rememberSessionIntent(
    id: string,
    patch: {
      mode?: PermissionMode;
      model?: { providerId: string; modelId: string };
      thinkingLevel?: ThinkingLevel;
    },
  ): void;
  /**
   * 组装无状态开工上下文（AgentTurnContext 的主体）：meta 真值（cwd / 归属 /
   * pi 本子）+ 会话级意图。拿不出可用上下文时把错误写进引擎 error 并返回 null。
   */
  buildTurn(id: string): Omit<SubmitAgentInput, "sessionId" | "text"> | null;
  readonly setError: (error: string | null) => void;
  readonly error: string | null;
  readonly refreshSessions: () => void;
  readonly refreshWorkspaces: () => void;
  readonly workspaceFailed: (cause: unknown) => void;
  readonly sessions: SessionMeta[];
  readonly loads: { sessions: LoadState; workspaces: LoadState };
  readonly reloadSessions: () => void;
  readonly reloadWorkspaces: () => void;
  readonly sessionsLoaded: boolean;
  readonly workspaces: Workspace[];
  readonly renameWorkspace: (id: string, name: string) => void;
  readonly removeWorkspace: (id: string) => void;
  readonly defaultCwd: string;
  readonly usable: ProviderDto[];
  readonly phaseOf: (id: string) => SessionEntry["phase"];
  readonly turnErrorOf: (id: string) => string | null;
  readonly answerApproval: (requestId: string, answer: PermissionAnswer) => void;
  readonly renameSession: (id: string, title: string) => void;
  readonly pinSession: (id: string, pinned: boolean) => void;
  readonly starSession: (id: string, starred: boolean) => void;
  readonly setCompletionSession: (id: string, completion: SessionCompletion) => void;
  readonly archiveDoneSessions: () => void;
  readonly carryovers: readonly Carryover[];
  readonly refreshCarryovers: () => void;
  readonly setCarryoverStatus: (id: string, status: Carryover["status"]) => void;
  readonly archiveSession: (id: string, archived: boolean) => void;
  readonly moveSession: (id: string, workspaceId: string | null) => void;
  readonly exportSession: (id: string) => void;
  readonly removeSession: (id: string) => void;
}

export function useChatSessionEngine(providers: ProviderDto[]): SessionEngine {
  /** 全部会话的槽；「当前看哪条」由各查看槽自己持有（sessionId ?? opened?.id） */
  const [states, setStates] = useState<SessionStates>(createSessionStates);
  /**
   * states 的同步镜像。事件回调（自动重发缓冲、send 查压缩态）要在 setStates 之外
   * 读最新值——闭包里的 states 是渲染时的旧值。在 setStates 的 updater 里同步：
   * 幂等（重复赋同一个 next），换掉effect 方案是因为 effect 晚一拍，连发两个
   * phase 事件时第二个会拿旧值重发已被清空的缓冲。
   */
  const statesRef = useRef<SessionStates>(states);
  const [error, setError] = useState<string | null>(null);
  /** agent 能看到的文件夹。**session 的 cwd 在创建时固定**，所以换工作区 = 换会话。 */
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loads, setLoads] = useState<{ sessions: LoadState; workspaces: LoadState }>({
    sessions: LOADING,
    workspaces: LOADING,
  });
  /** 会话列表第一读是否已落定：从 loads 派生（首页骨架态用）。 */
  const sessionsLoaded = loads.sessions.kind !== "loading";
  /** 已挂载的查看槽。事件泵按它路由 model 事件，删除/移动会话按它通知各槽。 */
  const views = useRef<Set<ViewHandle>>(new Set());
  const [defaultCwd, setDefaultCwd] = useState<string>("");
  /**
   * 遗留事项缓存（收尾仪式的真源在主进程 carryovers.jsonl）。挂在引擎是因为它的
   * 消费者是侧栏（角标 / 面板）与会话头部（清单确认），两处都从引擎读——与
   * sessions 同一条纪律。读失败保留上一份，不伪造成空（D-3 同款）。
   */
  const [carryovers, setCarryovers] = useState<readonly Carryover[]>([]);
  const refreshCarryovers = useCallback(() => {
    void api.session.carryoverList().then(setCarryovers).catch((cause: unknown) =>
      console.error("[carryover] 列表读不了", cause),
    );
  }, []);
  useEffect(refreshCarryovers, [refreshCarryovers]);

  /**
   * **同步读-改-写**：先算 next、同步落 ref、再 setStates。不用
   * `setStates((prev) => { ...; statesRef.current = next; return next; })`——
   * updater 要到渲染阶段才跑，紧接着的同步读（deliverNext / 连发两个事件时
   * 第二个的入队判定）拿到的是上一拍，排队卡「停止后不投递 / 两条一起飞」
   * 就是这个滞后（B4 修）。所有需要紧跟同步读的写入都走这里。
   */
  const applyStates = useCallback((f: (prev: SessionStates) => SessionStates): void => {
    const next = f(statesRef.current);
    statesRef.current = next;
    setStates(next);
  }, []);

  /**
   * 会话 meta 真值的 ref 镜像（refreshSessions 灌入）。无状态 submit 每轮都要
   * 带 cwd / 归属 / pi 本子——它们是**会话固定**的，以 meta 为准而不是当前的
   * 工作区选择（用户切了工作区再对旧会话发消息，工具目录不能跟着变）。
   * 事件路径（deliverNext 等 useCallback([]) 的回调）闭包里读不到 state，走 ref。
   */
  const sessionsRef = useRef<SessionMeta[]>([]);

  /**
   * 无状态开工的**投递兜底**：deliverNext 给后台会话投递排队项时，会话级意图与
   * meta 通常已经够用；新会话（meta 还没落盘）只能拿「最近的 UI 选择」。
   * 各查看槽把自己的选择推进来（`syncIntent`），双槽下它等于最近一次任一槽的选择
   * ——与单槽时代「当前查看的 UI」语义同源。defaultCwd 由引擎自己同步。
   */
  const intentRef = useRef<{
    model: { providerId: string; modelId: string } | null;
    mode: PermissionMode;
    thinkingLevel: ThinkingLevel;
    cwd: string | null;
    workspaceId: string | null;
    defaultCwd: string;
  }>({ model: null, mode: "plan", thinkingLevel: "medium", cwd: null, workspaceId: null, defaultCwd: "" });
  useEffect(() => {
    intentRef.current.defaultCwd = defaultCwd;
  }, [defaultCwd]);
  const syncIntent = useCallback(
    (patch: {
      model: { providerId: string; modelId: string } | null;
      mode: PermissionMode;
      thinkingLevel: ThinkingLevel;
      cwd: string | null;
      workspaceId: string | null;
    }): void => {
      Object.assign(intentRef.current, patch);
    },
    [],
  );

  /**
   * **会话级意图**：用户在哪条会话上改的档位 / 模型，就记在哪条名下。
   *
   * 查看槽的 UI 意图跟着「你正在看哪条」走（`openSession` 会把 mode / model 改成
   * 被查看会话的值）；而 `deliverNext` 是**不按「正看着谁」过滤**的，后台会话的
   * 队首照样会投递。两者合起来就是串台：A（plan）跑着且队列非空 → 切去看 B（skip）
   * → A 的轮结束 → A 的排队卡拿着 **B 的权限档与 B 的模型**跑出去。档位决定
   * bash 能不能跑，这是安全边界上的串台。
   *
   * 所以意图必须按会话记账：你在 A 上选的就只给 A。它不需要清——这就是「用户对
   * 这条会话的最新选择」，永远至少和 meta 一样新（闲着时两边会自行收敛）。
   */
  const sessionIntentRef = useRef<
    Map<
      string,
      {
        mode?: PermissionMode;
        model?: { providerId: string; modelId: string };
        thinkingLevel?: ThinkingLevel;
      }
    >
  >(new Map());
  const rememberSessionIntent = useCallback(
    (
      id: string,
      patch: {
        mode?: PermissionMode;
        model?: { providerId: string; modelId: string };
        thinkingLevel?: ThinkingLevel;
      },
    ) => {
      const map = sessionIntentRef.current;
      map.set(id, { ...map.get(id), ...patch });
    },
    [],
  );

  /**
   * 组装无状态开工上下文（AgentTurnContext 的主体）：meta 真值（cwd / 归属 /
   * pi 本子）+ 当前意图（模型 / 档位）。新会话（meta 还没落盘）用投递兜底。
   * 拿不出可用上下文时把错误写进红字并返回 null——调用方直接放弃这一跳。
   */
  const buildTurn = useCallback(
    (id: string): Omit<SubmitAgentInput, "sessionId" | "text"> | null => {
      const intent = intentRef.current;
      if (intent.model === null) {
        setError("Add a provider with at least one model first");
        return null;
      }
      const meta = sessionsRef.current.find((entry) => entry.id === id) ?? null;
      const cwdTarget = meta?.cwd ?? intent.cwd ?? intent.defaultCwd;
      if (cwdTarget === "") {
        setError("Choose a workspace folder first");
        return null;
      }
      /**
       * 档位与模型按**这条会话自己**的账算，不能拿全局意图（= 正看着的那条）：
       *
       *   会话级意图  → 用户在这条会话上改过但还没落进 meta（跑着时改的）
       *   meta      → 落盘的真值
       *   投递兜底  → 全新会话（meta 还不存在），那时 UI 上的选择就是意图
       *
       * cwd / 归属 / pi 本子不走这套——它们是会话固定事实，meta 就是真值。
       */
      const own = sessionIntentRef.current.get(id);
      const model = own?.model ?? (meta === null ? intent.model : { providerId: meta.providerId, modelId: meta.modelId });
      return {
        cwd: cwdTarget,
        workspaceId: meta?.workspaceId ?? intent.workspaceId ?? null,
        resume: meta?.piSessionFile != null ? { piSessionFile: meta.piSessionFile } : null,
        providerId: model.providerId,
        modelId: model.modelId,
        mode: own?.mode ?? meta?.mode ?? intent.mode,
        // 思考档同一条三级链：会话级意图 → meta → 投递兑底（新会话的 UI 选择）
        thinkingLevel: own?.thinkingLevel ?? meta?.thinkingLevel ?? intent.thinkingLevel,
      };
    },
    [],
  );

  /**
   * **读失败不清空。** 以前这里会 `.catch(() => setSessions([]))`，磁盘权限坏了就显示成
   * 「你的会话全没了」。现在失败只记到 `loads` 里，手里那份原样保留。
   * 刷新完通知各查看槽同步「正开着的那条」的 meta——那份真值只在这里读得到。
   */
  const refreshSessions = useCallback(() => {
    void api.session.list().then((list) => {
      setSessions(list);
      sessionsRef.current = list;
      setLoads((prev) => ({ ...prev, sessions: READY }));
      // **正看着的会话的 meta 必须从这里拿真值**——活会话（首页直接开的那条）
      // opened 一路是 null，不种上的话顶栏永远读 transcript 推导的旧标题，
      // 改名与模型标题都换不掉它（真实事故：改名后侧栏变了顶栏不变）。
      for (const view of views.current) view.syncOpened(list);
    }).catch((cause: unknown) => setLoads((prev) => ({ ...prev, sessions: failed(cause) })));
  }, []);

  useEffect(refreshSessions, [refreshSessions]);

  const refreshWorkspaces = useCallback(() => {
    void api.workspace
      .list()
      .then((list) => {
        setWorkspaces(list);
        setLoads((prev) => ({ ...prev, workspaces: READY }));
      })
      .catch((cause: unknown) => setLoads((prev) => ({ ...prev, workspaces: failed(cause) })));
  }, []);

  /**
   * 工作区的**写**操作失败也走列表那行错误。add / rename / remove 都要先把
   * 列表读一遍，所以读不出来时它们一定失败；失败原因跟列表是同一个（权限 / IO），
   * 没必要再开一块新的报错位。
   */
  const workspaceFailed = useCallback(
    (cause: unknown) => setLoads((prev) => ({ ...prev, workspaces: failed(cause) })),
    [],
  );

  /** 用户点了重试：先回到加载态让那一行有反应，再真的去读 */
  const reloadSessions = useCallback(() => {
    setLoads((prev) => ({ ...prev, sessions: LOADING }));
    refreshSessions();
  }, [refreshSessions]);

  const reloadWorkspaces = useCallback(() => {
    setLoads((prev) => ({ ...prev, workspaces: LOADING }));
    refreshWorkspaces();
  }, [refreshWorkspaces]);

  useEffect(refreshWorkspaces, [refreshWorkspaces]);

  useEffect(() => {
    void api.workspace
      .default()
      .then(setDefaultCwd)
      // 兜底目录读不到就不能静默落成 ""——那会让 send 报「先选工作区」，
      // 而真正的原因（磁盘 / 配置坏了）用户永远看不到
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, []);

  /**
   * 投递队首的一条。**一次只发一条**——发完这一轮结束会再来一次 phase 事件，
   * 那时再取下一条。先出队再发：出队是同步的，避免同一拍被投递两次。
   * 与「哪个槽在看」无关：队是按会话分的，事件带着 id 来。
   */
  const deliverNext = useCallback(
    (id: string) => {
      const entry = statesRef.current.get(id);
      if (entry === undefined) return;
      const head = nextDeliverable(entry);
      if (head === null) return;
      applyStates((prev) => dequeue(prev, id, head.id));
      const fail = (cause: unknown): void =>
        setError(cause instanceof Error ? cause.message : String(cause));
      if (head.kind === "compact") {
        const turn = buildTurn(id);
        if (turn === null) return;
        void api.agent
          .compact({ sessionId: id, ...turn, ...(head.instructions !== undefined ? { instructions: head.instructions } : {}) })
          .catch(fail);
      } else {
        const turn = buildTurn(id);
        if (turn === null) return;
        void api.agent.submit({ sessionId: id, text: head.text, ...turn }).catch(fail);
      }
    },
    [applyStates, buildTurn],
  );

  useEffect(() => {
    // 流式帧合帧：progress 的归约是纯函数（廉价），贵的是每次应用触发的渲染。
    // 回答期间 delta 可密到十几毫秒一帧，渲染把主线程挤满，点击与打字只能排在
    // 流式渲染后面——排队卡片点铅笔「时快时慢」的可感延迟根源（2026-09-10）。
    // 按 ~50ms 节拍攒批整批应用，渲染频率封顶，主线程留出空档；
    // phase / queue / permission 等低频且对延迟敏感的事件照旧即时应用。
    const coalescer = createProgressCoalescer<AgentEvent>((batch) => {
      applyStates((prev) => batch.reduce((acc, event) => applyAgentEvent(acc, event), prev));
    }, 50);
    const off = api.agent.onEvent((event) => {
        if (event.type === "failed") {
          // 回合级失败（重试耗尽）进槽、标注在对话里（applyAgentEvent 收）；
          // 操作级失败仍走全局红字（输入框上方）
          if (event.turn !== true) setError(event.message);
          // runtime 整个没了：全部槽归位（归约在 applyAgentEvent 里）。
          // 无状态后没有「活会话集合」要清——在不在跑由 runtime 的 running 表
          // 按真值回答，进程没了它自然空。
        }
        // 新一轮真的跑起来了（重试成功 / 用户重发 / 压缩开始）：上一次的失败已成
        // 过去，红字不再挂着——只有最后状态是失败时才该看到失败提示
        if (event.type === "phase" && event.phase !== "idle") setError(null);
        // 一轮跑完标题与 updatedAt 都变了，刷一次侧栏——**哪条会话跑完都刷**，
        // 后台完成的会话侧栏也该亮起来
        if (event.type === "phase" && event.phase === "idle") refreshSessions();
        // 模型标题到了（C-3，主进程已落 meta）：可能早于整轮结束，不等 phase idle
        if (event.type === "title") refreshSessions();
        // 会话内模型切换成功（C-4，主进程已落 meta）：对齐**正看着那条**的槽——
        // 双槽下事件泵不知道哪个槽在看，路由交给已注册的查看槽
        if (event.type === "model") {
          for (const view of views.current) {
            if (event.sessionId === view.sessionRef.current) {
              view.alignModel(event);
              break;
            }
          }
          refreshSessions();
        }
        // 思考档真值（clamp 后事实）到了：对齐正看着那条的槽，芯片自我纠真
        if (event.type === "thinking") {
          for (const view of views.current) {
            if (event.sessionId === view.sessionRef.current) {
              view.alignThinking(event);
              break;
            }
          }
        }
        // 工具耗时在这里记账（事件必经之路）：组折叠时成员行不渲染，渲染驱动会漏
        if (
          event.type === "progress" &&
          (event.progress.type === "item_started" ||
            event.progress.type === "item_updated" ||
            event.progress.type === "item_finished")
        ) {
          recordToolFrame(event.progress.item);
          // 流式起点在这里记账（stats-format）：Responding 行的估算分母要它，
          // 而归约器只留最后一帧的时间戳。真值不需要——真值在终态帧的 speed 上
          recordAssistantStart(event.progress.item);
        }
        // **不按「正看着谁」过滤**：每个事件进自己会话的槽（分槽的根）
        // 流式帧进合帧器按节拍整批应用（见 effect 开头）；其余事件即时
        if (event.type === "progress") {
          coalescer.push(event);
          return;
        }
        // **先交付攒着的流式帧，再应用这条事件**：否则即时事件会赶超缓冲里的
        // progress，最直接的后果是 phase idle 先于本轮最后一条回答的 item_finished 到达
        // ——「轮结束了但回答还没落地」（收尾扫描解析失败的根因，2026-09-22）。
        // 非 progress 事件本来就是低频的（phase / permission / stats / title / model），
        // 流式期间几乎不出现，这一下 flush 不会把合帧抵消掉。
        coalescer.flush();
        applyStates((prev) => applyAgentEvent(prev, event));
        // **投递节奏归我们**：phase 一变就看队首该不该发，一次只发一条。
        // 交给 pi 的 post-run 自动 drain 会把好几条一起吹出去——用户一条条点、
        // 最后两条自己一起飞，就是那么来的（2026-09-06 事故）。
        if (event.type === "phase") deliverNext(event.sessionId);
      });
    return () => {
      off();
      coalescer.dispose();
    };
  }, [applyStates, deliverNext, refreshSessions]);

  /** 「配置好」的标准与设置面的命名模型菜单同源（model-menu），不各写一份 */
  const usable = useMemo(() => usableProviders(providers), [providers]);

  const answerApproval = useCallback(
    (requestId: string, answer: PermissionAnswer) => {
      applyStates((prev) => removeApproval(prev, requestId));
      void api.agent.answerPermission(requestId, answer);
    },
    [applyStates],
  );

  const removeSession = useCallback(
    (id: string) => {
      void api.session.remove(id).then(() => {
        // 正看着它的槽各自退回首页（主槽 / 抽屉槽都可能正看着）
        for (const view of views.current) view.handleRemoved(id);
        // 槽一并丢——runtime 那头由主进程删文件时同步释放（刀 0-4）
        applyStates((current) => removeSessionEntry(current, id));
        refreshSessions();
      });
    },
    [applyStates, refreshSessions],
  );

  const renameSession = useCallback(
    (id: string, title: string) => {
      // **不做乐观更新**：改成空名字时后端会退回推导，猜不出来。
      // refreshSessions 会把列表与正开着的顶栏一起从真值同步。
      void api.session.rename(id, title).then(refreshSessions);
    },
    [refreshSessions],
  );

  const pinSession = useCallback(
    (id: string, pinned: boolean) => {
      void api.session.pin(id, pinned).then(refreshSessions);
    },
    [refreshSessions],
  );

  const starSession = useCallback(
    (id: string, starred: boolean) => {
      void api.session.star(id, starred).then(refreshSessions);
    },
    [refreshSessions],
  );

  const setCompletionSession = useCallback(
    (id: string, completion: SessionCompletion) => {
      void api.session.setCompletion(id, completion).then(refreshSessions);
    },
    [refreshSessions],
  );

  /** 翻转一条遗留事项的状态（面板勾选）：落盘后刷新缓存，角标与面板跟着真 */
  const setCarryoverStatus = useCallback(
    (id: string, status: Carryover["status"]) => {
      void api.session.carryoverSetStatus(id, status).then(refreshCarryovers);
    },
    [refreshCarryovers],
  );

  /**
   * 批量归档已完成的会话（会话菜单的清理动作）。**循环调既有 archive 通道**
   * 而不是新开批量通道：归档是幂等的单字段写，N 次往返没有原子性问题
   * （最坏部分成功，再点一次即收敛）；新通道要四层同步 + store 批量方法，
   * 而它只有一个消费者，不值。目标从 sessionsRef 真值取（事件回调闭包里的
   * 列表可能是旧的），全部落定后只刷新一次列表。
   */
  const archiveDoneSessions = useCallback(() => {
    const targets = sessionsRef.current.filter(
      (meta) => (meta.completion ?? "open") !== "open" && !meta.archived,
    );
    if (targets.length === 0) return;
    void Promise.all(targets.map((meta) => api.session.archive(meta.id, true))).then(
      refreshSessions,
    );
  }, [refreshSessions]);

  const archiveSession = useCallback(
    (id: string, archived: boolean) => {
      void api.session.archive(id, archived).then(refreshSessions);
    },
    [refreshSessions],
  );

  const moveSession = useCallback(
    (id: string, targetWorkspaceId: string | null) => {
      void api.session.move(id, targetWorkspaceId).then(() => {
        refreshSessions();
        // 正开着的就是这条：底栏那个作用域芯片也要跟着变（各查看槽自己认领）
        for (const view of views.current) view.handleMoved(id, targetWorkspaceId);
      });
    },
    [refreshSessions],
  );

  const exportSession = useCallback((id: string) => {
    void api.session.exportMarkdown(id);
  }, []);

  const renameWorkspace = useCallback(
    (id: string, name: string) => {
      void api.workspace.rename(id, name).then(refreshWorkspaces).catch(workspaceFailed);
    },
    [refreshWorkspaces, workspaceFailed],
  );

  /** 移出列表。**不动磁盘上的文件夹，也不删它的会话**——那些会话落回 TASKS 下。
   *  各查看槽自己认领「新任务不再落在这个工作区」。 */
  const removeWorkspace = useCallback(
    (id: string) => {
      void api.workspace
        .remove(id)
        .then(() => {
          refreshWorkspaces();
          for (const view of views.current) view.handleWorkspaceRemoved(id);
        })
        .catch(workspaceFailed);
    },
    [refreshWorkspaces, workspaceFailed],
  );

  return {
    states,
    statesRef,
    views: views.current,
    applyStates,
    syncIntent,
    sessionIntent: sessionIntentRef,
    rememberSessionIntent,
    buildTurn,
    setError,
    error,
    refreshSessions,
    refreshWorkspaces,
    workspaceFailed,
    sessions,
    loads,
    reloadSessions,
    reloadWorkspaces,
    sessionsLoaded,
    workspaces,
    renameWorkspace,
    removeWorkspace,
    defaultCwd,
    usable,
    phaseOf: (id: string): SessionEntry["phase"] => statesRef.current.get(id)?.phase ?? "idle",
    turnErrorOf: (id: string): string | null => statesRef.current.get(id)?.turnError ?? null,
    answerApproval,
    renameSession,
    pinSession,
    starSession,
    setCompletionSession,
    archiveDoneSessions,
    carryovers,
    refreshCarryovers,
    setCarryoverStatus,
    archiveSession,
    moveSession,
    exportSession,
    removeSession,
  };
}

/**
 * 查看槽——某个「正在看」的全部。主槽与抽屉槽各来一份，互不串：
 * 草稿、模型/权限档意图、cwd 归属都是槽内的；每轮 submit 显式带上自己槽内的值。
 */
export function useSessionView(engine: SessionEngine, key: string): ChatSession {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [opened, setOpened] = useState<SessionMeta | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [model, setModel] = useState<{ providerId: string; modelId: string } | null>(null);
  const [mode, setMode] = useState<PermissionMode>("plan");
  // 思考档初始 medium：不是新拍的默认，是这些会话一直实际在跑的那一档（pi 出厂默认）
  const [thinkingLevel, setThinkingLevelState] = useState<ThinkingLevel>("medium");
  const sessionRef = useRef<string | null>(null);

  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  /**
   * 启动恢复（A-0 复验 bug A）：上次退出前用的档/模型存在 settings.lastUsed，
   * 挂载后恢复一次——只影响「还没打开会话」的新任务槽；打开旧会话时
   *  openSession 会以那条会话 meta 的值为准覆写，后者赢。
   */
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    void api.settings
      .get()
      .then((settings) => {
        const last = settings.lastUsed;
        if (last === undefined) return;
        if (last.mode !== undefined) setMode(last.mode);
        if (last.thinkingLevel !== undefined) setThinkingLevelState(last.thinkingLevel);
        if (last.providerId !== undefined && last.modelId !== undefined) {
          setModel({ providerId: last.providerId, modelId: last.modelId });
        }
      })
      .catch(() => undefined); // 读不出来就停在默认，不挡开工
  }, []);

  /**
   * 输入框草稿**按会话隔离**（含首页）：key = 当前查看的会话 id，首页用 "home"。
   * 以前是全局单份，切换 / 新开会话草稿跟着走（2026-09-10 用户裁决：新会话就是
   * 新的，旧会话的草稿留在原地等他回来）。纯内存，不落盘——与旧行为一致。
   */
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map());
  const writeDraft = useCallback(
    (draftKey: string, value: string) => {
      setDrafts((prev) => (prev.get(draftKey) === value ? prev : new Map(prev).set(draftKey, value)));
    },
    [],
  );

  // 会话 meta 里存的模型可能已随 provider 被删而失效——失效就清空，让上面的
  // 默认播种兜住。真实事故（2026-09-04）：旧会话存着已删除的 openai-compatible，
  // 打开后直接发送，主进程炸 unknown provider。providers 未加载完（usable 空）不判。
  useEffect(() => {
    if (model === null || engine.usable.length === 0) return;
    if (!engine.usable.some((p) => p.id === model.providerId)) setModel(null);
  }, [engine.usable, model]);

  /** **正看着的会话的 meta 必须从引擎的列表刷新里拿真值**——活会话（首页直接开的那条）
   *  opened 一路是 null，不种上的话顶栏永远读 transcript 推导的旧标题，
   *  改名与模型标题都换不掉它（真实事故：改名后侧栏变了顶栏不变）。
   *  与 viewedId 同一条规则：盘上打开的优先，否则看活着的。 */
  const syncOpened = useCallback((list: readonly SessionMeta[]) => {
    setOpened((current) => {
      const id = current?.id ?? sessionRef.current ?? null;
      if (id === null) return null;
      return list.find((meta) => meta.id === id) ?? current;
    });
  }, []);

  /** 注册进引擎：model 事件路由、删除/移动会话通知、meta 同步都按这份名册来 */
  useEffect(() => {
    const handle: ViewHandle = {
      sessionRef,
      alignModel: (event) => setModel({ providerId: event.providerId, modelId: event.modelId }),
      // clamp 真值只认 5 档内的（xhigh/max 是目录未搬运前的边缘，进了也点不到）；
      // 不认识就保持原样——意图档继续显示，下一轮事件再纠
      alignThinking: (event) => {
        if (isThinkingLevel(event.level)) setThinkingLevelState(event.level);
      },
      handleRemoved: (id) => {
        setOpened((current) => (current?.id === id ? null : current));
        // 删掉的正是本槽活着的那条：回到首页，别让界面停在一条已经没有记录的会话上
        if (id === sessionRef.current) {
          setSessionId(null);
          sessionRef.current = null;
          engine.setError(null);
          setOpened(null);
        }
      },
      handleMoved: (id, target) => {
        setOpened((current) =>
          current?.id === id ? { ...current, workspaceId: target } : current,
        );
        if (id === sessionRef.current) setWorkspaceId(target);
      },
      handleWorkspaceRemoved: (id) => {
        setWorkspaceId((current) => (current === id ? null : current));
        setCwd((current) => (workspaceIdRef.current === id ? null : current));
      },
      syncOpened,
    };
    engine.views.add(handle);
    return () => {
      engine.views.delete(handle);
    };
  }, [engine, syncOpened]);

  // handleWorkspaceRemoved 读取「上一个 workspaceId」用的镜像：注册只发生一次，
  // 闭包里的 workspaceId 会变陈旧，ref 永远新鲜
  const workspaceIdRef = useRef<string | null>(null);
  useEffect(() => {
    workspaceIdRef.current = workspaceId;
  }, [workspaceId]);

  // 本槽的 UI 选择推进引擎的投递兜底（见引擎 syncIntent 的注释）
  useEffect(() => {
    engine.syncIntent({ model, mode, thinkingLevel, cwd, workspaceId });
  }, [engine, model, mode, cwd, workspaceId]);

  // 草稿键 = 当前查看的会话；send 与收回都写自己的键，互不串。
  // 兜底键带槽名：主槽与抽屉槽的「首页」是两份草稿
  const draftKey = sessionId ?? opened?.id ?? `home:${key}`;
  const draft = drafts.get(draftKey) ?? "";
  const setDraft = (value: string) => writeDraft(draftKey, value);

  /**
   * 绑定本槽 → 乐观置 turn → submit 全套开工上下文。send 的发送分支与遗留事项
   * 开工（startCarryoverTask）共用：两条路径对「发出去那一刻起它就是本槽的活
   * 会话」「失败归位并报错」「新本子首轮刷新侧栏」的要求完全一致，各写一份迟早漂移。
   * 模型 / 权限档用本槽当前意图（两条共用路径都是「以用户当下选的档开新轮」；
   * 按会话自己的账续跑另有 buildTurn 那条路，见 continueCarryoverInSource）。
   * model 为 null 的检查不在这：send 要在清草稿**之前**拦，这里再拦一道只作
   * 类型兑底（两处同文案，行为一致）。
   */
  const submitTurn = useCallback(
    async (
      id: string,
      text: string,
      target: string,
      workspace: string | null,
      resume: { piSessionFile: string } | null,
    ): Promise<void> => {
      if (model === null) {
        engine.setError("Add a provider with at least one model first");
        return;
      }
      // 无论新建还是从盘上重开：发出去的那一刻起它就是「本槽的活会话」——排队 /
      // 停止 / 撤回都靠 sessionRef 找它，不设就全部静默 no-op（2026-09-11 B 验收复现）
      if (sessionRef.current !== id) {
        setSessionId(id);
        sessionRef.current = id;
      }
      // 乐观置 turn：不等第一帧事件回来，输入框立刻进入「跑着」的样子
      engine.applyStates((prev) => setEntryPhase(prev, id, "turn"));
      try {
        // submit 自带全套开工上下文：换过的模型 / 权限档随本轮显式生效
        await api.agent.submit({
          sessionId: id,
          text,
          cwd: target,
          workspaceId: workspace,
          resume,
          providerId: model.providerId,
          modelId: model.modelId,
          mode,
          thinkingLevel,
        });
        // 新本子的首轮：submit 的开机确认（等 created → 建 meta）返回后侧栏才看得见它
        if (resume === null) engine.refreshSessions();
      } catch (cause) {
        engine.setError(cause instanceof Error ? cause.message : String(cause));
        // 提交没送出去本轮就没跑起来；真跑起来的失败由 failed 事件归位
        engine.applyStates((prev) => setEntryPhase(prev, id, "idle"));
      }
    },
    [engine, model, mode, thinkingLevel],
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if (text === "") return;
    engine.setError(null);
    // 手动压缩指令在本地拦下，**不发给模型**——发出去模型会角色扮演一段
    // 「摘要」贴进对话，而什么都没压缩（真实发生过的事故）。
    const compact = parseCompactCommand(text);
    if (compact !== null) {
      const busyId = sessionRef.current;
      const busyPhase = busyId !== null ? engine.statesRef.current.get(busyId)?.phase : undefined;
      // 跑着或压缩中：/compact 也排队——不打断正在跑的轮，等完全空闲
      // （前面排着的消息也发完）再压，压的才是完整对话。
      if (busyId !== null && busyPhase !== undefined && busyPhase !== "idle") {
        engine.applyStates((prev) =>
          enqueue(prev, busyId, {
            id: crypto.randomUUID(),
            kind: "compact",
            ...(compact.instructions !== undefined ? { instructions: compact.instructions } : {}),
          }),
        );
        writeDraft(draftKey, "");
        return;
      }
      // 压缩要有可续的会话；**绝不为压缩新建会话**——对一条空会话压缩没有意义。
      // 无状态：压缩也是一次开机（resume 带上 pi 本子），不需要先「唤醒」。
      const active =
        sessionId ?? (opened !== null && opened.piSessionFile !== null ? opened.id : null);
      if (active === null) {
        engine.setError("No running task to compact");
        return;
      }
      if (model === null) {
        engine.setError("Add a provider with at least one model first");
        return;
      }
      // 压缩轮开起来的那一刻起它也是「本槽的活会话」——压缩期间按 stop 才能找到它
      if (sessionRef.current !== active) {
        setSessionId(active);
        sessionRef.current = active;
      }
      writeDraft(draftKey, "");
      // 乐观置 turn：压缩是一次真实的 LLM 调用，输入框立刻进入忙碌
      engine.applyStates((prev) => setEntryPhase(prev, active, "turn"));
      void api.agent.compact({
        sessionId: active,
        cwd: opened?.cwd ?? cwd ?? engine.defaultCwd,
        workspaceId: opened?.workspaceId ?? workspaceId ?? null,
        resume: opened?.piSessionFile != null ? { piSessionFile: opened.piSessionFile } : null,
        providerId: model.providerId,
        modelId: model.modelId,
        mode,
        thinkingLevel,
        ...(compact.instructions !== undefined ? { instructions: compact.instructions } : {}),
      });
      return;
    }
    // 「本槽当前看哪条」：挂着的活会话，或从盘上打开的那条；首页两者皆无 → 开新的
    let id: string | null = sessionId ?? opened?.id ?? null;
    // **忙就排队，闲才直发**：这是队列归我们之后的核心分流。不再把消息推进 pi 的
    // steering/followUp——那边只有裸字符串、没有 id，正是一整晚竞态的来源。
    const busy = id !== null && engine.statesRef.current.get(id)?.phase !== "idle";
    if (id !== null && busy) {
      const queuedId = crypto.randomUUID();
      engine.applyStates((prev) => enqueue(prev, id as string, { id: queuedId, kind: "text", text }));
      setDraft("");
      return;
    }
    try {
      if (model === null) throw new Error("Add a provider with at least one model first");
      // 已有会话的 cwd / 归属 / 本子以 meta 真值为准（会话固定——用户切了工作区
      // 再对旧会话发消息，工具目录不能跟着变）；新会话用本槽当前选择。
      const meta = id !== null ? engine.sessions.find((entry) => entry.id === id) ?? null : null;
      const resume = meta?.piSessionFile != null ? { piSessionFile: meta.piSessionFile } : null;
      // 没选就落兜底——输入卡上写着「Home」，不是一个用户看不见的默认
      const target = meta?.cwd ?? cwd ?? engine.defaultCwd;
      if (target === "") throw new Error("Choose a workspace folder first");
      const workspace = meta?.workspaceId ?? workspaceId ?? null;
      if (id === null) id = crypto.randomUUID();
      writeDraft(draftKey, "");
      await submitTurn(id, text, target, workspace, resume);
    } catch (cause) {
      engine.setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [engine, draft, sessionId, model, mode, cwd, workspaceId, opened, draftKey, writeDraft, submitTurn]);

  const stop = useCallback(() => {
    // 只停本槽当前轮。排队不动：pi 队列滞留给下次发送自动带上；压缩缓冲在压缩结束
    // （含被停止的压缩）的 phase 事件里自动发出——停止不替用户放弃任何已说的话
    if (sessionRef.current === null) return;
    void api.agent.abort(sessionRef.current);
  }, []);

  /** 回到首页（本槽）。会话在首条消息提交时才真正创建（R8-01 ①）。 */
  const reset = useCallback(() => {
    setSessionId(null);
    sessionRef.current = null;
    engine.setError(null);
    setOpened(null);
    // **槽不动**：回首页不等于后台会话停了，它们在各自的槽里继续涨
  }, [engine]);

  /**
   * 打开一条会话（进本槽）：cwd / 归属 / 权限档一起恢复成它当时的样子。点的就是
   * 当前这条活着的会话时什么都不用做。**还在跑的会话直接接上活槽**——
   * 切回来就是最新画面，事件继续实时进。
   *
   * 没在跑的才从盘上把 transcript 种进槽；**续跑推迟到用户真的说话时**
   * （send 里带 resume）——打开一条会话就起一个进程内的 session 太贵了，
   * 翻记录是最常见的动作。返回的 Promise 在历史种完（或读失败）时落定——
   * 「打开后接着发消息」的编排（遗留事项续跑原会话）要等它，否则 submit 先行
   * 会把槽建出来，openSession 的种子看到槽已存在就不种历史了。
   */
  const openSession = useCallback(
    (id: string): Promise<void> => {
      if (id === sessionRef.current) return Promise.resolve();
      engine.setError(null);
      setLoadingHistory(true);
      return api.session
        .load(id)
        .then((detail) => {
          setLoadingHistory(false);
          if (detail === null) return;
          // meta（cwd / 归属 / 权限档 / 模型）两条路都要恢复
          setOpened(detail.meta);
          setCwd(detail.meta.cwd);
          setWorkspaceId(detail.meta.workspaceId);
          // 会话级意图优先于 meta：这条会话跑着时改的档位 / 模型落不进 meta，
          // 切走再切回时若拿 meta 重置 chip，chip 就会说 plan 而下一轮实际跑 skip
          const own = engine.sessionIntent.current.get(id);
          setMode(own?.mode ?? detail.meta.mode);
          setModel(own?.model ?? { providerId: detail.meta.providerId, modelId: detail.meta.modelId });
          setThinkingLevelState(own?.thinkingLevel ?? detail.meta.thinkingLevel);
          // 无状态：没有「活会话集合」要重连——正在跑的会话它的槽本来就在 states
          // 里（事件一直实时进），不种盘上的快照（种盘等于把画面倒回去）；
          // 没在跑的才从盘上种，readOnly 与「说话时才续跑」（send 带 resume）语义照旧。
          //
          // **正在跑的会话要把控制面一起绑过来**（不变量 5）：sessionRef 是停止 /
          // 立即发送 / 撤回 / 拖拽找会话的**唯一入口**，置空就等于把这整排按钮
          // 变成静默 no-op（守卫都是 `sessionRef.current === null 就 return`，无报错）。
          // 实测：发完消息后只要点过侧栏任一条会话（包括点回正在跑的这条），停止就
          // 彻底失效，直到下一次发送——用户看到的是「打断时灵时不灵」。
          //
          // 空闲会话仍然置空：`readOnly` 用 `sessionId === null` 判「没 pi 本子且还没
          // 唤醒」，绑上去会把只读的旧会话误判成可写。
          const live = (engine.statesRef.current.get(id)?.phase ?? "idle") !== "idle";
          setSessionId(live ? id : null);
          sessionRef.current = live ? id : null;
          if (!engine.statesRef.current.has(id)) {
            engine.applyStates((prev) => seedFromDisk(prev, id, detail.transcript, detail.meta.stats));
          }
        })
        .catch((cause: unknown) => {
          setLoadingHistory(false);
          engine.setError(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [engine],
  );

  /**
   * 方案 A：以一条遗留事项为种子**新开一单**带上下文开工（面板「Continue with
   * context」）。种子是可见的结构化 user 消息（形态决策见 carryover-resume.ts）；
   * cwd / 归属跟随来源会话——遗留事项是那单任务的未竟之事，新开工跑在同一个
   * 目录才能接着干；来源已删时退到本槽当前选择再退兑底。完成与否不回写：
   * 新单完成 ≠ 遗留办结，勾选留给用户（不猜）。
   */
  const startCarryoverTask = useCallback(
    (item: Carryover): void => {
      if (model === null) {
        engine.setError("Add a provider with at least one model first");
        return;
      }
      const source = engine.sessions.find((meta) => meta.id === item.sourceSessionId) ?? null;
      // 空标题的会话不会有 carryover（收尾扫描要求 transcript 非空），防御性兑到
      // Untitled task（transcriptToMarkdown 同款措辞），不谎称「已删除」
      const sourceTitle =
        source === null ? null : source.title === "" ? "Untitled task" : source.title;
      const seed = buildCarryoverSeed(item, sourceTitle);
      const target = source?.cwd ?? cwd ?? engine.defaultCwd;
      if (target === "") {
        engine.setError("Choose a workspace folder first");
        return;
      }
      const workspace = source?.workspaceId ?? workspaceId ?? null;
      // 回首页清槽，并把本槽落点切到来源目录：开工后的下一条新任务默认同目录
      reset();
      setCwd(source?.cwd ?? null);
      setWorkspaceId(source?.workspaceId ?? null);
      engine.setError(null);
      void submitTurn(crypto.randomUUID(), seed, target, workspace, null);
    },
    [engine, model, cwd, workspaceId, reset, submitTurn],
  );

  /**
   * 方案 B：以遗留事项为用户消息**续跑原会话**（同一个按钮的右键备选；
   * 只读导入会话没有 pi 本子，面板已按 canResumeInSource 禁掉入口，这里再守一道）。
   * **等 openSession 把历史种完再发**：submit 先行会把槽建出来，种子看到槽已存在
   * 就不种历史，用户会看不到原对话。在跑就排队（不打断正在跑的轮，与 send
   * 同一条纪律）；闲着就按会话自己的账续跑（buildTurn：cwd / 本子 / 档位都是
   * 它当时的样子，不用本槽当前的）。
   */
  const continueCarryoverInSource = useCallback(
    (item: Carryover): void => {
      const id = item.sourceSessionId;
      const meta = engine.sessions.find((entry) => entry.id === id) ?? null;
      if (meta === null || meta.piSessionFile === null) return;
      const text = buildCarryoverFollowUp(item);
      void openSession(id).then(() => {
        // 没有槽（undefined）也是没在跑：直接发，不排队——排了没人投递，成死队列
        const entry = engine.statesRef.current.get(id);
        if (entry !== undefined && entry.phase !== "idle") {
          engine.applyStates((prev) =>
            enqueue(prev, id, { id: crypto.randomUUID(), kind: "text", text }),
          );
          return;
        }
        const turn = engine.buildTurn(id);
        if (turn === null) return;
        // 这里不再清 error：openSession 读盘失败的红字要留着（链会继续走到这，
        // 消息照发、历史没种上，用户得知道有错）；常规清理 openSession 开头已做
        if (sessionRef.current !== id) {
          setSessionId(id);
          sessionRef.current = id;
        }
        engine.applyStates((prev) => setEntryPhase(prev, id, "turn"));
        void api.agent.submit({ sessionId: id, text, ...turn }).catch((cause: unknown) => {
          engine.setError(cause instanceof Error ? cause.message : String(cause));
          engine.applyStates((prev) => setEntryPhase(prev, id, "idle"));
        });
      });
    },
    [engine, openSession],
  );

  const branchFrom = useCallback(
    (anchorItemId: string) => {
      // 分支的源是「活着的或正打开的那条」——按钮就长在它的转录里
      const id = sessionRef.current ?? opened?.id ?? null;
      if (id === null) return;
      void api.session
        .branch(id, anchorItemId)
        .then((newId) => {
          engine.refreshSessions();
          openSession(newId);
        })
        .catch((cause: unknown) => engine.setError(cause instanceof Error ? cause.message : String(cause)));
    },
    [engine, opened, openSession],
  );

  /** 不属于任何工作区的新任务：清掉归属与 cwd，落在兜底 */
  const newTask = useCallback(() => {
    reset();
    setCwd(null);
    setWorkspaceId(null);
  }, [reset]);

  /** 这个工作区里的新任务：路径与归属一起填好，用户不用再点一次 */
  const newTaskIn = useCallback(
    (workspace: Workspace) => {
      reset();
      setCwd(workspace.path);
      setWorkspaceId(workspace.id);
    },
    [reset],
  );

  /** 加一个工作区，并把本槽的下一条任务直接落在它里面——加完就想用，别让人再点一次 */
  const addWorkspace = useCallback(() => {
    void api.workspace
      .add()
      .then((added) => {
        if (added === null) return;
        engine.refreshWorkspaces();
        reset();
        setCwd(added.path);
        setWorkspaceId(added.id);
      })
      .catch(engine.workspaceFailed);
  }, [engine, reset]);

  /**
   * 当前正在看的这条会话的相位。没有活会话（首页 / 盘上打开未唤醒）算 idle——
   * 那时根本没有「一轮」在跑，不该拦。
   */
  const currentPhase = useCallback((): SessionEntry["phase"] => {
    const id = sessionRef.current;
    return id === null ? "idle" : (engine.statesRef.current.get(id)?.phase ?? "idle");
  }, [engine]);

  /**
   * 换模型（C-4）。**有活会话就地切**：命令发过去，成功经 `model` 事件回环对齐
   * model state（不乐观——切换会失败：无 key、未知模型；失败红字说明，chip 不动）；
   * 没活的（首页 / 盘上打开未唤醒）只改意图，下一条消息 submit 时生效——
   * 换了却不发言就切走，会被 openSession 的 meta 播种冲掉，等于没换过（已裁决接受）。
   * pi 的切换对正在跑的轮无效、下一轮生效——正在跑的轮照旧，写的和跑的不会再对不上。
   */
  const chooseModel = useCallback(
    (providerId: string, modelId: string) => {
      setModel({ providerId, modelId });
      // 启动恢复点跟随（bug A）：下次启动应用从这个模型开始
      void api.settings.set({ lastUsed: { providerId, modelId } }).catch(() => undefined);
      const id = sessionRef.current;
      if (id === null) return; // 本槽开新任务：槽意图就是意图
      // 理由同 changeMode：模型也是「选给哪条会话」的，不能让后台会话的排队卡
      // 拿到你刚才给别的会话选的模型
      engine.rememberSessionIntent(id, { model: { providerId, modelId } });
      if (currentPhase() === "idle") {
        // 闲着就注入（校验 + 落 meta + model 事件回环）；跑着只改显示——
        // 无状态下注入就是下一轮 submit 带上的新值，不需要欠账冲账
        void api.agent
          .setModel(id, providerId, modelId)
          .catch((cause: unknown) => engine.setError(cause instanceof Error ? cause.message : String(cause)));
      }
    },
    [engine, currentPhase],
  );

  const changeMode = useCallback(
    (next: PermissionMode) => {
      // 理由同 chooseModel：权限档决定 bash 能不能跑，轮内改是另一种串台——
      // 所以注入延迟（UI 即时），不是锁 chip；跑着时下一轮 submit 自带新档
      setMode(next);
      // 启动恢复点跟随（bug A）：下次启动应用从这一档开始
      void api.settings.set({ lastUsed: { mode: next } }).catch(() => undefined);
      const id = sessionRef.current;
      if (id === null) return; // 本槽开新任务：还没有会话可记，槽意图就是意图
      // **先记在这条会话名下**：跑着时改不进 meta，而它的排队卡可能在你已经切去
      // 看别的会话之后才投递，那时全局意图已经是别人的了
      engine.rememberSessionIntent(id, { mode: next });
      if (currentPhase() === "idle") {
        void api.agent
          .setMode(id, next)
          .catch((cause: unknown) => engine.setError(cause instanceof Error ? cause.message : String(cause)));
      }
    },
    [engine, currentPhase],
  );

  const changeThinkingLevel = useCallback(
    (next: ThinkingLevel) => {
      // 同 changeMode 的整条规矩：本地即设（UI 即时）→ lastUsed 跟随 → 记在会话名下
      // （跑着时改不进 meta，排队卡投递时要拿这一档）→ 闲着才落 meta。下一轮 submit
      // 自带新档——轮中改不影响当前轮（pi 在轮启动时已快照档位，与换模型同一条语义）
      setThinkingLevelState(next);
      void api.settings.set({ lastUsed: { thinkingLevel: next } }).catch(() => undefined);
      const id = sessionRef.current;
      if (id === null) return; // 本槽开新任务：还没有会话可记，槽意图就是意图
      engine.rememberSessionIntent(id, { thinkingLevel: next });
      if (currentPhase() === "idle") {
        void api.agent
          .setThinkingLevel(id, next)
          .catch((cause: unknown) => engine.setError(cause instanceof Error ? cause.message : String(cause)));
      }
    },
    [engine, currentPhase],
  );

  /**
   * 立刻压一次上下文（A-1 用量菜单里那一项；A2-Q1 裁决：菜单项与 `/compact` 都要）。
   *
   * **只在闲着时给**——调用方（菜单项）已按 `phase !== "idle"` 禁用。
   * pi 的 `compact()` 会先打断当前这一轮，跑着时点它等于把回答砍了。
   *
   * 无状态下压缩也是一次开机（resume 带 pi 本子），不需要先「唤醒」；
   * **绝不为压缩新建会话**——对一条空会话压缩没有意义。进度不用单独回包：
   * `compaction_start` / `compaction` 事件那条链已经通了。
   */
  const compact = useCallback((): void => {
    engine.setError(null);
    // 压缩要有可续的会话
    const active = sessionId ?? (opened !== null && opened.piSessionFile !== null ? opened.id : null);
    if (active === null) {
      engine.setError("没有正在运行的任务可压缩");
      return;
    }
    const turn = engine.buildTurn(active);
    if (turn === null) return;
    // 压缩轮开起来的那一刻起它也是「本槽的活会话」——压缩期间按 stop 才能找到它
    if (sessionRef.current !== active) {
      setSessionId(active);
      sessionRef.current = active;
    }
    // 乐观置 turn：压缩是一次真实的 LLM 调用，输入框立刻进入忙碌
    engine.applyStates((prev) => setEntryPhase(prev, active, "turn"));
    void api.agent.compact({ sessionId: active, ...turn });
  }, [engine, sessionId, opened]);

  /** 排队项的文字退回草稿（拼接规则在 withdraw-draft.ts，那里有测试）。
   *  目标是**本槽当前会话**的草稿——草稿已按会话隔离，不再是一份全局 string。 */
  const restoreToDraft = useCallback(
    (text: string) => {
      setDrafts((prev) =>
        new Map(prev).set(draftKey, appendWithdrawn(prev.get(draftKey) ?? "", text)),
      );
    },
    [draftKey],
  );

  /** 撤回：移出队列，文字落回草稿。全程本地，没有往返也就没有落空。 */
  const withdrawQueued = useCallback(
    (queuedId: string) => {
      const id = sessionRef.current;
      if (id === null) return;
      const item = engine.statesRef.current.get(id)?.queued.find((entry) => entry.id === queuedId);
      if (item === undefined) return;
      engine.applyStates((prev) => dequeue(prev, id, queuedId));
      // compact 项没有「用户的话」可拿回——本仓没有斜杠命令 UI，把 `/compact`
      // 塞进输入框只会变成一条普通消息。它的撤回就是单纯取消。
      if (item.kind === "text") restoreToDraft(item.text);
    },
    [engine, restoreToDraft],
  );

  /** 拖拽排序：纯本地一次 splice，即时生效。 */
  const moveQueuedTo = useCallback(
    (sourceId: string, targetId: string, placement: "before" | "after") => {
      const id = sessionRef.current;
      if (id === null) return;
      engine.applyStates((prev) => moveQueuedIn(prev, id, sourceId, targetId, placement));
    },
    [engine],
  );

  /**
   * 立即发送：停下当前这一轮，把这条作为新一轮发出去。
   *
   * 空闲时没有「当前轮」可停，退化成直接发——对用户是同一件事：别等了，现在就办。
   */
  const sendQueuedNow = useCallback(
    (queuedId: string) => {
      const id = sessionRef.current;
      if (id === null) return;
      const entry = engine.statesRef.current.get(id);
      const item = entry?.queued.find((queued) => queued.id === queuedId);
      if (entry === undefined || item === undefined) return;
      engine.applyStates((prev) => dequeue(prev, id, queuedId));
      const fail = (cause: unknown): void =>
        engine.setError(cause instanceof Error ? cause.message : String(cause));
      // compact 的「立即」是另一回事：不打断，只是不等空闲马上压
      if (item.kind === "compact") {
        const turn = engine.buildTurn(id);
        if (turn === null) return;
        void api.agent
          .compact({ sessionId: id, ...turn, ...(item.instructions !== undefined ? { instructions: item.instructions } : {}) })
          .catch(fail);
        return;
      }
      const turn = engine.buildTurn(id);
      if (turn === null) return;
      if (entry.phase === "idle") {
        void api.agent.submit({ sessionId: id, text: item.text, ...turn }).catch(fail);
      } else {
        void api.agent.interrupt({ sessionId: id, text: item.text, ...turn }).catch(fail);
      }
    },
    [engine],
  );

  // provider 到位后先落一个默认模型：第一个 provider 的第一个模型。
  // 用户没选过时界面上也该显示出到底会用哪个，而不是一片空白
  useEffect(() => {
    if (model !== null) return;
    const first = engine.usable[0];
    const firstModel = first?.models.declared[0];
    if (first === undefined || firstModel === undefined) return;
    setModel({ providerId: first.id, modelId: firstModel.id });
  }, [engine.usable, model]);

  /** 「当前看哪条」：挂着的活会话，或从盘上打开的那条；首页两者皆无 → 空槽兜底。
   *  ChatView 本来就用 sessionId ?? opened?.id 推标题里的会话，这里不另设第二份账 */
  const viewedId = sessionId ?? opened?.id ?? null;
  const entry = (viewedId !== null ? engine.states.get(viewedId) : undefined) ?? EMPTY_ENTRY;

  // —— 收尾仪式（closing ritual）——
  // 点「Mark task done」→ 以当前会话的身份发一条**普通的用户消息**（扫描 prompt）→
  // agent 在同一条 session 里回看对话（复用对话 cache）、回一个 fenced json →
  // phase 回 idle 时解析、弹勾选清单 → 确认后落 carryovers + setCompletion。
  // 状态放查看槽而不是引擎：扫描只对「本槽正看着的会话」发起，切走不动它。
  /** 扫描进行态。baseline = 发出扫描消息前槽里的消息数——解析只看它之后新增的
   *  回答，防止扫描轮失败时误取上一轮的旧回答当扫描结果。 */
  const [closingScan, setClosingScan] = useState<{
    sessionId: string;
    baseline: number;
  } | null>(null);
  /** 扫描完成待确认的清单；非 null 且正在查看发起会话时，ChatView 在 footer 显示确认卡 */
  const [scanResult, setScanResult] = useState<{
    sessionId: string;
    drafts: CarryoverDraft[];
  } | null>(null);
  /** 降级 / 结果的一句反馈（中性，不是错误）；下一次发起或打开会话时清 */
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  /** 读不懂结果的那条会话（重试按它定向）。null = 没有可重试的失败。 */
  const [scanFailed, setScanFailed] = useState<string | null>(null);

  /** 打开另一条会话：上一轮的提示不是那条会话的事，不能跟过来。
   *  待确认的清单（scanResult）**不清**：它是发起会话的未完成动作，切走再切回
   *  还在——静默丢弃会让「点了 Mark done 却什么都没发生」。确认卡是 inline 浮层
   *  （只挂在发起会话的 footer），切走时不显示但状态保留；确认 / 取消都按
   *  scanResult.sessionId 定向，不会错标当前会话。 */
  useEffect(() => {
    setScanNotice(null);
    setScanFailed(null);
  }, [viewedId]);

  /** 扫描超时（默认 60s）：直接标完成并说清楚，不让用户卡在等待里。
   *  依赖取稳定字段而不是整个 engine（每次渲染都是新引用，会让 timer 被无谓
   *  重置）：setCompletionSession 是 useCallback 产物，引用稳定。 */
  const setCompletionSession = engine.setCompletionSession;
  useEffect(() => {
    if (closingScan === null) return;
    const timer = window.setTimeout(() => {
      setCompletionSession(closingScan.sessionId, "done");
      setScanNotice("The leftover scan didn't finish in time — marked done without a checklist.");
      setScanFailed(closingScan.sessionId);
      setClosingScan(null);
    }, CLOSING_SCAN_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [closingScan, setCompletionSession]);

  /**
   * 扫描轮落定（phase 回 idle，且本槽看着它）→ 取注入之后新增的 assistant
   * 回答解析。解析失败 / 没有新回答 / 空数组都是终局：前两者降级直接标完成，
   * 空数组是「没有遗留」的合法答案，同样直接标完成。依赖里带 viewedId：用户
   * 扫描期间切走再切回时 phase 已经是 idle，靠 viewedId 变化重新触发。
   */
  useEffect(() => {
    if (closingScan === null || viewedId !== closingScan.sessionId) return;
    if (entry.phase !== "idle") return;
    const statesRef = engine.statesRef;
    const items = selectTranscript(
      statesRef.current.get(closingScan.sessionId)?.transcript ?? EMPTY_ENTRY.transcript,
    );
    const answer = collectScanAnswer(items, closingScan.baseline);
    const drafts = answer === null ? null : parseCarryoverResponse(answer);
    setClosingScan(null);
    if (drafts === null) {
      // **读不懂不等于没事**：会话照标完成（收尾的意愿已经表达），但提示里带上
      // 重试——扫描消息就在对话里，模型回了什么用户看得见，重发一条就行。
      engine.setCompletionSession(closingScan.sessionId, "done");
      setScanNotice("Couldn't read the scan result — marked done without a checklist.");
      setScanFailed(closingScan.sessionId);
      return;
    }
    if (drafts.length === 0) {
      engine.setCompletionSession(closingScan.sessionId, "done");
      setScanNotice("The leftover scan found nothing — marked done.");
      return;
    }
    setScanResult({ sessionId: closingScan.sessionId, drafts });
    // entry.phase 是渲染值，它的变化就是本 effect 的触发源——必须进依赖；
    // engine 整体每次渲染都是新引用，取稳定的 statesRef / setCompletionSession
  }, [closingScan, viewedId, entry.phase, engine.statesRef, engine.setCompletionSession]);

  /**
   * 发出扫描消息（首次与重试共用）。**它是一条普通的用户消息**：走与
   * `send` 同一条 submit 链，进消息流、进 pi 历史，标题门禁与最近提问按普通消息处理。
   *
   * 只有一处不同：这一轮优先用设置里的命名模型（`settings.titleModel`）——详 scanTurnModel。
   * 设置读不出来不拦扫描，退回会话模型就是了。
   */
  const launchScan = useCallback(
    (id: string, baseline: number, turn: Omit<SubmitAgentInput, "sessionId" | "text">): void => {
      setClosingScan({ sessionId: id, baseline });
      engine.applyStates((prev) => setEntryPhase(prev, id, "turn"));
      void api.settings
        .get()
        .then((settings) => settings.titleModel)
        .catch(() => undefined)
        .then((naming) =>
          api.agent.submit({
            sessionId: id,
            text: CLOSING_SCAN_PROMPT,
            ...scanTurnModel(turn, naming),
          }),
        )
        .catch((cause: unknown) => {
          // 提交没送出去：扫描轮没开起来，归位并交代一句
          setClosingScan(null);
          engine.applyStates((prev) => setEntryPhase(prev, id, "idle"));
          engine.setError(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [engine],
  );

  /**
   * 点「Mark task done」（头部按钮）：能扫就发起仪式，不能扫就地降级。
   * 降级矩阵（按序判定）：
   *   在跑 / 已在扫 → no-op（按钮本就该禁）；
   *   队列里还有没发完的 → 报错停下（收尾不能把排队的话变成永远发不出的哑弹）；
   *   没有 pi 本子（只读会话）→ 纯标记——没有前文可扫，扫描没有意义；
   *   transcript 是空的 → 纯标记——扫描无对象；
   *   其余 → 发出扫描消息（乐观置 turn，按钮立刻进入扫描态）。
   */
  const startClosingRitual = useCallback((): void => {
    const id = sessionRef.current ?? opened?.id ?? null;
    if (id === null) return;
    if (closingScan !== null) return;
    const current = engine.statesRef.current.get(id);
    if (current === undefined || current.phase !== "idle") return;
    if (current.queued.length > 0) {
      engine.setError("There are queued messages in this task — send or withdraw them before wrapping up.");
      return;
    }
    const meta = engine.sessions.find((item) => item.id === id) ?? opened;
    // 只读 / 空对话：没有可扫的前文，扫描没有意义，直接纯标记
    if (meta === null || meta.piSessionFile === null) {
      engine.setCompletionSession(id, "done");
      setScanNotice("This task cannot be scanned (no agent session) — marked done directly.");
      return;
    }
    const baseline = selectTranscript(current.transcript).length;
    if (baseline === 0) {
      engine.setCompletionSession(id, "done");
      setScanNotice("Nothing was ever said in this task — marked done directly.");
      return;
    }
    const turn = engine.buildTurn(id);
    if (turn === null) return;
    // 绑定本槽（同 compact）：扫描期间停止 / 状态机都归本槽管
    if (sessionRef.current !== id) {
      setSessionId(id);
      sessionRef.current = id;
    }
    engine.setError(null);
    setScanNotice(null);
    setScanFailed(null);
    launchScan(id, baseline, turn);
  }, [closingScan, engine, launchScan, opened]);

  /**
   * 重试（提示行上的 Retry）：重发同一条扫描消息。会话已经是 done，
   * 重扫出东西就走清单、确认后转 done_with_todos；又读不懂就再给一次 Retry。
   * 基线重新取（上一轮的扫描消息与回答都已在转录里，不重新取会把旧回答再解一遍）。
   */
  const retryClosingScan = useCallback((): void => {
    const id = scanFailed;
    if (id === null || closingScan !== null) return;
    const current = engine.statesRef.current.get(id);
    if (current === undefined || current.phase !== "idle") return;
    const turn = engine.buildTurn(id);
    if (turn === null) return;
    engine.setError(null);
    setScanNotice(null);
    setScanFailed(null);
    launchScan(id, selectTranscript(current.transcript).length, turn);
  }, [closingScan, engine, launchScan, scanFailed]);

  /**
   * 确认清单：勾选项落盘 + setCompletion(done_with_todos)；全不勾 = done
   * （没有要留的就没有遗留）。锚点在这里现算（尽力而为，搜不到 null）。
   */
  const confirmCarryovers = useCallback(
    (picked: readonly CarryoverDraft[]): void => {
      if (scanResult === null) return;
      const id = scanResult.sessionId;
      setScanResult(null);
      if (picked.length === 0) {
        engine.setCompletionSession(id, "done");
        setScanNotice("Marked done — no carryover items were kept.");
        return;
      }
      const items = selectTranscript(
        engine.statesRef.current.get(id)?.transcript ?? EMPTY_ENTRY.transcript,
      );
      const drafts = picked.map((draft) => ({
        title: draft.title,
        detail: draft.detail,
        sourceMessageRange: locateMessageRange(items, draft.detail),
      }));
      void api.session
        .carryoverCreate(id, drafts)
        .then(() => {
          engine.setCompletionSession(id, "done_with_todos");
          engine.refreshCarryovers();
          setScanNotice(
            `Marked done with ${drafts.length} carryover item${drafts.length === 1 ? "" : "s"}.`,
          );
        })
        .catch((cause: unknown) => {
          // 落盘失败：清单丢了但会话还没标——如实报错，用户可以重试（再点 Mark done 会重扫）
          engine.setError(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [scanResult, engine],
  );

  /** 取消（已过二次确认）：丢弃清单，同样标 done——收尾的意愿已经表达了 */
  const cancelCarryovers = useCallback((): void => {
    if (scanResult === null) return;
    const id = scanResult.sessionId;
    setScanResult(null);
    engine.setCompletionSession(id, "done");
    setScanNotice("Marked done — the checklist was discarded.");
  }, [scanResult, engine]);

  // selectTranscript 每次调用都造新数组（pi 的实现如此）——在这里按 entry 引用
  // 稳定化，否则 ChatView 的 memo 转录列每次渲染都被新引用击穿，隔离形同虚设
  const transcript = useMemo(() => selectTranscript(entry.transcript), [entry.transcript]);

  return {
    sessionId,
    transcript,
    compactions: entry.compactions,
    phase: entry.phase,
    retry: entry.retry,
    turnError: entry.turnError,
    stats: entry.stats,
    phaseOf: engine.phaseOf,
    turnErrorOf: engine.turnErrorOf,
    error: engine.error,
    draft,
    setDraft,
    mode,
    changeMode,
    thinkingLevel,
    changeThinkingLevel,
    thinkingSupported: entry.thinking?.supported ?? null,
    approvals: entry.approvals,
    workspaces: engine.workspaces,
    addWorkspace,
    renameWorkspace: engine.renameWorkspace,
    removeWorkspace: engine.removeWorkspace,
    cwd,
    workspaceId,
    defaultCwd: engine.defaultCwd,
    usable: engine.usable,
    model,
    chooseModel,
    compact,
    sessions: engine.sessions,
    loads: engine.loads,
    reloadSessions: engine.reloadSessions,
    reloadWorkspaces: engine.reloadWorkspaces,
    sessionsLoaded: engine.sessionsLoaded,
    loadingHistory,
    opened,
    // 打开的是一条没有 pi 本子的旧会话，且还没开新的——只能读
    readOnly: opened !== null && opened.piSessionFile === null && sessionId === null,
    openSession,
    renameSession: engine.renameSession,
    pinSession: engine.pinSession,
    starSession: engine.starSession,
    setCompletionSession: engine.setCompletionSession,
    archiveDoneSessions: engine.archiveDoneSessions,
    archiveSession: engine.archiveSession,
    moveSession: engine.moveSession,
    branchFrom,
    exportSession: engine.exportSession,
    removeSession: engine.removeSession,
    carryovers: engine.carryovers,
    refreshCarryovers: engine.refreshCarryovers,
    setCarryoverStatus: engine.setCarryoverStatus,
    startCarryoverTask,
    continueCarryoverInSource,
    closingScan: closingScan !== null && closingScan.sessionId === viewedId,
    scanResult,
    startClosingRitual,
    confirmCarryovers,
    cancelCarryovers,
    scanNotice,
    // 重试只在「本槽正看着那条失败的会话」时给出——提示行本身就是那条会话的
    retryClosingScan: scanFailed !== null && scanFailed === viewedId ? retryClosingScan : null,
    send: () => void send(),
    stop,
    queued: entry.queued,
    sendQueuedNow,
    withdrawQueued,
    moveQueuedTo,
    newTask,
    newTaskIn,
    answerApproval: engine.answerApproval,
  };
}

/** 主槽：侧栏与中间的聊天面用的那一份。返回引擎供抽屉槽共用。 */
export function useChatSession(providers: ProviderDto[]): {
  session: ChatSession;
  engine: SessionEngine;
} {
  const engine = useChatSessionEngine(providers);
  const session = useSessionView(engine, "main");
  return { session, engine };
}
