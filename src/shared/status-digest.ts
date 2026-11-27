/**
 * 状态卡摘要（2026-11-27，「主进程算好摘要」）：对话区右上角状态卡不再把整条历史拉进 renderer
 * 重算，而是主进程每落盘一条记录就把它折进这条会话的摘要（fold），renderer 取摘要、再把
 * 尾窗里比摘要新的记录用**同一个 fold** 叠上去。
 *
 * ## fold 的口径：与卡上旧派生逐项相等
 *
 * 卡上每一块的数据来源与摘要的对应（旧派生函数是对账基准，见各段注释）：
 *
 * - **目标行**：旧 = useGoalLedger(records)（goal-ledger.ts 的 buildGoalLedger）。
 *   摘要 = `slim` 段里的 user / update_goal / update_plan  slim 记录，renderer 拿它跑同一个
 *   buildGoalLedger（ledgerEventsOf 的输入形状不变）——同一份代码，相等由构造保证。
 * - **进度（计划步骤）**：旧 = planTimeline(records)。摘要 = slim 段里的 update_plan 记录，
 *   renderer 跑同一个 planTimeline。slim 记录保留了 rawVersion 要读的每个字段
 *   （input / status / details.awaiting / id / toolCallId / timestamp）。
 * - **子会话挂哪步**：旧 = delegationSteps(records, timeline)。摘要 = slim 段（user /
 *   channel-mark 是「这一轮」的边界，delegate 记录带 title / planStep / childId），
 *   renderer 跑同一个 delegationSteps。knownIds 预扫在 slim 上进行——子会话 id 是派出时
 *   铸的随机 uuid，计划条目不可能提到还没出生的 id，所以 slim（只含 delegate 记录）与
 *   全量记录预扫出的集合相同。
 * - **产物**：旧 = statusOutputs(records)（chat-status.ts）。这段没有现成可复用的增量形，
 *   摘要自己折（outputs 段），语义逐行对着旧实现 port；对账测试守着。
 * - **在跑的终端**：旧 = useLiveTerminals 的 launched 半。摘要 = terminals 段（同一套抽取）。
 * - **子会话在跑什么**：旧 = childActivityOf(childTail)。摘要 = activity 段（同一套判定的
 *   增量形）。
 *
 * ## 顺序口径
 *
 * fold 按**日志落盘序**折叠。旧路径 view.records = 日志序前缀（loadOlder）+ 尾窗
 * （mergeSideRecords 按 (timestamp, 同刻 rank) 重排）：同毫秒相邻的记录两种序可能不同
 * （file-turn 的同刻 rank 排在 assistant 前）。摘要统一按日志序；真实数据里这对产物点名
 * 是否有影响由对账脚本（scripts/status-digest-audit.test.mjs）回答。
 *
 * ## 指纹与边界
 *
 * `meta`：lastId / lastTs / records（折了几条）/ recentIds（最后 64 条 id）。renderer 叠尾巴时
 * 取尾窗里位于 lastId 之后、且不在 recentIds 里的记录——同毫秒重排会让一两条已折叠的记录
 * 排到 lastId 后面，recentIds 挡住它们被折第二次。
 *
 * 纯模块：不 import electron / React，可被 node --test 直接加载。fold **就地修改** state
 * （调用方要不可变语义就自己 structuredClone）。
 */
import type { TranscriptRecord } from "./session.ts";
import type { FileTurnView, MediaArtifact } from "./revert.ts";
import { headLine } from "./goal-ledger.ts";
import { GOAL_TOOL_NAME } from "./goal.ts";
import { PLAN_TOOL_NAME } from "./plan.ts";
import { namedMedia, namedPaths } from "./named-outputs.ts";
import { isWebArtifactFile, mediaArtifactKind } from "./files.ts";
import { readCommandCard, type CommandCardData } from "./builtin-command.ts";
import { parsePluginBoardDetails, type PluginBoardResult } from "./plugin-board.ts";

// ───────────────────────── 产物（StatusOutput 的词表，从 chat-status.ts 搬来） ─────────────────────────

