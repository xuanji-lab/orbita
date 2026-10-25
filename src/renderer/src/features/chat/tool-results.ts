/**
 * 工具结果的归位 + 信息区渲染单元的派生：摊平、分组、diff 解析、思考预览。
 *
 * **为什么要归位。** 协议里工具调用与工具结果是两条独立的记录：
 * 调用是 assistant 消息里的一个 `toolCall` 块，结果是一条 `role: "tool"` 的 item。
 * 照原样渲染就会得到两行——「调用了 ls」和「ls 的结果」——而设计系统要的是
 * 「工具调用折叠成一行、**点击才展开**」（readme *Chat*）。所以结果不单独占一行，
 * 它是那次调用展开后的内容。
 *
 * **为什么要摊平与分组。** 块数组才是真源，扁平列表态从它派生（guideline）；
 * agent 连续查阅 N 个文件时，pi 常把它切成多条消息（read→结果→read…），
 * 只有先摊平再对「相邻同类 toolCall」做 run-length 合并，「连续做同类事」
 * 才能收成一行——顺序即语义，隔着正文/思考的不合并。
 *
 * 纯模块：不 import React，可被 `node --test` 直接加载。
 */
import { diffWords } from "diff";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import type { DelegateCard, ReadTaskCard } from "@shared/agent-ipc";
import type { ChannelMessageKind } from "@shared/channel";
import type { CompactedRecord, IntentRecallRecord, SessionRecord, TranscriptRecord } from "@shared/session";
import type { FileTurnRecord, FileTurnView, RevertRecord } from "@shared/revert";
// 值导入必须走相对路径带 .ts 后缀：本文件被 node --test 直接加载，@shared 别名只能解析类型（AGENTS.md 硬规则）
import { parseChannelPrompt } from "../../../../shared/channel.ts";
import {
  COMMAND_TIMEOUT_DEFAULT_SECONDS,
  COMMAND_TIMEOUT_FLOOR_SECONDS,
  COMMAND_TIMEOUT_HARD_MAX_SECONDS,
} from "../../../../shared/permission.ts";
// 值导入必须走相对路径带 .ts 后缀（同上一行的纪律：本文件被 node --test 直接加载）
import { skillForReadPath } from "../../../../shared/skill.ts";
import { parseQualifiedToolName } from "../../../../shared/mcp.ts";
import { isThinkingLevel } from "../../../../shared/thinking.ts";
import type { Messages } from "../../messages-en.ts";

/** toolCallId → 那次调用的结果。同一个 id 出现多次时以最后一条为准（终态帧在增量帧之后）。 */
export type ToolResultIndex = ReadonlyMap<string, ToolTranscriptItem>;

export function indexToolResults(transcript: readonly TranscriptItem[]): ToolResultIndex {
  const index = new Map<string, ToolTranscriptItem>();
  for (const item of transcript) {
    if (item.role === "tool") index.set(item.toolCallId, item);
  }
  return index;
}

/**
 * 渲染单元：records 摊平后的最小渲染单位。user 整条一个单元，assistant 按块拆，
 * 界碑自成单元。key 跨渲染稳定（`${item.id}:${blockIndex}`），折叠展开状态靠它保住。
 * assistant 单元带 `messageId`（所属消息的 id）——分支按钮要落在锚点消息的
 * **最后一个**单元后面，分组后归属只能靠它追溯；`timestamp` 从记录上原样带来
 * （adapter 每帧落 now()，终态帧即完成时刻）——大折叠的轮耗时靠它算，自己不计时。
 */
export type RenderUnit =
  | { kind: "user"; key: string; item: Extract<TranscriptItem, { role: "user" }> }
  | { kind: "text"; key: string; messageId: string; text: string; timestamp: number }
  | { kind: "thinking"; key: string; messageId: string; text: string; timestamp: number }
  | {
      kind: "toolCall";
      key: string;
      messageId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
      timestamp: number;
    }
  | { kind: "compacted"; key: string; record: CompactedRecord }
  | {
      kind: "channelMark";
      key: string;
      mark: { peerId: string; messageId: string; from: "parent" | "child"; kind: ChannelMessageKind };
      timestamp: number;
    }
  | { kind: "fileTurn"; key: string; record: FileTurnView }
  | { kind: "revertMark"; key: string; record: RevertRecord }
  | { kind: "intentRecall"; key: string; record: IntentRecallRecord };

/** toolCall 单元的别名：分组函数的输入输出都说它。 */
export type ToolCallUnit = Extract<RenderUnit, { kind: "toolCall" }>;

/** 相邻同类 toolCall 的 run（≥2）。展开后组内每条仍是完整的 ToolLine——两层折叠契约。 */
export interface ToolGroupUnit {
  kind: "toolGroup";
  /** `group:${首成员 toolCallId}`：成员集合不变时 key 不变，组的展开状态得以保住 */
  key: string;
  toolName: string;
  calls: readonly ToolCallUnit[];
}

export type RenderEntry = RenderUnit | ToolGroupUnit;

/**
 * records → 渲染单元流。tool item 不产生单元——它的结果由 `indexToolResults`
 * 挂到调用行上（归位）。**代价写明白**：万一某条 tool 结果找不到对应的调用
 * （协议上不该发生，因为结果必然由一次调用产生），它就不会被显示。
 * 宁可如此，也不要为了兜这个不存在的情形，让正常路径多出一行冗余。
 */
export function flattenRenderUnits(records: readonly TranscriptRecord[]): RenderUnit[] {
  const units: RenderUnit[] = [];
  for (const record of records) {
    if (record.role === "compacted") {
      units.push({ kind: "compacted", key: record.id, record });
      continue;
    }
    // 盘上读回的通道标记：画一行标记单元，正文只有一份、在通道账本里。
    if (record.role === "channel-mark") {
      units.push({
        kind: "channelMark",
        key: record.id,
        mark: { peerId: record.peerId, messageId: record.messageId, from: record.from, kind: record.kind },
        timestamp: record.timestamp,
      });
      continue;
    }
    if (record.role === "tool") continue;
    // 文件账三件（revert.ts）：轮尾账自成卡片、回退界碑自成标记行（FileTurnCard）；
    // undo 记录不产单元——它是轮尾卡上的徽标，由 ChatView 按 turnId 对回去
    if (record.role === "file-turn") {
      units.push({ kind: "fileTurn", key: record.id, record });
      continue;
    }
    if (record.role === "revert") {
      units.push({ kind: "revertMark", key: record.id, record });
      continue;
    }
    if (record.role === "undo") continue;
    // 意图召回卡（实验功能）：自成一张过程卡（阶段条 / 入选数），不是消息，
    // 也不参与折叠（它是过程元信息，与 fileTurn 同一批）
    if (record.role === "intent-recall") {
      units.push({ kind: "intentRecall", key: record.id, record });
      continue;
    }
    if (record.role === "user") {
      // 实时流里的通道消息：重载前 recorder 还没来得及把它落成 channel-mark 记录，
      // 首个 text 块能解出信封就按同一条判定画成标记行、不产 user 单元——
      // key 与落盘后的 channel-mark 记录相同（都是这条 user item 的 id），
      // 重载前后 React key 保持稳定。
      const envelope = channelEnvelopeOf(record);
      if (envelope !== null) {
        units.push({ kind: "channelMark", key: record.id, mark: envelope, timestamp: record.timestamp });
        continue;
      }
      units.push({ kind: "user", key: record.id, item: record });
      continue;
    }
    record.content.forEach((block, index) => {
      const key = `${record.id}:${index}`;
      if (block.type === "text") {
        units.push({ kind: "text", key, messageId: record.id, text: block.text, timestamp: record.timestamp });
      } else if (block.type === "thinking") {
        units.push({ kind: "thinking", key, messageId: record.id, text: block.thinking, timestamp: record.timestamp });
      } else if (block.type === "toolCall") {
        units.push({
          kind: "toolCall",
          key,
          messageId: record.id,
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          input: block.input,
          timestamp: record.timestamp,
        });
      }
    });
  }
  return units;
}

/**
 * user 记录的首个 text 块能否解出通道信封——同 `main/session/recorder.ts` 的
 * `channelMarkOf` 判定，只是画在渲染层而不是落盘层（重载前的活会话还没走过
 * recorder，实时流里它仍是一条带信封文本的 user item）。
 */
function channelEnvelopeOf(
  item: Extract<TranscriptItem, { role: "user" }>,
): { peerId: string; messageId: string; from: "parent" | "child"; kind: ChannelMessageKind } | null {
  const text = item.content.find((block) => block.type === "text");
  if (text === undefined || text.type !== "text") return null;
  const parsed = parseChannelPrompt(text.text);
  if (parsed === null) return null;
  return { peerId: parsed.peerId, messageId: parsed.messageId, from: parsed.from, kind: parsed.kind };
}

/**
 * 通道工具名单（子会话 PR4b 显示缺陷修正）：`delegate` / `reply_subsession` /
 * `report_to_parent` 三个工具调用是父子之间的**通信**，不是「工作过程」——
 * 不参与相邻合并、不算轮成员（见 `isTurnMember`）、不计入折叠统计（见 `turnStats`）。
 * 只在 renderer 用，不进 shared（消费者只有这一份渲染逻辑，没有第二边要认它）。
 */
const CHANNEL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "delegate",
  "reply_subsession",
  "report_to_parent",
]);

/**
 * 交接（request_user_action）同样独立成卡、不进折叠：它是「这一步要你来」的离开卡，
 * 折进组里用户就看不见，agent 会一直等下去。
 */
const HANDOFF_TOOL_NAME = "request_user_action";

// 故意不写成类型谓词（`entry is ToolCallUnit`）：只有「toolCall 且工具名在名单里」
// 那一部分该被排除，谓词的假分支会让 TS 把整个 "toolCall" kind 都窄掉，
// 下游 `entry.kind === "toolCall"` 判断就报「没有交集」。
// 名字沿用 isChannelToolCall：通道工具与交接都是「独立成卡、不参与合并与折叠」的那一类。
function isChannelToolCall(entry: RenderEntry): boolean {
  return entry.kind === "toolCall" && (CHANNEL_TOOL_NAMES.has(entry.toolName) || entry.toolName === HANDOFF_TOOL_NAME);
}

