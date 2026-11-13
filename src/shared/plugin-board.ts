/**
 * 插件看板契约 —— 清单 `orbita.board` 与它画出的卡片（IPC 四层的第 1 层）。
 *
 * **看板 = 一组固定尺寸的卡**。外框（四档尺寸、一格的宽高比、圆角）是 Orbita 的，由宿主画；
 * 卡里面（颜色、字号、背景、版式）是插件模板自己的。每张卡各自一个沙箱 iframe（沙箱与协议见 plugin-panel.ts）。
 * 清单写法（`.claude-plugin/plugin.json` 顶层 `orbita.board`；取代已作废的 `orbita.panel`）：
 *
 *   "board": { "title": "文献追踪", "spec": "./board/spec.md",
 *     "cards": [ { "id": "today", "title": "今日一篇", "size": "1x1", "template": "./board/today.html",
 *                  "data": "${CLAUDE_PLUGIN_DATA}/today.json", "sample": "./board/today.sample.json",
 *                  "repeat": "items", "note": "标题 · 为什么挑它" } ] }
 *
 * - `size`：`"1x1" | "2x1" | "1x2" | "2x2"`（宽 × 高，单位是「格」）；
 * - `data` 可选：没写、文件不存在或为空 → 用 `sample` 并在卡外标「样例」；
 * - `repeat` 可选（要求有 `data` 或 `sample`）：数据里这个顶层数组属性的每一项各画一张同尺寸的卡，
 *   这张卡收到的 `data` 就是那一项；
 * - `note` 可选：给人看的一句「这张卡显示什么」，详情页看板样式一节的每卡一行用它。
 * 数量上限：卡片声明 12 张，`repeat` 展开后整块看板最多 24 张。
 *
 * **本文件的分工**（约定 v3）：清单 / 视图类型（下面「清单与视图」一段）归插件详情那条线；
 * 会话里的看板快照、周看板的类型（文件后段）归看板数据那条线——同文件不同段。
 */

// ---------- 清单与视图 ----------

/** 四档尺寸（宽×高，单位格）。 */
export const BOARD_CARD_SIZES = ["1x1", "2x1", "1x2", "2x2"] as const;
export type BoardCardSize = (typeof BOARD_CARD_SIZES)[number];

export function isBoardCardSize(value: unknown): value is BoardCardSize {
  return typeof value === "string" && (BOARD_CARD_SIZES as readonly string[]).includes(value);
}

/** 一档尺寸占几列几行（格）。 */
export function boardCardSpan(size: BoardCardSize): { cols: number; rows: number } {
  switch (size) {
    case "1x1":
      return { cols: 1, rows: 1 };
    case "2x1":
      return { cols: 2, rows: 1 };
    case "1x2":
      return { cols: 1, rows: 2 };
    case "2x2":
      return { cols: 2, rows: 2 };
  }
}

/** 一格的宽高比（宽 : 高 = 10 : 9）。 */
export const BOARD_CELL_RATIO = { width: 10, height: 9 } as const;

/** 卡片声明数与 repeat 展开后的总数上限；id 的写法。 */
export const BOARD_MAX_CARDS = 12;
export const BOARD_MAX_EXPANDED_CARDS = 24;
export const BOARD_CARD_ID_PATTERN = /^[a-z0-9-]{1,32}$/;

/** 清单里一张卡的声明（路径是清单原文，未替换变量）。 */
export interface PluginBoardCardDecl {
  id: string;
  /** 卡名（给人看：卡外标题、详情页每卡一行）；没写退回 id */
  title: string;
  size: BoardCardSize;
  /** 给人看的一句「这张卡显示什么」；没写为 null */
  note: string | null;
  template: string;
  data: string | null;
  sample: string | null;
  /** data（没有就 sample）里的顶层数组属性名 */
  repeat: string | null;
}

/** 清单 `orbita.board` 解析后的样子（视图里带它，详情页画「看板样式」用）。 */
export interface PluginBoardInfo {
  title: string;
  /** 看板说明（给人看的短 markdown）的清单原文路径；没写为 null */
  spec: string | null;
  cards: PluginBoardCardDecl[];
}

/** `orbita.workflow[].wait`：这一步等用户——「board」在看板上点，「chat」在对话里回。 */
export type PluginWaitKind = "board" | "chat";

/** `orbita.io` 的一项（给人看，不执行）。 */
export interface PluginIoItem {
  path: string;
  note: string | null;
  /** 多久一次（只写入项常有）：「每天」「每周五」 */
  when: string | null;
}

export interface PluginIo {
  reads: PluginIoItem[];
  writes: PluginIoItem[];
}

export const EMPTY_PLUGIN_IO: PluginIo = { reads: [], writes: [] };

/** `orbita.external[].kind`：外接服务的种类。 */
export const PLUGIN_EXTERNAL_KINDS = ["api", "cli", "mcp", "service"] as const;
export type PluginExternalKind = (typeof PLUGIN_EXTERNAL_KINDS)[number];