/**
 * 状态卡里一份产物的文件类型（2026-11-22 20:58 用户：分组按文件类型，不按「怎么产生的」）。
 */
export type StatusOutputKind = "slides" | "pptx" | "doc" | "word" | "web" | "pdf" | "image" | "audio" | "video" | "board" | "file";

/** 一次成功的 show_plugin_board：调用 id（对话里那条结果的定位）+ 当时的快照 */
export interface BoardCall {
  toolCallId: string;
  result: PluginBoardResult;
}

export interface StatusOutput {
  kind: StatusOutputKind;
  path: string;
  title: string;
  /** 演示文稿页数等补充（量不到 null） */
  pages: number | null;
  /** 音视频时长（秒；agent 从容器头量到才有） */
  duration?: number;
  /** 子会话做的：它的标题；主会话自己的 = null */
  by: string | null;
  at: number;
  /** 看板：插件名（在右栏打开它的看板用）；别的类型 = null */
  plugin: string | null;
  /** 看板：这次（同名看板里最后一次成功的）show_plugin_board 的调用 id 与快照；别的类型 = null */
  boardCall: BoardCall | null;
}

const EXT_KIND: Readonly<Record<string, StatusOutputKind>> = {
  pdf: "pdf",
  docx: "word",
  doc: "word",
  pptx: "pptx",
  ppt: "pptx",
  png: "image",
  jpg: "image",
  jpeg: "image",
  svg: "image",
  gif: "image",
  webp: "image",
};

/** 扩展名 → 产物类型（图片 / PDF / Word / PPTX 的再分）；chat-status.ts 的产物行也用 */
export { EXT_KIND };

function extOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** 文件扩展名（小写、不含点；没有 = ""）：状态卡产物分类用，chat-status.ts 也从这里拿 */
export { extOf };

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** 路径归一（去重键）：反斜杠归一成正斜杠（process-rows.ts 的 norm 同款） */
function normPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/** 结尾产物卡认的 → 文件类型（结尾卡的 file 一类按扩展名再分：PDF / Word / PPTX / 图片 / 其他） */
export function statusKindOf(output: { kind: string; path: string }): StatusOutputKind {
  if (output.kind === "slides") return "slides";
  if (output.kind === "doc") return "doc";
  if (output.kind === "web") return "web";
  if (output.kind === "audio" || output.kind === "video") return output.kind;
  return EXT_KIND[extOf(output.path)] ?? "file";
}

/** 插件看板结果里的看板名与插件名（details.pluginBoard.title / plugin）；没有 = null */
export function boardOf(details: unknown): { title: string; plugin: string | null } | null {
  if (typeof details !== "object" || details === null) return null;
  const board = (details as Record<string, unknown>)["pluginBoard"];
  if (typeof board !== "object" || board === null) return null;
  const record = board as Record<string, unknown>;
  const plugin = typeof record["plugin"] === "string" && record["plugin"] !== "" ? record["plugin"] : null;
  const title = typeof record["title"] === "string" && record["title"] !== "" ? record["title"] : plugin;
  return title === null ? null : { title, plugin };
}

/** 一次 show_plugin_board 结果 → 调用 id + 快照；快照读不出来（形状不对）= null（缩略图退回图标） */
export function boardCallOf(toolCallId: string, details: unknown): BoardCall | null {
  const result = parsePluginBoardDetails(details);
  return result === null ? null : { toolCallId, result };
}

// ───────────────────────── 摘要状态 ─────────────────────────

/** 子会话此刻在跑的那次调用（childActivityOf 的增量形；input 只留 toolCallLine 读的六个键） */
export interface ActivityCall {
  toolName: string;
  input: unknown;
  since: number;
}

/** 这条会话的 agent 开的终端（useLiveTerminals 的 launched 半） */
export interface TerminalEntry {
  id: string;
  command: string;
  since: number;
}

