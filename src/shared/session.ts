/**
 * 会话契约 —— IPC 四层的第 1 层。
 *
 * **界面上叫 task，代码里叫 session**（`docs/ubiquitous-language.md`）——
 * 两边不互相翻译，这里一律 session。
 *
 * 存储形状（理由见 `docs/plans/2026-08-25-会话存储与命名工作区.md`）：
 *   sessions/<id>.meta.json   本文件的 SessionMeta，可变，原子写
 *   sessions/<id>.jsonl       只追加，一行一个 SessionRecord
 */
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import type { AgentStats } from "./agent-ipc.ts";
import { parseAutomationRunLabel, type AutomationRunLabel } from "./automation.ts";
import { CHANNEL_MESSAGE_KINDS, type ChannelMessageKind } from "./channel.ts";
import { PERMISSION_MODES, type PermissionMode } from "./permission.ts";
import { isThinkingLevel, parseThinkingLevel, type ThinkingLevel } from "./thinking.ts";
import { parseQuotedMessage, withoutQuotes } from "./quote.ts";
import { parseSkillSegments } from "./skill.ts";
import { stripInvocationBlock } from "./invocation.ts";
import { splitUserTextBlocks } from "./prompt-attachments.ts";
import type { FileTurnRecord, FileTurnView, RevertRecord, UndoRecord } from "./revert.ts";
import type { IntentAskView, IntentSelectedView, IntentUsageCount, RecallStageCell } from "./intent-recall.ts";
import type { IntentConfirmAnswer } from "./intent-confirm.ts";
import type { SessionWrapup, WrapupItem, WrapupTokens } from "./wrapup.ts";

/** 标题上限。超出截断加省略号——标题要在 288px 的侧栏里一行放得下。 */
export const SESSION_TITLE_MAX = 60;

/**
 * 导入会话的 provider 占位（导入与模型解耦，2026-09-28 裁决）：导入时不在 orbita 里
 * 替源模型挑渠道，providerId 一律写这个占位，打开时用户自己选。真实 provider id 只
 * 允许小写字母 / 数字 / 连字符（provider.ts 的 ID_PATTERN），带冒号的占位永远撞不上。
 * meta 解析要求 providerId / modelId 非空，所以不能写空串——必须有个非空占位。
 */
export const UNASSIGNED_PROVIDER_ID = "orbita:unassigned";

/** 导入会话没记录到原模型名时 modelId 的占位（同上：非空是 meta 解析的硬要求）。 */
export const UNASSIGNED_MODEL_ID = "unknown";

/**
 * 压缩边界记录。上下文压缩不是一条消息，是「此前的一切已折叠成摘要」的界碑——
 * 单独一个 role，不塞进 pi 的 TranscriptItem，也不做通用 visibility 包装：
 * 今天唯一的内部记录就是它，等第二个消费者出现再泛化（加字段是加法）。
 */
export interface CompactedRecord {
  role: "compacted";
  id: string;
  /** 压缩生成的摘要全文（markdown） */
  summary: string;
  /** 压缩前上下文的 token 数，折叠行上给人看 */
  tokensBefore: number;
  /** 压缩后上下文的估算 token 数（pi 的 estimate）。旧记录没有，展示时回退 */
  tokensAfter?: number;
  timestamp: number;
}

/**
 * 通道标记（子会话 2026-09-23 裁决）：父子往来的正文在通道账本里（`channel.ts`），
 * 会话的 transcript 只落一条指向它的标记——「这一刻通道里发生了一条 X」，对话流里画成一行
 * 虚线标记，点了跳通道。
 *
 * **为什么不是 `visibility: "internal"` 的消息**：标记不是一条被隐藏的消息，它不带正文——
 * 正文只有一份，在通道里；模型看到的那份在 pi 的本子里（投递时嗂进去），不在这本账。
 * 和 CompactedRecord 同一个做法：单独一个 role，逐字段校验，坏行跳过。
 *
 * **不变量（子会话 2026-09-23 修正）：transcript 里的每一条 `ChannelMarkRecord`
 * 都顶替了 pi 本子里的一条 user 消息**——它落在 recorder 识别信封的那个位置
 * （`session/recorder.ts`），恰好是 pi 那本账原本会收一条 user item_started 的地方；
 * 标记只是接收侧的投影，正文在通道账本里。这个不变量只在**接收侧**成立：发信一方
 * 若是模型经工具发的，发送侧的对话流里已经有那次工具调用（不需要再写一条标记）；
 * 若是用户代父发言（没有工具调用可投影），发送侧的 pi 本子里同样没有多出一条 user
 * 消息，因此也不写标记（`main/channel/requests.ts` 的 `applySpeak`）——**标记只出现
 * 在收到通道消息、真正喂给模型看的那一侧**。
 *
 * 因此它**是轮边界，与 user 同级**：`branchRoles`（分支按位对账）把它计作 `"user"`；
 * renderer 的分组 / 折叠 / 分支锚点判定同样把它当边界处理（见 `tool-results.ts`）。
 * 取代 ea3dcfa 时代「它不是消息也不构成轮边界」的说法——那时通道标记尚未接入
 * 渲染流，穿过不打断候选；接上不变量后才发现它必须与 user 同级，否则带通道投递
 * 的会话按位对账会错位一位，「从这里分支」会被拒绝。
 */
export interface ChannelMarkRecord {
  role: "channel-mark";
  id: string;
  /** 通道的另一头：在父的 transcript 里是 childId，在子的 transcript 里是 parentId */
  peerId: string;
  /** 指向的通道消息 id（`ChannelMessage.id`） */
  messageId: string;
  /** 冷数据，免得画一行标记还要先读通道：谁发的 */
  from: "parent" | "child";
  /** 什么类型。跟着 ChannelMessageKind 走（stop 理论上不出现——标记只落在收到
   * 投递的一侧，而 stop 不投递给任何人；但 parseChannelPrompt 认识它，类型上
   * 诚实比防御性收窄好） */
  kind: ChannelMessageKind;
  timestamp: number;
}

export function isChannelMarkRecord(raw: unknown): raw is ChannelMarkRecord {
  if (typeof raw !== "object" || raw === null) return false;
  const value = raw as Record<string, unknown>;
  return (
    value["role"] === "channel-mark" &&
    typeof value["id"] === "string" &&
    typeof value["peerId"] === "string" &&
    typeof value["messageId"] === "string" &&
    (value["from"] === "parent" || value["from"] === "child") &&
    typeof value["kind"] === "string" &&
    (CHANNEL_MESSAGE_KINDS as readonly string[]).includes(value["kind"]) &&
    typeof value["timestamp"] === "number"
  );
}

