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

/** 标题上限。超出截断加省略号——标题要在 288px 的侧栏里一行放得下。 */
export const SESSION_TITLE_MAX = 60;

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
 * 日志与视图里的一条记录：往来消息（pi 的 TranscriptItem）或压缩界碑（我们的）。
 */
export type SessionRecord = TranscriptItem | CompactedRecord;

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
  const line = text.trim().split("\n")[0]?.trim() ?? "";
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
      if (block.type === "text") body.push(block.text.trim());
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