/**
 * 钉住工具（2026-09-27 裁决）：show_image 是**给用户的展示**，不是「工作过程」——
 * 大折叠把轮内工具吞进统计行时会把它递出的画廊一起吞走，等于模型递完照片当场
 * 收回。与通道工具同一套豁免口径（不进工具组 / 不锚折叠边界 / 折叠区间在它处
 * 切开 / 不计统计——它根本不进 members），但语义不同：通道是父子通信，这是
 * 面向用户的输出。常见节奏（show 完就给结尾回复）下，豁免让画廊正好钉在
 * 折叠行之后、回复之前——「正文前面见图」不需要上浮收集就自然成立。
 */
const PINNED_TOOL_NAMES: ReadonlySet<string> = new Set(["show_image"]);

function isPinnedToolCall(entry: RenderEntry): boolean {
  return entry.kind === "toolCall" && PINNED_TOOL_NAMES.has(entry.toolName);
}

/** 这条 toolCall 是不是在 read 某条已知 skill 的 SKILL.md（分组排除用，同 ToolLine 的判定） */
function isSkillRead(
  unit: ToolCallUnit,
  skills: ReadonlyArray<{ slug: string; name: string }>,
): boolean {
  if (unit.toolName !== "read") return false;
  const path = (unit.input as Record<string, unknown> | null)?.["path"];
  return typeof path === "string" && skillForReadPath(path, skills) !== null;
}

/**
 * 相邻同类 toolCall 合并成组。**只合相邻**：任何非同类单元（正文、思考、用户、
 * 界碑、别的工具）都断开 run——隔着东西合并等于撒谎（顺序即语义）。
 * 单数不成组，原样放行，走普通 ToolLine。
 *
 * 通道工具（见 `CHANNEL_TOOL_NAMES`）**永不参与合并**，哪怕同名连发两次：
 * 它们是各自独立的一次通信，合并成组会把「发了两条」显示成「发了一条」。
 *
 * read SKILL.md 同样不参与合并（skills 索引命中即视为 skill 使用）：它是
 * 「agent 在用 skill」这个事件本身，并进普通文件组会把徽标吞掉——组头没有
 * skill 身份，用户就永远看不到 skill 被用过。skills 为空数组时无行为变化。
 */
export function groupToolUnits(
  units: readonly RenderUnit[],
  skills: ReadonlyArray<{ slug: string; name: string }> = [],
): RenderEntry[] {
  const entries: RenderEntry[] = [];
  let run: ToolCallUnit[] = [];
  const flush = () => {
    const head = run[0];
    if (head === undefined) return;
    if (run.length === 1) {
      entries.push(head);
    } else {
      entries.push({
        kind: "toolGroup",
        key: `group:${head.toolCallId}`,
        toolName: head.toolName,
        calls: run,
      });
    }
    run = [];
  };
  for (const unit of units) {
    const head = run[0];
    // skill read 要**彻底绕过 run 机制**（直接进 entries）：只挡在 groupable 上不够——
    // 它自己开的 run 会被后续同类 read 并进来，排除就白做了
    const skillRead = unit.kind === "toolCall" && isSkillRead(unit, skills);
    // 交接（request_user_action）与通道工具同待遇：独立成卡，不并进工具组
    const groupable =
      unit.kind === "toolCall" &&
      !skillRead &&
      !CHANNEL_TOOL_NAMES.has(unit.toolName) &&
      unit.toolName !== HANDOFF_TOOL_NAME &&
      !PINNED_TOOL_NAMES.has(unit.toolName);
    if (groupable && (head === undefined || head.toolName === unit.toolName)) {
      run.push(unit);
      continue;
    }
    flush();
    if (skillRead) {
      entries.push(unit);
    } else if (unit.kind === "toolCall") {
      run = [unit];
    } else {
      entries.push(unit);
    }
  }
  flush();
  return entries;
}

// ── 大折叠：已落定轮次的思考与工具按正文切段，各收进一条统计行 ──

/**
 * 大折叠单元：一段**连续的思考与工具行**的收纳（thinking / toolCall / toolGroup，
 * 原时间序，展开后就是原有的行）。
 *
 * 正文永不进折叠（2026-10-18 用户裁决，取代 2026-09-20 的 BUG-6 裁决）：text 是
 * 分组边界而不是成员——foldChunk 遇到正文就收口当前折叠、正文原样留在原位，
 * 正文之后再来的思考/工具开一个新的折叠单元。一轮因此可能有多个折叠块，
 * 各自夹在正文段落之间；BUG-6 的「展开即回原相对位置」语义保留，范围从
 * 整轮缩到一段。
 */
export interface TurnGroupUnit {
  kind: "turnGroup";
  /** `turn:${首成员 key}`：成员集合不变时 key 不变，折叠的展开状态得以保住 */
  key: string;
  /** 本段的思考 / 工具行 / 工具组——永不含 text（类型层兜底，见 TurnMemberEntry） */
  members: readonly TurnMemberEntry[];
  /**
   * 本段的时间跨度 = 段内成员 timestamp 的极差（工具成员以其结果的终态时刻为
   * 右端）。缺时间戳的单元在场时 null；跨度不足显示精度（<50ms，显示即
   * 「0.0 秒」）同样 null——它要么量不到（单记录思考段），要么只是即时工具的
   * 尾巴，显示出来只会误导读出「没干活」。诚实未知，不显示编造值。
   */
  durationMs: number | null;
  /**
   * 这轮开始流式回复的时刻 = 段内最早的 assistant 记录 timestamp（渲染单元的
   * timestamp 从记录上原样带来，即首条 assistant 的 message_start 时刻——含先吐
   * 正文再思考的前导 text，它不在成员里但在段内）。只有一轮的**第一个**折叠块
   * 带这个值（轮头时间标签是轮级信息，ChatView 的 TurnRollupLine 据此渲染），
   * 后续折叠块为 null；缺时间戳的单元在场时 null，同 durationMs 的诚实未知口径。
   */
  startedAt: number | null;
}

export type TurnViewEntry = RenderEntry | TurnGroupUnit;

/** 折叠成员：思考、单行工具调用、工具组。正文永不进折叠（2026-10-18 裁决），不在联合里。 */
export type TurnMemberEntry = Extract<
  RenderEntry,
  { kind: "thinking" } | { kind: "toolCall" } | { kind: "toolGroup" }
>;

/**
 * 通道工具（delegate / reply_subsession / report_to_parent）的 toolCall 不算轮成员：
 * 它们是父子间的通信，不是「工作过程」，不该被折叠吞掉（子会话 PR4b 显示缺陷修正）。
 * 它们也从不出现在 toolGroup 里（`groupToolUnits` 已挡），这里只需挡 toolCall 分支。
 */
function isTurnMember(entry: RenderEntry): entry is TurnMemberEntry {
  if (isChannelToolCall(entry) || isPinnedToolCall(entry)) return false;
  return entry.kind === "thinking" || entry.kind === "toolCall" || entry.kind === "toolGroup";
}

/**
 * 段内内容：轮边界（user / 界碑 / 通道标记）之外的全部——思考 / 工具 / 正文，
 * 折叠区间内只会有这些。通道标记与 user 同级（子会话 2026-09-23 不变量）：
 * 它顶替的正是 pi 本子里的一条 user 消息，不该被收进折叠。
 */
function isTurnContent(entry: RenderEntry): boolean {
  return (
    entry.kind !== "user" &&
    entry.kind !== "compacted" &&
    entry.kind !== "channelMark" &&
    entry.kind !== "fileTurn" &&
    entry.kind !== "revertMark" &&
    entry.kind !== "intentRecall"
  );
}

function entryTimestamp(entry: RenderEntry): number | null {
  if (entry.kind === "user") return entry.item.timestamp;
  if (entry.kind === "compacted") return entry.record.timestamp;
  if (entry.kind === "toolGroup") return entry.calls[0]?.timestamp ?? null;
  if (entry.kind === "fileTurn") return entry.record.timestamp;
  if (entry.kind === "revertMark") return entry.record.timestamp;
  if (entry.kind === "intentRecall") return entry.record.timestamp;
  return entry.timestamp;
}

function segmentSpan(segment: readonly RenderEntry[], results?: ToolResultIndex): number | null {
  let min: number | null = null;
  let max: number | null = null;
  const raise = (ts: number) => {
    max = max === null || ts > max ? ts : max;
  };
  for (const entry of segment) {
    const ts = entryTimestamp(entry);
    if (ts === null) return null;
    min = min === null || ts < min ? ts : min;
    raise(ts);
    // 工具的终态时刻在**结果**上（调用单元只带所属消息的帧时间）——轮的真正
    // 结束可能是最后一次工具落定（以工具收尾的失败轮尤其如此）
    const calls = entry.kind === "toolGroup" ? entry.calls : entry.kind === "toolCall" ? [entry] : [];
    for (const call of calls) {
      const end = results?.get(call.toolCallId)?.timestamp;
      if (end !== undefined) raise(end);
    }
  }
  if (min === null || max === null) return null;
  // 跨度不足显示精度（0.1 秒，即 <50ms）时不显示：极差为 0 是量不到——典型是
  // 「思考 → 开场白 → 工具」的开头，开场白是分组边界，第一条思考被单独切成一段，
  // 落盘只有记录级时间戳，块内真实耗时（模型实际想了几秒）不在任何极差里；
  // 极差 1-49ms 是即时工具（write/edit 几毫秒落定）或同记录「思考+工具」段——
  // 后者显示的只是工具尾巴，思考时间同样不在里面。这些「Worked 0.0s」要么不可信、
  // 要么没有信息量，一律按诚实未知给 null（2026-10-18 真机验收反馈），
  // 折叠行不显示时长段（TurnRollupLine 对 null 本就不渲染 Worked）。
  const span = max - min;
  return span >= 50 ? span : null;
}