/** 产物工具的待决调用：调用先进队，结果（tool 记录）按 callId 贴上；派生时按调用序回放 */
interface OutputCall {
  callId: string;
  toolName: string;
  /** input.path（没有 = null） */
  path: string | null;
  /** input.format（导出格式；没有 = null） */
  format: string | null;
  /** 结果：没等到 = null（派生时跳过，同 batch 的 result undefined） */
  result: {
    status: string;
    /** readCommandCard(details)（slides_create / doc_open / 导出要它） */
    card: CommandCardData | null;
    /** DECK_WRITERS 的结果正文里量到的页数（「the deck now has N slide(s)」） */
    deckPages: number | null;
  } | null;
}

/** 同名看板只留最后一次成功的那次（缩略图要最新快照） */
interface BoardEntry {
  title: string;
  plugin: string | null;
  at: number;
  boardCall: BoardCall | null;
}

interface OutputsFoldState {
  queue: OutputCall[];
  /** 当前正文段（file-turn 点名用）：text 块累积，非 text 非 file-turn 的单元断；file-turn 消费后**不清**（同 batch） */
  answer: string[];
  /** 各轮文件账里被最终回答点了名的文档 / 网页 / 音视频（turn-artifacts.ts 的增量形） */
  docs: string[];
  web: string[];
  media: MediaArtifact[];
  /** 改过、但当时没点名的文件（路径去重；派生时再按最终产物集过滤一次） */
  edited: string[];
  /** [key = `board:${title}`, entry]，Map 语义：同 key 删了重插（= 最后出现序） */
  boards: [string, BoardEntry][];
}

interface ActivityFoldState {
  /** 最近一条 assistant 的未解决调用（块序）；tool 终态记录删掉对应项 */
  pending: [string, ActivityCall][];
  /** 最后一个 status=running 的工具记录（batch 的 quirk：之后来了同 callId 的终态也仍报它） */
  running: ActivityCall | null;
}

/**
 * 摘要状态。`slim` 是 goal / plan / delegation 三段的输入（ slim 记录：user 首行、
 * channel-mark 整条、update_plan / update_goal / delegate 的 slim 工具记录），renderer 拿它
 * 跑现有的批量派生（buildGoalLedger / planTimeline / delegationSteps）——那三段相等由构造保证。
 */
export interface StatusDigestState {
  meta: {
    /** 最后折进去的记录 id（空会话 = null） */
    lastId: string | null;
    /** 最后折进去的记录时间戳（产物的 at 用它；跳过解析的大行不推进它，见主进程扫描的注释） */
    lastTs: number;
    /** 折了几条（含 undo 等空操作记录；revert 后重算 = 生效视图条数） */
    records: number;
    /** 最后 64 条折进去的记录 id：renderer 叠尾巴时挡住同毫秒重排到 lastId 之后的已折记录 */
    recentIds: string[];
  };
  slim: TranscriptRecord[];
  outputs: OutputsFoldState;
  activity: ActivityFoldState;
  /** [id, entry]，Map 语义：首插序、值覆盖（useLiveTerminals 的 map.set） */
  terminals: [string, TerminalEntry][];
}

export function emptyStatusDigestState(): StatusDigestState {
  return {
    meta: { lastId: null, lastTs: 0, records: 0, recentIds: [] },
    slim: [],
    outputs: { queue: [], answer: [], docs: [], web: [], media: [], edited: [], boards: [] },
    activity: { pending: [], running: null },
    terminals: [],
  };
}

/** 深拷一份（renderer 在摘要上叠尾巴前调，别改到缓存里的原件） */
export function cloneStatusDigestState(state: StatusDigestState): StatusDigestState {
  return structuredClone(state);
}

const RECENT_IDS_CAP = 64;

/** 指纹推进：每条折进去的记录都走（含 undo 等空操作记录）。跳过解析的大行由调用方直接喂 id */
export function advanceDigestMeta(state: StatusDigestState, id: string | null, timestamp: number | null): void {
  state.meta.records += 1;
  if (id !== null) {
    state.meta.lastId = id;
    state.meta.recentIds.push(id);
    if (state.meta.recentIds.length > RECENT_IDS_CAP) state.meta.recentIds.shift();
  }
  if (timestamp !== null) state.meta.lastTs = timestamp;
}

// ───────────────────────── slim 记录（goal / plan / delegation 的输入） ─────────────────────────