/**
 * 意图召回的终态卡片记录（实验功能 intent-system）：一轮 /recall 的摘要，落在
 * 它服务的那条 user 消息之后、回答之前。与 CompactedRecord / ChannelMarkRecord
 * 同一个做法：单独一个 role、逐字段校验、坏行跳过；不是轮边界，branchRoles
 * 不计它。**injection 永不落盘**（它引用历史 QA 的原文，只活在 pi 本子与模型
 * 上下文里）。usage 落在这里是刻意的：日账本可从会话 JSONL 回填重建，意图
 * 召回花的 token（DeepSeek / Proma 管线，用户自己的钱）不能在重建后丢账。
 */
export interface IntentRecallRecord {
  role: "intent-recall";
  /** 转录记录 id（重跑同一 turn 只留最后一张：renderer 按 turnId 去重取最后一张） */
  id: string;
  /** 本轮回显 user item 的 id（与 /recall 的 turnId 同一个值） */
  turnId: string;
  status: "done" | "error" | "cancelled";
  runId: string | null;
  /** 记录时刻（epoch ms）——与其它记录一样用于混排定序，值 = 召回开始时刻 */
  timestamp: number;
  /** recall 开始与终态落定的时刻（epoch ms；timestamp = startedAt） */
  startedAt: number;
  finishedAt: number;
  /** S1 判定的场景标签 */
  scene: string | null;
  /** /health→accepted 的 qaTotal（历史 QA 总量） */
  qaTotal: number | null;
  /** S3 通过数（最后一帧 progress 的 passed） */
  passed: number | null;
  budgetMs: number | null;
  peak: boolean;
  timings: { totalMs: number; gateMs: number; s1Ms: number; s3Ms: number; s4Ms: number } | null;
  summary: string | null;
  selected: IntentSelectedView[];
  ask: IntentAskView[];
  /** 待问队列里还没问到的条数（本轮之外） */
  askRemaining?: number;
  /** 落卡时刻的阶段条（含每格数字与用时） */
  stages?: RecallStageCell[];
  error: { stage: string; message: string; retryable: boolean } | null;
  /** 门卫跳过（done.skipped="gate"）：why 与 gate 事件同一句；null = 正常走完 */
  skipped: "gate" | null;
  gateWhy: string | null;
  /** 出错停在哪一步（stage + 最后一帧进度）；error 态之外为 null */
  halted: { stage: string; done: number | null; total: number | null } | null;
  /** 回答前确认的用户表态；null = 没弹过卡 */
  confirm?: {
    action: "confirm" | "skip-all";
    answers: IntentConfirmAnswer[];
    note: string;
    /** /feedback 写回的边数 */
    edgesWritten: number | null;
    /** 表态提升为入选的条数（契约 7 增补，可选） */
    promoted?: number;
  } | null;
  /** 契约 7：这一轮召回的 token 用量（DeepSeek / Proma 管线）；服务端没报则缺席 */
  usage?: IntentUsageCount;
}

/** 逐字段校验（宽松版：渲染可用的字段齐就行，畸形字段缺席、不丢整行）。 */
export function isIntentRecallRecord(raw: unknown): raw is IntentRecallRecord {
  if (typeof raw !== "object" || raw === null) return false;
  const value = raw as Record<string, unknown>;
  if (
    value["role"] !== "intent-recall" ||
    typeof value["id"] !== "string" ||
    typeof value["turnId"] !== "string" ||
    (value["status"] !== "done" && value["status"] !== "error" && value["status"] !== "cancelled") ||
    typeof value["timestamp"] !== "number" ||
    typeof value["startedAt"] !== "number" ||
    typeof value["finishedAt"] !== "number" ||
    (value["peak"] !== false && value["peak"] !== true)
  ) {
    return false;
  }
  if (!Array.isArray(value["selected"]) || !Array.isArray(value["ask"])) return false;
  if (value["skipped"] !== null && value["skipped"] !== undefined && value["skipped"] !== "gate") return false;
  if (value["gateWhy"] !== null && value["gateWhy"] !== undefined && typeof value["gateWhy"] !== "string") return false;
  if (value["error"] !== null && typeof value["error"] !== "object") return false;
  if (value["halted"] !== null && value["halted"] !== undefined) {
    const halted = value["halted"];
    if (typeof halted !== "object" || halted === null) return false;
    const h = halted as Record<string, unknown>;
    if (typeof h["stage"] !== "string") return false;
    if (h["done"] !== null && typeof h["done"] !== "number") return false;
    if (h["total"] !== null && typeof h["total"] !== "number") return false;
  }
  if (value["confirm"] !== null && value["confirm"] !== undefined) {
    const confirm = value["confirm"];
    if (typeof confirm !== "object" || confirm === null) return false;
    const c = confirm as Record<string, unknown>;
    if (c["action"] !== "confirm" && c["action"] !== "skip-all") return false;
    if (typeof c["note"] !== "string") return false;
    if (!Array.isArray(c["answers"])) return false;
    for (const answer of c["answers"]) {
      if (typeof answer !== "object" || answer === null) return false;
      const a = answer as Record<string, unknown>;
      if (typeof a["askId"] !== "string") return false;
      if (a["verdict"] !== "yes" && a["verdict"] !== "no" && a["verdict"] !== "skip") return false;
      if (a["edited"] !== undefined && typeof a["edited"] !== "string") return false;
    }
  }
  return true;
}


/**
 * 日志与视图里的一条记录：往来消息（pi 的 TranscriptItem）、压缩界碑、通道标记
 * 或文件账三件（`revert.ts`：轮尾文件账 / 回退界碑 / 单轮撤销标记）。
 */
export type SessionRecord =
  | TranscriptItem
  | StampedAssistantRecord
  | CompactedRecord
  | ChannelMarkRecord
  | FileTurnRecord
  | RevertRecord
  | UndoRecord
  | IntentRecallRecord;