/**
 * 大折叠分组：把渲染单元流按轮边界（user / 界碑 / 通道标记）切段，**已落定的段**
 * 把成员收进一个 TurnGroupUnit，位置在第一个成员处。
 *
 * 时机（用户裁决）：折叠只在整轮回答落定后发生——活跃轮（turnActive 时的最后一段）
 * 原样铺开什么都不收；落定即一次性收进，无记忆（ToolGroupLine 同款裁决，用户可再
 * 点开）。旧会话加载即全收——长会话的 DOM 从「每行全渲染」降到「一轮一行」。
 * 纯正文段（无思考无工具）没有可收的，原样放行，不包折叠壳。
 */
export function groupTurns(
  entries: readonly RenderEntry[],
  turnActive: boolean,
  results?: ToolResultIndex,
): TurnViewEntry[] {
  const segments: RenderEntry[][] = [];
  for (const entry of entries) {
    // 通道标记与 user 同级：它顶替的正是 pi 本子里的一条 user 消息（子会话
    // 2026-09-23 不变量），因此同样开新段、不进折叠。
    if (
      entry.kind === "user" ||
      entry.kind === "compacted" ||
      entry.kind === "channelMark" ||
      entry.kind === "revertMark" ||
      segments.length === 0
    ) {
      segments.push([entry]);
    } else {
      segments[segments.length - 1]?.push(entry);
    }
  }
  const activeIndex = turnActive ? segments.length - 1 : -1;
  const view: TurnViewEntry[] = [];
  segments.forEach((segment, index) => {
    if (index === activeIndex) {
      view.push(...segment);
      return;
    }
    view.push(...foldSegment(segment, results));
  });
  return view;
}

/**
 * 折叠一个已落定的段。通道工具调用（delegate / reply_subsession / report_to_parent）
 * 不算轮成员且必须原样留在流里、位置不变（子会话 PR4b）——按它们把段切成若干块，
 * 每块各自套用「找首尾轮成员、中间收进折叠」的规则，通道工具本身穿插在块之间，
 * 永不进任何一块的折叠。没有通道工具时退化成原来的单块行为。
 *
 * 钉住工具（show_image）不同（2026-09-27 裁决 Y′）：画廊**挂轮尾**——不管
 * show 发生在轮内哪一步（思考/工具之间也好），落定视图统一钉在折叠块之后、
 * 结尾回复之前，「图贴正文」的阅读顺序永远成立；位置不随展开收起切换（不闪跳）。
 * 代价是展开态画廊不在它的时间线原位——show_image 行本身在折叠展开流里仍有
 * 标识，可追溯。若按原位切开，show 夹在轮中间会产生「两个折叠块夹一张画廊」
 * 的割裂形态（正是本裁决要消灭的）。
 */
function foldSegment(segment: readonly RenderEntry[], results?: ToolResultIndex): TurnViewEntry[] {
  const view: TurnViewEntry[] = [];
  let chunk: RenderEntry[] = [];
  const pinned: RenderEntry[] = [];
  const tailCards: RenderEntry[] = [];
  const flushChunk = () => {
    view.push(...foldChunk(chunk, results));
    chunk = [];
  };
  for (const entry of segment) {
    if (isPinnedToolCall(entry)) {
      pinned.push(entry);
      continue;
    }
    // 轮尾文件卡钉在段尾：不管这一轮改文件的动作发生在哪一步，落定视图统一
    // 「回答在前、文件账殿后」——它是这一轮的产物小结，永远跟着轮走（show_image
    // 钉在结尾回复之前，文件卡钉在最后：画廊是正文的一部分，账是结算行）
    if (entry.kind === "fileTurn") {
      tailCards.push(entry);
      continue;
    }
    if (isChannelToolCall(entry)) {
      flushChunk();
      view.push(entry);
      continue;
    }
    chunk.push(entry);
  }
  flushChunk();
  if (tailCards.length > 0) view.push(...tailCards);
  if (pinned.length === 0) return view;
  // 插在结尾回复（视图尾部连续的正文）之前；没有正文就挂段尾
  let insertAt = view.length;
  while (insertAt > 0 && view[insertAt - 1]?.kind === "text") insertAt -= 1;
  view.splice(insertAt, 0, ...pinned);
  return view;
}

/**
 * 单块内分组：text 是边界不是成员（2026-10-18 裁决）——成员攒成连续的一段就
 * 收成一个折叠单元，遇到正文先收口再原样放行正文；正文之后的成员开新的一段。
 * 一轮因此可能有多个折叠块，各自夹在正文之间。空白 text 块（流式常产生的空
 * delta 落块）不当边界也不落视图：它渲染出来本就是空行，拿它断开折叠只会
 * 凭空多出一条统计行。`foldSegment` 按通道工具切出的每一块都走这里。
 */
function foldChunk(chunk: readonly RenderEntry[], results?: ToolResultIndex): TurnViewEntry[] {
  const view: TurnViewEntry[] = [];
  let run: TurnMemberEntry[] = [];
  let firstGroup = true;
  const flush = () => {
    if (run.length === 0) return;
    view.push({
      kind: "turnGroup",
      key: `turn:${run[0]?.key ?? ""}`,
      members: run,
      durationMs: segmentSpan(run, results),
      // 轮头时间只挂在第一个折叠块上（轮级信息），后续块不带
      startedAt: firstGroup ? chunkStartAt(chunk) : null,
    });
    firstGroup = false;
    run = [];
  };
  for (const entry of chunk) {
    if (isTurnMember(entry)) {
      run.push(entry);
      continue;
    }
    if (entry.kind === "text" && entry.text.trim() === "") continue;
    flush();
    view.push(entry);
  }
  flush();
  return view;
}

/**
 * 段内最早的 **assistant 侧**渲染单元 timestamp = 这轮开始流式回复的时刻。
 * 段里还带着开轮的 user 单元（它不是 assistant 的输出，且它早于任何回答），
 * 用 isTurnContent 排掉；缺时间戳的单元在场时 null（同 segmentSpan 的口径：
 * 宁可不显示，不编造）。
 */
function chunkStartAt(chunk: readonly RenderEntry[]): number | null {
  let min: number | null = null;
  for (const entry of chunk) {
    if (!isTurnContent(entry)) continue;
    const ts = entryTimestamp(entry);
    if (ts === null) return null;
    if (min === null || ts < min) min = ts;
  }
  return min;
}

/**
 * 回合级失败（重试耗尽）该亮红警示的折叠：**只在失败那一轮里找**。
 *
 * 失败归属于转录末尾那轮（最后一条 user / 界碑 / 通道标记之后）。那轮若有折叠
 * （工具跑了几个才断），图标亮在它头上、与后面的红字成对；若没有（模型开口前就断，
 * 重试耗尽的常态），红字自带的图标就是全部——**上一轮的折叠不能背锅**。旧写法取
 * 「整个视图里最后一个折叠」，失败轮没折叠时就拿到上一轮的，图标和红字隔着一条
 * 用户消息（2026-09-11 验收复现）。
 */
export function failedFoldKey(view: readonly TurnViewEntry[]): string | null {
  let start = 0;
  for (let i = view.length - 1; i >= 0; i -= 1) {
    const entry = view[i];
    if (
      entry !== undefined &&
      (entry.kind === "user" || entry.kind === "compacted" || entry.kind === "channelMark")
    ) {
      start = i + 1;
      break;
    }
  }
  for (let i = start; i < view.length; i += 1) {
    const entry = view[i];
    if (entry !== undefined && entry.kind === "turnGroup") return entry.key;
  }
  return null;
}

/** 单个工具类别的计数：调用了几次、失败几次——失败计数红字跟在类别后面显示。 */
export interface TurnToolStat {
  toolName: string;
  count: number;
  failed: number;
}

/** 大折叠头的统计。轮耗时在分组时已算好（durationMs），这里补思考与工具计数。 */
export interface TurnStats {
  durationMs: number | null;
  /**
   * 思考总时长：各思考块**现场计时**求和（thinkingTimers）。头部显示的是思考
   * **次数**，这个总时长不上界面，但求和过程顺带把没冻结的表冻上（首次渲染即
   * 落定时刻）——成员行展开时才能显示落定时长，而不是「展开那一刻」的膨胀值。
   * 任一块没见过现场（旧会话、后台轮）→ 整个返回 null——部分和是编造。
   * ponytail: 后台落定的轮冻结在「下次被看到」的时刻，数字偏大；根治要像
   * recordToolFrame 那样在事件入口记账，等这个误差真的咬人再做。
   */
  thinkingMs: number | null;
  /** 思考次数（思考块数量）。 */
  thinkingCount: number;
  calls: number;
  /** 各工具的次数与失败数，首次出现序；零次的工具不出现。 */
  byTool: ReadonlyArray<TurnToolStat>;
}

/**
 * 折叠行的加粗开头由哪一段担任。有时长时是「用时 X」；量不到时长（durationMs 为
 * null，见 segmentSpan 的诚实未知）时，由第一段统计顶上——思考数，没有思考就是
 * 工具数。否则行首只剩一串 tertiary 等宽小字，看着不像一行可以点开的折叠
 * （2026-10-18 真机验收：「thought 1」「tools 1 · bash 1」两种行单独看都发虚）。
 * 一段统计都没有时返回 null（成员只有通道 / 钉住之外的空段，正常不会出现）。
 */
export type RollupLead = "duration" | "thinking" | "tools" | null;

export function rollupLead(stats: Pick<TurnStats, "durationMs" | "thinkingCount" | "calls">): RollupLead {
  if (stats.durationMs !== null) return "duration";
  if (stats.thinkingCount > 0) return "thinking";
  if (stats.calls > 0) return "tools";
  return null;
}

/**
 * 折叠统计行的「统计词汇」（2026-09-27 裁决）：read SKILL.md 记作 skill、mcp__ 名
 * 记作 mcp——按「家族」计数，不逐 server/tool 展开名字（多台 server 会撑爆一行）。
 * TurnToolStat.toolName 装的是它，不总是真实工具名。
 */
