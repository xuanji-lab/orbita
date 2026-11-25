/**
 * 对话区右上角「状态」卡（原型，2026-11-22）的纯推导：子会话此刻在跑什么、
 * 收着时计划露哪几步、走表多久跳一次、收起小钮说哪一种状态、产物的类型词。
 *
 * 用户的出发点（2026-11-22 17:21）：「我看进度为了知道进度到哪了。我看产物为了知道我产出了些什么。
 * 我看子会话只是想知道他们是否还在工作。」——这张卡跨轮常驻，所以有固定位置，不进对话流。
 *
 * 纯模块：不 import React，可被 node --test 直接加载。
 */
import type { TranscriptRecord } from "@shared/session";
import type { ChannelStatus } from "@shared/channel";
import { PLAN_TOOL_NAME } from "../../../../shared/plan.ts";
import { parsePluginBoardDetails, type PluginBoardResult } from "../../../../shared/plugin-board.ts";
import type { PlanStep, PlanTimeline } from "./plan-timeline.ts";
import type { TurnOutput } from "../chat/process-rows.ts";
import { sessionOutputs } from "../chat/child-outputs.ts";
import { subSessionRowStatus } from "../chat/sub-sessions-rows.ts";

// ───────────────────────── 子会话此刻在跑什么 ─────────────────────────

export interface ChildActivity {
  toolName: string;
  input: unknown;
  /** 这次调用开始的时刻 */
  since: number;
}

/**
 * 子会话转录的尾巴 → 正在跑的那次工具调用（状态 running 的工具记录；或 assistant 发出了调用、结果还没来）。
 * 没有在跑的调用 = null（在想、在写回答、已停）。
 */
export function childActivityOf(records: readonly TranscriptRecord[]): ChildActivity | null {
  const resolved = new Set<string>();
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined) continue;
    if (record.role === "tool") {
      if (record.status === "running") return { toolName: record.toolName, input: record.input, since: record.timestamp };
      resolved.add(record.toolCallId);
      continue;
    }
    if (record.role === "assistant") {
      for (const block of record.content) {
        if (block.type === "toolCall" && !resolved.has(block.toolCallId)) {
          return { toolName: block.toolName, input: block.input, since: record.timestamp };
        }
      }
      // 最后一条 assistant 的调用都有结果：此刻不在跑工具
      return null;
    }
    if (record.role === "user") return null;
  }
  return null;
}