/**
 * 落盘的 assistant 记录多一个 Orbita 自己盖的字段：**这一轮实际生效的思考档**。
 *
 * 为什么要盖：pi 的消息条目不带档位，pi 本子里的 `thinking_level_change` 只在建会话与
 * 手动压缩前后写——续会话时 sdk 见本子里已有一条就不再写，会话中途改档在两本账里都
 * 留不下痕迹（orbita-dev 2026-10-24 实测：137 条原生会话里 23 条 meta 的档与 pi 本子
 * 最后一条对不上）。「价格 · 能力图」按「型号 × 档」算每任务成本，档必须逐轮可考。
 *
 * 值取开轮时 runtime 推的 `thinking` 事件（clamp 之后的真值，不是用户点的意图），
 * 由主进程 recorder 在落盘同一刻盖上。缺席 = 盖章之前的旧记录，读者按 pi 本子的
 * 时间线补（main/usage/task-cost.ts）。协议加字段是加法：不认识它的读者原样忽略。
 */
export type StampedAssistantRecord = Extract<TranscriptItem, { role: "assistant" }> & {
  thinkingLevel?: ThinkingLevel;
};

/** 记录上盖的档（缺席或坏值 = undefined，不兑默认——补不补、拿什么补是读者的事） */
export function stampedThinkingLevel(record: SessionRecord): ThinkingLevel | undefined {
  if (record.role !== "assistant" || !("thinkingLevel" in record)) return undefined;
  const level: unknown = record.thinkingLevel;
  return isThinkingLevel(level) ? level : undefined;
}

/**
 * 渲染层的合并记录：SessionRecord 外加轮尾账的**视图形**（FileTurnView——剥掉快照
 * 引用的路径 + 统计）。renderer 的实时事件（fileTurnView）与盘上种子（FileTurnRecord，
 * 视图的超集）在这里汇流；主进程的读者（load / export / branch）只见 SessionRecord，
 * 不认识视图形。
 */
export type TranscriptRecord = SessionRecord | FileTurnView;

/**
 * 逐字段校验，坏值判 false。readLog 靠它分流：**坏掉的 compacted 行按坏行跳过**，
 * 绝不把半截界碑当消息渲染——用户会把摘要残渣当成 agent 说过的话。
 */
export function isCompactedRecord(raw: unknown): raw is CompactedRecord {
  if (typeof raw !== "object" || raw === null) return false;
  const value = raw as Record<string, unknown>;
  return (
    value["role"] === "compacted" &&
    typeof value["id"] === "string" &&
    typeof value["summary"] === "string" &&
    typeof value["tokensBefore"] === "number" &&
    (value["tokensAfter"] === undefined || typeof value["tokensAfter"] === "number") &&
    typeof value["timestamp"] === "number"
  );
}

/**
 * 标题的来源。三态是 auto-title 的门禁（C-3，`docs/plans/2026-09-02-会话标题模型生成.md`）：
 * `derived` = 首句截断（含从未生成过 / 生成失败），允许模型再试；
 * `auto` = 模型已生成，不再试；`user` = 用户改过名（含改空），模型永不覆盖。
 */
export type TitleSource = "derived" | "auto" | "user";

/** 会话卡上「最近提问」槽位数。规格固定 3（不足留空槽），超出丢最旧的。 */
export const RECENT_QUERIES_MAX = 3;

/**
 * 把一条用户消息记进「最近提问」。**截断与首行规则复用 `deriveSessionTitle`**——
 * 会话卡上的提问行和侧栏标题一样必须一行放得下，两处不各写一套。
 * 空消息（图片消息等没有文本块的）不记；不查重——发三次「继续」就是三条提问。
 */
export function pushRecentQuery(current: readonly string[], text: string): string[] {
  const query = deriveSessionTitle(text);
  if (query === "") return [...current];
  return [query, ...current].slice(0, RECENT_QUERIES_MAX);
}

/** 从一段 transcript 抽「最近提问」（新→旧）——分支的新会话从它的前缀里继承。 */
export function recentQueriesFromRecords(records: readonly SessionRecord[]): string[] {
  let queries: string[] = [];
  for (const record of records) {
    if (record.role !== "user") continue;
    const text = record.content.find((block) => block.type === "text");
    if (text !== undefined && text.type === "text") queries = pushRecentQuery(queries, text.text);
  }
  return queries;
}

/**
 * 完成状态：会话作为「一单任务」的闭环三态。语义与可撤销性见
 * `SessionMeta.completion` 的字段注释。
 */
export type SessionCompletion = "open" | "done" | "done_with_todos";

/**
 * 是否已完成（done / done_with_todos）。parse 已补默认，运行时恒有值；
 * `?? "open"` 只防构造点未写这三个键的 meta 字面量（构造点不写是既定决策）。
 * 抽成函数是因为判断有两个消费者（侧栏筛选/行内标识、会话头部按钮），
 * 各写一份 `completion !== "open"` 迟早漂移。
 */
export function isSessionDone(meta: SessionMeta): boolean {
  return (meta.completion ?? "open") !== "open";
}

/**
 * 收尾仪式（carryover）收割的一条遗留事项。真源是全局一份 `carryovers.jsonl`
 * （会话侧只存 `completion` 状态、不内嵌正文——避免两处真源）；侧栏「待办 N」角标
 * 与「Has todos」筛选都由 renderer 按 `sourceSessionId` 现算。reopen（回 open）
 * **不删不改**这些记录：遗留事项是收尾时收割的事实，不随会话状态回滚。
 */
export interface Carryover {
  id: string;
  /** 一句话事项，清单 UI 里显示的就是它 */
  title: string;
  /** 上下文摘录（agent 从对话里摘的原句/概括），展开时看 */
  detail: string;
  /** 回链：从哪条会话收割的 */
  sourceSessionId: string;
  /** transcript 里的消息序号区间锚点；跳回原文定位用，算不出就 null */
  sourceMessageRange: [number, number] | null;
  status: "open" | "done";
  createdAt: number;
  doneAt: number | null;
}

/** carryover 的 status 取值（独立出来给 store 与 IPC 复用）。 */
export type CarryoverStatus = Carryover["status"];

/**
 * 批量创建的载荷（renderer → 主进程）：内容与锚点；id / status / 时间戳由
 * CarryoverStore 铸——落盘事实由写盘方定，renderer 不猜。
 * 放在 shared（而非 store）是因为 preload 与 renderer 都要引用它，而它们不得
 * import 主进程模块（preload 头部纪律）。
 */
