/**
 * 插件看板契约 —— IPC 四层的第 1 层（看板这一半；插件本体在 plugin.ts，面板旧契约在 plugin-panel.ts）。
 *
 * 本文件分两段，两位作者：
 * - **清单段**（`orbita.board` 的卡片尺寸等）：作者是插件详情 / 卡片宿主那条线。这里只放会话结果要用的
 *   最小同名版本，合并时以那条线的为准。
 * - **快照段**（`BoardCardSnapshot` / `PluginBoardResult` / 周看板）：会话里的看板结果与全局周看板的数据。
 *
 * 看板结果的来龙去脉：插件跑在一条会话里，跑完 agent 调 `show_plugin_board`，主进程把这个插件**此刻**每张卡的
 * 模板与数据读出来——数据**快照进工具结果的 details**（随会话落盘），模板按内容 sha256 存一份到
 * `<userData>/board-templates/<hash>.html`（去重，快照里只记哈希）。所以插件以后改了模板、改了数据，
 * 旧会话里的卡仍按当时的样子画。全局周看板（`board:week`）从自动化的运行记录找回这些快照。
 */

// ==================== 清单段（最小版本，合并时以卡片宿主那条线为准） ====================

/** 卡片的四档尺寸：宽×高，单位是格（格子宽高比由宿主定）。 */
export const BOARD_CARD_SIZES = ["1x1", "2x1", "1x2", "2x2"] as const;
export type BoardCardSize = (typeof BOARD_CARD_SIZES)[number];

export function isBoardCardSize(value: unknown): value is BoardCardSize {
  return (BOARD_CARD_SIZES as readonly unknown[]).includes(value);
}

/** 一个插件的卡片数上限；`repeat` 展开后的总张数上限。 */
export const BOARD_MAX_CARDS = 12;
export const BOARD_MAX_EXPANDED_CARDS = 24;
/** 卡 id：插件内唯一 */
export const BOARD_CARD_ID_PATTERN = /^[a-z0-9-]{1,32}$/;

// ==================== 快照段 ====================

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
