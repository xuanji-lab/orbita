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