/** `orbita.external` 的一项：插件要接的外部服务 / 命令行（给人看，不执行）。 */
export interface PluginExternal {
  name: string;
  kind: PluginExternalKind;
  /** 要不要账号；没写为 null（界面不说） */
  account: boolean | null;
  /** 会不会常驻后台；没写为 null */
  resident: boolean | null;
  note: string | null;
}

// ==================== 快照段（会话里的看板结果与全局周看板） ====================


/** 单张卡快照数据（JSON 序列化后的 UTF-8 字节）上限；整份结果的数据上限。 */
export const BOARD_SNAPSHOT_CARD_MAX_BYTES = 256 * 1024;
export const BOARD_SNAPSHOT_TOTAL_MAX_BYTES = 1024 * 1024;
/** 模板仓库的目录名（`<userData>/board-templates/`）与哈希的形状 */
export const BOARD_TEMPLATES_DIR = "board-templates";
export const BOARD_TEMPLATE_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * 一张卡在那一刻的样子。`repeat` 卡每一项各一张：`id` 相同、`index` 递增，`data` 是**那一项**
 * （不是整份数据——整份复制 24 份会吃光预算）；非 repeat 卡 `index` 为 0、`data` 是整份数据。
 * 渲染端的 key 用 `${id}:${index}`。
 */
export interface BoardCardSnapshot {
  id: string;
  title: string;
  size: BoardCardSize;
  index: number;
  /** 模板内容的 sha256（小写十六进制）；模板正文在 `<userData>/board-templates/<hash>.html` */
  template: string;
  /** 宿主发给模板的 `orbita:data.data`；`state: "empty"` 时为 null */
  data: unknown;
  state: "ready" | "empty";
  /** 数据来自 `sample`（数据文件不存在 / 为空）：卡外标「样例」 */
  usingSample: boolean;
  /** 数据文件 mtime（毫秒）；样例 / 空为 null */
  updatedAt: number | null;
}

/**
 * 没放进结果的卡：
 * - `unknown-card`：`cards` 参数点名了清单里没有的 id；
 * - `template`：模板读不出来（逃逸 / 缺失 / 超限）；
 * - `data`：数据路径不合规 / 数据文件坏了（坏 JSON / 超 2 MB）——不拿样例盖过去；
 * - `too-large`：这张卡的数据超过 256 KB；
 * - `budget`：整份已到 1 MB，放不下了；
 * - `repeat`：`repeat` 指的不是数组，或展开超过 24 张后的余下几项。
 */
export type BoardSkipReason = "unknown-card" | "template" | "data" | "too-large" | "budget" | "repeat";

export interface BoardSkippedCard {
  id: string;
  reason: BoardSkipReason;
  /** 语言中立的事实（路径、字节数、问题分类），界面按语言组句 */
  detail: string;
}

/** `show_plugin_board` 工具结果的 `details.pluginBoard`：会话结果行照它画（BoardGrid 容器模式）。 */
export interface PluginBoardResult {
  /** 插件名（清单 name；草稿没写名字时为文件夹名） */
  plugin: string;
  /** 卡外标题行用的显示名（清单 displayName，缺省为 plugin） */
  displayName: string;
  /** 看板标题（`orbita.board.title`，缺省为 displayName） */
  title: string;
  /** 已装的插件，还是本会话工作区里还没装的草稿 */
  source: "installed" | "draft";
  /** 草稿的真实路径；已装为 null */
  draftPath: string | null;
  /** 快照时刻（毫秒） */
  at: number;
  /** 清单 `orbita.tuned`：用户和插件磨合好了 */
  tuned: boolean;
  cards: BoardCardSnapshot[];
  skipped: BoardSkippedCard[];
}

/** 工具结果 details 的键：`details.pluginBoard` */
export interface PluginBoardDetails {
  pluginBoard: PluginBoardResult;
}

/** agent 进程 ↔ 主进程（broker 的问答）：show_plugin_board 的回执 */
export type PluginBoardOutcome = { ok: true; board: PluginBoardResult } | { ok: false; error: string };

// ---------- 纯校验（renderer 读 details、主进程读会话记录都用） ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCard(raw: unknown): BoardCardSnapshot | null {
  if (!isRecord(raw)) return null;
  const { id, title, size, index, template, state, updatedAt } = raw;
  if (typeof id !== "string" || !BOARD_CARD_ID_PATTERN.test(id)) return null;
  if (typeof title !== "string" || !isBoardCardSize(size)) return null;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return null;
  if (typeof template !== "string" || !BOARD_TEMPLATE_HASH_PATTERN.test(template)) return null;
  if (state !== "ready" && state !== "empty") return null;
  return {
    id,
    title,
    size,
    index,
    template,
    data: state === "ready" ? (raw["data"] ?? null) : null,
    state,
    usingSample: raw["usingSample"] === true,
    updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : null,
  };
}

