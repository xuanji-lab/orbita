import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { selectTranscript } from "@earendil-works/pi-coding-agent/client";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { api } from "../../api";
import type { IntentRecallRecord } from "@shared/session";
import type { RecallCardState } from "@shared/intent-recall";
import type { IntentConfirmDecision } from "@shared/intent-confirm";
import { splitEchoBlocks } from "../../../../shared/prompt-attachments.ts";
import {
  EMPTY_ENTRY,
  dequeue,
  applyAgentEvent,
  enqueue,
  enqueueChannelMessage,
  createSessionStates,
  moveQueued as moveQueuedIn,
  parseCompactCommand,
  removeApproval,
  removeIntentAsk,
  setPendingEcho,
  nextDeliverable,
  prependOlder,
  removeSessionEntry,
  revertOptimisticTurn,
  seedFromDisk,
  setOlderLoading,
  setEntryPhase,
  type PendingApproval,
  type QueuedMessage,
  type SessionEntry,
  type SessionStates,
} from "./session-states.ts";
import { LOADING, READY, failed, type LoadState } from "./load-state.ts";
import { createProgressCoalescer } from "./progress-coalescer.ts";
import { recordToolFrame } from "./tool-results.ts";
import { shouldRefreshSessions } from "./session-list-refresh.ts";
import { appendWithdrawn } from "./withdraw-draft.ts";
import { admitImages, promptImagesBytes, readAsPromptImage, rejectionText, type ComposerImage } from "../../shell/composer-images.ts";
import { PROMPT_IMAGE_MIME_TYPES, PROMPT_IMAGE_MAX_COUNT, type PromptImage } from "../../../../shared/prompt-images.ts";
import {
  admitFileRefs,
  fileRefRejectionText,
  withStatKinds,
  type ComposerFileRef,
} from "../../shell/composer-attachments.ts";
import {
  pastedTextSize,
  EXTERNAL_FILE_COPY_MAX_BYTES,
  type PromptFileRef,
} from "@shared/prompt-attachments";
import {
  assemblePasteDraft,
  draftFromSentBlocks,
  draftFromSentText,
  parsePasteTokens,
  repositionBlocks,
  type ComposerPasteBlock,
} from "../../shell/paste-blocks.ts";
import { acceptQuote, composeQuotedMessage, parseQuotedMessage, QUOTE_MAX_TOTAL_CHARS, type TextQuote } from "../../../../shared/quote.ts";
import { recordAssistantStart } from "./stats-format.ts";
import { DEFAULT_PERMISSION_MODE, type PermissionAnswer, type PermissionMode } from "@shared/permission";
import type { ThinkingLevel as PiThinkingLevel } from "@earendil-works/pi-protocol";
import { isThinkingLevel, type ThinkingLevel } from "@shared/thinking";
import { modelThinkingLevels } from "@shared/model-defaults";
import type { AgentEvent, AgentStats, BuiltinProvider, RetryStatus, SubmitAgentInput } from "@shared/agent-ipc";
import { composeChannelPrompt, userRepliesNote, userRepliesSincePreviousReport } from "@shared/channel";
import type { ProviderDto } from "@shared/provider";
import { useBuiltinCatalog, usableProviders } from "../settings/model-menu";
import { modelPreferenceById } from "../settings/providers-view-model.ts";
import { reconcileThinkingLevel, resolveThinkingLevel } from "./thinking-choice.ts";
import { modelRequiredText } from "./model-required.ts";
import { collectScanAnswer, locateMessageRange, scanSubmitInput } from "./carryover-parse.ts";
import { isClosingScanText, parseWrapupScan } from "../../../../shared/wrapup-scan.ts";
import type { WrapupDraft, WrapupPlan, WrapupReviseResult } from "@shared/wrapup";
import { buildCarryoverFollowUp, buildCarryoverSeed } from "./carryover-resume.ts";
import {
  childSessions,
  rootSessions,
  SESSION_PAGE_RECORDS,
  type Carryover,
  type ChannelMarkRecord,
  type CompactedRecord,
  type SessionCompletion,
  type SessionMeta,
} from "@shared/session";
import type { FileTurnView, RevertPlan, RevertRecord, UndoPlan, UndoRecord } from "@shared/revert";
import { splitUserTextBlocks } from "@shared/prompt-attachments";
import type { Workspace } from "@shared/workspace";
import { pathTail } from "@shared/path";
import { stripInvocationBlock } from "../../../../shared/invocation.ts";
import type { Messages } from "../../messages-en.ts";
import { ipcErrorText } from "../../utils/ipc-error.ts";


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
/** 回退确认框的全部状态：计划 + 要放回输入框的那条原文（含附件）。 */
export interface RevertDialogState {
  sessionId: string;
  targetMessageId: string;
  plan: RevertPlan;
  /** 回退目标那条 user 记录（确认成功后原文放回输入框用） */
  message: Extract<TranscriptItem, { role: "user" }>;
}

/** 撤销确认框的状态。 */
export interface UndoDialogState {
  sessionId: string;
  turnId: string;
  plan: UndoPlan;
}

export interface ChatSession {
  sessionId: string | null;
  /**
   * 已加载窗口的往来流（源侧分页：**盘上是全量，这里是尾部一段**）。
   * 渲染、分组、锚点全按它算，与以前一样——只是开头可能还有没拉回来的更早历史。
   */
  transcript: readonly TranscriptItem[];
  /** 更早的历史还有没拉回来（尾窗之外还有记录）——顶部指示与触顶触发都读它 */
  hasMoreHistory: boolean;
  /** 更早的一页在途（顶部「正在加载更早的消息…」那一行） */
  loadingOlder: boolean;
  /**
   * 本槽成功并入的早页数（只增）。**滚动锚定拿它当判据**：它变了就是前面真补进来了一页
   * （拿窗口首条记录 id 比不出「重新种盘」与「真并页」的区别，槽里那个 id 两件事都会变）。
   */
  olderPages: number;
  /**
   * 拉更早的一页（滚动触顶时调）。**不满足条件时静默 no-op**（没有更早 / 在途 /
   * 锚点未知）——滚动处理器每帧都可能调它，不该为「已经到顶」报任何东西。
   */
  loadOlder: () => void;
  /** 压缩界碑（与 transcript 分开记账）；显示时由 applyCompactionBoundary 合成 */
  compactions: readonly CompactedRecord[];
  /**
   * 通道标记（子会话 PR4a，与 compactions 分开记账，同一条纪律）：盘上读回的
   * `ChannelMarkRecord`；显示时由 `mergeSideRecords` 按时间插回往来流。
   */
  marks: readonly ChannelMarkRecord[];
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
  /** 按 id 查回合失败标注（槽里有真相）——未读标记的 failed 快照用，与「当前看哪条」无关 */
  turnErrorOf: (id: string) => string | null;
  /** 按 id 查挂着的工具审批（槽里有真相）——竖条「在等你」要读到后台会话的审批 */
  approvalsOf: (id: string) => readonly PendingApproval[];
  error: string | null;
  /** 当前查看会话的输入框草稿——**按会话隔离**，切换 / 新开会话互不带走 */
  draft: string;
  /** 写当前查看会话的草稿 */
  setDraft: (value: string) => void;
  /** 当前查看会话输入框里的附图——与草稿同一把键隔离，发送 / 排队时一起带走 */
  attachments: readonly ComposerImage[];
  /** 挑选 / 粘贴 / 拖进来的文件：图片读成 base64、其余按路径引用；被拒的点名报在 error 上 */
  attachIncoming: (files: readonly File[]) => void;
  removeAttachment: (id: string) => void;
  /** 回形针「添加文件夹」：主进程目录选择器，选中目录按拖入同一套分拣入列 */
  attachFolderRefs: () => Promise<void>;
  /** 当前查看会话输入框里的文件引用（纯路径，模型用 read 工具自己读） */
  files: readonly ComposerFileRef[];
  /** 文件面板「引用到输入卡」的入口：原位置引用（不复制），去重走同一套分拣 */
  attachFileRef: (ref: { path: string; name: string; kind: "file" | "dir" }) => void;
  removeFile: (id: string) => void;
  /** 当前查看会话草稿里的粘贴块（方案 C：收起 = 句中胶囊 token，展开 = 铺底色区间） */
  pasted: readonly ComposerPasteBlock[];
  /** 大段粘贴成块（Composer 已按阈值拦下、在光标处插 token）：建块并返回 seq */
  addPasteBlock: (text: string) => number;
  /** 展开：区间写回块状态（文本替换 Composer 已做） */
  expandPaste: (seq: number, range: { start: number; end: number }) => void;
  /** 收起：把区间里的现文（可能已编辑过）存回块，折回收起态 */
  collapsePaste: (seq: number, text: string, lines: number) => void;
  /** 当前查看会话输入框里的文字引用（同一把键隔离）；发送时展开成引用块拼在文字前面 */
  quotes: readonly TextQuote[];
  /** 加一条引用。同一条消息里的同一段重复加不重复记 */
  addQuote: (quote: TextQuote) => void;
  removeQuote: (index: number) => void;
  mode: PermissionMode;
  changeMode: (next: PermissionMode) => void;
  /** 当前查看会话的思考档（意图；clamp 真值经事件自动纠） */
  thinkingLevel: ThinkingLevel;
  changeThinkingLevel: (next: ThinkingLevel) => void;
  /** 模型支持的思考档（开轮事件回的真值）。null = 还没开过轮，未知 */
  thinkingSupported: readonly PiThinkingLevel[] | null;
  /** pi 内建目录（引擎一份 fetch 的透传，见 SessionEngine.catalog）——ComposerBar 从这读 */
  catalog: readonly BuiltinProvider[];
  approvals: PendingApproval[];
  /** 侧栏列的工作区（落盘、跨会话）。 */
  workspaces: Workspace[];
  addWorkspace: () => void;
  /** 命名新建：在 ~/Orbita/<name>/ 建文件夹并加进来。名字不合法由主进程拒（错误走列表那行） */
  createWorkspace: (name: string) => void;
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
  /** 没选工作区时的兜底（今天是 ~/Orbita/Home）。UI 必须如实显示它，不能让它是个隐形默认。 */
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
   * context」）。cwd / 归属跟随来源会话；新会话收尾确认时这条遗留事项自动标为做完。
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
  /** 扫描完成待确认的清单（计划 + 智能体给的初稿）；正在查看发起会话时在 footer 显示确认卡 */
  scanResult: { sessionId: string; plan: WrapupPlan; draft: WrapupDraft } | null;
  /** 点「Mark task done」：正常路径发扫描，只读（无 pi 本子）降级为纯标记 */
  startClosingRitual: () => void;
  /** 确认清单：做完的事落账、留下的事进遗留清单、会话标完成（主进程一次办完） */
  confirmCarryovers: (draft: WrapupDraft) => void;
  /** 按用户一句话改清单（家务活模型，不进会话） */
  reviseWrapup: (draft: WrapupDraft, feedback: string) => Promise<WrapupReviseResult>;
  /** 取消（已过二次确认）：丢弃清单，setCompletion(done) */
  cancelCarryovers: () => void;
  /** 扫描降级 / 结果的一句反馈；下一次发起扫描或打开会话时清 */
  scanNotice: string | null;
  /**
   * 读不懂扫描结果时的重试（重发同一条扫描消息）。null = 没有可重试的失败。
   * 解析失败不再只留一句「已标完成」就完事——那是把失败变成死胡同。
   */
  retryClosingScan: (() => void) | null;
  /** 轮尾文件账（fileTurn 事件 + 盘上种子）——轮尾卡片的数据源 */
  fileTurns: readonly FileTurnView[];
  /** 回退界碑（盘上种子）——「已回退」标记行与还原卡 */
  reverts: readonly RevertRecord[];
  /** 撤销记录（盘上种子）——轮尾卡的「已撤销」徽标 */
  undos: readonly UndoRecord[];
  /**
   * 「回到这里」入口（user 气泡）：拉回退计划并弹确认框。确认后走 confirmRevert。
   * 原文（含附件）放回输入框是 executeRevert 成功后的动作，见 confirmRevert。
   */
  revertToMessage: (messageId: string) => void;
  /** 确认框正在展示的回退计划；null = 无框 */
  revertDialog: RevertDialogState | null;
  /** 回退在途：确认框转圈、双提交防抖 */
  revertBusy: boolean;
  confirmRevert: () => void;
  cancelRevert: () => void;
  /** 轮尾卡的撤销入口：拉撤销计划并弹确认框 */
  undoTurn: (turnId: string) => void;
  undoDialog: UndoDialogState | null;
  /** 撤销在途 */
  undoBusy: boolean;
  confirmUndo: () => void;
  cancelUndo: () => void;
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
  /* ---------- 意图系统（实验功能 intent-system） ---------- */
  /** 终态召回卡（实时事件 + 盘上种子；同一 turn 只留最后一张） */
  intentRecalls: readonly IntentRecallRecord[];
  /** 运行中的召回卡（流事件归约）；终态记录到达后回 null */
  intentRun: RecallCardState | null;
  /** 挂起的回答前确认；null = 没有 */
  intentAsk: Extract<AgentEvent, { type: "intentAsk" }> | null;
  /** 确认卡的回答（对不上号的陈旧应答由 runtime 丢弃） */
  answerIntentConfirm: (requestId: string, decision: IntentConfirmDecision) => void;
  /** 会话级召回开关：null = 没有会话（新任务）；undefined = 没开实验功能 */
  intentEnabled: boolean | null | undefined;
  setIntentEnabled: (next: boolean) => void;
  /** 乐观回显：发出即画的用户气泡（真回显事件一到即清）。ephemeral */
  pendingEcho: { blocks: readonly string[] } | null;
}