export function rollupToolKey(
  toolName: string,
  input: unknown,
  skills: ReadonlyArray<{ slug: string; name: string }> = [],
): string {
  if (toolName === "read") {
    const path = (input as Record<string, unknown> | null)?.["path"];
    if (typeof path === "string" && skillForReadPath(path, skills) !== null) return "skill";
  }
  return parseQualifiedToolName(toolName) !== null ? "mcp" : toolName;
}

export function turnStats(
  group: TurnGroupUnit,
  results: ToolResultIndex,
  now: number = Date.now(),
  skills: ReadonlyArray<{ slug: string; name: string }> = [],
): TurnStats {
  let thinkingMs: number | null = 0;
  let thinkingCount = 0;
  let calls = 0;
  const tools = new Map<string, TurnToolStat>();
  for (const member of group.members) {
    if (member.kind === "thinking") {
      thinkingCount++;
      const entry = thinkingTimers.get(member.key);
      if (entry === undefined) {
        thinkingMs = null;
      } else {
        if (entry.end === null) entry.end = now;
        if (thinkingMs !== null) thinkingMs += entry.end - entry.start;
      }
      continue;
    }
    for (const call of member.kind === "toolGroup" ? member.calls : [member]) {
      calls++;
      const statKey = rollupToolKey(call.toolName, call.input, skills);
      const stat = tools.get(statKey) ?? { toolName: statKey, count: 0, failed: 0 };
      stat.count++;
      if (results.get(call.toolCallId)?.status === "error") stat.failed++;
      tools.set(statKey, stat);
    }
  }
  return {
    durationMs: group.durationMs,
    thinkingMs,
    thinkingCount,
    calls,
    byTool: [...tools.values()],
  };
}

/** 组行的状态汇总：结果索引上数一遍，失败/进行中/已中断/完成各多少。 */
export interface ToolGroupStatus {
  total: number;
  failed: number;
  running: number;
  /** 已中断（无结果帧且结果永远不会来，见 `interruptedToolCallIds`）——不占 running，组头不为它呼吸 */
  interrupted: number;
  done: number;
}

export function toolGroupStatus(
  calls: readonly ToolCallUnit[],
  results: ToolResultIndex,
  interrupted: ReadonlySet<string> = new Set(),
): ToolGroupStatus {
  let failed = 0;
  let running = 0;
  let broke = 0;
  let done = 0;
  for (const call of calls) {
    const result = results.get(call.toolCallId);
    if (result === undefined || result.status === "running") {
      // 连结果帧都没有、且判定已中断：按中断计，不算运行中
      if (result === undefined && interrupted.has(call.toolCallId)) broke++;
      else running++;
    } else if (result.status === "error") failed++;
    else done++;
  }
  return { total: calls.length, failed, running, interrupted: broke, done };
}

/**
 * 已中断的工具调用 id 集：调用**从未执行、结果永远不会来**——所在 assistant 消息
 * 以 error / aborted 收场（模型流在发 tool call 参数途中被切断，2026-10-09 的
 * 「委派中…」呼吸不停就是它），或消息已落定而轮已结束 / 后面已有新的对话记录，
 * 结果帧却始终缺席。这类调用按「运行中」渲染就会永远呼吸（delegate 卡）/ 转圈，
 * 界面要能说出「这一步没发生」。
 *
 * 判定护住几类真跑着的调用，不误伤：
 * - **有结果帧**（含 running 帧）的一律不算——工具已经启动，结果只是还没到；
 * - **流式中的消息**（status "streaming"，stopReason 尚未定）不算；
 * - **活跃轮末条 assistant** 上的 complete 调用不算——那是「消息已完、工具即将/
 *   正在启动」的正常窗口。**「末条」只看 assistant / user 记录，不看 tool 帧**：
 *   pi 并行批次里每个调用先落 start 帧、再过审批闸门（可能等用户很久）才轮到
 *   下一个（agent-loop 的 executeToolCallsParallel）——同批还没 start 的调用没有
 *   帧，把 tool 帧当「后面有新记录」会在审批挂起时把它误判成已中断。反过来，
 *   新的 assistant / user 一定在整批结果落定之后才出现（pi 只在整批工具落定后
 *   才开下一条 assistant；steer 注入的 user 也落在批次之后），它们才是
 *   「结果该齐了」的可信界碑。
 */
export function interruptedToolCallIds(
  records: readonly TranscriptRecord[],
  results: ToolResultIndex,
  turnActive: boolean,
): ReadonlySet<string> {
  const ids = new Set<string>();
  // 倒序扫：「右边已出现过 assistant / user」——对本条消息来说就是后面已有新对话。
  // 收集到的 id 最后再倒回文档序（Set 按插入序迭代），调试与断言都稳定
  const found: string[] = [];
  let movedOn = false;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record === undefined) continue;
    if (record.role === "user") {
      movedOn = true;
      continue;
    }
    if (record.role !== "assistant") continue; // tool 帧 / 界碑 / 通道标记都不是界碑
    if (record.status === "streaming") {
      // 轮已走到新的流式消息：它自己的调用不判（stopReason 未定），
      // 但它左边的批次已经收账——结果缺席就是孤儿
      movedOn = true;
      continue;
    }
    for (const block of record.content) {
      if (block.type !== "toolCall" || results.has(block.toolCallId)) continue;
      if (record.status === "error" || record.status === "aborted" || !turnActive || movedOn) {
        found.push(block.toolCallId);
      }
    }
    movedOn = true;
  }
  for (const id of found.reverse()) ids.add(id);
  return ids;
}

export function thinkingPreview(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line !== undefined && line.trim() !== "") return line;
  }
  return "";
}

/**
 * 流式中的思考块 key（行首呼吸的判定）：本轮未结束、转录末条是 assistant、
 * 且它的**最后一块**是 thinking——流式中思考永远是最尾块，模型转去出正文或调
 * 工具时它就不再是最后一块，呼吸即停（状态变了就结束，不等整轮）。
 * 其余情况（idle、压缩中、末条是 user/tool/界碑、末块不是 thinking）都返回 null。
 */
export function streamingThinkingKey(
  records: readonly TranscriptRecord[],
  turnActive: boolean,
): string | null {
  if (!turnActive) return null;
  const last = records[records.length - 1];
  if (last === undefined || last.role !== "assistant") return null;
  const index = last.content.length - 1;
  const block = last.content[index];
  return block !== undefined && block.type === "thinking" ? `${last.id}:${index}` : null;
}

/** 思考时长格式：不足 1 秒按 1 秒；满一分钟「1m 05s」（秒两位补零，与 formatToolDuration 同款）。 */
export function formatThinkingDuration(ms: number, t: Messages): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return t.chat.seconds(String(seconds));
  return t.chat.minutesSeconds(Math.floor(seconds / 60), String(seconds % 60).padStart(2, "0"));
}

/**
 * 思考块的**现场计时**：块第一次被看到（active）时起表，落定那一刻冻结。
 * 落盘记录里没有块级时间戳，重开的旧会话量不到——返回 null，副标不显示。
 * 进行中返回 null（此时活尾预览在说话，秒数不抢戏）。
 */
const thinkingTimers = new Map<string, { start: number; end: number | null }>();

export function thinkingDurationText(
  key: string,
  active: boolean,
  t: Messages,
  now: number = Date.now(),
): string | null {
  let entry = thinkingTimers.get(key);
  if (active) {
    if (entry === undefined) {
      entry = { start: now, end: null };
      thinkingTimers.set(key, entry);
    }
    return null;
  }
  if (entry === undefined) return null;
  if (entry.end === null) entry.end = now;
  return formatThinkingDuration(entry.end - entry.start, t);
}

/**
 * 工具执行的现场计时（bash/powershell 折叠行的耗时）。**事件帧驱动**：running 帧
 * 的 timestamp 是 adapter 在 tool_execution_start 落的 now()，起点精确；终态帧落
 * 终点。挂在事件入口（useChatSession）记——组折叠时成员行不渲染，渲染驱动会漏。
 * 旧会话只有盘上终态帧、没见过 running 帧，量不到就返回 null（thinking 计时同款
 * 限制）。ponytail: Map 无上限，每个工具几十字节。
 */
const toolTimers = new Map<string, { start: number; end: number | null }>();

/** 记一帧工具记录。幂等：running 只记首个起点、终态只记首个终点（增量帧会重复到达）。 */
export function recordToolFrame(item: TranscriptItem): void {
  if (item.role !== "tool") return;
  const entry = toolTimers.get(item.toolCallId);
  if (item.status === "running") {
    if (entry === undefined) toolTimers.set(item.toolCallId, { start: item.timestamp, end: null });
    return;
  }
  if (entry === undefined || entry.end !== null) return;
  toolTimers.set(item.toolCallId, { start: entry.start, end: item.timestamp });
}

/** 执行时长文案（如「12.3 秒」）；没记到起点（旧会话）或还在跑返回 null。 */
export function toolDurationText(toolCallId: string, t: Messages): string | null {
  const entry = toolTimers.get(toolCallId);
  if (entry === undefined || entry.end === null) return null;
  return formatToolDuration(entry.end - entry.start, t);
}

/**
 * 运行中的 shell 工具还差多久说不清，但「已经跑了多久」必须说得清（2026-10 用户
 * 反馈：长 bash 一行不动，像卡死）。起点读现场计时表：还在跑的条目 end 为 null，
 * 没记到（旧会话重开、或 renderer 晚于工具启动才挂上）返回 null，界面退化为不显示计时。
 */
export function toolStartAt(toolCallId: string): number | null {
  const entry = toolTimers.get(toolCallId);
  return entry !== undefined && entry.end === null ? entry.start : null;
}

// ── 运行中 shell 的可见性（长命令自动展开 + 活尾 + 计时）──

/**
 * 自动展开阈值（秒）。依据：全量 46,363 次 bash 调用里 P90 ≈ 6.3s——10s 只会
 * 打进约 8% 的慢命令，快命令（读文件、小 grep）永不展开，界面的安静不被破坏。
 */