export interface CarryoverDraft {
  title: string;
  detail: string;
  sourceMessageRange: [number, number] | null;
}

/**
 * 解析磁盘上的一条 carryover。**坏了返回 null，调用方跳过该行**（parseSessionMeta
 * 的纪律）：一条字段残缺的遗留事项混进清单，比少列一条更误导——用户会去办一件
 * 标题都没说清的事。
 */
export function parseCarryover(raw: unknown): Carryover | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const id = str(value["id"]);
  const title = str(value["title"]);
  const sourceSessionId = str(value["sourceSessionId"]);
  if (id === null || title === null || sourceSessionId === null) return null;
  if (typeof value["detail"] !== "string") return null;
  const range = value["sourceMessageRange"];
  if (
    range !== null &&
    (typeof range !== "object" ||
      !Array.isArray(range) ||
      typeof range[0] !== "number" ||
      typeof range[1] !== "number" ||
      !Number.isFinite(range[0]) ||
      !Number.isFinite(range[1]))
  ) {
    return null;
  }
  const createdAt = num(value["createdAt"]);
  if (createdAt === null) return null;
  const doneAt = num(value["doneAt"]);
  return {
    id,
    title,
    detail: value["detail"],
    sourceSessionId,
    sourceMessageRange: range as [number, number] | null,
    status: value["status"] === "done" ? "done" : "open",
    createdAt,
    doneAt,
  };
}

export interface SessionMeta {
  id: string;
  /** 首条用户消息的第一行；模型生成成功后替换为概括（titleSource = auto） */
  title: string;
  titleSource: TitleSource;
  /**
   * 意图召回的会话级开关（实验功能 intent-system，输入框旁的小开关）。
   * 缺席 = 跟随设置里的新会话默认（settings.intent.newSessionOn）；
   * 开着实验功能但某条会话关了召回时，回答照常 /ingest 攒历史。
   */
  intentEnabled?: boolean;
  /**
   * 这一单跑在哪儿。**创建时固定、不可改**——pi 的 session 在 `createAgentSession`
   * 时锁定 cwd，所以换目录只能换会话。
   */
  cwd: string;
  /**
   * 属于哪个工作区；**null = 不属于任何工作区**（侧栏 TASKS 节点下那些）。
   * 按**工作区 id** 而不是按 cwd 归属：用户挪个文件夹或改个名，会话不该成孤儿。
   */
  workspaceId: string | null;
  /**
   * 会话当前用的 provider / 模型。导入的会话没有「当前用的」——providerId 落
   * `UNASSIGNED_PROVIDER_ID` 占位、modelId 落源应用记录的原模型名（缺席 "unknown"），
   * 打开时模型栏显示「没有模型」、由用户自己选（2026-09-28 裁决：导入与模型解耦，
   * 源模型名对到哪个渠道「在我们这里做不出好的设计决策」）。原生会话的 provider
   * 被删后也会短暂处于「无效 provider」态，同一套界面处理。
   */
  providerId: string;
  modelId: string;
  /** 最后一次用的权限档。存下来是为了重开这条会话时不会静默换档。 */
  mode: PermissionMode;
  /**
   * 最后一次用的思考档，同 mode 的理由：重开不静默换档。**缺省退 "medium"**——
   * 这个字段落地之前存的会话，实际跑的就是 pi 的默认 medium，退 "off" 才是改写历史。
   */
  thinkingLevel: ThinkingLevel;
  /**
   * pi 自己那份 session 文件的路径；**null = 这条会话只能读不能续**。
   *
   * 续会话不是我们把历史重讲一遍，而是把 pi 自己的本子还给它
   * （`SessionManager.open`）——理由与被否决的方案见 guideline §四。
   * 本字段落地之前存的会话、或 pi 那份被删了的，都是 null。
   */
  piSessionFile: string | null;
  /** 置顶。列表里排在最前，与 updatedAt 无关 */
  pinned: boolean;
  /** 归档。从主列表里移走，收进侧栏底部的 Archived——**不是删除** */
  archived: boolean;
  /*
   * 生命周期三字段（星标 / 完成状态 / 关闭时刻）是**可选**的：它们落地前构造的
   * meta 字面量（importer、新建会话）不写这三个键，落盘即缺席，读回 parse 补
   * 默认——与 importedFrom 的「缺席即否」同构。parse 出来的对象运行时恒有值。
   */
  /**
   * 星标：用户的价值标记，**与任务状态正交**——星一个会话说的是「值得回来翻」，
   * 不代表它做完了，也不参与排序（排序只认 pinned）。缺席即 false。
   */
  starred?: boolean;
  /**
   * 未读：这条会话（后台）跑完了、人还没看过——2026-10-10 用户裁决**落盘**：
   * 重启后侧栏竖条与右下角铃铛清单还要指得出「有结果没看」。**null / 缺席即已读**。
   *
   * - `at`：标未读那一刻（Unix ms）。铃铛清单同档排序（新→旧）与家务活模型
   *   以后扫清单都要一个时间。
   * - `failed`：那一轮以失败收尾（重试耗尽等）——竖条画 3/3 红而不是绿，
   *   同样算未读。是**落定那一刻的快照**，不是运行时态。
   *
   * 谁写：renderer 判定（completion-notice 的 planNotice：没在看才标），经
   * session:unread 通道落盘；看过（主槽 / 辅助对话显示了它）即清。新开一轮跑
   * 完会覆盖成新值。
   */
  unread?: { at: number; failed: boolean } | null;
  /**
   * 完成状态：open = 还在跑；done = 干完了；done_with_todos = 干完了但留了
   * 遗留事项。**可撤销**——重开 done 的会话继续干活就回 open。缺席即 open。
   */
  completion?: SessionCompletion;
  /**
   * 关闭时刻（Unix ms）。completion 为 "open" 时恒为 null：翻到 done /
   * done_with_todos 的那一刻写入，撤销（回 open）时清掉。缺席即 null。
   */
  closedAt?: number | null;
  /**
   * 收尾确认的记录（旧 → 新）：每次确认「做完的事」各一件，任务账本按它记账（价格 · 能力图的
   * 实测任务只认这里与子会话）。下次收尾从最后一次的 throughTurn + 1 扫起。缺席即空。
   */
  wrapups?: SessionWrapup[];
  /**
   * 这条会话在接着做哪些遗留事项（carryover id）：从遗留清单「继续」开出的新会话、或在原会话
   * 续跑时记下；这条会话收尾确认时，它们自动标为做完，然后清空。缺席即空。
   */
  resumedCarryovers?: string[];
  /**
   * 最近 3 条用户提问（新→旧，每条首行、截断规则同 title）。
   * 首页会话卡的三个提问槽吃它；**旧会话没有这个字段，显示空槽**。
   */
  recentQueries: string[];
  /**
   * 从外部应用导入的会话才有的标记（Proma pi 同构导入，importer.ts）：
   * `importedFrom` = 源 pi session 文件的绝对路径，**幂等键**——重复导入按它判重；
   * `importedModel` = 源应用记录的原始模型 id（渠道名不可信，只有 id 值得留；
   * 映射结果就在 providerId/modelId，miss 兜底时这里保住「原本跑的是谁」）。
   * 非导入会话两个字段都缺省——不加 `imported: false` 这类反字段，缺席即否。
   */
  importedFrom?: string;
  importedModel?: string;
  /**
   * 母会话 id；**缺席 = 根会话**（缺席即否，同 importedFrom 的纪律）。
   *
   * 子会话是母会话的附属物（2026-09-22 裁决）：**永不进左栏**，不参与 pin / 归档，
   * 只从母会话的右栏「Sub-sessions」入口到达；母会话归档与否不影响这条路径；
   * 删母会话级联删子。为什么不挂树在侧栏：子会话的数量级取决于产品给不给
   * agent 一个「保护主上下文的搜索原语」——给了就是 zcode 那样一条会话二十几个，
   * 侧栏挂树不可扩展。契约上允许多层，UI 只做一层。
   *
   * 生产者有两个：导入器（Proma 的 delegation 子会话）与 orbita 自己的 delegate 工具——
   * 主进程派出子会话时标题由模型在派出那一刻给定，`titleSource` 直接是 `"user"`，
   * 不走 auto-title（模型起的名就是最终名，不会被首句截断或后续生成覆盖；
   * 命名只发生在派出那一刻）。
   */
  parentId?: string;
  /**
   * 这条会话是哪条自动化**新开**出来的（实验功能 automation，target = new_session）；
   * **缺席 = 用户自己开的会话**。this_session 的任务是叫醒一条普通会话，不在这条会话上留任何标记。
   *
   * 自动化每次触发开一条新会话（在该自动化所属的工作区里），meta 上记它的 id：
   * - 左栏与所有「根会话」列表都不列它（`rootSessions` 过滤；`promoted` 之后才列），
   *   只从右栏自动化面板里那条任务下面进；
   * - 它自己的 agent 不注册 automation_* 工具（自动化不能再建自动化，防递归）；
   * - 自动化被删时它跑出的会话不删——这个 id 指向不存在的自动化是正常状态，
   *   会话顶部的标注读下面的 `automationRun`，不依赖自动化还在。
   */
  automationId?: string;
  /** 会话顶部「任务名 · 第 n 次 · 时间 · 定时/手动」的素材；与 automationId 同生（缺席 = 没有标注） */
  automationRun?: AutomationRunLabel;
  /**
   * 用户点了「转成普通会话」：这条自动化开出的会话从此进左侧栏（`rootSessions` 认它）。
   * 缺席即否；只对带 automationId 的会话有意义。
   */
  promoted?: boolean;
  /**
   * 上一次跑完时的用量快照（A1-Q1，2026-09-03 裁决）。
   * **null = 没有账本**（本字段之前存的会话，或还没跑过一轮）。
   *
   * **为什么存快照而不是每次重算**：pi 的 `getSessionStats()` 里 token 与花费
   * 确实能从 session 文件重新聚合，但 `contextUsage` 不行——它要模型的
   * contextWindow 加 pi 的 token 估算器跑当前分支的消息，两样都只活在
   * `AgentSession` 上，pi 也没把它们单独导出。而「打开一条会话就建一个
   * AgentSession」太贵——翻记录是最常见的动作。
   *
   * 代价说清楚：pi 那份 session 文件才是原始账本，这里只是我们上次看到的样子。
   * 同一份 pi session 被别的客户端续过的话，这份快照会偏旧，直到它在这里再跑一轮。
   */
  stats: AgentStats | null;
  createdAt: number;
  updatedAt: number;
}