/** 摘要工具：这三类的 tool 记录整行留下（plan / goal / delegate 的 slim 从它们来） */
const SLIM_TOOLS: ReadonlySet<string> = new Set([PLAN_TOOL_NAME, GOAL_TOOL_NAME, "delegate"]);

/**
 * 一条记录 → slim 记录（不是这三段的输入 = null）。slim 记录保留批量派生要读的每个字段，
 * 其余丢掉（user 正文只留 headLine——buildGoalLedger 只用它做来源行；headLine 幂等，
 * 折两次与折一次相同）。
 */
export function slimRecordOf(record: TranscriptRecord): TranscriptRecord | null {
  if (record.role === "user") {
    const text = record.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    return { role: "user", id: record.id, timestamp: record.timestamp, content: [{ type: "text", text: headLine(text) }] };
  }
  if (record.role === "channel-mark") return record;
  if (record.role !== "tool") return null;
  if (record.toolName === PLAN_TOOL_NAME || record.toolName === GOAL_TOOL_NAME) {
    const awaiting = (record.details as { awaiting?: unknown } | undefined)?.awaiting === true;
    // spread 保留 status/isError 的判别联合（running⇒isError false 等），只覆盖要 slim 的字段
    return { ...record, input: record.input, content: [], ...(awaiting ? { details: { awaiting: true } } : { details: undefined }) };
  }
  if (record.toolName === "delegate") {
    const childId = delegateChildIdOf(record.details);
    if (childId === null) return null;
    const input = (record.input ?? {}) as Record<string, unknown>;
    const slimInput: { title?: string; planStep?: string } = {};
    if (typeof input["title"] === "string") slimInput.title = input["title"];
    if (typeof input["planStep"] === "string") slimInput.planStep = input["planStep"];
    return { ...record, input: slimInput, content: [], details: { delegate: { childId } } };
  }
  return null;
}

function delegateChildIdOf(details: unknown): string | null {
  if (typeof details !== "object" || details === null) return null;
  const raw = (details as Record<string, unknown>)["delegate"];
  if (typeof raw !== "object" || raw === null) return null;
  const id = (raw as Record<string, unknown>)["childId"];
  return typeof id === "string" && id !== "" ? id : null;
}

// ───────────────────────── 产物折（statusOutputs 的增量形） ─────────────────────────

/** 写演示文稿的工具：结果里带「the deck now has N slide(s)」 */
const DECK_WRITERS: ReadonlySet<string> = new Set(["slides_write", "slides_edit", "slides_insert_image"]);
/** 产物工具的调用进队等结果；别的工具调用与产物无关 */
const OUTPUT_TOOLS: ReadonlySet<string> = new Set([
  "slides_create",
  "slides_write",
  "slides_edit",
  "slides_insert_image",
  "doc_open",
  "slides_export",
  "doc_export",
]);
/** PNG 是 agent 自己看排版用的（一页一张）：留在过程里当缩略图，不算交给用户的产物 */
const SELF_CHECK_EXPORT: ReadonlySet<string> = new Set(["png"]);

/** 导出格式的类型字（中文界面的英文词白名单里没有 PPTX，写 PowerPoint） */
const FORMAT_NAME: Readonly<Record<string, string>> = {
  pdf: "PDF",
  html: "HTML",
  pptx: "PowerPoint",
  "pptx-basic": "PowerPoint",
  docx: "Word",
  md: "Markdown",
  "md-plain": "Markdown",
};

/** 导出的格式 → 归哪一类：PDF 自成一类，PowerPoint 并进演示文稿，Word / Markdown 并进文档，HTML 归网页 */
const KIND_OF_FORMAT: Readonly<Record<string, "slides" | "doc" | "pdf" | "web">> = {
  pdf: "pdf",
  pptx: "slides",
  "pptx-basic": "slides",
  docx: "doc",
  md: "doc",
  "md-plain": "doc",
  html: "web",
};