export const SHELL_AUTO_EXPAND_SECONDS = 10;

/** expected_seconds 的合法上限（秒）：超过一天的一定不是认真的估计，当坏值丢弃。 */
const EXPECTED_SECONDS_MAX = 86_400;

/**
 * 模型自估的执行秒数（`expected_seconds`）。**只给 UI**（展开时机与「预计约」文案），
 * 不影响执行、不做硬性结束——pi 的 TypeBox 校验对未知字段放行（实测 0.84.3），
 * 字段随入参原样流到渲染层，bash 的 execute 只解构 command/timeout、无视它。
 * 逐字段校验：非有限正数、超上限、字符串数字都判 null（字符串数字不猜——
 * 「预计约 abc」比没有预计更糟）。
 */
export function expectedSecondsOf(input: unknown): number | null {
  return secondsFieldOf(input, "expected_seconds");
}

/**
 * 本次调用实际跑在多少秒上限上，运行行显示「/ 上限 30:00」。**套闸门同一条规则**
 * （shared/permission.ts 的三档常量）：闸门夹超时改的是入参对象、不回写会话记录，
 * 这里读到的是模型原始值——不套同一条规则，模型填 60 实际跑在 600 上、不填实际跑在
 * 1800 上，界面都会撒谎。
 *
 * 规则一字不差：不填 → DEFAULT（本 PR 的行为变更：不填不再是「无上限」）；填了 →
 * min(max(raw, FLOOR), HARD_MAX)；非法（≤0 / 非有限数 / 字符串数字不猜）→ null（不替 pi 做
 * 第二套校验，那种调用本来就会报 Invalid timeout、不会真跑）。
 */
export function timeoutSecondsOf(input: unknown): number | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>)["timeout"];
  if (value === undefined) return COMMAND_TIMEOUT_DEFAULT_SECONDS;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(Math.max(value, COMMAND_TIMEOUT_FLOOR_SECONDS), COMMAND_TIMEOUT_HARD_MAX_SECONDS);
}

function secondsFieldOf(input: unknown, key: string): number | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value > EXPECTED_SECONDS_MAX) return null;
  return value;
}

/** 运行中计时的 m:ss 形态（0:45 / 12:03）：秒两位补零，分钟不限位。 */
export function formatRunClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * 折叠行下的活尾预览：让「它在动」不展开也看得见。取末尾最多 keep 个**非空**行
 * （尾部空行是噪音），每行截到 maxChars——预览是信号不是正文，长行以「…」收口。
 * 从尾往前找，返回按原顺序排列。
 */
export function tailPreviewLines(text: string, keep = 2, maxChars = 160): string[] {
  const lines = text.split("\n");
  const picked: string[] = [];
  for (let i = lines.length - 1; i >= 0 && picked.length < keep; i--) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    picked.push(line.length > maxChars ? `${line.slice(0, maxChars)}…` : line);
  }
  return picked.reverse();
}

/**
 * 剥掉末尾的空行（只剥尾部，中间的空行保留——它们是内容结构）。shell 输出几乎
 * 总以 `\n` 结尾，按行拆分后末尾多一个空行；展开体以前没有下边框看不出来，
 * 2026-10-12 套圆角虚线框后框底多出一整行空白，渲染前先剥。
 */
export function stripTrailingBlankLines(text: string): string {
  const lines = text.split("\n");
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last === undefined || last.trim() === "") lines.pop();
    else break;
  }
  return lines.join("\n");
}

/**
 * 自动展开判定（纯函数，驱动方拿着它在每秒重算）：模型给了 expected 且达阈值 →
 * **开跑就展**（一秒都不让用户盯着静止的行）；没给或没达 → 已运行时长达阈值再展。
 * elapsed 记不到（晚挂载）时只认 expected——两个信号都没有就不自动展开。
 */
export function shellAutoExpand(expectedSeconds: number | null, elapsedMs: number | null): boolean {
  if (expectedSeconds !== null && expectedSeconds >= SHELL_AUTO_EXPAND_SECONDS) return true;
  return elapsedMs !== null && elapsedMs >= SHELL_AUTO_EXPAND_SECONDS * 1000;
}

/** 工具时长格式：不足一分钟带一位小数（毫秒级工具是噪音，只有慢命令值得看），满一分钟「1m 04s」（秒两位补零）。 */
export function formatToolDuration(ms: number, t: Messages): string {
  const seconds = ms / 1000;
  if (seconds < 60) return t.chat.seconds(seconds.toFixed(1));
  const whole = Math.round(seconds);
  return t.chat.minutesSeconds(Math.floor(whole / 60), String(whole % 60).padStart(2, "0"));
}

/** 折叠态那一行右侧的摘要：让人不展开也能大致知道发生了什么。 */
/**
 * B-1：read_task 结果 `details` 里的任务卡。**逐字段校验，坏值判 null**——
 * 卡片坏了不碍事（展开体还在），编造 sessionId 才碍事（点了跳错会话）。
 * running 帧还没有 card（details 随终态帧来），一律 null。
 */
export function readTaskCard(result: ToolTranscriptItem | undefined): ReadTaskCard | null {
  if (result === undefined || result.status === "running") return null;
  const details = result.details;
  if (typeof details !== "object" || details === null) return null;
  const raw = (details as Record<string, unknown>)["readTask"];
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const sessionId = value["sessionId"];
  if (typeof sessionId !== "string" || sessionId === "") return null;
  const title = value["title"];
  const mode = value["mode"];
  const roundCount = value["roundCount"];
  if (typeof title !== "string" || (mode !== "briefing" && mode !== "rounds")) return null;
  if (typeof roundCount !== "number" || !Number.isFinite(roundCount)) return null;
  const rounds = value["rounds"];
  return {
    sessionId,
    title: title === "" ? "(untitled)" : title,
    mode,
    ...(typeof rounds === "string" ? { rounds } : {}),
    roundCount,
  };
}

/** show_image 结果 details 里的画廊卡：图给用户看，与模型有没有视觉无关（agent/image-tools.ts） */
export interface ShowImageCardView {
  images: { data: string; mimeType: string; name: string }[];
}

/**
 * show_image 的画廊卡。**逐字段校验，坏值判 null**——同 readTaskCard 的纪律；
 * 键名 `"showImage"` 对应 `image-tools.ts` 落的 `details: { showImage: card }`。
 * 卡片走 details 而非 content 的 image 块：非视觉模型时 content 没有图（provider
 * 约束），用户的画廊不能跟着消失。
 */
export function showImageCard(result: ToolTranscriptItem | undefined): ShowImageCardView | null {
  if (result === undefined || result.status === "running") return null;
  const details = result.details;
  if (typeof details !== "object" || details === null) return null;
  const raw = (details as Record<string, unknown>)["showImage"];
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const list = value["images"];
  if (!Array.isArray(list) || list.length === 0) return null;
  const images: { data: string; mimeType: string; name: string }[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) return null;
    const entry = item as Record<string, unknown>;
    const data = entry["data"];
    const mimeType = entry["mimeType"];
    const name = entry["name"];
    if (typeof data !== "string" || data === "") return null;
    if (typeof mimeType !== "string" || !mimeType.startsWith("image/")) return null;
    if (typeof name !== "string") return null;
    images.push({ data, mimeType, name });
  }
  return { images };
}

/**
 * 子会话：`delegate` 结果 `details` 里的派出卡。**逐字段校验，坏值判 null**——
 * 同 readTaskCard 的纪律，键名 `"delegate"` 对应 `channel-tools.ts` 落的
 * `details: { delegate: card satisfies DelegateCard }`。running 帧还没有卡
 * （details 随终态帧来），一律 null。
 */
/**
 * 交接（request_user_action）的结局：details.browser.handoff（主进程写的，不解析给模型的文字）。
 * 还在等 / 结果还没到 / 形状不对都是 null——交接卡按「等你」画。
 */
export function handoffOutcome(result: ToolTranscriptItem | undefined): "done" | "cancelled" | null {
  if (result === undefined || result.status === "running") return null;
  const details = result.details;
  if (typeof details !== "object" || details === null) return null;
  const browser = (details as Record<string, unknown>)["browser"];
  if (typeof browser !== "object" || browser === null) return null;
  const outcome = (browser as Record<string, unknown>)["handoff"];
  return outcome === "done" || outcome === "cancelled" ? outcome : null;
}

export function delegateCard(result: ToolTranscriptItem | undefined): DelegateCard | null {
  if (result === undefined || result.status === "running") return null;
  const details = result.details;
  if (typeof details !== "object" || details === null) return null;
  const raw = (details as Record<string, unknown>)["delegate"];
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const childId = value["childId"];
  const title = value["title"];
  const modelId = value["modelId"];
  const workbench = value["workbench"];
  const thinkingLevel = value["thinkingLevel"];
  if (typeof childId !== "string" || childId === "") return null;
  if (typeof title !== "string" || title === "") return null;
  if (typeof modelId !== "string" || modelId === "") return null;
  if (typeof workbench !== "string" || workbench === "") return null;
  if (!isThinkingLevel(thinkingLevel)) return null;
  return { childId, title, modelId, workbench, thinkingLevel };
}


/** channelMarkLabel 的 tone：颜色是第二信号，与 ChannelMarkLine 的取色一一对应。 */
export type ChannelMarkTone = "question" | "reply" | "neutral" | "done" | "failed";

/**
 * 通道标记的文案与语气（纯函数；QueueStrip 的排队条目在用）。`ownSide` 是被查看
 * 会话相对通道的身份（父还是子），`peerTitle` 是对面会话的标题（查不到时调用方
 * 传 "Sub-session" / "Parent session" 兜底）。
 *
 * 方向由 `mark.from` 与 `ownSide` 的组合定：本会话是父时看到的是子发来的
 * question/progress/done/failed（allowedKinds("child")）；本会话是子时看到的是
 * 父发来的 task/reply（allowedKinds("parent")）——两个方向的 kind 空间天然不交叠，
 * "其余组合" 分支理论上不会命中，只是防御性兜底。
 */