/** 打开一条会话拿到的东西：元数据 + 落盘的 transcript（**生效视图全量**） */
export interface SessionDetail {
  meta: SessionMeta;
  transcript: SessionRecord[];
}

/**
 * 源侧分页的一页有多少条记录（尾窗与 loadOlder 共用同一个数）。
 *
 * 500 条 ≈ 60 轮 × 平均 8 条/轮（一轮 = 一条 user + 回答与工具调用各若干条），
 * 贴 ZCode 的冷订阅尾窗 60 行 / 滚顶每次再取 200 行的思路。**只分 IPC 传输量与
 * renderer 渲染量**：主进程照样全量读盘 + 折叠，窗口是读时投影（见 store.loadWindow）。
 */
export const SESSION_PAGE_RECORDS = 500;

/** 一条会话的窗口信息：已加载窗口之外还有多少历史 */
export interface SessionWindow {
  /** 生效视图里的记录总条数（主进程全量读 + 折叠后的长度），给排障与将来的进度显示 */
  total: number;
  /** 已加载窗口之前还有记录（滚动触顶要拉的那一页在不在） */
  hasMore: boolean;
  /**
   * 窗口**之前**的生效视图里有几条压缩界碑（`role: "compacted"`）。
   *
   * 用量环要显示「这是第几个上下文窗口」，而压缩过的会话恰恰是长会话——界碑多半落在
   * 尾窗之外，只数已加载窗口会少数。主进程本来就全量读了生效视图，顺手数一遍；
   * renderer 拉更早一页时把那页里的界碑从这个数里挪进已加载的账（总数不变）。
   * 回退折叠后的视图里才数，所以回退掉的压缩不算。
   */
  compactionsBefore: number;
}

/**
 * 打开一条会话的**尾窗**：元数据 + 尾部一段 transcript + 窗口信息。
 * 与 `SessionDetail` 同形（transcript 只是被切过），renderer 的「已加载窗口」就是它。
 * 要全量视图的消费者（导出 / 回退 / intent 归档 / read_task）走 store.load，不走这里。
 */