function exportKind(format: string | null, path: string): { kind: "slides" | "doc" | "pdf" | "web"; format: string | null } {
  if (format !== null) return { kind: KIND_OF_FORMAT[format] ?? "doc", format: FORMAT_NAME[format] ?? format };
  // 入参没写格式：按扩展名认
  const ext = extOf(path);
  const known = ext === "pptx" ? "pptx" : ext;
  return { kind: KIND_OF_FORMAT[known] ?? "doc", format: FORMAT_NAME[known] ?? (ext === "" ? null : ext.toUpperCase()) };
}

/** 导出文件的说明：类型字 + 工具结果卡上带的其余部分（「3 页 · 171 KB」）；卡上第一段是工具自己的格式名（PPTX），换成类型字 */
function exportDetail(format: string | null, subtitle: string | undefined): string | null {
  if (format === null) return subtitle ?? null;
  const rest = subtitle === undefined ? [] : subtitle.split(" · ").slice(1);
  return [format, ...rest].join(" · ");
}

/** 「the deck now has 3 slide(s)」「the deck has 3 slide(s)」→ 3 */
function deckPagesFrom(text: string): number | null {
  const match = /the deck (?:now )?has (\d+) slide/.exec(text);
  return match === null ? null : Number(match[1]);
}

/** 与 renderer builtin-commands.ts 的 fileLabel 同一份规矩（演示文稿 / 文档的文件名标签）；漂移由对账测试抓 */
function fileLabel(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.replace(/\.slides\.json$/i, "").replace(/\.(?:md|markdown|txt)$/i, "");
}

/** 一轮里交给用户的产物（process-rows.ts 的 TurnOutput 形状；摘要内部用，派生时映射成 StatusOutput） */
interface DigestTurnOutput {
  kind: "slides" | "doc" | "pdf" | "web" | "audio" | "video";
  path: string;
  title: string;
  pages: number | null;
  format: string | null;
  detail: string | null;
  duration?: number;
}

const DOC_FILE = /\.(?:md|markdown|txt)$/i;

/** 文件账记录 → 点了名的文档 / 网页 / 音视频与「改过但没点名」的（turn-artifacts.ts 的增量形） */
function foldFileTurn(state: StatusDigestState, record: FileTurnView): void {
  const text = state.outputs.answer.join("\n");
  const changed = record.changes.map((change) => change.path);
  const docCandidates = changed.filter((path) => DOC_FILE.test(path));
  const webCandidates = [...changed.filter((path) => isWebArtifactFile(path)), ...(record.webArtifacts ?? [])];
  const namedDocs = namedPaths(docCandidates, text);
  const namedWeb = namedPaths(webCandidates, text);
  state.outputs.docs.push(...namedDocs);
  state.outputs.web.push(...namedWeb);
  state.outputs.media.push(...namedMedia(record.mediaArtifacts ?? [], text));
  const shown = new Set([...namedDocs, ...namedWeb]);
  for (const path of changed) {
    if (!shown.has(path) && !state.outputs.edited.includes(path)) state.outputs.edited.push(path);
  }
}

// ───────────────────────── 子会话在跑什么（childActivityOf 的增量形） ─────────────────────────

/** toolCallLine 只读这六个键（command / path / query / pattern / url / terminalId）：brief 只留它们，行话不变 */
const ACTIVITY_INPUT_KEYS = ["command", "path", "query", "pattern", "url", "terminalId"] as const;

function activityInputOf(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const record = input as Record<string, unknown>;
  const brief: Record<string, unknown> = {};
  for (const key of ACTIVITY_INPUT_KEYS) {
    if (key in record) brief[key] = record[key];
  }
  return brief;
}

// ───────────────────────── fold ─────────────────────────