export function channelMarkLabel(
  mark: { from: "parent" | "child"; kind: ChannelMessageKind },
  ownSide: "parent" | "child",
  peerTitle: string,
  t: Messages,
): { text: string; tone: ChannelMarkTone } {
  const c = t.channel;
  const label = ((): { text: string; tone: ChannelMarkTone } => {
    if (ownSide === "parent" && mark.from === "child") {
      switch (mark.kind) {
        case "question":
          return { text: c.markAsked(peerTitle), tone: "question" };
        case "progress":
          return { text: c.markProgress(peerTitle), tone: "neutral" };
        case "done":
          return { text: c.markDone(peerTitle), tone: "done" };
        case "failed":
          return { text: c.markFailed(peerTitle), tone: "failed" };
        default:
          return { text: c.markOther(peerTitle, c.kinds[mark.kind]), tone: "neutral" };
      }
    }
    if (ownSide === "child" && mark.from === "parent") {
      switch (mark.kind) {
        case "task":
          return { text: c.taskFrom(peerTitle), tone: "neutral" };
        case "reply":
          return { text: c.replyFrom(peerTitle), tone: "reply" };
        default:
          return { text: c.markOther(peerTitle, c.kinds[mark.kind]), tone: "neutral" };
      }
    }
    return { text: c.markOther(peerTitle, c.kinds[mark.kind]), tone: "neutral" };
  })();
  return label;
}

export function summarizeToolResult(result: ToolTranscriptItem | undefined, t: Messages): string | null {
  if (result === undefined) return null;
  if (result.status === "running") return t.common.running;
  if (result.status === "error") return t.common.failed;
  const text = result.content
    .map((block) => (block.type === "text" ? block.text : "[image]"))
    .join("\n")
    .trim();
  if (text === "") return t.chat.noOutputShort;
  const lines = text.split("\n").length;
  return lines > 1 ? t.chat.lines(lines) : t.chat.chars(text.length);
}

/** MCP 工具的入参摘要（4-5）：不认识的工具没有专用摘要器，退回 JSON 一行
 * 截断——有东西总比空白强，完整参数在展开体/审批条里。 */
export function mcpInputSummary(input: unknown, max = 40): string | null {
  if (input === null || input === undefined) return null;
  let text: string;
  try {
    text = typeof input === "string" ? input : JSON.stringify(input) ?? "";
  } catch {
    return null;
  }
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "" || flat === "{}") return null;
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * MCP 工具卡的折叠摘要（4-5）：成功按规格说量词——纯文本 `{n} chars`、
 * 含图 `{n} images · {n} chars`（图片张数在前，因为它是这类 server 的主产出）。
 * 失败不在这里分型（见 mcpFailureKind）。
 */
export function summarizeMcpResult(result: ToolTranscriptItem | undefined, t: Messages): string | null {
  if (result === undefined) return null;
  if (result.status === "running") return t.common.running;
  if (result.status === "error") return mcpFailureKind(result) === "business" ? t.common.failed : mcpFailureLabel(result, t);
  const images = result.content.filter((block) => block.type === "image").length;
  const chars = result.content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim().length;
  if (images === 0 && chars === 0) return t.chat.noOutputShort;
  if (images === 0) return t.chat.chars(chars);
  return `${t.chat.images(images)} · ${t.chat.chars(chars)}`;
}

/**
 * MCP 失败分型（4-5）：业务失败 = server 自己报错（isError 语义，mcp.ts 翻成
 * 抛出、正文是 server 的话）；传输失败 = 我们这边连不上 / 等不到（超时、
 * 连接断、reload 后 server 没了）。两者的下一步完全不同——前者去修 server，
 * 后者去修连接，折叠行和展开体都要分得开。
 */
export function mcpFailureKind(
  result: ToolTranscriptItem,
): "business" | "timedOut" | "unreachable" {
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
  if (/调用超时|timed?[- ]?out/i.test(text)) return "timedOut";
  if (/not connected|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket|连接|Unreachable/i.test(text)) {
    return "unreachable";
  }
  return "business";
}

/** 折叠行的失败词（分型驱动）：Timed out / Unreachable；业务失败是 Failed。 */
export function mcpFailureLabel(result: ToolTranscriptItem, t: Messages): string {
  const kind = mcpFailureKind(result);
  if (kind === "timedOut") return t.chat.timedOut;
  if (kind === "unreachable") return t.chat.unreachable;
  return t.common.failed;
}

/** 展开体的首行（分型驱动）：讲清「错在哪一层」。 */
export function mcpFailureLead(result: ToolTranscriptItem, t: Messages): string {
  const kind = mcpFailureKind(result);
  if (kind === "business") return t.chat.serverError;
  if (kind === "timedOut") return t.chat.timedOutLead;
  return t.chat.unreachableLead;
}

/** 展开后要显示的正文。图片暂不渲染，只标记它存在——真正的图片渲染是后面的事。 */
export function toolResultText(result: ToolTranscriptItem, t: Messages): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : t.chat.imageMarker(block.mimeType)))
    .join("\n");
}

/**
 * 工具行能不能展开：跑完（含失败）都能；**跑着的只有 shell 能**——pi 的 bash /
 * powershell 执行中持续吐部分输出帧（adapter 已映射成 running 态 item 的累积文本），
 * 展开就是实时输出；read / grep 这类在结束前没有部分产出，展开只会开出一个空盒子。
 * 还没收到任何结果帧（item 未建成）同样不可展开。
 */
export function toolExpandable(result: ToolTranscriptItem | undefined, toolName: string): boolean {
  if (result === undefined) return false;
  if (result.status !== "running") return true;
  return toolName === "bash" || toolName === "powershell";
}

/**
 * 跑着的时候只渲染尾部 keep 行：partial 是**累积快照**、每帧整条重渲染，
 * 万行输出会拖垮 DOM。跑完的完整结果不走这里（pi 侧对超长输出自己有截断）。
 */
export function liveTailLines(text: string, keep = 200): string {
  const lines = text.split("\n");
  if (lines.length <= keep) return text;
  return lines.slice(lines.length - keep).join("\n");
}

// ── C-2：分支锚点 ──

/**
 * 分支锚点：每轮 agent 的**最终完整输出**（按钮出在它下面）。
 *
 * 判据——assistant 记录已终态（非 streaming）、带 ≥1 个非空 text 块、它的每个
 * toolCall 都有落定的结果（complete / error：有调用没结果的上下文是畸形的，
 * 切出去就是一条坏分支），且后面跟的不再是本轮的 tool / assistant（轮边界 =
 * user 记录、界碑、通道标记或转录末尾；轮里的中间回答会被后面的回答顶替）。
 *
 * **通道标记是轮边界**（子会话 2026-09-23 不变量修正）：它顶替的正是 pi 本子里的
 * 一条 user 消息，按位对账（`branchRoles`）把它计作 user——展示层的边界判定必须
 * 与主进程的对账口径一致，否则界面判对而账对不上，分支会被主进程拒绝。取代
 * ea3dcfa 时代「穿过不打断候选」的旧语义。
 *
 * 这是**展示层**判定（决定按钮出不出），最终裁决在 agent 进程的对账守卫——
 * 界面判对而账对不上时，分支会被拒绝并报错，不会切错。
 *
 * `turnActive`（本轮还在跑）：**不做末尾确认**。工具结果刚落定、下一条回答还没开始
 * 生成的窗口里，半轮的 candidate 会被末尾确认误钉成锚点——复制/分支/速度行在
 * 「回应中」就冒出来，回答落定前又消失（2026-09-28 用户报告）。轮边界确认的历史
 * 锚点不受影响。
 */
export function branchAnchorIds(
  records: readonly TranscriptRecord[],
  toolResults: ToolResultIndex,
  turnActive = false,
): ReadonlySet<string> {
  const settled = (toolCallId: string): boolean => {
    const result = toolResults.get(toolCallId);
    return result !== undefined && (result.status === "complete" || result.status === "error");
  };
  const anchors = new Set<string>();
  let candidate: string | null = null;
  const confirm = () => {
    if (candidate !== null) anchors.add(candidate);
    candidate = null;
  };
  for (const record of records) {
    if (record.role === "user" || record.role === "compacted" || record.role === "channel-mark") {
      confirm();
      continue;
    }
    if (record.role === "tool") continue; // 结果归位到调用行，不构成边界
    // 文件账三件（revert.ts）：轮尾账跟着回答落定，确认锚点；界碑 / 撤销不开新轮
    if (record.role === "file-turn") {
      confirm();
      continue;
    }
    if (record.role === "revert" || record.role === "undo") continue;
    if (record.role === "intent-recall") continue; // 召回卡是过程元信息，不构成边界
    if (record.status === "streaming") {
      candidate = null; // 还没完整——这一轮没有可分支的「最终输出」
      continue;
    }
    const hasText = record.content.some(
      (block) => block.type === "text" && block.text.trim() !== "",
    );
    const toolsSettled = record.content.every(
      (block) => block.type !== "toolCall" || settled(block.toolCallId),
    );
    candidate = hasText && toolsSettled ? record.id : null;
  }
  if (!turnActive) confirm(); // 末尾确认只属于落定的轮次；活跃轮的半轮候选等回答结束
  return anchors;
}

/**
 * 锚点消息 → 它**最后一个渲染单元**所在的 entry 下标。渲染层在该 entry 后面插
 * 分支按钮行——组行的归属看组内最后一个成员（组只合相邻，最后一成员之后必然
 * 是轮边界，不会把按钮插到组中间）。同一条锚点消息占多个 entry 时，下标大的
 * 覆盖小的，天然取到最后。
 * 输入是**大折叠分组后的视图**：折叠单元不携带归属（其成员的正文才是锚点的
 * 最后一单元，而正文永远在折叠外面），直接跳过——倒序扫自然先命中锚点的正文。
 */