/** 查看槽回踩引擎用的窄接口——避免引擎与视图互相持有完整类型 */
interface ViewHandle {
  readonly sessionRef: Readonly<{ current: string | null }>;
  /** 正在看的会话 id（含盘上打开、未唤醒的：sessionRef 为 null、opened 在）。
  * model / thinking 事件按它路由——盘上打开的会话切模型后事件可能要几秒才回
  * （agent 进程冷启动），期间任何一次 openSession 都拿旧 meta 把 chip 播种回去，
  * 迟到的事件必须能纠回正看着的槽 */
  readonly viewedIdRef: Readonly<{ current: string | null }>;
  /** model 事件回环对齐（C-4）：只对齐正看着那条会话的槽 */
  alignModel(event: { providerId: string; modelId: string }): void;
  alignThinking(event: { level: PiThinkingLevel }): void;
  /** 档位被父会话切档联动改了（主进程已落 meta / runtime）：mode 芯片对齐 */
  alignMode(mode: PermissionMode): void;
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
  /**
   * pi 内建目录：模型项的 ctx 徽标、思考档支持集都要从这里查官方参数——
   * 一个 app 一次 fetch（此前 ComposerBar 与设置面各自 `useBuiltinCatalog()`，
   * 移到引擎后 ComposerBar 改读这一份）。拉不到就空数组，不挡开工。
   */
  readonly catalog: readonly BuiltinProvider[];
  /**
   * 用户在**本次运行内**手选的思考档，跨会话/跨模型全局共用（两个查看槽共用
   * 同一份——「用户上一次手选」本来就是全局的）。null = 这次运行还没手选过。
   * **不落盘**：彻底重启就丢，新任务槽落回模型默认档（wafo 2026-09-23 裁决）。
   * changeThinkingLevel 直接写它；程序性改档（换模型时的自动调整）不写。
   */
  readonly pickedThinkingRef: { current: ThinkingLevel | null };
  /** 当前界面语言的文案表（useChatSession 由 App 传入，每次渲染同步）——引擎与查看槽报给界面的句子从这里取 */
  readonly messagesRef: Readonly<{ current: Messages }>;
  /** 分槽状态（渲染值）。查看槽从这里按自己的 session id 取 entry。 */
  readonly states: SessionStates;
  /** 已挂载的查看槽名册：model 事件路由 / 删除通知 / meta 同步按它来 */
  readonly views: Set<ViewHandle>;
  /** 与 states 同步的镜像（见 statesRef 的历史注释，引擎内即时写） */
  readonly statesRef: Readonly<{ current: SessionStates }>;
  /** 幂等应用一次状态变更（并同步镜像）——查看槽的队列操作走这里 */
  applyStates(fn: (prev: SessionStates) => SessionStates): void;
  /**
   * renderer 发起一轮（submit / compact）前乐观置 turn，返回 IPC 失败时调的归位。
   * 归位带防踩（revertOptimisticTurn）：期间来过 phase 事件就不动，交给 runtime 的 idle。
   */
  beginOptimisticTurn(id: string): () => void;
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
   * 子会话档位联动（renderer 侧）：用户切父会话档时，主进程已把子会话的 runtime
   * 账与 meta 一起切（applyModeCascade，agent 域）；这里同步三样衍生状态——
   *   ① 子会话的会话级意图覆写（intent 优先于 meta：buildTurn / openSession 都
   *      先读它，不覆写的话下一轮 submit 仍带旧档、切回子会话 chip 也显示旧档）；
   *   ② 会话列表缓存乐观更新（Sub-sessions 面板等直读这份缓存）；
   *   ③ 正看着某条子会话的查看槽，mode 芯片对齐。
   */
  cascadeSubSessionModes(parentId: string, mode: PermissionMode): void;
  /**
   * 组装无状态开工上下文（AgentTurnContext 的主体）：meta 真值（cwd / 归属 /
   * pi 本子）+ 会话级意图。拿不出可用上下文时把错误写进引擎 error 并返回 null。
   */
  buildTurn(id: string): Omit<SubmitAgentInput, "sessionId" | "text"> | null;
  /** 没选模型时的发送报错文案：有服务商但没选 →「先选一个模型」，一个都没有 → 原文 */
  readonly modelMissingText: () => string;
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
  readonly approvalsOf: (id: string) => readonly PendingApproval[];
  readonly answerApproval: (requestId: string, answer: PermissionAnswer) => void;
  /** 意图确认卡的回答（实验功能 intent-system） */
  readonly answerIntentConfirm: (requestId: string, decision: IntentConfirmDecision) => void;
  /** 乐观回显：发出即画用户气泡（真回显事件一到即清）。ephemeral */
  readonly setPendingEcho: (id: string, blocks: readonly string[]) => void;
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

export function useChatSessionEngine(providers: ProviderDto[], t: Messages): SessionEngine {
  // 文案表的同步镜像：报错与收尾提示在异步回调里产生，要读产生那一刻的界面语言
  const messagesRef = useRef(t);
  messagesRef.current = t;
  // pi 内建目录：全应用一份，ComposerBar 与查看槽的新任务起档都从这里读
  const catalog = useBuiltinCatalog();
  // 本次运行内的手选思考档：纯内存 ref，不落盘（见 SessionEngine.pickedThinkingRef 注释）
  const pickedThinkingRef = useRef<ThinkingLevel | null>(null);
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

  const beginOptimisticTurn = useCallback(
    (id: string): (() => void) => {
      const epoch = (statesRef.current.get(id) ?? EMPTY_ENTRY).phaseEpoch;
      applyStates((prev) => setEntryPhase(prev, id, "turn"));
      return () => applyStates((prev) => revertOptimisticTurn(prev, id, epoch));
    },
    [applyStates],
  );

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
  }>({
    model: null,
    mode: DEFAULT_PERMISSION_MODE,
    thinkingLevel: "medium",
    cwd: null,
    workspaceId: null,
    defaultCwd: "",
  });
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
   * 子会话档位联动（renderer 侧）。真值由主进程落盘，这里只同步衍生状态——
   * 缓存里还没有的子会话（刚派出、列表未刷新）跳过：它没有旧 intent 可挡，
   * meta 已被主进程切，buildTurn 拿到的就是新档。
   */
  const cascadeSubSessionModes = useCallback(
    (parentId: string, mode: PermissionMode) => {
      const children = childSessions(sessionsRef.current, parentId);
      if (children.length === 0) return;
      const childIds = new Set(children.map((child) => child.id));
      const next = sessionsRef.current.map((meta) =>
        childIds.has(meta.id) ? { ...meta, mode } : meta,
      );
      sessionsRef.current = next;
      setSessions(next);
      for (const child of children) {
        rememberSessionIntent(child.id, { mode });
        for (const view of views.current) {
          if (view.sessionRef.current === child.id) view.alignMode(mode);
        }
      }
    },
    [rememberSessionIntent],
  );