/**
 * 把一条记录折进摘要（就地修改）。语义逐行对着旧派生 port：
 *
 * - user：正文段清空（turn-artifacts 的 answer 断）、子会话活动清空（childActivityOf 的 user 边界）、
 *   slim 进队（goal 的来源 / delegation 的「这一轮」边界）；
 * - assistant：正文段按块序折（text 累积、thinking / toolCall 断）；产物工具调用进队；
 *   子会话活动换成它的调用（running 清空——batch 从尾扫到这条 assistant 就停）；
 * - tool：结果贴上产物队列；终端 / 看板 / slim（plan / goal / delegate）各归各；子会话活动
 *   解决（终态删 pending，running 记 running）；
 * - file-turn：消费正文段点名（**不清**正文段，同 batch）；
 * - channel-mark：正文段断 + slim 进队（delegation 边界）；
 * - compacted / intent-recall / revert：正文段断（它们在 flattenRenderUnits 里各产一个单元）；
 * - undo：什么都不动（flattenRenderUnits 不产单元）——只推进指纹。
 *
 * revert 的「截到 targetMessageId 之前」fold 做不了（折不可逆行）：主进程见到 revert 记录
 * 一律全量重算（status-digest.ts 的 store），renderer 尾窗里的 revert 记录由「摘要失效重取」覆盖，
 * 这里只断正文段（与 batch 的 revertMark 单元一致）。
 */