export function branchAnchorEntries(
  anchorIds: ReadonlySet<string>,
  entries: readonly (RenderEntry | TurnGroupUnit)[],
): Map<number, string> {
  // 倒序扫：每个锚点消息**首次**命中就是它的最后一个 entry，后面不再覆盖
  const lastOf = new Map<string, number>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry === undefined || entry.kind === "turnGroup") continue;
    let messageId: string | null = null;
    if (entry.kind === "text" || entry.kind === "thinking" || entry.kind === "toolCall") {
      messageId = entry.messageId;
    } else if (entry.kind === "toolGroup") {
      messageId = entry.calls.at(-1)?.messageId ?? null;
    }
    if (messageId !== null && anchorIds.has(messageId) && !lastOf.has(messageId)) {
      lastOf.set(messageId, i);
    }
  }
  const rows = new Map<number, string>();
  for (const [messageId, index] of lastOf) rows.set(index, messageId);
  return rows;
}


/**
 * 折叠行上工具名右边的参数摘要：`bash · git status`、`edit · src/app.ts`。
 * 字段名按 pi 工具 schema 的真名（bash→command，路径类→path，搜索类→pattern）；
 * 不认识的工具、input 不是对象、字段缺失或不是字符串，一律返回 null——
 * 摘要缺了不碍事，编造才碍事。
 */
export function toolCallSummary(toolName: string, input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const str = (key: string): string | null => {
    const value = record[key];
    return typeof value === "string" && value !== "" ? value : null;
  };
  switch (toolName) {
    case "bash":
    case "powershell": // pi 0.84.3 的独立工具（bash 的 PowerShell 壳，schema 同构）
      return str("command");
    case "read":
    case "write":
    case "edit":
    case "read_pdf": // PDF 的 read（agent/pdf-tools.ts）：摘要同样是它在读哪份文件
    case "read_docx": // word 的 read（agent/docx-tools.ts）同上
      return str("path");
    case "grep":
    case "find": {
      const pattern = str("pattern");
      if (pattern === null) return null;
      const path = str("path");
      return path === null || path === "." ? pattern : `${pattern} in ${path}`;
    }
    case "ls":
      return str("path") ?? ".";
    // show_image 的入参是路径数组：摘要 = 空格连接的文件名（截断由调用方排版管）
    case "show_image": {
      const value = record["paths"];
      if (!Array.isArray(value)) return null;
      const names = value.filter((item): item is string => typeof item === "string" && item !== "");
      return names.length > 0 ? names.map((name) => name.split(/[\\/]/).pop() ?? name).join(" ") : null;
    }
    case "read_task":
    // 子会话：delegate 的入参同样有 task 字段——派出卡的任务预览复用这条摘要
    case "delegate":
      return str("task");
    // 自我配置工具（4-3）：摘要就是它们造出来的那条的名字
    case "create_skill":
      return str("name") ?? str("slug");
    case "add_mcp_server":
      return str("name");
    // 受管浏览器：导航说去哪；读取类作用于当前页，入参里没有值得摘的，交给结果摘要
    case "browser_navigate":
      return str("url");
    // 交互：模型给的 element 人话（审批卡上也是它）；缺了退回 ref / 坐标，至少知道点的哪
    case "browser_click": {
      const x = record["x"];
      const y = record["y"];
      return str("element") ?? str("ref") ?? (typeof x === "number" && typeof y === "number" ? `${x}, ${y}` : null);
    }
    case "browser_type":
      return str("element") ?? str("ref");
    case "browser_press":
      return str("key");
    case "browser_scroll":
      return str("direction");
    // 诊断：摘要说清看的是哪一档（level）/ 哪个地址（url，含状态范围）；纯读上次记录的不编造
    case "browser_console_messages":
      return str("level");
    case "browser_network_requests": {
      const url = str("url");
      const min = record["statusMin"];
      const max = record["statusMax"];
      const range =
        typeof min === "number" || typeof max === "number" ? `status ${min ?? "…"}–${max ?? "…"}` : null;
      if (url !== null && range !== null) return `${url} (${range})`;
      return url ?? range;
    }
    // 等待：摘要说等的是什么（两个都给了就是任一命中）
    case "browser_wait_for": {
      const selector = str("selector");
      const text = str("text");
      if (selector !== null && text !== null) return `${selector} or "${text}"`;
      return selector ?? (text === null ? null : `"${text}"`);
    }
    // 交接：摘要就是 agent 说的原因（交接卡的标题）
    case "request_user_action":
      return str("reason");
    default:
      return null;
  }
}

/** diff 行的四种角色：增 / 删 / 头与块标记 / 上下文 */
export type DiffLineKind = "add" | "del" | "meta" | "ctx";

/** diff 渲染需要的一行：角色 + 新旧行号（add 只有新行号、del 只有旧行号）+ 剥掉前缀的正文。 */
export interface DiffRow {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

/** parseDiffLines 的产物：文件路径与增删统计从头行来，行体从 hunk 来。 */
export interface ParsedDiff {
  path: string | null;
  added: number;
  removed: number;
  rows: readonly DiffRow[];
}

/** `@@ -12,3 +13,4 @@`；count 缺省按 1（git 对单行 hunk 省略 `,1`）。 */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** `b/src/app.ts` → `src/app.ts`；不带 a//b// 前缀的（pi 自产 diff）原样返回。 */
function stripPathPrefix(header: string): string {
  const value = header.trim();
  if (value.startsWith("a/") || value.startsWith("b/")) return value.slice(2);
  return value;
}

/**
 * unified diff → 可渲染的行数组。文件头（`diff --git` / `---` / `+++`）只在
 * **第一个 hunk 之前**当头解析——进了 hunk 再出现 `--- x` 是「删掉一行 `-- x`」，
 * 提前按角色处理会吃掉它。行号从 `@@` 头起算：ctx 双进、del 旧进、add 新进；
 * `\ No newline` 是标记不是行，不推进计数。
 */
export function parseDiffLines(diff: string): ParsedDiff {
  const lines = diff.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let path: string | null = null;
  let oldPath: string | null = null;
  let sawHunk = false;
  let oldCtr = 0;
  let newCtr = 0;
  let added = 0;
  let removed = 0;
  const rows: DiffRow[] = [];
  for (const line of lines) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null) {
      sawHunk = true;
      oldCtr = Number(hunk[1]);
      newCtr = Number(hunk[3]);
      rows.push({ kind: "meta", oldLine: null, newLine: null, text: line });
      continue;
    }
    if (!sawHunk) {
      if (line.startsWith("diff --git")) continue;
      if (line.startsWith("--- ")) {
        oldPath = stripPathPrefix(line.slice(4));
        continue;
      }
      if (line.startsWith("+++ ")) {
        path = stripPathPrefix(line.slice(4));
        continue;
      }
      // 第一个 hunk 之前的其余行都是头部元数据（`Index:`、`=====` 分隔线、`index abc..def`、
      // `new file mode`）——不是正文。以前漏到正文里，jsdiff 的 `=====` 被画成第 0 行（实机）
      continue;
    }
    if (line.startsWith("\\")) {
      rows.push({ kind: "meta", oldLine: null, newLine: null, text: line });
      continue;
    }
    // 进了 hunk 就是纯前缀分类：`--- x` 是「删掉一行 `-- x`」，
    // 不能再当文件头（文件头只在第一个 hunk 之前，上面已经消费掉了）
    if (line.startsWith("+")) {
      rows.push({ kind: "add", oldLine: null, newLine: newCtr++, text: line.slice(1) });
      added++;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", oldLine: oldCtr++, newLine: null, text: line.slice(1) });
      removed++;
    } else {
      rows.push({ kind: "ctx", oldLine: oldCtr++, newLine: newCtr++, text: line.slice(1) });
    }
  }
  // 新文件被删光时 `+++` 是 /dev/null，路径退回 `---` 那边
  if (path === null || path === "/dev/null") {
    path = oldPath !== null && oldPath !== "/dev/null" ? oldPath : path;
  }
  return { path, added, removed, rows };
}

/**
 * edit 落在 details 里的两份 diff 各司其职：
 * - `diff` 是 pi **专为展示生成**的格式（±标记 + 行号 + 正文，增/上下文带新文档行号），
 *   无文件头、无 @@ 头、无 `\ No newline` 标记——展开显示用它（`editDiffText` + `parseEditDiff`）。
 * - `patch` 是标准 unified diff（createTwoFilesPatch 产物）——折叠行的 +N/-M 统计用它数数。
 */