export interface SessionWindowDetail extends SessionDetail {
  window: SessionWindow;
}

/** `session:loadOlder` 的一页：`before` 那条记录之前的一段 + 还有更早吗 */
export interface SessionOlderPage {
  /** 生效视图里紧挨在 before 之前的一段（起点同样对齐到轮边界） */
  records: SessionRecord[];
  /** 这一段之前还有记录 */
  hasMore: boolean;
}

/**
 * 从一段用户输入里取标题。**放在 shared 是为了主进程与渲染层用同一条规则**——
 * 主进程落盘时算一次，渲染层给还没落盘的当前会话算一次，两边必须一致，
 * 否则同一条会话在侧栏和标题栏会显示两个名字。
 */
export function deriveSessionTitle(text: string): string {
  // 引用块不是用户自己说的话：剥掉再取首行，否则标题是一行 `<quoted_context …>`。
  // 附件块同理（粘贴块 / 文件清单）：「只发附件不打字」开会话时，第一条用户消息的
  // 文本块就是它们，不剥的话标题栏与最近提问是一行裸 XML。
  // `/skill:` / `/mcp:` 的指令块同理（转录存的是发给模型的全文，用户自己写的从
  // 指令块之后开始）——剥掉取正文，剥完为空则标题为空，侧栏按「等首条带字消息」
  // 规则处理。
  // 旧格式的 `<skill>` 块（2026-10-02 前句中展开时代的存量）同样全剥，不迁移。
  const invocationStripped = stripInvocationBlock(text);
  const skillStripped = (() => {
    const segments = parseSkillSegments(invocationStripped);
    if (segments === null) return invocationStripped;
    return segments
      .filter((segment): segment is Extract<typeof segment, { kind: "text" }> => segment.kind === "text")
      .map((segment) => segment.text)
      .join("\n\n");
  })();
  // 标题 / 最近提问 / 渲染层给当前会话算标题都走这里，一处剥全处生效
  const body = splitUserTextBlocks([withoutQuotes(skillStripped)]).body;
  const line = body.trim().split("\n")[0]?.trim() ?? "";
  if (line === "") return "";
  return line.length > SESSION_TITLE_MAX ? `${line.slice(0, SESSION_TITLE_MAX)}…` : line;
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return (PERMISSION_MODES as readonly unknown[]).includes(value);
}

const TITLE_SOURCES: readonly TitleSource[] = ["derived", "auto", "user"];

function isTitleSource(value: unknown): value is TitleSource {
  return (TITLE_SOURCES as readonly unknown[]).includes(value);
}

const SESSION_COMPLETIONS: readonly SessionCompletion[] = ["open", "done", "done_with_todos"];

function isSessionCompletion(value: unknown): value is SessionCompletion {
  return (SESSION_COMPLETIONS as readonly unknown[]).includes(value);
}

/** 磁盘上的 recentQueries 只收「字符串数组的前 3 个」，其余全部丢掉，不给坏值过路。 */
function parseRecentQueries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").slice(0, RECENT_QUERIES_MAX);
}

/**
 * 解磁盘上的一份未读标记。**坏了返回 null（当已读）**，不丢整条会话——
 * 未读丢了只是少一个提醒，会话本体还在；同 parse 系列的纪律。
 * 也用在 IPC 入口：renderer 传来的坏载荷当已读写回，不裸存进 meta。
 */
export function parseSessionUnread(raw: unknown): { at: number; failed: boolean } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const at = num(value["at"]);
  if (at === null) return null;
  return { at, failed: value["failed"] === true };
}

/** 有限数字才算数字。NaN / Infinity 进了界面就是一行胡话 */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 上下文占用。**没有它不影响剩下的账本**，所以单独解、单独为 null：
 * 压缩刚发生完那一刻存下的快照本来就没有它（`tokens: null`）。
 */
function parseContextUsage(raw: unknown): AgentStats["contextUsage"] {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const contextWindow = num(value["contextWindow"]);
  if (contextWindow === null) return null;
  return { tokens: num(value["tokens"]), contextWindow, percent: num(value["percent"]) };
}

/**
 * 解磁盘上的一份用量快照。**缺一项就整条丢**（返回 null）——
 * 半份账本比没有账本更容易骗人：缺了 cacheRead 的那一行会显示成 0，
 * 而 0 在这个界面上的意思是「真的没用缓存」。
 */