export function foldStatusRecord(state: StatusDigestState, record: TranscriptRecord): void {
  advanceDigestMeta(state, record.id, record.timestamp);
  switch (record.role) {
    case "user": {
      state.outputs.answer = [];
      state.activity.pending = [];
      state.activity.running = null;
      const slim = slimRecordOf(record);
      if (slim !== null) state.slim.push(slim);
      return;
    }
    case "assistant": {
      for (const block of record.content) {
        if (block.type === "text") {
          state.outputs.answer.push(block.text);
          continue;
        }
        // thinking / toolCall 都断正文段（turn-artifacts：非 text 非 file-turn 即断）
        state.outputs.answer = [];
        if (block.type === "toolCall" && OUTPUT_TOOLS.has(block.toolName)) {
          const input = (block.input ?? {}) as Record<string, unknown>;
          state.outputs.queue.push({
            callId: block.toolCallId,
            toolName: block.toolName,
            path: typeof input["path"] === "string" && input["path"] !== "" ? input["path"] : null,
            format: typeof input["format"] === "string" && input["format"].trim() !== "" ? input["format"].trim() : null,
            result: null,
          });
        }
      }
      // 子会话活动：这条 assistant 的调用成为新的 pending（batch：从尾扫到这条就停，更早的不看）
      state.activity.pending = record.content
        .filter((block): block is Extract<typeof block, { type: "toolCall" }> => block.type === "toolCall")
        .map((block) => [block.toolCallId, { toolName: block.toolName, input: activityInputOf(block.input), since: record.timestamp }]);
      state.activity.running = null;
      return;
    }
    case "tool": {
      // 产物队列：结果按 callId 贴上（同一个 id 多次出现以最后一条为准，同 indexToolResults）
      const queued = state.outputs.queue.find((call) => call.callId === record.toolCallId);
      if (queued !== undefined) {
        const text = record.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
        queued.result = {
          status: record.status,
          card: readCommandCard(record.details),
          deckPages: DECK_WRITERS.has(queued.toolName) ? deckPagesFrom(text) : null,
        };
      }
      if (record.toolName === "terminal_execute" && record.status === "complete") {
        const text = record.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
        const id = /visible terminal (\S+) \(/.exec(text)?.[1];
        const command = (record.input as Record<string, unknown> | null)?.["command"];
        if (id !== undefined && typeof command === "string") {
          const at = state.terminals.findIndex(([key]) => key === id);
          const entry: TerminalEntry = { id, command, since: record.timestamp };
          if (at >= 0) state.terminals[at] = [id, entry];
          else state.terminals.push([id, entry]);
        }
      }
      if (record.toolName === "show_plugin_board" && record.status === "complete") {
        const board = boardOf(record.details);
        if (board !== null) {
          const key = `board:${board.title}`;
          const at = state.outputs.boards.findIndex(([k]) => k === key);
          if (at >= 0) state.outputs.boards.splice(at, 1);
          state.outputs.boards.push([
            key,
            { title: board.title, plugin: board.plugin, at: record.timestamp, boardCall: boardCallOf(record.toolCallId, record.details) },
          ]);
        }
      }
      // 子会话活动：running 记下（batch quirk：之后来了同 callId 的终态也仍报它）；终态解决 pending
      if (record.status === "running") {
        state.activity.running = { toolName: record.toolName, input: activityInputOf(record.input), since: record.timestamp };
      } else {
        state.activity.pending = state.activity.pending.filter(([callId]) => callId !== record.toolCallId);
      }
      const slim = slimRecordOf(record);
      if (slim !== null) state.slim.push(slim);
      return;
    }
    case "file-turn": {
      foldFileTurn(state, record);
      return;
    }
    case "channel-mark": {
      state.outputs.answer = [];
      const slim = slimRecordOf(record);
      if (slim !== null) state.slim.push(slim);
      return;
    }
    case "compacted":
    case "intent-recall":
    case "revert": {
      state.outputs.answer = [];
      return;
    }
    case "undo":
      return;
  }
}

/** 一次折一串（补算 / 对账用） */
export function foldStatusRecords(records: readonly TranscriptRecord[]): StatusDigestState {
  const state = emptyStatusDigestState();
  for (const record of records) foldStatusRecord(state, record);
  return state;
}

// ───────────────────────── 派生（纯读） ─────────────────────────

/**
 * 摘要 → 产物列表（statusOutputs 的等价派生）：队列按调用序回放（put 语义），
 * 加上文件账点名与看板，新的在前。by 由调用方套（主会话 null，子会话 = 它的标题）。
 */
export function digestOutputs(state: StatusDigestState): StatusOutput[] {
  const byPath = new Map<string, DigestTurnOutput>();
  const order: string[] = [];
  const deckByName = new Map<string, string>();
  const put = (output: DigestTurnOutput): void => {
    const prev = byPath.get(output.path);
    if (prev === undefined) order.push(output.path);
    byPath.set(output.path, { ...prev, ...output, pages: output.pages ?? prev?.pages ?? null });
  };
  for (const call of state.outputs.queue) {
    const result = call.result;
    if (result === null || result.status !== "complete") continue;
    const card = result.card;
    if (call.toolName === "slides_create" && card !== null) {
      deckByName.set(basename(card.path), card.path);
      put({ kind: "slides", path: card.path, title: card.title, pages: 0, format: null, detail: null });
      continue;
    }
    if (DECK_WRITERS.has(call.toolName)) {
      if (call.path === null) continue;
      const path = deckByName.get(basename(call.path)) ?? call.path;
      const prev = byPath.get(path);
      put({ kind: "slides", path, title: prev?.title ?? fileLabel(path), pages: result.deckPages, format: null, detail: null });
      continue;
    }
    if (call.toolName === "doc_open" && card !== null) {
      put({ kind: "doc", path: card.path, title: card.title, pages: null, format: null, detail: null });
      continue;
    }
    if ((call.toolName === "slides_export" || call.toolName === "doc_export") && card !== null) {
      if (call.format !== null && SELF_CHECK_EXPORT.has(call.format)) continue;
      const made = exportKind(call.format, card.path);
      put({ kind: made.kind, path: card.path, title: card.title, pages: null, format: made.format, detail: exportDetail(made.format, card.subtitle) });
    }
  }
  const made = order.map((path) => byPath.get(path)).filter((output): output is DigestTurnOutput => output !== undefined);
  // allOutputs 的口径：fileOutputs 各自内部按原始路径去重，mediaOutputs 不去重；
  // 合起来的 more 只按 made 的路径集过滤（more 内部不去重——同名媒体被两轮点名会出两份，与 batch 一致）
  const seen = new Set(made.map((output) => normPath(output.path)));
  const fileOutputs = (kind: "doc" | "web", paths: readonly string[]): DigestTurnOutput[] => {
    const internal = new Set<string>();
    const out: DigestTurnOutput[] = [];
    for (const path of paths) {
      if (internal.has(path)) continue;
      internal.add(path);
      out.push({ kind, path, title: basename(path), pages: null, format: null, detail: null });
    }
    return out;
  };
  const mediaOutputs = (media: readonly MediaArtifact[]): DigestTurnOutput[] => {
    const out: DigestTurnOutput[] = [];
    for (const item of media) {
      const kind = mediaArtifactKind(item.path);
      if (kind === null) continue;
      out.push({ kind, path: item.path, title: basename(item.path), pages: null, format: null, detail: null, ...(item.duration !== undefined ? { duration: item.duration } : {}) });
    }
    return out;
  };
  const more = [...fileOutputs("doc", state.outputs.docs), ...fileOutputs("web", state.outputs.web), ...mediaOutputs(state.outputs.media)].filter(
    (output) => !seen.has(normPath(output.path)),
  );
  // 结尾那摞的顺序：演示文稿与文档在前，PDF，最后网页；同一类里保持原顺序（稳定排序）
  const rank = (output: DigestTurnOutput): number =>
    output.kind === "slides" || output.kind === "doc" ? 0 : output.kind === "pdf" ? 1 : output.kind === "audio" ? 2 : output.kind === "video" ? 3 : 4;
  const all = [...made, ...more].sort((a, b) => rank(a) - rank(b));

  const at = state.meta.lastTs;
  const list: StatusOutput[] = all.map((output) => ({
    kind: statusKindOf(output),
    path: output.path,
    title: output.title,
    pages: output.pages,
    ...(output.duration === undefined ? {} : { duration: output.duration }),
    by: null,
    at,
    plugin: null,
    boardCall: null,
  }));
  // 图片：文件账里写出、但没被点名的（sessionOutputs 的 edited 过滤：按**原始路径**对最终产物集）
  const shown = new Set(all.map((output) => output.path));
  for (const path of state.outputs.edited) {
    if (shown.has(path)) continue;
    if (EXT_KIND[extOf(path)] === "image") {
      list.push({ kind: "image", path, title: basename(path), pages: null, by: null, at, plugin: null, boardCall: null });
    }
  }
  // 看板：同名只留最后一次（fold 时已收成最后出现序），接在最后
  for (const [key, entry] of state.outputs.boards) {
    list.push({ kind: "board", path: key, title: entry.title, pages: null, by: null, at: entry.at, plugin: entry.plugin, boardCall: entry.boardCall });
  }
  return list.reverse();
}

/** 摘要 → 子会话此刻在跑什么（childActivityOf 的等价派生）：running 优先，否则最近一条 assistant 的第一个未解决调用 */
export function digestChildActivity(state: StatusDigestState): ActivityCall | null {
  return state.activity.running ?? state.activity.pending[0]?.[1] ?? null;
}

/** 摘要 → 这条会话的 agent 开的终端（useLiveTerminals 的 launched 半；开着与否由 renderer 问终端列表） */
export function digestTerminals(state: StatusDigestState): TerminalEntry[] {
  return state.terminals.map(([, entry]) => entry);
}

// ───────────────────────── 落盘形状的校验 ─────────────────────────

/**
 * 读盘 / 收 IPC 时的轻量校验：形状不对 = null（调用方重算，绝不将错就错）。
 * 只查骨架（各段在不在、是不是数组），不逐条深查——指纹（logOffset + lastId）才是
 * 「摘要对不对」的判据，这里只挡截断 / 坏文件。
 */
export function parseStatusDigestState(raw: unknown): StatusDigestState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const meta = value["meta"];
  if (typeof meta !== "object" || meta === null) return null;
  const m = meta as Record<string, unknown>;
  if (typeof m["lastId"] !== "string" && m["lastId"] !== null) return null;
  if (typeof m["lastTs"] !== "number" || typeof m["records"] !== "number") return null;
  if (!Array.isArray(m["recentIds"]) || !m["recentIds"].every((id) => typeof id === "string")) return null;
  if (!Array.isArray(value["slim"])) return null;
  const outputs = value["outputs"];
  if (typeof outputs !== "object" || outputs === null) return null;
  const o = outputs as Record<string, unknown>;
  for (const key of ["queue", "answer", "docs", "web", "media", "edited", "boards"] as const) {
    if (!Array.isArray(o[key])) return null;
  }
  const activity = value["activity"];
  if (typeof activity !== "object" || activity === null) return null;
  const a = activity as Record<string, unknown>;
  if (!Array.isArray(a["pending"])) return null;
  if (typeof a["running"] !== "object") return null;
  if (!Array.isArray(value["terminals"])) return null;
  return raw as StatusDigestState;
}