function editDetailField(result: ToolTranscriptItem, key: string): string | null {
  if (result.toolName !== "edit") return null;
  const details = result.details;
  if (typeof details !== "object" || details === null) return null;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** edit 展开显示用的 pi 显示格式 diff；缺失返回 null——调用方退回原文展示 */
export function editDiffText(result: ToolTranscriptItem): string | null {
  return editDetailField(result, "diff");
}

/** edit 折叠行的增删统计（来自 details.patch）；没有 patch 返回 null */
export interface EditDiffStats {
  added: number;
  removed: number;
}

export function editDiffStats(result: ToolTranscriptItem): EditDiffStats | null {
  const patch = editDetailField(result, "patch");
  if (patch === null) return null;
  const { added, removed } = parseDiffLines(patch);
  return { added, removed };
}

/** pi 显示格式的一行：角色 + 行号（增/上下文带新文档行号、删带旧文档行号）+ 正文 */
export interface EditDiffRow {
  kind: "add" | "del" | "ctx";
  lineNum: string;
  text: string;
}

/** pi 的 diff.ts 同款行格式：「+123 内容」/「-123 内容」/「 123 内容」/ 跳段「   ...」 */
const EDIT_DIFF_LINE = /^([+\- ])(\s*\d*)\s(.*)$/;

/**
 * pi 显示格式 → 行数组。解析不了的行按 ctx 原样保留（跳段「...」就是这么进来的，
 * pi 对解析失败同样按上下文色渲染）；行号两侧空白剥掉。
 */
export function parseEditDiff(diff: string): EditDiffRow[] {
  const rows: EditDiffRow[] = [];
  for (const line of diff.split("\n")) {
    if (line === "") continue;
    const match = EDIT_DIFF_LINE.exec(line);
    if (match === null) {
      rows.push({ kind: "ctx", lineNum: "", text: line });
      continue;
    }
    const marker = match[1] ?? " ";
    const kind = marker === "+" ? "add" : marker === "-" ? "del" : "ctx";
    rows.push({ kind, lineNum: (match[2] ?? "").trim(), text: match[3] ?? "" });
  }
  return rows;
}

/** 词级对比 token：changed 的片段是这行里真正变动的部分（pi 的 inverse 在 DOM 里的等价物） */
export interface IntraToken {
  text: string;
  changed: boolean;
}

export interface IntraLineTokens {
  removed: readonly IntraToken[];
  added: readonly IntraToken[];
}

/** 首个 changed token 的行首空白不算改动（pi 同款规则——缩进不该被高亮） */
function stripLeadingWhitespace(tokens: IntraToken[]): void {
  const first = tokens[0];
  if (first === undefined || !first.changed) return;
  const ws = /^\s*/.exec(first.text)?.[0] ?? "";
  if (ws === "") return;
  first.text = first.text.slice(ws.length);
  tokens.unshift({ text: ws, changed: false });
  if (first.text === "") tokens.splice(1, 1);
}

/** 单行修改的词级对比：diffWords 分词，删行与增行各得一组 token */
export function intraLineTokens(oldText: string, newText: string): IntraLineTokens {
  const removed: IntraToken[] = [];
  const added: IntraToken[] = [];
  for (const part of diffWords(oldText, newText)) {
    if (part.removed) removed.push({ text: part.value, changed: true });
    else if (part.added) added.push({ text: part.value, changed: true });
    else {
      removed.push({ text: part.value, changed: false });
      added.push({ text: part.value, changed: false });
    }
  }
  stripLeadingWhitespace(removed);
  stripLeadingWhitespace(added);
  return { removed, added };
}

/** DiffView 的渲染单元：普通行，或「单行修改」对（相邻的 1 删 + 1 增，pi 对它做词级对比） */
export type EditDiffEntry =
  | { kind: "row"; row: EditDiffRow }
  | { kind: "pair"; removed: EditDiffRow; added: EditDiffRow; tokens: IntraLineTokens };

/**
 * 行数组 → 渲染单元。只有「恰好 1 删 + 1 增」相邻才算单行修改做词级对比；
 * 多删多增按普通行逐行渲染（pi 的 diff.ts 同款判定）。
 */
export function editDiffEntries(rows: readonly EditDiffRow[]): EditDiffEntry[] {
  const entries: EditDiffEntry[] = [];
  let i = 0;
  while (i < rows.length) {
    const current = rows[i];
    if (current !== undefined && current.kind === "del") {
      let dels = 1;
      while (rows[i + dels]?.kind === "del") dels++;
      let adds = 0;
      while (rows[i + dels + adds]?.kind === "add") adds++;
      const added = rows[i + 1];
      if (dels === 1 && adds === 1 && added !== undefined) {
        entries.push({
          kind: "pair",
          removed: current,
          added,
          tokens: intraLineTokens(current.text, added.text),
        });
        i += 2;
        continue;
      }
    }
    if (current !== undefined) entries.push({ kind: "row", row: current });
    i++;
  }
  return entries;
}

/**
 * edit 组折叠头的文件数：按成员 input.path **字符串去重**（「./a.ts」与「a.ts」算两个，
 * 归一化不值得——同轮调用几乎总是一种写法），只数落定且非失败的（改成才算改）。
 * 复用 toolCallSummary 抽 path（edit 的摘要就是 path）。
 */
export function editGroupFileCount(
  calls: readonly ToolCallUnit[],
  results: ToolResultIndex,
): number | null {
  const paths = new Set<string>();
  for (const call of calls) {
    const result = results.get(call.toolCallId);
    if (result === undefined || result.status === "running" || result.status === "error") continue;
    const path = toolCallSummary("edit", call.input);
    if (path !== null) paths.add(path);
  }
  return paths.size > 0 ? paths.size : null;
}

/**
 * write 要写入的正文。**不在结果里**——pi 的 write 成功只回一行
 * `Successfully wrote N bytes to <path>`（details 也是 undefined），内容在调用入参里；
 * pi 自己的 TUI 也在调用阶段渲染正文。空串与缺字段返回 null（退回原文展示）。
 */
export function writeContent(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>)["content"];
  return typeof value === "string" && value !== "" ? value : null;
}

/** 去掉尾部空行（pi 的 trimTrailingEmptyLines：写入正文末尾的换行不数成行） */
function trimTrailingEmptyLines(lines: readonly string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end);
}

/** write 折叠行的量词：写入了多少行。入参没正文时返回 null（摘要让位给状态词）。 */
export function writeLineCount(input: unknown): number | null {
  const content = writeContent(input);
  if (content === null) return null;
  return trimTrailingEmptyLines(content.split("\n")).length;
}

/** grep 结果行：pi 的输出格式——匹配行 `path:N: 正文`、上下文行 `path-N- 正文`。 */
export interface GrepLine {
  kind: "match" | "context";
  path: string;
  lineNum: string;
  text: string;
}

const GREP_MATCH_LINE = /^(.+?):(\d+): ?(.*)$/;
const GREP_CONTEXT_LINE = /^(.+?)-(\d+)- ?(.*)$/;

/**
 * 单行解析 grep 输出。不匹配（尾注 `[Truncated: ...]`、"No matches found"、空行）
 * 返回 null——调用方按原样行渲染，宁可不解析也不猜错。前缀惰性匹配，
 * 带空格 / 反斜杠的路径也认（在第一个 `:数字:` / `-数字-` 处断开）。
 */
export function parseGrepLine(line: string): GrepLine | null {
  const match = GREP_MATCH_LINE.exec(line);
  if (match !== null) {
    return { kind: "match", path: match[1] ?? "", lineNum: match[2] ?? "", text: match[3] ?? "" };
  }
  const context = GREP_CONTEXT_LINE.exec(line);
  if (context !== null) {
    return { kind: "context", path: context[1] ?? "", lineNum: context[2] ?? "", text: context[3] ?? "" };
  }
  return null;
}

/**
 * 路径清单行（find / ls）拆尾：目录前缀退灰、文件名亮。ls 的目录条目
 * （`docs/`）尾分隔符后没有名字——整条当文件名，不拆出空名。
 */
export function splitPathTail(line: string): { dir: string; name: string } {
  const idx = Math.max(line.lastIndexOf("/"), line.lastIndexOf("\\"));
  if (idx === -1 || idx === line.length - 1) return { dir: "", name: line };
  return { dir: line.slice(0, idx + 1), name: line.slice(idx + 1) };
}

/** 工具行展开的「文件内容视图」参数。write 用入参正文、read 用读到的原文；其余工具返回 null（原文展示）。 */
export interface FileViewInput {
  text: string;
  startLine: number;
}

/** read 的起始行号：pi 的 offset 是 1-indexed，缺省 1（行号列从它起算，不然带 offset 读时行号是假的） */
export function readStartLine(input: unknown): number {
  if (typeof input !== "object" || input === null) return 1;
  const value = (input as Record<string, unknown>)["offset"];
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}

export function fileViewFor(
  toolName: string,
  input: unknown,
  result: ToolTranscriptItem,
): FileViewInput | null {
  if (result.status === "error") return null;
  if (toolName === "write") {
    const text = writeContent(input);
    return text === null ? null : { text, startLine: 1 };
  }
  if (toolName === "read") {
    // 图片读取（content 混着 image 块）不进文件视图——行号列对图片标记没有意义；
    // 截断尾注（`[N more lines in file...]`）留在正文里跟 pi 一致
    if (result.content.some((block) => block.type !== "text")) return null;
    // 上一行已排除非文本块，这里没有图片标记要写——不经 toolResultText，也就不需要文案表
    const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    return text === "" ? null : { text, startLine: readStartLine(input) };
  }
  return null;
}

/** 轮内的记录：参数放宽成结构类型，调用方手里的可能混着压缩界碑。 */
interface TurnRecordLike {
  id: string;
  role: unknown;
  content?: readonly { type: string; text?: string }[];
}

/**
 * 锚点消息所在那一轮的全部 assistant 记录（原序）。轮边界 = user / 界碑 / 通道标记
 * （子会话 2026-09-23 不变量：通道标记顶替的正是一条 user 消息，与 branchAnchorIds
 * 的边界口径一致——否则锚点紧跟在通道标记后面时，会把标记之前那一轮的 assistant
 * 记录也一并拷进来）。
 *
 * pi 每次 toolCall 都结束当前消息：「说一句 → 跑工具 → 再说一句」是两三条记录。
 * 只读锚点（末条）会丢前面那句——复制漏前半段、速度只算末条那几百毫秒（2026-09-11 验收复现）。
 * 找不到锚点返回空数组。
 */
export function turnAssistantRecords<T extends TurnRecordLike>(
  records: readonly T[],
  anchorId: string,
): T[] {
  const end = records.findIndex((record) => record.id === anchorId);
  if (end === -1) return [];
  let start = 0;
  for (let i = end; i >= 0; i -= 1) {
    const role = records[i]?.role;
    if (role === "user" || role === "compacted" || role === "channel-mark") {
      start = i + 1;
      break;
    }
  }
  return records.slice(start, end + 1).filter((record) => record.role === "assistant");
}

/**
 * 回答的正文文本——「复制回答」按钮拷的就是它。收一轮里全部 assistant 记录的
 * **text 块**（markdown 原样），段间空行；thinking 与 toolCall 不进：用户要的是答案，不是过程。
 * 非 assistant 记录跳过，空 text 块不占段。
 */
export function answerText(records: readonly TurnRecordLike[]): string {
  return records
    .filter((record) => record.role === "assistant")
    .flatMap((record) => (record.content ?? []).filter((block) => block.type === "text"))
    .map((block) => block.text ?? "")
    .filter((text) => text.trim() !== "")
    .join("\n\n");
}