export function parseAgentStats(raw: unknown): AgentStats | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const cost = num(value["cost"]);
  if (cost === null) return null;

  const rawTokens = value["tokens"];
  if (typeof rawTokens !== "object" || rawTokens === null) return null;
  const t = rawTokens as Record<string, unknown>;
  const input = num(t["input"]);
  const output = num(t["output"]);
  const cacheRead = num(t["cacheRead"]);
  const cacheWrite = num(t["cacheWrite"]);
  const total = num(t["total"]);
  if (
    input === null ||
    output === null ||
    cacheRead === null ||
    cacheWrite === null ||
    total === null
  ) {
    return null;
  }

  return {
    tokens: { input, output, cacheRead, cacheWrite, total },
    cost,
    contextUsage: parseContextUsage(value["contextUsage"]),
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
/**
 * 解析磁盘上的一份 meta。**坏了返回 null，调用方跳过这条**，而不是补一个默认值——
 * 一条 id 是编出来的会话比少列一条更糟：它会指向一个不存在的 transcript，
 * 用户点进去看到空白，还以为记录丢了。
 */
export function parseSessionMeta(raw: unknown): SessionMeta | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const id = str(value["id"]);
  const cwd = str(value["cwd"]);
  const providerId = str(value["providerId"]);
  const modelId = str(value["modelId"]);
  if (id === null || cwd === null || providerId === null || modelId === null) return null;

  const createdAt = typeof value["createdAt"] === "number" ? value["createdAt"] : null;
  if (createdAt === null) return null;
  const importedFrom = str(value["importedFrom"]);
  const importedModel = str(value["importedModel"]);
  const parentId = str(value["parentId"]);
  const automationId = str(value["automationId"]);
  const automationRun = parseAutomationRunLabel(value["automationRun"]);

  return {
    id,
    // 标题可以为空（会话建了但一条消息都没发过），所以它不是必填
    title: typeof value["title"] === "string" ? value["title"] : "",
    // 缺 titleSource 的是 auto-title 之前存的会话：它们是首句截断，允许模型再试
    titleSource: isTitleSource(value["titleSource"]) ? value["titleSource"] : "derived",
    cwd,
    providerId,
    modelId,
    // 缺 workspaceId 的是刀 B 之前存的会话：它们不属于任何工作区，落到 TASKS 下
    workspaceId: typeof value["workspaceId"] === "string" ? value["workspaceId"] : null,
    // 缺 piSessionFile 的会话只能读不能续——界面要如实说出来
    piSessionFile: typeof value["piSessionFile"] === "string" ? value["piSessionFile"] : null,
    // 两个开关都**默认关**：老会话不该因为加了字段就突然被置顶或藏起来
    pinned: value["pinned"] === true,
    archived: value["archived"] === true,
    // 生命周期三字段的缺省即默认：老会话不因加字段而变样（星标关、open、无关闭时刻）；
    // 坏值回落默认，不丢整条会话——与 mode / thinkingLevel 的坏值策略一致
    starred: value["starred"] === true,
    completion: isSessionCompletion(value["completion"]) ? value["completion"] : "open",
    closedAt: num(value["closedAt"]),
    // 收尾记录与在做的遗留事项：缺席即空；坏条目逐条丢（一条坏账不连累整条会话）
    ...parseWrapupsField(value["wrapups"]),
    ...parseResumedField(value["resumedCarryovers"]),
    // 未读标记：缺 at 整条丢（当已读）——见 parseSessionUnread 的纪律
    unread: parseSessionUnread(value["unread"]),
    // 缺 recentQueries 的是会话卡之前存的会话：空槽显示，不补算（读日志太贵）
    recentQueries: parseRecentQueries(value["recentQueries"]),
    // 读不出用量就当没有——一份坏账本不该连带丢掉整条会话
    stats: parseAgentStats(value["stats"]),
    // 档位不认识就退回最保守的那一档，而不是丢掉整条会话
    mode: isPermissionMode(value["mode"]) ? value["mode"] : "plan",
    // 思考档坏值退 medium（老会话实际跑的那一档），理由见字段注释
    thinkingLevel: parseThinkingLevel(value["thinkingLevel"]),
    // 导入标记：非导入会话缺席（空串/null 都当没有，str 的规则）
    ...(importedFrom === null ? null : { importedFrom }),
    ...(importedModel === null ? null : { importedModel }),
    // 母会话 id：非字符串 / 空串一律当根会话——一条指向乌有的 parentId 会让会话
    // 从左栏消失又无处可达，比多列一条根会话糟得多
    ...(parentId === null ? null : { parentId }),
    ...(automationId === null ? null : { automationId }),
    ...(automationId === null || automationRun === null ? null : { automationRun }),
    ...(automationId !== null && value["promoted"] === true ? { promoted: true } : null),
    // 意图召回的会话级开关（实验功能 intent-system）：缺席 = 跟随设置里的
    // 新会话默认。只认布尔，坏值丢掉
    ...(value["intentEnabled"] === true || value["intentEnabled"] === false
      ? { intentEnabled: value["intentEnabled"] }
      : {}),
    createdAt,
    updatedAt: typeof value["updatedAt"] === "number" ? value["updatedAt"] : createdAt,
  };
}

function parseTokens(raw: unknown): WrapupTokens | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const keys = ["input", "output", "cacheRead", "cacheWrite"] as const;
  if (!keys.every((key) => typeof v[key] === "number" && Number.isFinite(v[key]) && (v[key] as number) >= 0)) {
    return null;
  }
  return { input: v["input"] as number, output: v["output"] as number, cacheRead: v["cacheRead"] as number, cacheWrite: v["cacheWrite"] as number };
}

function parseTurnRange(raw: unknown): [number, number] | null | undefined {
  if (raw === null) return null;
  if (!Array.isArray(raw) || raw.length !== 2) return undefined;
  const [from, to] = raw as unknown[];
  if (!Number.isInteger(from) || !Number.isInteger(to)) return undefined;
  if ((from as number) < 1 || (to as number) < (from as number)) return undefined;
  return [from as number, to as number];
}

function parseWrapupItem(raw: unknown): WrapupItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v["title"] !== "string") return null;
  const turns = parseTurnRange(v["turns"]);
  const tokens = parseTokens(v["tokens"]);
  const unpricedTokens = parseTokens(v["unpricedTokens"]);
  if (turns === undefined || tokens === null || unpricedTokens === null) return null;
  const recordedCost = v["recordedCost"];
  if (typeof recordedCost !== "number" || !Number.isFinite(recordedCost) || recordedCost < 0) return null;
  const providerId = typeof v["providerId"] === "string" ? v["providerId"] : null;
  const modelId = typeof v["modelId"] === "string" ? v["modelId"] : null;
  return {
    title: v["title"],
    turns,
    providerId,
    modelId,
    level: isThinkingLevel(v["level"]) ? v["level"] : null,
    tokens,
    recordedCost,
    unpricedTokens,
  };
}

/** 一次收尾确认；坏了返回 null（逐条丢） */
export function parseSessionWrapup(raw: unknown): SessionWrapup | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const id = str(v["id"]);
  const at = num(v["at"]);
  const through = v["throughTurn"];
  if (id === null || at === null || !Number.isInteger(through) || (through as number) < 0) return null;
  if (!Array.isArray(v["items"])) return null;
  const items: WrapupItem[] = [];
  for (const entry of v["items"] as unknown[]) {
    const item = parseWrapupItem(entry);
    if (item === null) return null;
    items.push(item);
  }
  return { id, at, throughTurn: through as number, items };
}

function parseWrapupsField(raw: unknown): { wrapups?: SessionWrapup[] } {
  if (!Array.isArray(raw)) return {};
  const wrapups = raw.map(parseSessionWrapup).filter((w): w is SessionWrapup => w !== null);
  return wrapups.length === 0 ? {} : { wrapups };
}

function parseResumedField(raw: unknown): { resumedCarryovers?: string[] } {
  if (!Array.isArray(raw)) return {};
  const ids = [...new Set(raw.filter((id): id is string => typeof id === "string" && id !== ""))];
  return ids.length === 0 ? {} : { resumedCarryovers: ids };
}

