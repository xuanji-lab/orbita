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
import type { CompactedRecord, SessionRecord } from "@shared/session";

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
  | { kind: "compacted"; key: string; record: CompactedRecord };

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
export function flattenRenderUnits(records: readonly SessionRecord[]): RenderUnit[] {
  const units: RenderUnit[] = [];
  for (const record of records) {
    if (record.role === "compacted") {
      units.push({ kind: "compacted", key: record.id, record });
      continue;
    }
    if (record.role === "tool") continue;
    if (record.role === "user") {
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
 * 相邻同类 toolCall 合并成组。**只合相邻**：任何非同类单元（正文、思考、用户、
 * 界碑、别的工具）都断开 run——隔着东西合并等于撒谎（顺序即语义）。
 * 单数不成组，原样放行，走普通 ToolLine。
 */
export function groupToolUnits(units: readonly RenderUnit[]): RenderEntry[] {
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
    if (unit.kind === "toolCall" && (head === undefined || head.toolName === unit.toolName)) {
      run.push(unit);
      continue;
    }
    flush();
    if (unit.kind === "toolCall") {
      run = [unit];
    } else {
      entries.push(unit);
    }
  }
  flush();
  return entries;
}

// ── 大折叠（一轮一行）：已落定轮次的思考与工具收进一条统计行 ──

/**
 * 大折叠单元：一个**已落定轮次**里全部思考行与工具行/组的收纳。
 * 正文（text）、用户气泡与界碑**永远不进**——中间正文留在外面各在原位，
 * 折叠只是把它的成员在原序列里**原地**替换掉，不重排任何东西。
 */
export interface TurnGroupUnit {
  kind: "turnGroup";
  /** `turn:${首成员 key}`：成员集合不变时 key 不变，折叠的展开状态得以保住 */
  key: string;
  /** 收进的成员（thinking / toolCall / toolGroup），原时间序；展开后就是原有的行 */
  members: readonly TurnMemberEntry[];
  /**
   * 轮时间跨度 = 段内全部渲染单元 timestamp 的极差。adapter 每帧落 now()，末条
   * assistant 的终态帧即正文流式完成时刻——所以这个跨度**含正文时间且旧会话也准**，
   * 不需要现场计时。缺时间戳的单元在场时 null（诚实未知）。
   */
  durationMs: number | null;
}

export type TurnViewEntry = RenderEntry | TurnGroupUnit;

/** 折叠能收的成员：思考、单行工具调用、工具组。正文/气泡/界碑永远不在内。 */
export type TurnMemberEntry = Extract<
  RenderEntry,
  { kind: "thinking" } | { kind: "toolCall" } | { kind: "toolGroup" }
>;

function isTurnMember(entry: RenderEntry): entry is TurnMemberEntry {
  return entry.kind === "thinking" || entry.kind === "toolCall" || entry.kind === "toolGroup";
}

function entryTimestamp(entry: RenderEntry): number | null {
  if (entry.kind === "user") return entry.item.timestamp;
  if (entry.kind === "compacted") return entry.record.timestamp;
  if (entry.kind === "toolGroup") return entry.calls[0]?.timestamp ?? null;
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
  return min !== null && max !== null ? max - min : null;
}

/**
 * 大折叠分组：把渲染单元流按轮边界（user / 界碑）切段，**已落定的段**把成员收进
 * 一个 TurnGroupUnit，位置在第一个成员处。
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
    if (entry.kind === "user" || entry.kind === "compacted" || segments.length === 0) {
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
    const firstMember = segment.findIndex(isTurnMember);
    if (firstMember === -1) {
      view.push(...segment);
      return;
    }
    view.push(...segment.slice(0, firstMember));
    view.push({
      kind: "turnGroup",
      key: `turn:${segment[firstMember]?.key ?? ""}`,
      members: segment.filter(isTurnMember),
      durationMs: segmentSpan(segment, results),
    });
    view.push(...segment.slice(firstMember).filter((entry) => !isTurnMember(entry)));
  });
  return view;
}

/**
 * 回合级失败（重试耗尽）该亮红警示的折叠：**只在失败那一轮里找**。
 *
 * 失败归属于转录末尾那轮（最后一条 user / 界碑之后）。那轮若有折叠（工具跑了几个才断），
 * 图标亮在它头上、与后面的红字成对；若没有（模型开口前就断，重试耗尽的常态），红字自带的
 * 图标就是全部——**上一轮的折叠不能背锅**。旧写法取「整个视图里最后一个折叠」，
 * 失败轮没折叠时就拿到上一轮的，图标和红字隔着一条用户消息（2026-09-11 验收复现）。
 */
export function failedFoldKey(view: readonly TurnViewEntry[]): string | null {
  let start = 0;
  for (let i = view.length - 1; i >= 0; i -= 1) {
    const entry = view[i];
    if (entry !== undefined && (entry.kind === "user" || entry.kind === "compacted")) {
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

export function turnStats(
  group: TurnGroupUnit,
  results: ToolResultIndex,
  now: number = Date.now(),
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
      const stat = tools.get(call.toolName) ?? { toolName: call.toolName, count: 0, failed: 0 };
      stat.count++;
      if (results.get(call.toolCallId)?.status === "error") stat.failed++;
      tools.set(call.toolName, stat);
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

/** 组行的状态汇总：结果索引上数一遍，失败/进行中/完成各多少。 */
export interface ToolGroupStatus {
  total: number;
  failed: number;
  running: number;
  done: number;
}

export function toolGroupStatus(
  calls: readonly ToolCallUnit[],
  results: ToolResultIndex,
): ToolGroupStatus {
  let failed = 0;
  let running = 0;
  let done = 0;
  for (const call of calls) {
    const result = results.get(call.toolCallId);
    if (result === undefined || result.status === "running") running++;
    else if (result.status === "error") failed++;
    else done++;
  }
  return { total: calls.length, failed, running, done };
}

/**
 * 思考折叠行的预览：取**最后一个非空行**。流式时每来一行新思考就顶替上一行
 * （一行顶替一行的活尾刷新，增量由 pi 归约器直接送达，这里只管取行）；
 * 结束后同一规则——无跳变，展开看全文是另一条路。
 */
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
  records: readonly SessionRecord[],
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
export function formatThinkingDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
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
  return formatThinkingDuration(entry.end - entry.start);
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
export function toolDurationText(toolCallId: string): string | null {
  const entry = toolTimers.get(toolCallId);
  if (entry === undefined || entry.end === null) return null;
  return formatToolDuration(entry.end - entry.start);
}

/** 工具时长格式：不足一分钟带一位小数（毫秒级工具是噪音，只有慢命令值得看），满一分钟「1m 04s」（秒两位补零）。 */
export function formatToolDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}

/** 折叠态那一行右侧的摘要：让人不展开也能大致知道发生了什么。 */
export function summarizeToolResult(result: ToolTranscriptItem | undefined): string | null {
  if (result === undefined) return null;
  if (result.status === "running") return "Running";
  if (result.status === "error") return "Failed";
  const text = result.content
    .map((block) => (block.type === "text" ? block.text : "[image]"))
    .join("\n")
    .trim();
  if (text === "") return "No output";
  const lines = text.split("\n").length;
  return lines > 1 ? `${lines} lines` : `${text.length} chars`;
}

/** 展开后要显示的正文。图片暂不渲染，只标记它存在——真正的图片渲染是后面的事。 */
export function toolResultText(result: ToolTranscriptItem): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : `[image ${block.mimeType}]`))
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
 * user 记录、界碑或转录末尾；轮里的中间回答会被后面的回答顶替）。
 *
 * 这是**展示层**判定（决定按钮出不出），最终裁决在 agent 进程的对账守卫——
 * 界面判对而账对不上时，分支会被拒绝并报错，不会切错。
 */
export function branchAnchorIds(
  records: readonly SessionRecord[],
  toolResults: ToolResultIndex,
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
    if (record.role === "user" || record.role === "compacted") {
      confirm();
      continue;
    }
    if (record.role === "tool") continue; // 结果归位到调用行，不构成边界
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
  confirm();
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
    const text = toolResultText(result);
    return text === "" ? null : { text, startLine: readStartLine(input) };
  }
  return null;
}

/**
 * 回答的正文文本——「复制回答」按钮拷的就是它。**只取 text 块**（markdown 原样），
 * thinking 与 toolCall 不进：用户要的是答案，不是过程。参数放宽成结构类型：
 * 调用方手里的记录可能混着压缩界碑，界碑与非 assistant 一律空串。
 */
export function answerText(
  record: { role: unknown; content?: readonly { type: string; text?: string }[] } | undefined | null,
): string {
  if (record === undefined || record === null || record.role !== "assistant") return "";
  return (record.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n\n");
}
