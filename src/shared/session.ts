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
import { PERMISSION_MODES, type PermissionMode } from "./permission.ts";
import { parseThinkingLevel, type ThinkingLevel } from "./thinking.ts";
import { parseQuotedMessage, withoutQuotes } from "./quote.ts";
import { parseSkillBlock } from "./skill.ts";
import { splitUserTextBlocks } from "./prompt-attachments.ts";

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
  /** 冷数据，免得画一行标记还要先读通道：谁发的、什么类型 */
  from: "parent" | "child";
  kind: "task" | "reply" | "question" | "progress" | "done" | "failed";
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
    ["task", "reply", "question", "progress", "done", "failed"].includes(value["kind"]) &&
    typeof value["timestamp"] === "number"
  );
}

/**
 * 日志与视图里的一条记录：往来消息（pi 的 TranscriptItem）、压缩界碑或通道标记（我们的）。
 */
export type SessionRecord = TranscriptItem | CompactedRecord | ChannelMarkRecord;

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

/** 打开一条会话拿到的东西：元数据 + 落盘的 transcript */
export interface SessionDetail {
  meta: SessionMeta;
  transcript: SessionRecord[];
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
  // `<skill>` 块同理（/skill: 展开的正文，wafo 二轮：同 3fbe362 的裸 XML 病）——
  // 剥掉取附加指示，剥完为空则标题为空，侧栏按「等首条带字消息」规则处理
  const skillStripped = (() => {
    const parsed = parseSkillBlock(text);
    return parsed === null ? text : parsed.rest;
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
    createdAt,
    updatedAt: typeof value["updatedAt"] === "number" ? value["updatedAt"] : createdAt,
  };
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
 * 根会话：没有母会话的那些。**左栏、首页最近、辅助对话选择器只列根会话**——
 * 三处消费者各自调用同一个函数，不各写一遍 `parentId === undefined`。
 */
export function rootSessions(sessions: readonly SessionMeta[]): SessionMeta[] {
  return sessions.filter((meta) => meta.parentId === undefined);
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
        // 用户消息里的引用块导成引用段落：存档给人读，XML 标签是给模型的
        const { quotes, text } = parseQuotedMessage(block.text);
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