/**
 * 会话列表的排序：**置顶的在前，其余按最近活动倒序**。
 *
 * 抽成函数是因为它有两个消费者（主进程的 `list()` 与渲染层重排后的列表），
 * 两处排法不一致会让同一条会话在刷新前后跳位置。
 */
export function sortSessions(sessions: readonly SessionMeta[]): SessionMeta[] {
  return [...sessions].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

/**
 * 根会话：没有母会话、也不是自动化跑出来（且没被「转成普通会话」）的那些。
 * **左栏、首页最近、辅助对话选择器只列根会话**——三处消费者各自调用同一个函数，不各写一遍
 * `parentId === undefined`。自动化新开的会话（`automationId`）只从右栏自动化面板进，
 * 转成普通会话（`promoted`）之后才进这些列表。
 */
export function rootSessions(sessions: readonly SessionMeta[]): SessionMeta[] {
  return sessions.filter(
    (meta) => meta.parentId === undefined && (meta.automationId === undefined || meta.promoted === true),
  );
}

/**
 * 某条会话的直接子会话，**按创建时间正序**——子会话的自然顺序是派出顺序，
 * 不是活跃倒序（sortSessions 是根列表的排法，不套用）。只取一层：契约允许多层，
 * 但今天没有第二层的生产者。
 */
export function childSessions(sessions: readonly SessionMeta[], parentId: string): SessionMeta[] {
  return sessions
    .filter((meta) => meta.parentId === parentId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 机器事实用 ISO 8601 UTC：无歧义、可测、与设计系统「mono for machine facts」一致。 */
function iso(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 工具输出的导出截断上限。一次 grep 可能几千行——导出是给人读的存档，不是磁盘镜像。 */
const TOOL_EXPORT_MAX_LINES = 50;

/** 截断必须标注真实行数——「被截掉了」这件事不能是悄悄的。 */
function clipLines(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= TOOL_EXPORT_MAX_LINES) return text;
  return `${lines.slice(0, TOOL_EXPORT_MAX_LINES).join("\n")}\n… (truncated, ${lines.length} lines in total)`;
}

/**
 * transcript → Markdown。**导出与「复制整条对话」共用它**——
 * 两处各写一份的话，导出的和复制的会长得不一样，而用户以为是同一个东西。
 *
 * 思考与工具调用**保留但标出来**：导出是给人看的存档，把过程抹掉就没法追溯了
 * （设计系统：用户需要的是「知道 agent 在干嘛」与可追溯）。
 */
export function transcriptToMarkdown(
  transcript: readonly SessionRecord[],
  meta?: SessionMeta,
): string {
  const parts: string[] = [];
  if (meta !== undefined) {
    parts.push(`# ${meta.title === "" ? "Untitled task" : meta.title}`);
    parts.push(
      [
        `- Folder: \`${meta.cwd}\``,
        `- Model: \`${meta.providerId} / ${meta.modelId}\``,
        `- Permission: \`${meta.mode}\``,
        `- Created: \`${iso(meta.createdAt)}\``,
        `- Updated: \`${iso(meta.updatedAt)}\``,
      ].join("\n"),
    );
    parts.push("---");
  }

  for (const item of transcript) {
    if (isCompactedRecord(item)) {
      // 界碑在导出里同样站得住：标记 + 摘要进引用块，读起来是「此前发生过」而不是对话
      parts.push(`**[Compacted]** (earlier context ≈ ${item.tokensBefore.toLocaleString("en-US")} tokens)`);
      parts.push(
        item.summary
          .trim()
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
      );
      continue;
    }
    if (isChannelMarkRecord(item)) {
      // 通道标记暂不渲染（真正的标记 UI 是后续 PR）。正文只有一份、在通道账本里，
      // 导出也不该在这里捏一行假的——要看通道往来，去读那份账本
      continue;
    }
    // 文件账三件（revert.ts）不是对话：轮尾账与撤销标记跳过；回退界碑落一行
    // 「此后已回退」的说明——存档的人要知道再往前的记录是被回退折掉的
    if (item.role === "file-turn" || item.role === "undo") continue;
    if (item.role === "revert") {
      parts.push("---");
      parts.push(
        `**[Reverted]** (${item.restored.length} file(s) restored · conversation below this point was rolled back and re-run)`,
      );
      continue;
    }
    // 意图召回卡（实验功能）：一行过程记录——召回服务过哪一句、结局如何；
    // 注入块永不落盘（见 IntentRecallRecord），导出也不谈
    if (item.role === "intent-recall") {
      parts.push(
        `**Intent recall · ${item.status}** (qa ${item.qaTotal ?? "?"}, selected ${item.selected.length})`,
      );
      continue;
    }
    if (item.role === "tool") {
      // 工具结果自成一块：调用本身（toolName + input）已经在它前面那条 assistant
      // 消息的 toolCall 块里，这里只落结果与成败——导出要的是可追溯，不是重复
      const output = item.content
        .map((block) => (block.type === "text" ? block.text : `[image ${block.mimeType}]`))
        .join("\n")
        .trim();
      parts.push(`**Tool · ${item.toolName}**${item.isError ? " (failed)" : ""}`);
      parts.push(`\`\`\`text\n${output === "" ? "(no output)" : clipLines(output)}\n\`\`\``);
      continue;
    }
    const body: string[] = [];
    for (const block of item.content) {
      if (block.type === "text" && item.role === "user") {
        // 用户消息里的引用块导成引用段落，/skill: / /mcp: 的指令块剥掉：存档给人读，
        // XML 标签是给模型的
        const { quotes, text } = parseQuotedMessage(stripInvocationBlock(block.text));
        for (const quote of quotes) {
          body.push(
            quote.text
              .trim()
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n"),
          );
        }
        if (text.trim() !== "") body.push(text.trim());
      } else if (block.type === "text") body.push(block.text.trim());
      else if (block.type === "thinking") {
        // 用引用块：读起来是「旁白」，而不是它说出口的话
        body.push(
          block.thinking
            .trim()
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n"),
        );
      } else if (block.type === "toolCall") {
        body.push(`\`\`\`json\n${JSON.stringify({ tool: block.toolName, input: block.input }, null, 2)}\n\`\`\``);
      }
    }
    if (body.length === 0) continue;
    parts.push(`**${item.role === "user" ? "User" : "Assistant"}**`);
    parts.push(body.join("\n\n"));
  }

  return `${parts.join("\n\n")}\n`;
}