  /**
   * 组装无状态开工上下文（AgentTurnContext 的主体）：meta 真值（cwd / 归属 /
   * pi 本子）+ 当前意图（模型 / 档位）。新会话（meta 还没落盘）用投递兜底。
   * 拿不出可用上下文时把错误写进红字并返回 null——调用方直接放弃这一跳。
   */
  const buildTurn = useCallback(
    (id: string): Omit<SubmitAgentInput, "sessionId" | "text"> | null => {
      const intent = intentRef.current;
      const meta = sessionsRef.current.find((entry) => entry.id === id) ?? null;
      const cwdTarget = meta?.cwd ?? intent.cwd ?? intent.defaultCwd;
      if (cwdTarget === "") {
        setError(messagesRef.current.session.noWorkspaceFolder);
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
      // meta 的 provider 已不在可用列表里时不认：导入的会话落的是占位 provider
      // （导入与模型解耦，2026-09-28 裁决），provider 被删的旧会话同理——改拿投递兑底
      // （用户当下选的模型），不把无效 id 送去主进程
      const metaModel =
        meta !== null && usableRef.current.some((provider) => provider.id === meta.providerId)
          ? { providerId: meta.providerId, modelId: meta.modelId }
          : null;
      const model = own?.model ?? metaModel ?? intent.model;
      if (model === null) {
        setError(modelRequiredText(usableRef.current.length > 0, messagesRef.current));
        return null;
      }
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
   *
   * **发出前乐观置 turn**（与 send 直发同一条规矩）：runtime 收到 submit 就占坑，
   * 但它的 turn 事件要等 open 完、agent_start 才来（几百毫秒）。不填这段空档的话，
   * 这期间用户回车会被当成「空闲直发」、撞 already running，开头就是
   * 「发出去的字留在输入框里」那条链（2026-09-28 CDP 复现）。
   */
  const deliverNext = useCallback(
    (id: string) => {
      const entry = statesRef.current.get(id);
      if (entry === undefined) return;
      const head = nextDeliverable(entry);
      if (head === null) return;
      applyStates((prev) => dequeue(prev, id, head.id));
      const dispatch = (request: () => Promise<void>): void => {
        const revert = beginOptimisticTurn(id);
        request().catch((cause: unknown) => {
          setError(ipcErrorText(cause));
          revert();
        });
      };
      if (head.kind === "compact") {
        const turn = buildTurn(id);
        if (turn === null) return;
        dispatch(() =>
          api.agent.compact({
            sessionId: id,
            ...turn,
            ...(head.instructions !== undefined ? { instructions: head.instructions } : {}),
          }),
        );
      } else if (head.kind === "channel") {
        // 子会话 PR4a：子→父投递就在这里发生——子标题从 sessionsRef 真值查
        // （查不到用 ""，composeChannelPrompt 自己会写 Untitled，不是哨兵值）。
        // buildTurn 已支持从 meta 装配从没在本窗口打开过的会话（新会话/新槽由
        // dequeue/enqueue 就地建），父会话不必先被用户点开过才能收到子的消息。
        const childTitle = sessionsRef.current.find((meta) => meta.id === head.childId)?.title ?? "";
        const envelope = composeChannelPrompt(head.message, { id: head.childId, title: childTitle });
        const turn = buildTurn(id);
        if (turn === null) return;
        // 用户在收件箱里代父回复过的话，父模型上下文里没有：投递前从账本取出，拼在信封后
        // （userRepliesSincePreviousReport 的注释）。读账本失败就照原样投递，不拦这一轮。
        dispatch(async () => {
          const ledger = await api.channel.load({ parentId: id, childId: head.childId }).catch(() => []);
          const note = userRepliesNote(userRepliesSincePreviousReport(ledger, head.message.id));
          const text = note === "" ? envelope : `${envelope}\n${note}`;
          await api.agent.submit({ sessionId: id, text, ...turn });
        });
      } else {
        const turn = buildTurn(id);
        if (turn === null) return;
        // 乐观回显同直发路径：投递那一刻先画气泡（真回显一到即换下）
        applyStates((prev) => setPendingEcho(prev, id, splitEchoBlocks(head.text)));
        dispatch(() =>
          api.agent.submit({
            sessionId: id,
            text: head.text,
            ...imagesField(head.images),
            ...filesField(head.files),
            ...turn,
          }),
        );
      }
    },
    [applyStates, beginOptimisticTurn, buildTurn],
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
        // 会话列表何时重拉（一轮跑完 / 模型标题 / 换模型 / 列表里没有的会话开轮）：
        // 规则与理由在 session-list-refresh.ts。refreshSessions 是异步的（IPC 回来才
        // 回填），排在下面 model 的 alignModel 前面调用不改变先后
        if (shouldRefreshSessions(event, sessionsRef.current)) refreshSessions();
        // 会话内模型切换成功（C-4，主进程已落 meta）：对齐**正看着那条**的槽——
        // 双槽下事件泵不知道哪个槽在看，路由交给已注册的查看槽。按 viewedId
        // （活会话 ?? 盘上打开的）路由：盘上打开的会话切模型后事件可能要几秒才回
        // （agent 进程冷启动），期间 openSession 已拿旧 meta 把 chip 播种回去了，
        // 迟到的事件要能纠回正看着的槽（2026-10-08 验收实测的竞态）
        if (event.type === "model") {
          for (const view of views.current) {
            if (event.sessionId === view.viewedIdRef.current) {
              view.alignModel(event);
              break;
            }
          }
        }
        // 思考档真值（clamp 后事实）到了：同一条路由规则对齐
        if (event.type === "thinking") {
          for (const view of views.current) {
            if (event.sessionId === view.viewedIdRef.current) {
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

  /**
   * 子会话 PR4a：子→父投递。通道消息落账 + 广播是主进程的事（`applyChannelSend` /
   * `applyDelegate`），**排队所有权在这里**——子→父恒 followUp，进父的 renderer
   * 队列，父空闲立即开一轮、在跑等这轮结束（既有的 phase 事件 deliverNext 会
   * 接手）。父→子由主进程直接投递（steer / 空闲开轮），renderer 不管，所以这里
   * 只认 `message.from === "child"` 的事件。
   */
  useEffect(() => {
    const off = api.channel.onEvent((event) => {
      if (event.type !== "message" || event.message.from !== "child") return;
      // enqueueChannelMessage 内建按 message.id 去重：订阅重连等场景同一条事件
      // 重复到达不会让队列里出现两条一样的话。
      applyStates((prev) =>
        enqueueChannelMessage(prev, event.parentId, {
          id: event.message.id,
          kind: "channel",
          childId: event.childId,
          message: event.message,
        }),
      );
      // 父此刻空闲就立即投；在跑的话 nextDeliverable 在这里会拿到 null，
      // 是安全的 no-op——真正的投递等这一轮 phase 回 idle 时上面那个
      // agent.onEvent 效果里的 deliverNext 调用点接手。
      deliverNext(event.parentId);
    });
    return off;
  }, [applyStates, deliverNext]);

  /** 「配置好」的标准与设置面的命名模型菜单同源（model-menu），不各写一份 */
  const usable = useMemo(() => usableProviders(providers), [providers]);
  /** usable 的 ref 镜像：事件回调（buildTurn / modelMissingText）在闭包里也要读最新一份 */
  const usableRef = useRef(usable);
  usableRef.current = usable;

  /**
   * 没选模型时的发送报错（model-required.ts 的取舍）：有可用服务商但没选模型
   * →「先选一个模型」（导入的会话正是这个状态）；一个都没有 → 原来的「先添服务商」。
   */
  const modelMissingText = useCallback(
    () => modelRequiredText(usableRef.current.length > 0, messagesRef.current),
    [],
  );

  const answerApproval = useCallback(
    (requestId: string, answer: PermissionAnswer) => {
      applyStates((prev) => removeApproval(prev, requestId));
      void api.agent.answerPermission(requestId, answer);
    },
    [applyStates],
  );

  /** 乐观回显：与 beginOptimisticTurn 同拍写入（发出那一刻），真回显清掉它 */
  const setPendingEchoCb = useCallback(
    (id: string, blocks: readonly string[]) => {
      applyStates((prev) => setPendingEcho(prev, id, blocks));
    },
    [applyStates],
  );

  // 意图确认卡的回答（实验功能）：摘掉挂起的请示再送 agent 进程（按 requestId 对号）
  const answerIntentConfirm = useCallback(
    (requestId: string, decision: IntentConfirmDecision) => {
      applyStates((prev) => removeIntentAsk(prev, requestId));
      void api.agent.answerIntentConfirm(requestId, decision);
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
    // 子会话不参与归档（session.ts 的契约：它们永不进左栏/Archived，母会话归档
    // 与否也不影响它——子会话 PR4c 2.3）；rootSessions 过滤，不止是不显示它，
    // 批量动作本身就不该碰它
    const targets = rootSessions(sessionsRef.current).filter(
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

  // 引用稳定的按 id 查询：都经 ref 读最新值，闭包不必每次渲染重建——
  // PR4a 的派出卡（TranscriptColumn 的 memo）新引入了 childPhaseOf 这个消费者，
  // 不稳定的话每次引擎渲染都会传一个新函数进去，直接打穿那层 memo（见 TranscriptColumn 的注释）。
  const phaseOf = useCallback(
    (id: string): SessionEntry["phase"] => statesRef.current.get(id)?.phase ?? "idle",
    [],
  );
  const turnErrorOf = useCallback(
    (id: string): string | null => statesRef.current.get(id)?.turnError ?? null,
    [],
  );
  // 按 id 查挂着的审批（2026-10-10 未读/竖条一刀）：竖条「在等你」要读到后台
  // 会话的审批，不只当前看着的那条；与 phaseOf / turnErrorOf 同一套 ref 读法
  const approvalsOf = useCallback(
    (id: string): readonly PendingApproval[] => statesRef.current.get(id)?.approvals ?? [],
    [],
  );

  return {
    catalog,
    messagesRef,
    pickedThinkingRef,
    states,
    answerIntentConfirm,
    setPendingEcho: setPendingEchoCb,
    statesRef,
    views: views.current,
    applyStates,
    beginOptimisticTurn,
    syncIntent,
    sessionIntent: sessionIntentRef,
    rememberSessionIntent,
    cascadeSubSessionModes,
    buildTurn,
    modelMissingText,
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
    phaseOf,
    turnErrorOf,
    approvalsOf,
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
/** 草稿 = 文本 + 粘贴块同体（paste-blocks.ts 的方案 C：token 在文本里，全文在块里） */
interface DraftState {
  text: string;
  pasted: readonly ComposerPasteBlock[];
}

/** 粘贴块的 token 序号：模块级只增计数器——不随块删除回收，撤销 / 回退还原出的
 *  token 永不与后来的块撞号；两个查看槽（主槽 / 抽屉）共用同一把，天然不撞 */
let pasteSeqCounter = 0;
function nextPasteSeq(): number {
  pasteSeqCounter += 1;
  return pasteSeqCounter;
}

/** 没有附图时的稳定引用——每次渲染一个新 [] 会让 send 的依赖每帧都变 */
const NO_ATTACHMENTS: readonly ComposerImage[] = [];
const NO_FILES: readonly ComposerFileRef[] = [];
const NO_PASTED: readonly ComposerPasteBlock[] = [];
const NO_QUOTES: readonly TextQuote[] = [];

/** 附图载荷：空就不带字段，纯文字消息的 IPC 载荷与以前一字不差 */
function imagesField(images: readonly PromptImage[] | undefined): { images?: PromptImage[] } {
  return images !== undefined && images.length > 0 ? { images: [...images] } : {};
}

/** 文件引用载荷：只带路径事实（id 是 renderer 本地的，不出门） */
function filesField(files: readonly ComposerFileRef[] | undefined): { files?: PromptFileRef[] } {
  return files !== undefined && files.length > 0
    ? { files: files.map(({ path, name, kind, origin }) => ({ path, name, kind, origin })) }
    : {};
}

export function useSessionView(engine: SessionEngine, key: string): ChatSession {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  /** 本槽成功并入的早页数（滚动锚定的判据，见 ChatSession.olderPages） */
  const [olderPages, setOlderPages] = useState(0);
  const [opened, setOpened] = useState<SessionMeta | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [model, setModel] = useState<{ providerId: string; modelId: string } | null>(null);
  const [mode, setMode] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE);
  // 思考档初始 medium：不是新拍的默认，是这些会话一直实际在跑的那一档（pi 出厂默认）
  const [thinkingLevel, setThinkingLevelState] = useState<ThinkingLevel>("medium");
  const sessionRef = useRef<string | null>(null);

  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  /**
   * **新任务槽**起档：按「手选（若这个型号仍支持）> 这个型号的默认档」重算并
   * 置本地状态（thinking-choice.ts 的 resolveThinkingLevel）——用户裁决
   * （wafo 2026-09-23）的落点。只用于「本槽还没有会话」的时机（启动恢复 /
   * 默认播种 / 回首页开新任务 / 换模型且本槽无会话）；有会话时档位跟着
   * 会话账走，是另一条路（changeThinkingLevel / chooseModel 换模型分支）。
   */
  const { catalog, pickedThinkingRef, usable } = engine;
  const applyNewTaskThinking = useCallback(
    (providerId: string, modelId: string) => {
      // 支持集按「哪家服务商的哪个型号」算：同一个 kimi-k3，OpenCode Go 上只有 max
      const supported = modelThinkingLevels(modelId, catalog, null, modelPreferenceById(usable, providerId));
      setThinkingLevelState(resolveThinkingLevel({ modelId, supported, picked: pickedThinkingRef.current }));
    },
    // 只依赖 catalog、usable 与 ref：engine 是每次渲染新建的对象，依赖它会让下面依赖本函数的
    // effect 每次渲染都跑一遍（usable 是 useMemo 出来的，providers 不变它就不变）
    [catalog, usable, pickedThinkingRef],
  );

  /**
   * 启动恢复（A-0 复验 bug A）：上次退出前用的权限档/模型存在 settings.lastUsed，
   * 挂载后恢复一次（思考档不在其列：重启落回模型默认档，wafo 2026-09-23）——
   * 只影响「还没打开会话」的新任务槽；打开旧会话时
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
        if (last.providerId !== undefined && last.modelId !== undefined) {
          setModel({ providerId: last.providerId, modelId: last.modelId });
          // 恢复了模型之后，思考档按规则起（手选 > 这个模型的默认档）——
          // 不是巧合地停在初始 medium
          applyNewTaskThinking(last.providerId, last.modelId);
        }
      })
      .catch(() => undefined); // 读不出来就停在默认，不挡开工
  }, []);

  /**
   * 输入框草稿**按会话隔离**（含首页）：key = 当前查看的会话 id，首页用 "home"。
   * 以前是全局单份，切换 / 新开会话草稿跟着走（2026-09-10 用户裁决：新会话就是
   * 新的，旧会话的草稿留在原地等他回来）。纯内存，不落盘——与旧行为一致。
   */
  const [drafts, setDrafts] = useState<ReadonlyMap<string, DraftState>>(new Map());
  /** 草稿 = 文本 + 粘贴块同体（paste-blocks.ts）：展开区间随每次文本编辑搬运、
   *  撤销对账也在这里做——两个状态分开存，搬运就没有单点可依 */
  const writeDraft = useCallback((draftKey: string, value: string) => {
    setDrafts((prev) => {
      const current = prev.get(draftKey);
      if (current?.text === value) return prev;
      const pasted =
        current === undefined || current.pasted.length === 0
          ? NO_PASTED
          : repositionBlocks(current.text, value, current.pasted);
      return new Map(prev).set(draftKey, { text: value, pasted });
    });
  }, []);
  /** 只动粘贴块（成块 / 展开 / 收起），文本不动——文本那条路自己会搬运区间 */
  const writeBlocks = useCallback(
    (draftKey: string, update: (current: readonly ComposerPasteBlock[]) => readonly ComposerPasteBlock[]) => {
      setDrafts((prev) => {
        const current = prev.get(draftKey);
        const before = current?.pasted ?? [];
        const after = update(before);
        if (after === before) return prev;
        if (current === undefined && after.length === 0) return prev;
        return new Map(prev).set(draftKey, { text: current?.text ?? "", pasted: after });
      });
    },
    [],
  );
  /** 文字引用：同附图的规矩（按会话隔离，纯内存）。发送 / 排队时展开进正文，撤回时解析回来 */
  const [quoteMap, setQuoteMap] = useState<ReadonlyMap<string, readonly TextQuote[]>>(new Map());
  const writeQuotes = useCallback(
    (draftKey: string, update: (current: readonly TextQuote[]) => readonly TextQuote[]) => {
      setQuoteMap((prev) => {
        const current = prev.get(draftKey) ?? [];
        const next = update(current);
        if (next === current) return prev;
        const map = new Map(prev);
        if (next.length === 0) map.delete(draftKey);
        else map.set(draftKey, next);
        return map;
      });
    },
    [],
  );
  /** 附图与草稿同一把键、同一条规矩：按会话隔离，纯内存，不落盘 */
  const [attachmentMap, setAttachmentMap] = useState<ReadonlyMap<string, readonly ComposerImage[]>>(new Map());
  const writeAttachments = useCallback(
    (draftKey: string, update: (current: readonly ComposerImage[]) => readonly ComposerImage[]) => {
      setAttachmentMap((prev) => {
        const current = prev.get(draftKey) ?? [];
        const next = update(current);
        if (next === current) return prev;
        const map = new Map(prev);
        if (next.length === 0) map.delete(draftKey);
        else map.set(draftKey, next);
        return map;
      });
    },
    [],
  );
  /** 文件引用与粘贴文本块：与附图同一把键、同一条规矩 */
  const [fileMap, setFileMap] = useState<ReadonlyMap<string, readonly ComposerFileRef[]>>(new Map());
  const writeFiles = useCallback(
    (draftKey: string, update: (current: readonly ComposerFileRef[]) => readonly ComposerFileRef[]) => {
      setFileMap((prev) => {
        const current = prev.get(draftKey) ?? [];
        const next = update(current);
        if (next === current) return prev;
        const map = new Map(prev);
        if (next.length === 0) map.delete(draftKey);
        else map.set(draftKey, next);
        return map;
      });
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

  // 清空的补种：正开着的会话 meta 从占位变成真实模型（设置 › 服务商的「分配
  // 模型」），列表刷新把新 meta 送来时种回模型栏——此前它被上面清成了「没有模型」。
  // 只补 null：用户手选的（非 null）永远不动，不替任何人改选择。
  useEffect(() => {
    if (model !== null || opened === null) return;
    const provider = engine.usable.find((p) => p.id === opened.providerId);
    if (provider !== undefined && provider.models.declared.some((m) => m.id === opened.modelId)) {
      setModel({ providerId: opened.providerId, modelId: opened.modelId });
    }
  }, [engine.usable, model, opened]);

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
  // viewedId 镜像（事件路由用，见 ViewHandle.viewedIdRef）：「正看着哪条」＝活会话优先，
  // 否则盘上打开的那条。注册只一次，闭包里的 opened 会陈旧，ref 永远新鲜
  const viewedIdRef = useRef<string | null>(null);
  useEffect(() => {
    viewedIdRef.current = sessionId ?? opened?.id ?? null;
  }, [sessionId, opened]);
  useEffect(() => {
    const handle: ViewHandle = {
      sessionRef,
      viewedIdRef,
      alignModel: (event) => setModel({ providerId: event.providerId, modelId: event.modelId }),
      // 档位联动对齐：父会话切档带过来的新档直接上 chip（值只来自用户切档路径）
      alignMode: (mode) => setMode(mode),
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
  const draft = drafts.get(draftKey)?.text ?? "";
  const setDraft = (value: string) => writeDraft(draftKey, value);
  const attachments = attachmentMap.get(draftKey) ?? NO_ATTACHMENTS;
  const files = fileMap.get(draftKey) ?? NO_FILES;
  const pasted = drafts.get(draftKey)?.pasted ?? NO_PASTED;
  const quotes = quoteMap.get(draftKey) ?? NO_QUOTES;

  const addQuote = useCallback(
    (quote: TextQuote) => {
      // 准入（shared/quote.ts 的 acceptQuote）：重复沿用旧规则静默去重；
      // 总字数超上限要说出原因——藏住一条用户看得见却发不出
      // 的引用，比报一句更糟
      const verdict = acceptQuote(quoteMap.get(draftKey) ?? [], quote);
      engine.setError(verdict.reason === "too-long-total" ? engine.messagesRef.current.quote.tooLongTotal(QUOTE_MAX_TOTAL_CHARS) : null);
      if (!verdict.accepted) return;
      writeQuotes(draftKey, (current) => [...current, quote]);
    },
    [draftKey, quoteMap, writeQuotes, engine],
  );
  const removeQuote = useCallback(
    (index: number) => writeQuotes(draftKey, (current) => current.filter((_, i) => i !== index)),
    [draftKey, writeQuotes],
  );

  /**
   * 收外部进来的文件（按钮选择 / 粘贴 / 拖放，三条入口同流）。按 MIME 分流：
   * 图片走 base64 管线（admitImages，agent 进程缩放后进模型）；其余一切文件按
   * **纯路径引用**（admitFileRefs，发送时主进程把副本收进会话目录）——内容模型
   * 用 read 工具自己读。分拣是同步的（被拒的当场点名）；读图是异步的——**键在
   * 进来那一刻定下**，读完时用户就算切到别的会话，图也落回它被拖进来的那个输入框。
   * 文件先按 file 同步入列、再向主进程问一次真实类型（拖入的目录在 renderer 里
   * 分不出来，发送时的 lstat 纠正又太晚——图标与名字当场就该是对的）；问不到就
   * 留在 file，发送侧的纠正仍兑底。
   */
  const attachIncoming = useCallback(
    (incoming: readonly File[]) => {
      if (incoming.length === 0) return;
      const key = draftKey;
      const t = engine.messagesRef.current;
      const imageCandidates = incoming.filter((file) => PROMPT_IMAGE_MIME_TYPES.includes(file.type));
      const fileCandidates = incoming.filter((file) => !PROMPT_IMAGE_MIME_TYPES.includes(file.type));
      // 总量线要算上已在输入框里的图：两批各自不超线、叠加却超线时，第二批该被拦下
      const currentImages = attachmentMap.get(key) ?? [];
      const { accepted: acceptedImages, rejected: imageRejected } = admitImages(
        imageCandidates,
        currentImages.length,
        promptImagesBytes(currentImages.map((item) => item.image)),
      );
      const { accepted: acceptedFiles, rejected: fileRejected } = admitFileRefs(
        fileCandidates.map((file) => ({ path: api.window.getPathForFile(file), name: file.name })),
        fileMap.get(key) ?? [],
      );
      const notice = [rejectionText(imageRejected, t), fileRefRejectionText(fileRejected, t)]
        .filter((line) => line !== null)
        .join(" ");
      engine.setError(notice === "" ? null : notice);
      if (acceptedFiles.length > 0) {
        // id 在入列那一刻铸好，stat 回来按它贴回类型；发送与这次写入不互相等
        const entries = acceptedFiles.map((ref) => ({
          id: crypto.randomUUID(),
          name: ref.name,
          path: ref.path,
          kind: "file" as const,
          origin: "external" as const,
        }));
        writeFiles(key, (current) => [...current, ...entries]);
        void api.files
          .statKind(entries.map((entry) => entry.path))
          .then((facts) => {
            // kind 为 null（stat 不到）时按 file 收下：分拣不给附件添堵；超过复制
            // 上限的标「未复制」——发送时主进程会按原位置引用，胶囊上明说代价
            writeFiles(key, (current) =>
              withStatKinds(
                current,
                entries.map((entry, index) => ({
                  id: entry.id,
                  kind: facts[index]?.kind ?? "file",
                  uncopied: (facts[index]?.size ?? 0) > EXTERNAL_FILE_COPY_MAX_BYTES,
                })),
              ),
            );
          })
          .catch((cause: unknown) => {
            // 通道坏了维持 file 入列：发送时主进程的 lstat 纠正仍会给出真实类型
            console.error("[chat] 附件类型没问到，按文件入列", cause);
          });
      }
      if (acceptedImages.length === 0) return;
      // 图的名额在追加时再截一次：两批并发拖进来，各自分拣时都以为还有位子（文件不设名额）
      void Promise.allSettled(acceptedImages.map((file) => readAsPromptImage(file))).then((results) => {
        const read: ComposerImage[] = [];
        const failures: string[] = [];
        results.forEach((result, index) => {
          const name = acceptedImages[index]?.name ?? "";
          if (result.status === "fulfilled") read.push({ id: crypto.randomUUID(), name, image: result.value });
          else failures.push(t.composer.imageReadFailed(name));
        });
        if (failures.length > 0) engine.setError([notice, ...failures].filter((line) => line !== null).join(" "));
        writeAttachments(key, (current) => [...current, ...read].slice(0, PROMPT_IMAGE_MAX_COUNT));
      });
    },
    [engine, draftKey, attachmentMap, fileMap, writeAttachments, writeFiles],
  );

  const removeAttachment = useCallback(
    (id: string) => writeAttachments(draftKey, (current) => current.filter((item) => item.id !== id)),
    [draftKey, writeAttachments],
  );

  /**
   * 文件面板「引用到输入卡」：**原位置引用，不复制**——文件本来就在这条会话的
   * 根清单里（工作台 / 工作区 / 附加目录），agent 的 read 一定够得着，复制一份
   * 只会过期。去重走与拖入同一套分拣（重复引用会点名，不会无声无息）。
   */
  const attachFileRef = useCallback(
    (ref: { path: string; name: string; kind: "file" | "dir" }) => {
      const key = draftKey;
      const t = engine.messagesRef.current;
      const { accepted, rejected } = admitFileRefs([{ path: ref.path, name: ref.name }], fileMap.get(key) ?? []);
      engine.setError(fileRefRejectionText(rejected, t));
      if (accepted.length === 0) return;
      writeFiles(key, (current) => [
        ...current,
        ...accepted.map((item) => ({
          id: crypto.randomUUID(),
          name: item.name,
          path: item.path,
          kind: ref.kind,
          origin: "workspace" as const,
        })),
      ]);
    },
    [draftKey, fileMap, writeFiles, engine],
  );

  const removeFile = useCallback(
    (id: string) => writeFiles(draftKey, (current) => current.filter((item) => item.id !== id)),
    [draftKey, writeFiles],
  );

  /**
   * 回形针「添加文件夹」：主进程开目录选择器（多选；Windows 不允许与选文件同框，
   * 所以与「添加文件」分两个入口），选回来的与拖入同一套分拣入列。kind 直接记
   * dir——选择器只会给出目录，不必再问一遍 stat；origin external（发送时主进程
   * 不复制目录、按原位置引用，路径仍 realpath 成规范形）。取消选择器是用户的
   * 正常退出，不报错也不动草稿。
   */
  const attachFolderRefs = useCallback(async () => {
    const key = draftKey;
    let picked: string[] | null;
    try {
      picked = await api.files.pickFolders();
    } catch (cause: unknown) {
      console.error("[chat] 文件夹选择器打不开", cause);
      return;
    }
    if (picked === null || picked.length === 0) return;
    const t = engine.messagesRef.current;
    const { accepted, rejected } = admitFileRefs(
      picked.map((path) => ({ path, name: pathTail(path) === "" ? path : pathTail(path) })),
      fileMap.get(key) ?? [],
    );
    engine.setError(fileRefRejectionText(rejected, t));
    if (accepted.length === 0) return;
    writeFiles(key, (current) => [
      ...current,
      ...accepted.map((item) => ({
        id: crypto.randomUUID(),
        name: item.name,
        path: item.path,
        kind: "dir" as const,
        origin: "external" as const,
      })),
    ]);
  }, [draftKey, fileMap, writeFiles, engine]);

  /** 大段粘贴成块（方案 C）。seq 用模块级计数器发——只增不复用：撤销 / 回退还原
   *  出的 token 永不与后来的块撞号。返回值给 Composer 拼 token 用（同步要） */
  const addPasteBlock = useCallback(
    (text: string): number => {
      const seq = nextPasteSeq();
      writeBlocks(draftKey, (current) => [
        ...current,
        { id: crypto.randomUUID(), seq, text, lines: pastedTextSize(text).lines, range: null },
      ]);
      return seq;
    },
    [draftKey, writeBlocks],
  );

  const expandPaste = useCallback(
    (seq: number, range: { start: number; end: number }) => {
      writeBlocks(draftKey, (current) =>
        current.map((block) => (block.seq === seq ? { ...block, range } : block)),
      );
    },
    [draftKey, writeBlocks],
  );

  const collapsePaste = useCallback(
    (seq: number, text: string, lines: number) => {
      writeBlocks(draftKey, (current) =>
        current.map((block) => (block.seq === seq ? { ...block, text, lines, range: null } : block)),
      );
    },
    [draftKey, writeBlocks],
  );

  /**
   * 发送失败时的回填快照。send 直发分支在提交前就清空输入框，而失败可能发生在
   * 很后面（agent 进程的图片解码、主进程的 provider 装配）——不留快照的话，
   * 「第 1 张图片无法解码…没有发送」之后用户挑好的图 / 文件 / 长文全没了，只能
   * 重头再来（2026-09-27 用户实测报的）。快照的生死：
   *   - 消息**落账**（本会话的下一条用户条目回显到达）→ 作废，正常走；
   *   - 没等到回显就失败（failed）或归位（idle，含被停止）→ 内容放回输入框，
   *     换模型 / 改内容再发。放回用撤回同一套拼接与名额截断。
   */
  interface SentSnapshot {
    sessionId: string;
    draftKey: string;
    /** 本条新建的会话（首页首条消息）：失败回填时若还绑定着，解绑回出发地 */
    fresh: boolean;
    text: string;
    quotes: readonly TextQuote[];
    images: readonly ComposerImage[];
    files: readonly ComposerFileRef[];
    /** 草稿当时的粘贴块（区间指向 text——快照存的就是那份原文） */
    pasted: readonly ComposerPasteBlock[];
  }
  const restoreRef = useRef<SentSnapshot | null>(null);
  const restoreSent = useCallback(
    (snap: SentSnapshot) => {
      if (snap.text !== "") {
        // 回填是把快照原文**接在现草稿末尾**：块的区间随接缝平移（快照的区间都指
        // 向 snap.text 自己，落在接回后的同一段文字上）
        setDrafts((prev) => {
          const current = prev.get(snap.draftKey);
          const merged = appendWithdrawn(current?.text ?? "", snap.text);
          const offset = merged.length - snap.text.length;
          const pasted =
            snap.pasted.length === 0
              ? current?.pasted ?? []
              : (current?.pasted ?? []).concat(
                  snap.pasted.map((block) =>
                    block.range === null
                      ? block
                      : { ...block, range: { start: block.range.start + offset, end: block.range.end + offset } },
                  ),
                );
          return new Map(prev).set(snap.draftKey, { text: merged, pasted });
        });
      }
      if (snap.quotes.length > 0) writeQuotes(snap.draftKey, (current) => [...current, ...snap.quotes]);
      if (snap.images.length > 0) {
        writeAttachments(snap.draftKey, (current) => [...current, ...snap.images].slice(0, PROMPT_IMAGE_MAX_COUNT));
      }
      if (snap.files.length > 0) {
        writeFiles(snap.draftKey, (current) => [...current, ...snap.files]);
      }
      // 首页发首条消息时，submitTurn 已把新会话绑成本槽的活会话、输入框换到新会话的
      // 草稿键上——回填写回出发键（home:main）的话界面读的是新键，两头错过（2026-09-27
      // CDP 实测复现：回填执行了、界面还是空的）。这条会话没落任何内容，解绑回首页，
      // 用户带着内容回到出发地。解绑要三件套：sessionId、sessionRef 之外还有 opened——
      // submit 成功路径的 refreshSessions→syncOpened 已把新建会话的 meta 填进 opened，
      // 只清 sessionId 的话 homeActive 仍为 false、草稿键仍指向新会话（同轮 CDP 复现）。
      // 若失败落地前用户已在新键上打了字（亚秒级窗口），一并搬回出发键，不丢
      if (snap.fresh && sessionRef.current === snap.sessionId) {
        setDrafts((prev) => {
          const stray = prev.get(snap.sessionId);
          const map = new Map(prev);
          if (stray !== undefined && stray.text.trim() !== "") {
            const into = map.get(snap.draftKey);
            const intoText = into?.text ?? "";
            const merged = appendWithdrawn(intoText, stray.text);
            // 块的区间指向 stray.text 自己：接缝在 merged 末尾，末端锚定算偏移
            const offset = merged.length - stray.text.length;
            map.set(snap.draftKey, {
              text: merged,
              pasted: (into?.pasted ?? []).concat(
                stray.pasted.map((block) =>
                  block.range === null
                    ? block
                    : {
                        ...block,
                        range: {
                          start: block.range.start + offset,
                          end: block.range.end + offset,
                        },
                      },
                ),
              ),
            });
          }
          map.delete(snap.sessionId);
          return map;
        });
        setSessionId(null);
        sessionRef.current = null;
        setOpened(null);
      }
    },
    [writeQuotes, writeAttachments, writeFiles],
  );
  useEffect(
    () =>
      api.agent.onEvent((event) => {
        const snap = restoreRef.current;
        if (snap === null) return;
        if (event.type !== "progress" && event.type !== "failed" && event.type !== "phase") return;
        if (event.sessionId !== snap.sessionId) return;
        // 本会话出现用户条目回显 = 我们这条落账了；之后的失败属于「发出去了没答上」，
        // 不是「没发出去」，不回填（消息已在转录里，回填等于重发一份）
        if (event.type === "progress" && event.progress.type === "item_started" && event.progress.item.role === "user") {
          restoreRef.current = null;
          return;
        }
        // 回合级失败（turn: true）一定出自一轮已经回显过用户消息的轮——快照那条还没回显，
        // 这条失败就不是它的，而是它前面那一轮的（典型：抢跑打断工具执行中的旧轮）。
        // 当成「没发出去」回填，已经发出去的话就会回到输入框（2026-09-29 用户稳定复现）
        if (event.type === "failed" && event.turn === true) return;
        if (event.type === "failed" || (event.type === "phase" && event.phase === "idle")) {
          restoreRef.current = null;
          restoreSent(snap);
        }
      }),
    [restoreSent],
  );

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
      images?: readonly PromptImage[],
      extras?: { files?: readonly ComposerFileRef[]; carryoverId?: string },
    ): Promise<void> => {
      if (model === null) {
        engine.setError(engine.modelMissingText());
        return;
      }
      // 无论新建还是从盘上重开：发出去的那一刻起它就是「本槽的活会话」——排队 /
      // 停止 / 撤回都靠 sessionRef 找它，不设就全部静默 no-op（2026-09-11 B 验收复现）
      if (sessionRef.current !== id) {
        setSessionId(id);
        sessionRef.current = id;
      }
      // 乐观置 turn：不等第一帧事件回来，输入框立刻进入「跑着」的样子
      const revertTurn = engine.beginOptimisticTurn(id);
      // 乐观回显：agent 进程冷启 / 开轮装配要几秒，真回显之前先就地画用户气泡
      // （与 runtime 的回显同款切法，真回显一到无缝换下）
      engine.setPendingEcho(id, splitEchoBlocks(text));
      try {
        // submit 自带全套开工上下文：换过的模型 / 权限档随本轮显式生效。
        // 文件引用与粘贴块跟图同行：主进程落盘副本 / agent 进程组装进正文
        await api.agent.submit({
          sessionId: id,
          text,
          ...imagesField(images),
          ...filesField(extras?.files),
          ...(extras?.carryoverId === undefined ? {} : { carryoverId: extras.carryoverId }),
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
        engine.setError(ipcErrorText(cause));
        // 提交没送出去本轮就没跑起来；真跑起来的失败由 failed 事件归位。
        // IPC 直接失败（provider 装配等）不发事件，快照在这里兑底放回输入框
        if (restoreRef.current?.sessionId === id) {
          const snap = restoreRef.current;
          restoreRef.current = null;
          restoreSent(snap);
        }
        // 归位带防踩：撞 already running 时真在跑的那一轮已报过 phase，不能把它标成空闲
        revertTurn();
      }
    },
    [engine, model, mode, thinkingLevel, restoreSent],
  );

  const send = useCallback(async () => {
    const own = draft.trim();
    const images = attachments.map((item) => item.image);
    // 有主的粘贴（句中胶囊或展开区间）也算「有内容」——纯粘贴一条也能发
    const pasteActive =
      pasted.some((block) => block.range !== null) || parsePasteTokens(own).length > 0;
    if (
      own === "" &&
      images.length === 0 &&
      quotes.length === 0 &&
      files.length === 0 &&
      !pasteActive
    ) {
      return;
    }
    // 引用展开进正文：模型、转录、pi 的本子看到的都是这一整段（解析回 chip 在显示时做）。
    // 句中粘贴胶囊就地组装成 <pasted-text> 块——位置保留（方案 C），展开的区间本就是
    // 正文。组装后的 text 从这里往下走：排队、投递都以它为准（回填快照另存草稿原文）
    const raw = composeQuotedMessage(quotes, own);
    const text = assemblePasteDraft(raw, pasted);
    engine.setError(null);
    // 手动压缩指令在本地拦下，**不发给模型**——发出去模型会角色扮演一段
    // 「摘要」贴进对话，而什么都没压缩（真实发生过的事故）。
    // 手工输入时带附件（图 / 文件 / 粘贴块）不认压缩指令：压缩吃不了附件，当命令
    // 拦下会把附件悉数丢掉——按普通消息发。
    const compact =
      images.length === 0 && quotes.length === 0 && files.length === 0 && !pasteActive
        ? parseCompactCommand(text)
        : null;
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
        engine.setError(engine.messagesRef.current.session.noRunningToCompact);
        return;
      }
      if (model === null) {
        engine.setError(engine.modelMissingText());
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
      engine.applyStates((prev) =>
        enqueue(prev, id as string, {
          id: queuedId,
          kind: "text",
          text,
          ...imagesField(images),
          // 队列存 renderer 原生形状（带 id），投递 / 撤回原样交出或退回输入框。
          // 粘贴块已内联进 text（token 换块），撤回时 draftFromSentText 拆回来
          ...(files.length > 0 ? { files } : {}),
        }),
      );
      setDraft("");
      writeAttachments(draftKey, () => []);
      writeFiles(draftKey, () => []);
      writeBlocks(draftKey, () => []);
      writeQuotes(draftKey, () => []);
      return;
    }
    try {
      if (model === null) throw new Error(engine.modelMissingText());
      // 已有会话的 cwd / 归属 / 本子以 meta 真值为准（会话固定——用户切了工作区
      // 再对旧会话发消息，工具目录不能跟着变）；新会话用本槽当前选择。
      const meta = id !== null ? engine.sessions.find((entry) => entry.id === id) ?? null : null;
      const resume = meta?.piSessionFile != null ? { piSessionFile: meta.piSessionFile } : null;
      // 没选就落兜底——输入卡上写着「Home」，不是一个用户看不见的默认
      const target = meta?.cwd ?? cwd ?? engine.defaultCwd;
      if (target === "") throw new Error(engine.messagesRef.current.session.noWorkspaceFolder);
      const workspace = meta?.workspaceId ?? workspaceId ?? null;
      if (id === null) id = crypto.randomUUID();
      // 留回填快照：这条没落账就失败（provider 装配、图片解码……）时内容放回输入框。
      // 落账（用户条目回显）由事件订阅作废它；submitTurn 的 catch 兜底 IPC 直接失败的那类
      restoreRef.current = {
        sessionId: id,
        draftKey,
        fresh: resume === null,
        // 回填快照存**草稿原文**（带 token / 展开区间）：失败放回输入框要的是
        // 还原成发送前的样子，不是已组装的消息
        text: draft,
        quotes,
        images: attachments,
        files,
        pasted,
      };
      writeDraft(draftKey, "");
      writeAttachments(draftKey, () => []);
      writeFiles(draftKey, () => []);
      writeBlocks(draftKey, () => []);
      writeQuotes(draftKey, () => []);
      await submitTurn(id, text, target, workspace, resume, images, { files });
    } catch (cause) {
      engine.setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [engine, draft, attachments, quotes, files, pasted, sessionId, model, mode, cwd, workspaceId, opened, draftKey, writeDraft, writeAttachments, writeFiles, writeBlocks, writeQuotes, submitTurn]);

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
    // 思考档按规则重算：模型不变，但档位不能沿用刚才打开的那条旧会话的账——
    // 否则「回首页开新任务」看起来会像是继承了上一条会话的思考档
    if (model !== null) applyNewTaskThinking(model.providerId, model.modelId);
  }, [engine, model, applyNewTaskThinking]);

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
          const restoredModel = own?.model ?? { providerId: detail.meta.providerId, modelId: detail.meta.modelId };
          setModel(restoredModel);
          /**
           * 档位来自会话账——**要过一遍这个型号在这家服务商上的支持集**
           * （reconcileThinkingLevel，移植自 PR 180）。会话记的档可以是这个型号进白名单之前
           * 选的（step-5-preview 曾被当成不能思考的型号，会话账里留着 off；官方口径是三档、
           * 关不掉——2026-10-10 wafo 实测 chip 说 Off、模型一直在思考），也可以是白名单收紧
           * 支持集之后留下的。纠完同时记回会话意图：下一轮发出去的也是纠过的档。
           */
          const storedThinking = own?.thinkingLevel ?? detail.meta.thinkingLevel;
          const nextThinking = reconcileThinkingLevel(
            storedThinking,
            restoredModel.modelId,
            modelThinkingLevels(
              restoredModel.modelId,
              engine.catalog,
              null,
              modelPreferenceById(engine.usable, restoredModel.providerId),
            ),
          );
          setThinkingLevelState(nextThinking);
          if (nextThinking !== storedThinking) engine.rememberSessionIntent(id, { thinkingLevel: nextThinking });
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
            engine.applyStates((prev) =>
              seedFromDisk(prev, id, detail.transcript, detail.meta.stats, detail.window),
            );
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
   * 目录才能接着干；来源已删时退到本槽当前选择再退兑底。新会话记下它接的是哪条
   * 遗留事项（meta.resumedCarryovers），收尾确认时那条自动标为做完（2026-10-24 用户：
   * 遗留事项的后续之前「没有设计」）。
   */
  const startCarryoverTask = useCallback(
    (item: Carryover): void => {
      if (model === null) {
        engine.setError(engine.modelMissingText());
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
        engine.setError(engine.messagesRef.current.session.noWorkspaceFolder);
        return;
      }
      const workspace = source?.workspaceId ?? workspaceId ?? null;
      // 回首页清槽，并把本槽落点切到来源目录：开工后的下一条新任务默认同目录
      reset();
      setCwd(source?.cwd ?? null);
      setWorkspaceId(source?.workspaceId ?? null);
      engine.setError(null);
      // 带上遗留事项 id：主进程记进新会话的 meta.resumedCarryovers，它收尾确认时这条自动标为做完
      void submitTurn(crypto.randomUUID(), seed, target, workspace, null, undefined, { carryoverId: item.id });
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
        const revertTurn = engine.beginOptimisticTurn(id);
        void api.agent.submit({ sessionId: id, text, ...turn, carryoverId: item.id }).catch((cause: unknown) => {
          engine.setError(cause instanceof Error ? cause.message : String(cause));
          revertTurn();
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

  /** 命名新建工作区：落点与 addWorkspace 同一套（加完就切过去），名字由主进程校验 */
  const createWorkspace = useCallback(
    (name: string) => {
      void api.workspace
        .create(name)
        .then((created) => {
          engine.refreshWorkspaces();
          reset();
          setCwd(created.path);
          setWorkspaceId(created.id);
        })
        .catch(engine.workspaceFailed);
    },
    [engine, reset],
  );

  /**
   * 当前正在看的这条会话的相位。没有活会话（首页 / 盘上打开未唤醒）算 idle——
   * 那时根本没有「一轮」在跑，不该拦。
   */
  const currentPhase = useCallback((): SessionEntry["phase"] => {
    const id = sessionRef.current;
    return id === null ? "idle" : (engine.statesRef.current.get(id)?.phase ?? "idle");
  }, [engine]);

  /**
   * 落一档到**这条会话**名下：本地即设（UI 即时）→ 记在会话名下（跑着时改不进
   * meta，排队卡投递时要拿这一档）→ 闲着才落 meta。changeThinkingLevel（用户
   * 手选）与 chooseModel 的「换模型时自动调整」共用同一条路径，差别只在
   * 要不要写 pickedThinkingRef——两处都要这条路，不能各写一份。
   */
  const applySessionThinking = useCallback(
    (id: string, next: ThinkingLevel) => {
      setThinkingLevelState(next);
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
   * 换模型（C-4）。**选中哪条会话就切哪条**：本地即设（UI 即时）+ 命令发过去，
   * 成功经 `model` 事件回环对齐；失败红字说明。
   * 盘上打开、还没唤醒的旧会话（sessionRef 置空、opened 在）同样按会话记账并注入
   * （2026-10-08 CDP 实测复现后修）：此前这里只改本地显示，选择既不落 meta 也不进
   * 会话意图账，任何一次 openSession——包括再点一次同一行——都拿旧 meta 把 chip
   * 播种回去，用户看到的就是「切了没同步」。runtime 的 setLedgerModel 本就为
   * 「没在跑」的会话而设：校验 + `model` 事件回环落 meta，与活会话同一条真源。
   * 换了不发言就切走会丢选择的旧裁决由此作废——现在选择当场落盘。
   * pi 的切换对正在跑的轮无效、下一轮生效——正在跑的轮照旧，写的和跑的不会再对不上。
   *
   * 思考档跟着模型走（用户裁决 wafo 2026-09-23）：本槽没有会话（新任务槽）按
   * 「手选 > 新模型的默认档」重算；有会话则当前档新模型仍支持就保留，不支持
   * 才落新模型默认档——且**不写** pickedThinkingRef，这不是用户直接选的档。
   */
  const chooseModel = useCallback(
    (providerId: string, modelId: string) => {
      setModel({ providerId, modelId });
      // 启动恢复点跟随（bug A）：下次启动应用从这个模型开始
      void api.settings.set({ lastUsed: { providerId, modelId } }).catch(() => undefined);
      // 这条会话的档要不要跟着动：新模型仍支持当前档（或支持集未知）就不动，
      // 不支持才落新模型的默认档——换模型不该顺手改掉会话自己的设定
      // 新模型仍支持当前档（或支持集未知）就不动，不支持才落新模型的默认档——与打开旧会话
      // 同一条规则（reconcileThinkingLevel），规则只留一份
      const supported = modelThinkingLevels(modelId, catalog, null, modelPreferenceById(engine.usable, providerId));
      const reconciled = reconcileThinkingLevel(thinkingLevel, modelId, supported);
      const switched = reconciled === thinkingLevel ? null : reconciled;
      // 盘上打开的旧会话按它的 id 记账与注入（理由见函数头）；首页新任务槽两者皆空
      const id = sessionRef.current ?? opened?.id ?? null;
      if (id === null) {
        applyNewTaskThinking(providerId, modelId);
        return;
      }
      // 理由同 changeMode：模型也是「选给哪条会话」的，不能让后台会话的排队卡
      // 拿到你刚才给别的会话选的模型
      engine.rememberSessionIntent(id, { model: { providerId, modelId } });
      if (currentPhase() === "idle") {
        // 闲着就注入（校验 + 落 meta + model 事件回环）；跑着只改显示——
        // 无状态下注入就是下一轮 submit 带上的新值，不需要欠账冲账。
        // currentPhase 只认本槽活会话（sessionRef）：盘上打开的会话恒判 idle，
        // 若它其实正在后台跑（通道投递开的轮），runtime 侧自然走 setSessionModel
        // 的在跑路径——两条路都是正解
        void api.agent
          .setModel(id, providerId, modelId)
          .catch((cause: unknown) => engine.setError(cause instanceof Error ? cause.message : String(cause)));
      }
      if (switched !== null) applySessionThinking(id, switched);
    },
    [engine, catalog, opened, currentPhase, thinkingLevel, applyNewTaskThinking, applySessionThinking],
  );

  const changeMode = useCallback(
    (next: PermissionMode) => {
      // 理由同 chooseModel 的记账链：UI 即时、意图记在会话名下（跑着时改不进
      // meta，排队卡投递时要拿这一档）。
      // **总是发 IPC（不再只在 idle 时发）**：档位联动子会话（父带子）不能等父
      // 会话空闲——用户切档解救卡在 plan 档的子会话时，父多半正跑着等子会话回报，
      // 只在 idle 发的话联动在那条时间线上根本不触发。轮内改档是安全的：runtime
      // 的 setMode 只改账本，工具审批闸门每次调用现场读账，当前轮后续工具立刻
      // 按新档判；system prompt 里的档位描述下一个 before_agent_start 重讲。
      setMode(next);
      // 启动恢复点跟随（bug A）：下次启动应用从这一档开始
      void api.settings.set({ lastUsed: { mode: next } }).catch(() => undefined);
      // 盘上打开的旧会话同样记账并落 meta（同 chooseModel 的口径：选择当场落盘，
      // 不留「切走再回就回跳」的键面）；首页新任务槽两者皆空
      const id = sessionRef.current ?? opened?.id ?? null;
      if (id === null) return; // 本槽开新任务：还没有会话可记，槽意图就是意图
      engine.rememberSessionIntent(id, { mode: next });
      // 子会话的 renderer 侧联动（intent 覆写 + 列表缓存 + 正看着子会话的槽）；
      // 子会话切档时它没有下级，这里是 no-op（联动单向：父带子）
      engine.cascadeSubSessionModes(id, next);
      void api.agent
        .setMode(id, next)
        .catch((cause: unknown) => engine.setError(cause instanceof Error ? cause.message : String(cause)));
    },
    [engine, opened],
  );

  const changeThinkingLevel = useCallback(
    (next: ThinkingLevel) => {
      // 同 changeMode 的整条规矩：本地即设（UI 即时）→ 记在会话名下（跑着时改不进
      // meta，排队卡投递时要拿这一档）→ 闲着才落 meta。下一轮 submit 自带新档——轮中
      // 改不影响当前轮（pi 在轮启动时已快照档位，与换模型同一条语义）。
      // **不写 lastUsed**：思考档不跨重启，重启落回模型默认档（wafo 2026-09-23）。
      // **这是用户手选**：记进本次运行的手选记忆——重启前的新任务槽起档都从它
      // 开始，双查看槽共用（用户上一次手选是全局的，不按槽分）
      engine.pickedThinkingRef.current = next;
      // 盘上打开的旧会话同样记账并落 meta（同 chooseModel 的口径）；首页新任务槽两者皆空
      const id = sessionRef.current ?? opened?.id ?? null;
      if (id === null) {
        setThinkingLevelState(next); // 本槽开新任务：还没有会话可记，槽意图就是意图
        return;
      }
      applySessionThinking(id, next);
    },
    [engine, opened, applySessionThinking],
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
  /** 会话级意图召回开关（实验功能）：本地 meta 镜像先动（开关立即回弹），
   *  落盘走 IPC、列表异步刷新。没有会话（新任务）时不动——首条消息按设置默认建。 */
  const setIntentEnabled = useCallback(
    (next: boolean) => {
      setOpened((prev) => (prev === null ? prev : { ...prev, intentEnabled: next }));
      const id = sessionRef.current ?? (opened !== null ? opened.id : null);
      if (id === null) return;
      void api.session
        .setIntentEnabled(id, next)
        .then(() => engine.reloadSessions())
        .catch(() => undefined);
    },
    [opened, engine],
  );

  const compact = useCallback((): void => {
    engine.setError(null);
    // 压缩要有可续的会话
    const active = sessionId ?? (opened !== null && opened.piSessionFile !== null ? opened.id : null);
    if (active === null) {
      engine.setError(engine.messagesRef.current.session.noRunningToCompact);
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
    (
      message: string,
      images: readonly PromptImage[] = [],
      files: readonly ComposerFileRef[] = [],
    ) => {
      // 排队项的正文是已组装的（粘贴块已内联、引用已展开）：先拆粘贴块回句中
      // 胶囊（位置保留），再解析回引用，只把用户自己的话退回文字框
      const pasteLang = engine.messagesRef.current.composer.pasteToken;
      const { draft: textWithTokens, blocks: pastedBack } = draftFromSentText(
        message,
        nextPasteSeq,
        pasteLang,
      );
      const { quotes: withdrawn, text } = parseQuotedMessage(textWithTokens);
      // 文本与粘贴块同拍写回：块的 token 在 text 里，分两拍会有一帧对不上账
      setDrafts((prev) => {
        const current = prev.get(draftKey);
        const merged = appendWithdrawn(current?.text ?? "", text);
        const restored = pastedBack.map((block) => ({
          id: crypto.randomUUID(),
          seq: block.seq,
          text: block.text,
          lines: block.lines,
          range: null,
        }));
        return new Map(prev).set(draftKey, {
          text: merged,
          pasted: (current?.pasted ?? []).concat(restored),
        });
      });
      if (withdrawn.length > 0) writeQuotes(draftKey, (current) => [...current, ...withdrawn]);
      // 附图一起退回输入框（接在已有的后面）——撤回是「这条我要改」，图是这条的一部分。
      // 超出名额的截掉：输入框里多于上限的图发不出去，留着只会让发送卡住
      if (images.length > 0) {
        writeAttachments(draftKey, (current) =>
          [...current, ...images.map((image) => ({ id: crypto.randomUUID(), name: "", image }))].slice(
            0,
            PROMPT_IMAGE_MAX_COUNT,
          ),
        );
      }
      // 文件引用同退（文件不设条数上限）
      if (files.length > 0) {
        writeFiles(draftKey, (current) => [...current, ...files.map((file) => ({ ...file, id: crypto.randomUUID() }))]);
      }
    },
    [draftKey, engine, writeAttachments, writeQuotes, writeFiles],
  );

  // ————————————————— 会话回退 / 单轮撤销（revert.ts） —————————————————

  /**
   * 从盘上重读一条会话种进槽（回退 / 撤销执行后的刷新）。openSession 有「已经是
   * 这条就不重开」的守卫，而回退恰恰需要**就地换血**——槽里的旧画面全是被撤掉
   * 的世界。live 会话不可能（回退入口在忙碌时禁用），种盘语义安全。
   */
  const reloadSession = useCallback(
    (id: string): Promise<void> =>
      api.session
        .load(id)
        .then((detail) => {
          if (detail === null) return;
          setOpened(detail.meta);
          engine.applyStates((prev) =>
            seedFromDisk(prev, id, detail.transcript, detail.meta.stats, detail.window),
          );
        })
        .catch((cause: unknown) =>
          engine.setError(cause instanceof Error ? cause.message : String(cause)),
        ),
    [engine],
  );

  /**
   * 拉更早的一页（滚动触顶时调，源侧分页）。
   *
   * - **静默 no-op**：没更早 / 上一页还在途中 / 还没种过窗口（firstId 未知）
   *   就直接返回——滚动处理器可能每帧都调它，「已经到顶」不该报任何东西；
   * - **防重看槽里的 loading**（同步写进 ref）：连续两个滚动事件只发一次请求；
   * - 回执并进窗口前面（`prependOlder`）；失败把 loading 收回去并上屏错误
   *   （不回退已加载的历史，下次触顶自然会重试）。
   */
  const loadOlder = useCallback((): void => {
    const id = sessionRef.current ?? opened?.id ?? null;
    if (id === null) return;
    const current = engine.statesRef.current.get(id);
    if (current === undefined) return;
    const win = current.window;
    if (!win.hasMore || win.loading || win.firstId === null) return;
    const before = win.firstId;
    engine.applyStates((prev) => setOlderLoading(prev, id, true));
    void api.session
      .loadOlder(id, before, SESSION_PAGE_RECORDS)
      .then((page) => {
        engine.applyStates((prev) => prependOlder(prev, id, page.records, { hasMore: page.hasMore }));
        // 只在本页真带了记录时动计数：空页 / 失败不改变几何，锚点由渲染侧作废
        if (page.records.length > 0) setOlderPages((n) => n + 1);
      })
      .catch((cause: unknown) => {
        engine.applyStates((prev) => setOlderLoading(prev, id, false));
        engine.setError(ipcErrorText(cause));
      });
  }, [engine, opened]);

  /** 回退确认框 */
  const [revertDialog, setRevertDialog] = useState<RevertDialogState | null>(null);
  const [revertBusy, setRevertBusy] = useState(false);
  /** 撤销确认框 */
  const [undoDialog, setUndoDialog] = useState<UndoDialogState | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);

  /** 「回到这里」：拉计划弹框。原文从槽里的转录取（它就是屏幕上那条气泡）。 */
  const revertToMessage = useCallback(
    (messageId: string) => {
      const id = sessionRef.current ?? opened?.id ?? null;
      if (id === null) return;
      const item = selectTranscript(
        engine.statesRef.current.get(id)?.transcript ?? EMPTY_ENTRY.transcript,
      ).find((entry): entry is Extract<TranscriptItem, { role: "user" }> => entry.role === "user" && entry.id === messageId);
      if (item === undefined) return;
      engine.setError(null);
      void api.session
        .revertPlan(id, messageId)
        .then((plan) => setRevertDialog({ sessionId: id, targetMessageId: messageId, plan, message: item }))
        .catch((cause: unknown) =>
          engine.setError(ipcErrorText(cause)),
        );
    },
    [engine, opened],
  );

  /**
   * 确认回退：执行 → 重读会话（新世界）→ 原文（含附件）放回输入框。
   * 执行中禁用整框（防止连点两条回退）。
   */
  const confirmRevert = useCallback((): void => {
    if (revertDialog === null || revertBusy) return;
    const { sessionId, targetMessageId, message } = revertDialog;
    setRevertBusy(true);
    void api.session
      .revert(sessionId, targetMessageId)
      .then(() => {
        setRevertDialog(null);
        engine.refreshSessions();
        void reloadSession(sessionId);
        // 原文放回输入框：拆回正文 / 引用 / 粘贴块 / 文件引用 / 附图。粘贴块按
        // **块序**拆回句中胶囊——位置即发送时的位置（draftFromSentBlocks）；
        // /skill: 指令块剥掉，回到输入框的必须是用户自己当时打的那句
        const texts = message.content
          .filter((block) => block.type === "text")
          .map((block) => (block.type === "text" ? block.text : ""));
        const back = draftFromSentBlocks(texts, nextPasteSeq, engine.messagesRef.current.composer.pasteToken);
        const split = splitUserTextBlocks(texts);
        const images = message.content
          .filter((block): block is Extract<typeof block, { type: "image" }> => block.type === "image")
          .map((block) => ({ type: "image" as const, data: block.data, mimeType: block.mimeType }));
        restoreToDraft(
          stripInvocationBlock(back.draft),
          images,
          split.files.map((file) => ({
            id: crypto.randomUUID(),
            name: file.path.split(/[\\/]/).filter(Boolean).pop() ?? file.path,
            path: file.path,
            kind: file.kind,
            origin: "workspace" as const,
          })),
        );
        if (back.pasted.length > 0) {
          writeBlocks(draftKey, (current) => [
            ...current,
            ...back.pasted.map((block) => ({ id: crypto.randomUUID(), ...block, range: null })),
          ]);
        }

      })
      .catch((cause: unknown) => {
        // 失败留在框里（计划还有效），错误亮出来
        engine.setError(ipcErrorText(cause));
      })
      .finally(() => setRevertBusy(false));
  }, [revertDialog, revertBusy, engine, reloadSession, restoreToDraft, draftKey, writeBlocks]);

  const cancelRevert = useCallback((): void => {
    if (revertBusy) return;
    setRevertDialog(null);
  }, [revertBusy]);

  /** 轮尾卡的撤销入口 */
  const undoTurn = useCallback(
    (turnId: string) => {
      const id = sessionRef.current ?? opened?.id ?? null;
      if (id === null) return;
      engine.setError(null);
      void api.session
        .undoPlan(id, turnId)
        .then((plan) => setUndoDialog({ sessionId: id, turnId, plan }))
        .catch((cause: unknown) =>
          engine.setError(ipcErrorText(cause)),
        );
    },
    [engine, opened],
  );

  /** 确认撤销：执行 → 重读会话（轮尾卡挂「已撤销」徽标）。对话不动。 */
  const confirmUndo = useCallback((): void => {
    if (undoDialog === null || undoBusy) return;
    const { sessionId, turnId } = undoDialog;
    setUndoBusy(true);
    void api.session
      .undo(sessionId, turnId)
      .then(() => {
        setUndoDialog(null);
        engine.refreshSessions();
        void reloadSession(sessionId);
      })
      .catch((cause: unknown) => {
        engine.setError(ipcErrorText(cause));
      })
      .finally(() => setUndoBusy(false));
  }, [undoDialog, undoBusy, engine, reloadSession]);

  const cancelUndo = useCallback((): void => {
    if (undoBusy) return;
    setUndoDialog(null);
  }, [undoBusy]);

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
      // channel 项同样不进草稿（子会话 PR4a）：它不是用户自己的话，是子会话
      // 发来的消息——撤回只是不再投给父模型，消息仍在通道账本里，不提供编辑。
      if (item.kind === "text") restoreToDraft(item.text, item.images, item.files);
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
      const fail = (cause: unknown): void => {
        engine.setError(ipcErrorText(cause));
        // IPC 直接失败（provider 装配等）不发 agent 事件，回填
        // 快照等不到兑底——与 send 直发分支同款，在这里放回输入框
        if (item.kind === "text" && restoreRef.current?.sessionId === id) {
          const snap = restoreRef.current;
          restoreRef.current = null;
          restoreSent(snap);
        }
      };
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
      // channel 条目同样组信封文本发出——「立即发送」对它是同一件事：别等父
      // 空闲了，现在就把子的消息喂给模型看（子标题查不到就交给 compose 写
      // Untitled，不是本地再造一个哨兵）。
      const text =
        item.kind === "channel"
          ? composeChannelPrompt(item.message, {
              id: item.childId,
              title: engine.sessions.find((meta) => meta.id === item.childId)?.title ?? "",
            })
          : item.text;
      const images = imagesField(item.kind === "text" ? item.images : undefined);
      const extras = item.kind === "text" ? { ...filesField(item.files) } : {};
      // 留回填快照（wafo 二轮：出队后失败即丢——9e2d7e5 的回填没覆盖这条路径）：
      // 已从队列删掉，失败时 nowhere 可归，只有快照能把内容放回输入框。排队时引用
      // 已展开进 text，这里解析回净文与 chip（撤回 restoreToDraft 同纪律），输入框
      // 不留裸 XML；compact/channel 分支不建——压缩无内容可丢，channel 的正文在
      // 通道账本里丢不了。
      if (item.kind === "text") {
        // 排队的 text 里粘贴块已内联：拆回 token 与块，快照还原成发送前的草稿样子
        const tokenized = draftFromSentText(item.text, nextPasteSeq, engine.messagesRef.current.composer.pasteToken);
        const { quotes: queuedQuotes, text: queuedText } = parseQuotedMessage(tokenized.draft);
        restoreRef.current = {
          sessionId: id,
          draftKey,
          fresh: false,
          text: queuedText,
          quotes: queuedQuotes,
          // PromptImage → ComposerImage 与撤回同款转换（排队时名字已丢，name 空串是既有先例）
          images: (item.images ?? []).map((image) => ({ id: crypto.randomUUID(), name: "", image })),
          files: item.files ?? [],
          pasted: tokenized.blocks.map((block) => ({
            id: crypto.randomUUID(),
            seq: block.seq,
            text: block.text,
            lines: block.lines,
            range: null,
          })),
        };
      }
      if (entry.phase === "idle") {
        // 空闲直发同样乐观置 turn：不填 runtime 首个 phase 事件前的空档，期间的回车会
        // 被当成空闲直发、撞 already running（与 deliverNext 同因）
        const revertTurn = engine.beginOptimisticTurn(id);
        void api.agent.submit({ sessionId: id, text, ...images, ...extras, ...turn }).catch((cause: unknown) => {
          fail(cause);
          revertTurn();
        });
      } else {
        void api.agent.interrupt({ sessionId: id, text, ...images, ...extras, ...turn }).catch(fail);
      }
    },
    [engine, draftKey, restoreSent],
  );

  // provider 到位后先落一个默认模型：第一个 provider 的第一个模型。
  // **只种新任务槽（opened === null）**：用户没选过时界面上也该显示出到底会用哪个，
  // 而不是一片空白。打开的会话不替用户挑渠道——导入的会话 meta 落的是占位
  // provider（导入与模型解耦，2026-09-28 裁决）、provider 被删的旧会话同理，模型栏
  // 如实显示「没有模型」，发送时引导先选（model-required.ts）
  useEffect(() => {
    if (model !== null || opened !== null) return;
    const first = engine.usable[0];
    const firstModel = first?.models.declared[0];
    if (first === undefined || firstModel === undefined) return;
    setModel({ providerId: first.id, modelId: firstModel.id });
    // 这个默认模型也要有一个真实的起档，不是停在初始 medium
    applyNewTaskThinking(first.id, firstModel.id);
  }, [engine.usable, model, opened, applyNewTaskThinking]);

  // 目录是异步到的：上面几处起档发生时 engine.catalog 可能还是空数组，算出来的
  // 支持集是 null（未夹，接受——pi 发送前按同规则夹）。目录到位后，**本槽还没
  // 起会话**就按真实支持集再起一次——不会踩用户刚手选的档：picked 就是手选值，
  // 重算结果要么等于它（仍支持，原样返回）要么是这个模型的默认档（确实不支持，
  // 该纠），都不是「覆盖用户意图」。有会话的槽不归这条管，档位已经跟着会话账走——
  // **包括盘上打开、还没唤醒的旧会话**：它的 sessionRef 同样是 null（见 openSession
  // 「空闲会话仍然置空」），只看 sessionRef 会把它当成新任务槽，打开即把会话自己记的
  // 档覆盖成默认档（2026-09-23 实机复现：会话记 high，打开显示 Max）。
  useEffect(() => {
    if (sessionRef.current !== null || opened !== null || model === null) return;
    applyNewTaskThinking(model.providerId, model.modelId);
  }, [catalog, model, opened, applyNewTaskThinking]);

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
    /** 这次扫描的计划（轮号范围与各轮用量）：解析校验轮号、卡片算花费都用它 */
    plan: WrapupPlan;
  } | null>(null);
  /** 扫描完成待确认的清单；非 null 且正在查看发起会话时，ChatView 在 footer 显示确认卡 */
  const [scanResult, setScanResult] = useState<{
    sessionId: string;
    plan: WrapupPlan;
    draft: WrapupDraft;
  } | null>(null);
  /** 降级 / 结果的一句反馈（中性，不是错误）；下一次发起或打开会话时清 */
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  /**
   * 读不懂结果的那条会话（重试按它定向）。null = 没有可重试的失败。
   * messageId = 那条扫描消息在转录里的 id——重试**回退到它**再重发（不是追加：
   * 旧回答留在历史里，模型会参考自己上次的失败格式再错一次）。
   */
  const [scanFailed, setScanFailed] = useState<{ sessionId: string; messageId: string | null } | null>(null);

  /** 打开另一条会话：上一轮的提示不是那条会话的事，不能跟过来。
   *  待确认的清单（scanResult）**不清**：它是发起会话的未完成动作，切走再切回
   *  还在——静默丢弃会让「点了 Mark done 却什么都没发生」。确认卡是 inline 浮层
   *  （只挂在发起会话的 footer），切走时不显示但状态保留；确认 / 取消都按
   *  scanResult.sessionId 定向，不会错标当前会话。 */
  useEffect(() => {
    setScanNotice(null);
    setScanFailed(null);
  }, [viewedId]);

  /** 已选出的消息列表里那条扫描消息的 id（从后往前找最近一次扫描）。 */
  const scanMessageIdIn = (items: readonly TranscriptItem[]): string | null => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item?.role !== "user") continue;
      const text = item.content.find((block) => block.type === "text");
      if (text !== undefined && text.type === "text" && isClosingScanText(text.text)) return item.id;
    }
    return null;
  };


  /*
   * 扫描不设超时（v1 是 60s）：扫描改用会话自己的模型之后，大模型开着高档回看一长段会话，实测
   * 两分钟还在思考（Kimi K3 · 最高，15 轮）；到点强行标完成会把随后到的答案扔掉。扫描是对话流里
   * 一条看得见的轮，输入卡上有停止键——用户不想等就停，停下来没有回答走「读不懂」那条降级（标完成
   * + 可重试）。
   */

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
    const draft = answer === null ? null : parseWrapupScan(answer, closingScan.plan);
    setClosingScan(null);
    if (draft === null) {
      // **读不懂不等于没事**：会话照标完成（收尾的意愿已经表达），但提示里带上
      // 重试——扫描消息就在对话里，模型回了什么用户看得见，重发一条就行。
      engine.setCompletionSession(closingScan.sessionId, "done");
      setScanNotice(engine.messagesRef.current.session.scanUnreadable);
      setScanFailed({ sessionId: closingScan.sessionId, messageId: scanMessageIdIn(items) });
      return;
    }
    // 两组都空也弹卡：用户可能还想自己加一件（v1 时代这里直接标完成——那时卡上只有留下的事）
    setScanResult({ sessionId: closingScan.sessionId, plan: closingScan.plan, draft });
    // entry.phase 是渲染值，它的变化就是本 effect 的触发源——必须进依赖；
    // engine 整体每次渲染都是新引用，取稳定的 statesRef / setCompletionSession
  }, [closingScan, viewedId, entry.phase, engine.statesRef, engine.setCompletionSession]);

  /**
   * 发出扫描消息（首次与重试共用）。**它是一条普通的用户消息**：走与
   * `send` 同一条 submit 链，进消息流、进 pi 历史，标题门禁与最近提问按普通消息处理。
   *
   * **用会话自己当前的模型**，不用家务活模型（用户 2026-10-24：「这个总结上下文其实是需要一个
   * 上下文很好的模型来总结的」）：它的窗口装得下这段会话，扫描发在同一个会话里前缀缓存是热的，
   * 比换一个小模型重读全文便宜。上一版用家务活模型时还有个副作用：开轮推回的思考档是家务活
   * 模型 clamp 后的档，被当成会话的档写上输入卡，下一轮真按它发了出去。
   */
  const launchScan = useCallback(
    (id: string, baseline: number, turn: Omit<SubmitAgentInput, "sessionId" | "text">, plan: WrapupPlan): void => {
      setClosingScan({ sessionId: id, baseline, plan });
      const revertTurn = engine.beginOptimisticTurn(id);
      void api.agent
        .submit(scanSubmitInput(id, turn, plan))
        .catch((cause: unknown) => {
          // 提交没送出去：扫描轮没开起来，归位并交代一句
          setClosingScan(null);
          revertTurn();
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
      engine.setError(engine.messagesRef.current.session.queuedBeforeWrapUp);
      return;
    }
    const meta = engine.sessions.find((item) => item.id === id) ?? opened;
    // 只读 / 空对话：没有可扫的前文，扫描没有意义，直接纯标记
    if (meta === null || meta.piSessionFile === null) {
      engine.setCompletionSession(id, "done");
      setScanNotice(engine.messagesRef.current.session.noAgentSession);
      return;
    }
    const baseline = selectTranscript(current.transcript).length;
    if (baseline === 0) {
      engine.setCompletionSession(id, "done");
      setScanNotice(engine.messagesRef.current.session.nothingSaid);
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
    // 先问主进程这次要扫哪几轮（上次确认之后的那些）。没有新轮次：上次确认过的都已落账，直接标完成
    void api.session
      .wrapupPlan(id)
      .then((plan) => {
        if (plan === null) {
          engine.setCompletionSession(id, "done");
          setScanNotice(engine.messagesRef.current.session.scanNoNewTurns);
          return;
        }
        launchScan(id, baseline, turn, plan);
      })
      .catch((cause: unknown) => engine.setError(ipcErrorText(cause)));
  }, [closingScan, engine, launchScan, opened]);

  /**
   * 重试（提示行上的 Retry）：重发同一条扫描消息。会话已经是 done，
   * 重扫出东西就走清单、确认后转 done_with_todos；又读不懂就再给一次 Retry。
   * 基线重新取（上一轮的扫描消息与回答都已在转录里，不重新取会把旧回答再解一遍）。
   */
  const retryClosingScan = useCallback((): void => {
    const failed = scanFailed;
    if (failed === null || closingScan !== null) return;
    const current = engine.statesRef.current.get(failed.sessionId);
    if (current === undefined || current.phase !== "idle") return;
    engine.setError(null);
    setScanNotice(null);
    setScanFailed(null);
    /** 重发扫描（基线取此刻槽里的消息数——回退种盘后它是「扫描之前」的世界） */
    const relaunch = (): void => {
      const turn = engine.buildTurn(failed.sessionId);
      if (turn === null) return;
      const items = selectTranscript(
        engine.statesRef.current.get(failed.sessionId)?.transcript ?? EMPTY_ENTRY.transcript,
      );
      void api.session
        .wrapupPlan(failed.sessionId)
        .then((plan) => {
          if (plan !== null) launchScan(failed.sessionId, items.length, turn, plan);
        })
        .catch((cause: unknown) => engine.setError(ipcErrorText(cause)));
    };
    // 回退到那条扫描消息再重发：连它读不懂的回答（以及扫描轮里可能动过的
    // 文件）一起撤掉——追加式重发会让模型参考自己上次的失败格式再错一次
    if (failed.messageId === null) {
      relaunch();
      return;
    }
    void api.session
      .revert(failed.sessionId, failed.messageId)
      .then(() => {
        engine.refreshSessions();
        return reloadSession(failed.sessionId);
      })
      .then(relaunch)
      .catch((cause: unknown) =>
        engine.setError(ipcErrorText(cause)),
      );
  }, [closingScan, engine, launchScan, scanFailed, reloadSession]);

  /**
   * 确认清单：主进程一次办完——做完的事落进 meta.wrapups 并记账、留下的事进遗留清单、会话标完成、
   * 这条会话在接着做的遗留事项标为做完。遗留事项的锚点在这里现算（尽力而为，搜不到 null）。
   */
  const confirmCarryovers = useCallback(
    (draft: WrapupDraft): void => {
      if (scanResult === null) return;
      const id = scanResult.sessionId;
      const plan = scanResult.plan;
      setScanResult(null);
      const items = selectTranscript(
        engine.statesRef.current.get(id)?.transcript ?? EMPTY_ENTRY.transcript,
      );
      const left = draft.left.filter((entry) => entry.title.trim() !== "");
      const done = draft.done.filter((entry) => entry.title.trim() !== "");
      void api.session
        .wrapupConfirm(id, {
          throughTurn: plan.lastTurn,
          done: done.map((entry) => ({ title: entry.title, turns: entry.turns })),
          carryovers: left.map((entry) => ({
            title: entry.title,
            detail: entry.detail,
            sourceMessageRange: locateMessageRange(items, entry.detail),
          })),
        })
        .then(() => {
          engine.refreshSessions();
          engine.refreshCarryovers();
          setScanNotice(engine.messagesRef.current.session.wrapupConfirmed(done.length, left.length));
        })
        .catch((cause: unknown) => {
          // 落盘失败：会话还没标——如实报错，用户可以重试（再点完成会重扫）
          engine.setError(ipcErrorText(cause));
        });
    },
    [scanResult, engine],
  );

  /** 按用户一句话改清单：家务活模型一次独立小调用（不进会话、不进意图系统与任务账本） */
  const reviseWrapup = useCallback(
    (draft: WrapupDraft, feedback: string): Promise<WrapupReviseResult> => {
      if (scanResult === null) return Promise.resolve({ ok: false, error: "no checklist" });
      return api.session
        .wrapupRevise(scanResult.sessionId, {
          sinceTurn: scanResult.plan.sinceTurn,
          lastTurn: scanResult.plan.lastTurn,
          draft,
          feedback,
        })
        .catch((cause: unknown): WrapupReviseResult => ({ ok: false, error: ipcErrorText(cause) }));
    },
    [scanResult],
  );

  /** 取消（已过二次确认）：丢弃清单，同样标 done——收尾的意愿已经表达了 */
  const cancelCarryovers = useCallback((): void => {
    if (scanResult === null) return;
    const id = scanResult.sessionId;
    setScanResult(null);
    engine.setCompletionSession(id, "done");
    setScanNotice(engine.messagesRef.current.session.checklistDiscarded);
  }, [scanResult, engine]);

  // selectTranscript 每次调用都造新数组（pi 的实现如此）——在这里按 entry 引用
  // 稳定化，否则 ChatView 的 memo 转录列每次渲染都被新引用击穿，隔离形同虚设
  const transcript = useMemo(() => selectTranscript(entry.transcript), [entry.transcript]);

  return {
    sessionId,
    transcript,
    hasMoreHistory: entry.window.hasMore,
    loadingOlder: entry.window.loading,
    olderPages,
    loadOlder,
    compactions: entry.compactions,
    marks: entry.marks,
    phase: entry.phase,
    retry: entry.retry,
    turnError: entry.turnError,
    stats: entry.stats,
    phaseOf: engine.phaseOf,
    turnErrorOf: engine.turnErrorOf,
    approvalsOf: engine.approvalsOf,
    error: engine.error,
    draft,
    setDraft,
    attachments,
    attachIncoming,
    removeAttachment,
    attachFolderRefs,
    files,
    attachFileRef,
    removeFile,
    pasted,
    addPasteBlock,
    expandPaste,
    collapsePaste,
    quotes,
    addQuote,
    removeQuote,
    mode,
    changeMode,
    thinkingLevel,
    changeThinkingLevel,
    thinkingSupported: entry.thinking?.supported ?? null,
    catalog: engine.catalog,
    approvals: entry.approvals,
    intentRecalls: entry.intentRecalls,
    intentRun: entry.intentRun,
    pendingEcho: entry.pendingEcho,
    intentAsk: entry.intentAsk,
    answerIntentConfirm: engine.answerIntentConfirm,
    intentEnabled: opened === null ? null : opened.intentEnabled,
    setIntentEnabled,
    workspaces: engine.workspaces,
    addWorkspace,
    createWorkspace,
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
    reviseWrapup,
    cancelCarryovers,
    scanNotice,
    // 重试只在「本槽正看着那条失败的会话」时给出——提示行本身就是那条会话的
    retryClosingScan: scanFailed !== null && scanFailed.sessionId === viewedId ? retryClosingScan : null,
    fileTurns: entry.fileTurns,
    reverts: entry.reverts,
    undos: entry.undos,
    revertToMessage,
    revertDialog,
    revertBusy,
    confirmRevert,
    cancelRevert,
    undoTurn,
    undoDialog,
    undoBusy,
    confirmUndo,
    cancelUndo,
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
export function useChatSession(
  providers: ProviderDto[],
  t: Messages,
): {
  session: ChatSession;
  engine: SessionEngine;
} {
  const engine = useChatSessionEngine(providers, t);
  const session = useSessionView(engine, "main");
  return { session, engine };
}