/** 一次工具调用的一行字：「bash bun run typecheck」「read TaskProgress.tsx」——工具名 + 最能认出它的那个参数 */
export function toolCallLine(toolName: string, input: unknown): string {
  const value = (input ?? {}) as Record<string, unknown>;
  const pick = (key: string): string | null => {
    const raw = value[key];
    return typeof raw === "string" && raw.trim() !== "" ? raw.trim().split("\n")[0] ?? null : null;
  };
  const tail = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const arg =
    pick("command") ??
    (pick("path") !== null ? tail(pick("path") ?? "") : null) ??
    pick("query") ??
    pick("pattern") ??
    (pick("url") !== null ? hostOf(pick("url") ?? "") : null) ??
    pick("terminalId");
  return arg === null ? toolName : `${toolName} ${arg}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 同一个工具调用跑了这么久就算「卡得异常久」（P97 的空档是 28 秒；一条命令十分钟没动静，人该看一眼） */
export const STUCK_MS = 10 * 60_000;

/** 状态卡里一个子会话的状态：在子会话面板那八档之上，多一档 stuck（在跑，但同一个调用跑太久了） */
export type ChildState = "running" | "stuck" | "waiting" | "approval" | "done" | "failed" | "interrupted" | "stopped" | "idle";

/**
 * 一个子会话此刻的状态。running 只认引擎活 phase；转录尾巴只提供正在跑的工具与卡住计时。
 * 基础八档与面板 / 派出卡共用 subSessionRowStatus，不再各算一份。
 */
export function childStateOf(input: {
  channelStatus: ChannelStatus | undefined;
  needsApproval: boolean;
  enginePhaseRunning: boolean;
  activity: ChildActivity | null;
  now: number;
}): ChildState {
  const status = subSessionRowStatus({
    channelStatus: input.channelStatus,
    needsApproval: input.needsApproval,
    running: input.enginePhaseRunning,
  });
  if (status === "running" && input.activity !== null && input.now - input.activity.since > STUCK_MS) return "stuck";
  return status;
}

/** 「在干活」的：步骤行尾画机器人头像的那些 */
export function isWorking(state: ChildState): boolean {
  return state === "running" || state === "stuck" || state === "waiting" || state === "approval";
}

/** 一步下面的子会话怎么排：要你的（在问 / 待批 / 卡住 / 失败）在前，其次在跑，已交回的最后 */
const CHILD_ORDER: Record<ChildState, number> = { waiting: 0, approval: 0, stuck: 1, failed: 2, interrupted: 2, running: 3, idle: 4, stopped: 5, done: 6 };

export function sortChildren<T extends { state: ChildState; since: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => CHILD_ORDER[a.state] - CHILD_ORDER[b.state] || a.since - b.since);
}

// ───────────────────────── 计划收着时露哪几步 ─────────────────────────

export type PlanWindowRow = { kind: "step"; index: number } | { kind: "fold"; count: number; where: "before" | "between" | "after" };

/**
 * 收着的计划：只露「正在发生的」步——在做的、在等的、挂着在干活的子会话的；其余折成「N 个更早的步骤」/「N 个步骤」/「还有 N 步」。
 * （第二版还多露前一步做完的、后一步待做的；2026-11-22 20:58 用户要让产物尽量进第一屏，收成只露在做的。）
 * 四步以内全露（折了反而更长）。没有正在发生的步：露下一步待做的；全做完了露最后一步。
 */
export function planWindow(items: readonly Pick<PlanStep, "id" | "status">[], live: ReadonlySet<string>): PlanWindowRow[] {
  if (items.length <= 4) return items.map((_, index) => ({ kind: "step", index }));
  const isLive = (index: number): boolean => {
    const item = items[index];
    return item !== undefined && (item.status === "in_progress" || item.status === "waiting" || live.has(item.id));
  };
  const shown = new Set(items.map((_, index) => index).filter(isLive));
  if (shown.size === 0) {
    const next = items.findIndex((item) => item.status !== "done");
    shown.add(next >= 0 ? next : items.length - 1);
  }
  const rows: PlanWindowRow[] = [];
  let gap = 0;
  let seen = false;
  items.forEach((_, index) => {
    if (!shown.has(index)) {
      gap += 1;
      return;
    }
    if (gap > 0) rows.push({ kind: "fold", count: gap, where: seen ? "between" : "before" });
    gap = 0;
    seen = true;
    rows.push({ kind: "step", index });
  });
  if (gap > 0) rows.push({ kind: "fold", count: gap, where: "after" });
  return rows;
}

// ───────────────────────── 走表 ─────────────────────────

/**
 * 下一次要重画的时间（毫秒后）：只有在跑项才走（since 列表为空 = null，不走表）；显示精度是「秒」的（不到一分钟）
 * 每秒跳，否则按分钟跳——对齐到最早一个「下一分钟」的边界，四十个计时也只醒一次。
 */
export function nextTickIn(sinces: readonly number[], now: number): number | null {
  if (sinces.length === 0) return null;
  let wait = 60_000;
  for (const since of sinces) {
    const elapsed = Math.max(0, now - since);
    if (elapsed < 60_000) return 1000 - (elapsed % 1000);
    wait = Math.min(wait, 60_000 - (elapsed % 60_000));
  }
  return Math.max(250, wait);
}

/** 跑了多久的字：不到一分钟写秒，不到一小时写分，再长写时 + 分（分钟级，不写秒——秒在跳只会吸走眼睛） */
export function elapsedParts(ms: number): { h: number; m: number; s: number } {
  const total = Math.max(0, Math.floor(ms / 1000));
  return { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 };
}

// ───────────────────────── 收起小钮说哪一种 ─────────────────────────

export type PillSignal = { kind: "waiting" | "failed" | "stuck" | "running"; count: number } | null;

/**
 * 收起后的小钮只说一件事，按「要不要你」排：在问你 / 待批 > 失败（还没看）> 卡住 > 在跑（Codex 宠物同一个思路：
 * 一个指示器同时有几种动静时，按优先级只露一种）。都没有 = null，小钮安静。
 */
export function pillSignal(states: readonly ChildState[], extraRunning: number): PillSignal {
  const count = (pick: (state: ChildState) => boolean) => states.filter(pick).length;
  const waiting = count((state) => state === "waiting" || state === "approval");
  if (waiting > 0) return { kind: "waiting", count: waiting };
  const failed = count((state) => state === "failed" || state === "interrupted");
  if (failed > 0) return { kind: "failed", count: failed };
  const stuck = count((state) => state === "stuck");
  if (stuck > 0) return { kind: "stuck", count: stuck };
  const running = count((state) => state === "running") + extraRunning;
  return running > 0 ? { kind: "running", count: running } : null;
}

// ───────────────────────── 产物 ─────────────────────────

/**
 * 状态卡里一份产物的文件类型（2026-11-22 20:58 用户：分组按文件类型，不按「怎么产生的」——第二版的「导出的文件」
 * 其实是「还没支持预览的文件」，去掉）。
 */
export type StatusOutputKind = "slides" | "pptx" | "doc" | "word" | "web" | "pdf" | "image" | "audio" | "video" | "board" | "file";

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
  /** 看板：这次（同名看板里最后一次成功的）show_plugin_board 的调用 id 与快照——缩略图画它的第一张卡、点击滚回那次结果；别的类型 = null */
  boardCall: BoardCall | null;
}

/** 一次成功的 show_plugin_board：调用 id（对话里那条结果的定位）+ 当时的快照 */
export interface BoardCall {
  toolCallId: string;
  result: PluginBoardResult;
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

/** 结尾产物卡认的 → 文件类型（结尾卡的 file 一类按扩展名再分：PDF / Word / PPTX / 图片 / 其他） */
export function statusKindOf(output: TurnOutput): StatusOutputKind {
  if (output.kind === "slides") return "slides";
  if (output.kind === "doc") return "doc";
  if (output.kind === "web") return "web";
  if (output.kind === "audio" || output.kind === "video") return output.kind;
  return EXT_KIND[extOf(output.path)] ?? "file";
}

function extOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
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

/**
 * 点状态卡里的看板产物：怎么走。
 * - `reveal`：主会话自己的看板、有快照 → 滚回对话里那次结果并原地展开（对话那头找不到那一行时再退回打开插件页，见 ChatView）；
 * - `open-plugin`：子会话做的（调用不在这条会话的转录里，滚不到）、或快照读不出来 → 直接打开右栏插件页。
 */
export function boardClickAction(output: Pick<StatusOutput, "by" | "plugin" | "boardCall">): "reveal" | "open-plugin" {
  return output.by === null && output.boardCall !== null ? "reveal" : "open-plugin";
}

/** 缩略图画哪一张卡：这次快照的第一张；没有卡（全被跳过）= null（退回图标） */
export function thumbCardOf(result: PluginBoardResult): PluginBoardResult["cards"][number] | null {
  return result.cards[0] ?? null;
}

/**
 * 一条会话做出来的全部产物（新的在前）。口径 = 每轮结尾那摞产物卡（sessionOutputs，与 turnOutputs / child-outputs 同一套推导），
 * 只多两类结尾卡里没有的（用户 20:58：「图片待在里面也没毛病。看板也肯定待在里面」）：
 * - 图片：文件账（file-turn）里写出、结尾卡归进「改过的文件」的 png / jpg / svg / gif / webp（write、edit、bash 生成后被记账的都算）；
 * - 看板：show_plugin_board 成功的结果（details.pluginBoard）。
 * 音视频沿用结尾卡的同一套 `turnArtifacts` / `namedMedia` 判定：只有最终回答点了名的 `mediaArtifacts` 才收。
 * 画布、表格这里仍不收。by = 子会话标题（主会话自己的 null）。
 */
export function statusOutputs(records: readonly TranscriptRecord[], by: string | null): StatusOutput[] {
  const { outputs, edited } = sessionOutputs(records);
  const at = records.at(-1)?.timestamp ?? 0;
  const list: StatusOutput[] = outputs.map((output) => ({
    kind: statusKindOf(output),
    path: output.path,
    title: output.title,
    pages: output.pages,
    ...(output.duration === undefined ? {} : { duration: output.duration }),
    by,
    at,
    plugin: null,
    boardCall: null,
  }));
  for (const path of edited) {
    if (EXT_KIND[extOf(path)] === "image") list.push({ kind: "image", path, title: path.split(/[\\/]/).pop() ?? path, pages: null, by, at, plugin: null, boardCall: null });
  }
  // 同名看板只留一条，取**最后一次**成功的那次（缩略图要的是最新的快照）；位置也跟着挪到最后（= 反转后排最前）
  for (const record of records) {
    if (record.role !== "tool" || record.toolName !== "show_plugin_board" || record.status !== "complete") continue;
    const board = boardOf(record.details);
    if (board === null) continue;
    const path = `board:${board.title}`;
    const index = list.findIndex((item) => item.path === path);
    if (index >= 0) list.splice(index, 1);
    list.push({
      kind: "board",
      path,
      title: board.title,
      pages: null,
      by,
      at: record.timestamp,
      plugin: board.plugin,
      boardCall: boardCallOf(record.toolCallId, record.details),
    });
  }
  return list.reverse();
}

/**
 * 产物按文件类型分行：演示文稿（含 PPTX）· 文档（含 Word）· 网页 · PDF · 图片 · 视频 · 音频 · 看板 · 其他文件。
 * 行序固定（看得见画面的在前），不随新旧跳——找东西靠「它在哪一行」的记忆。行内新的在前，但并进来的格式（PPTX、Word：
 * 只有图标卡）排在本行能渲染的之后——一行的第一张是大图，不是图标。没有的类型不出行。
 */
export type OutputGroupKey = "slides" | "doc" | "web" | "pdf" | "image" | "video" | "audio" | "board" | "file";

const GROUP_OF: Readonly<Record<StatusOutputKind, OutputGroupKey>> = {
  slides: "slides",
  pptx: "slides",
  doc: "doc",
  word: "doc",
  web: "web",
  pdf: "pdf",
  image: "image",
  video: "video",
  audio: "audio",
  board: "board",
  file: "file",
};
const GROUP_ORDER: readonly OutputGroupKey[] = ["slides", "doc", "web", "pdf", "image", "video", "audio", "board", "file"];

export function groupOutputs<T extends Pick<StatusOutput, "kind">>(outputs: readonly T[]): { key: OutputGroupKey; items: T[] }[] {
  const map = new Map<OutputGroupKey, T[]>();
  for (const output of outputs) {
    const key = GROUP_OF[output.kind];
    map.set(key, [...(map.get(key) ?? []), output]);
  }
  const merged = (item: T) => (item.kind === "pptx" || item.kind === "word" ? 1 : 0);
  return GROUP_ORDER.flatMap((key) => {
    const items = map.get(key);
    return items === undefined ? [] : [{ key, items: [...items].sort((a, b) => merged(a) - merged(b)) }];
  });
}

// ───────────────────────── 面板宽度 ─────────────────────────

/**
 * 状态卡可拖的宽度（用户 2026-11-22：「我就是想这个卡片能调整宽度」；进度啰嗦时要宽一点）。
 * 卡长得仍是浮卡（「悬浮挺好的，这样我还可以一边看到计划，一边写文稿」），但**挤对话列**（同日 20:25：「保持浮卡，但是要挤对话列！」）：
 * 卡打开时对话列右侧让出「卡宽 + 两侧间距」。所以上限同时受对话区宽度约束：最宽 560、对话区宽的 60%、
 * 给对话列留够 CHAT_MIN 之后剩下的，三者取小；最窄 340（20:58 由 280 提上来）。连 340 都放不下（fitsPanel 为假）就默认收起。
 */
export const PANEL_MIN = 340;
export const PANEL_MAX = 560;
export const PANEL_DEFAULT = 380;
export const PANE_SHARE = 0.6;
/** 对话列（正文 + 输入框）至少留这么宽，再窄一行不到三十个字 */
export const CHAT_MIN = 480;
/** 卡与对话区右缘、卡与对话列之间的间距之和（两侧各 --space-3） */
export const PANEL_GAP = 24;

export function clampPanelWidth(width: number, paneWidth: number): number {
  const room = Math.min(Math.floor(paneWidth * PANE_SHARE), paneWidth - CHAT_MIN - PANEL_GAP);
  const value = Number.isFinite(width) ? width : PANEL_DEFAULT;
  return Math.round(Math.max(PANEL_MIN, Math.min(PANEL_MAX, room, value)));
}

/** 对话区放得下一张最窄的卡且对话列还有 CHAT_MIN 宽吗；放不下 = 默认收起 */
export function fitsPanel(paneWidth: number): boolean {
  return paneWidth - PANEL_MIN - PANEL_GAP >= CHAT_MIN;
}

/**
 * 目标的短标题：第一个冒号前那一句（「补上璇玑的『最后一公里』：先把……」→「补上璇玑的『最后一公里』」），
 * 4–40 字才算；没有冒号或太短太长就用全文（卡头照旧最多两行）。目标照用户原话写，常常一长串，
 * 卡头只要认得出是哪件事（2026-11-23 用户：「goal 都写的好长，这个怎么优化一些」）。纯函数，测试在 chat-status.test.ts。
 */
export function goalHeadline(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = flat.search(/[：:]/);
  if (cut >= 4 && cut <= 40) return flat.slice(0, cut);
  return flat;
}