const SKIP_REASONS: readonly BoardSkipReason[] = ["unknown-card", "template", "data", "too-large", "budget", "repeat"];

/**
 * 读工具结果 details 里的看板（`details.pluginBoard`）。逐字段校验：整份形状不对回 null；
 * 单张坏卡丢掉（不让一张坏卡毁掉整份）。details 随会话落盘，旧版本 / 手改过的文件都可能长歪。
 */
export function parsePluginBoardDetails(details: unknown): PluginBoardResult | null {
  if (!isRecord(details)) return null;
  const raw = details["pluginBoard"];
  if (!isRecord(raw)) return null;
  const { plugin, displayName, title, source, draftPath, at } = raw;
  if (typeof plugin !== "string" || plugin === "") return null;
  if (source !== "installed" && source !== "draft") return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  const cards = Array.isArray(raw["cards"]) ? raw["cards"].map(parseCard).filter((card): card is BoardCardSnapshot => card !== null) : [];
  const skipped = Array.isArray(raw["skipped"])
    ? raw["skipped"].flatMap((entry): BoardSkippedCard[] => {
        if (!isRecord(entry) || typeof entry["id"] !== "string") return [];
        const reason = entry["reason"];
        if (!(SKIP_REASONS as readonly unknown[]).includes(reason)) return [];
        return [{ id: entry["id"], reason: reason as BoardSkipReason, detail: typeof entry["detail"] === "string" ? entry["detail"] : "" }];
      })
    : [];
  return {
    plugin,
    displayName: typeof displayName === "string" && displayName !== "" ? displayName : plugin,
    title: typeof title === "string" && title !== "" ? title : plugin,
    source,
    draftPath: typeof draftPath === "string" && draftPath !== "" ? draftPath : null,
    at,
    tuned: raw["tuned"] === true,
    cards,
    skipped,
  };
}

// ---------- 模板 → iframe（会话结果与周看板按快照画） ----------

/** `board:frame` 入参：模板哈希（快照里的 `template`） */
export interface BoardFrameRequest {
  hash: string;
}

/** 一次性 iframe 地址（`orbita-panel://doc/<token>`，同面板）；哈希不合规 / 仓库里没有为 null */
export type BoardFrameResult = { frameUrl: string } | null;

// ---------- 全局周看板（`board:week`） ----------

/** 入参：当地周一 00:00（毫秒）。主进程会规整到它所在那一周的周一 00:00，不信任调用方算的边界。 */
export interface BoardWeekRequest {
  weekStart: number;
}

/**
 * 过去的一次自动化运行（带它那次会话里 show_plugin_board 的卡快照）。按 `at` 升序。
 * 没调 show_plugin_board 的运行也列出（`cards` 为空）：界面自己决定画不画。
 */
export interface BoardWeekItem {
  /** 运行时刻（触发 / 送达，毫秒） */
  at: number;
  automationId: string;
  automationTitle: string;
  /** 自动化选的插件名；没选为 null（卡片的插件名以 `pluginTitle` / 快照为准） */
  plugin: string | null;
  /** 显示名：最后一份快照的 displayName，没有快照时同 plugin */
  pluginTitle: string | null;
  /** 那次运行的会话（点卡打开它）；会话没开成为 null */
  sessionId: string | null;
  cards: BoardCardSnapshot[];
  // 以下为加法字段（界面可选用）
  runId: string;
  status: "running" | "success" | "error";
  workspaceId: string | null;
}

/** 排好还没到的一次运行（灰字）。按 `at` 升序。 */
export interface BoardPlannedRun {
  at: number;
  automationId: string;
  title: string;
  plugin: string | null;
  workspaceId: string | null;
}

export interface BoardWeekDay {
  /** 当地那天 00:00 与次日 00:00（毫秒）；夏令时那天不是 24 小时 */
  start: number;
  end: number;
  items: BoardWeekItem[];
  planned: BoardPlannedRun[];
}

export interface BoardWeekResponse {
  /** 规整后的当地周一 00:00 */
  weekStart: number;
  /** 主进程算这份数据的时刻：早于它的给 items，晚于它的给 planned */
  now: number;
  /** 恒为 7 天，周一 → 周日 */
  days: BoardWeekDay[];
}

/** 本地时区：t 所在那一周的周一 00:00。按日历加减（不是 ±86400000），夏令时那周也对。 */
export function localWeekStart(t: number): number {
  const date = new Date(t);
  const sinceMonday = (date.getDay() + 6) % 7;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - sinceMonday).getTime();
}

/** 本地时区：从 weekStart 起第 i 天的 00:00（i 可以是 7，即下周一）。 */
export function localDayStart(weekStart: number, i: number): number {
  const date = new Date(weekStart);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + i).getTime();
}
