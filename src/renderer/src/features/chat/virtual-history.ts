/**
 * 历史段虚拟化的纯计算——行过滤、key / 消息 id 到虚拟行下标的映射、按 key 的高度
 * 缓存（LRU）、前插锚点的目标 scrollTop。不依赖 React / DOM，`node --test` 直接加载。
 *
 * **为什么还要过滤行。** 虚拟化的单位是 `TurnViewEntry`，但其中有一部分条目渲染为
 * `null`（相邻 show_image 已被前一张的合画画廊吸收、同一条消息的后续正文块已并进
 * 扫描回答卡、父流里的子会话进度标记不画）。它们若仍占虚拟行，`gap` 会留下一段
 * 空白，前插/跳转的下标也会对不上「屏幕上真有的行」。过滤规则与 `TranscriptRow` /
 * `EntryView` 的提前返回逐条对应；带分支按钮行的条目保留——`TranscriptRow` 会只画
 * 分支行（正文为 null 时按钮仍要出现）。
 */
import type { ScanAnswerCard, ToolResultIndex, TurnViewEntry } from "./tool-results.ts";

/** 一个渲染行：`index` 是它在历史段 `turnView` 里的原下标（分支行、show_image 前项判定都用它） */
export interface VirtualHistoryRow {
  entry: TurnViewEntry;
  index: number;
}

/** 与 TranscriptRow 的 show_image 判定一致：调用成功（或结果未到）的图片工具 */
function isShowCall(entry: TurnViewEntry): entry is Extract<TurnViewEntry, { kind: "toolCall" }> {
  return entry.kind === "toolCall" && entry.toolName === "show_image";
}

function showCallRenders(entry: TurnViewEntry, results: ToolResultIndex): boolean {
  return isShowCall(entry) && results.get(entry.toolCallId)?.status !== "error";
}

/**
 * 历史段里真正会产出 DOM 的行。规则（按顺序，与渲染层一致）：
 * 1. 相邻成功 show_image：后一张被前一张的画廊吸收（`TranscriptRow` 返回 null）；
 * 2. 同一条 assistant 消息的多个 text 块：只有扫描回答卡的 `firstKey` 画卡，其余 null；
 * 3. 通道标记：只有「子看父」与「父看子（非 progress）」画，其余 null；
 * 4. 带有分支按钮行的条目一律保留——即使正文为 null，按钮仍要渲染。
 */
export function virtualHistoryRows(
  view: readonly TurnViewEntry[],
  results: ToolResultIndex,
  carryoverCards: ReadonlyMap<string, ScanAnswerCard>,
  ownSide: "parent" | "child",
  branchRows: ReadonlyMap<number, string>,
): VirtualHistoryRow[] {
  const rows: VirtualHistoryRow[] = [];
  for (let index = 0; index < view.length; index += 1) {
    const entry = view[index];
    if (entry === undefined) continue;
    let renders = true;
    if (showCallRenders(entry, results)) {
      const prev = view[index - 1];
      if (prev !== undefined && showCallRenders(prev, results)) renders = false;
    } else if (entry.kind === "text") {
      const card = carryoverCards.get(entry.messageId);
      if (card !== undefined && entry.key !== card.firstKey) renders = false;
    } else if (entry.kind === "channelMark") {
      const fromParent = ownSide === "child" && entry.mark.from === "parent";
      const fromChild = ownSide === "parent" && entry.mark.from === "child" && entry.mark.kind !== "progress";
      renders = fromParent || fromChild;
    }
    if (!renders && !branchRows.has(index)) continue;
    rows.push({ entry, index });
  }
  return rows;
}

/** 条目（含折叠成员）里出现的消息 id：引用跳转要按消息 id 找它所在的行 */
function messageIdsOf(entry: TurnViewEntry): string[] {
  switch (entry.kind) {
    case "user":
      return [entry.item.id];
    case "text":
    case "thinking":
    case "toolCall":
      return [entry.messageId];
    case "toolGroup":
      return entry.calls.map((call) => call.messageId);
    case "turnGroup":
      return entry.members.flatMap(messageIdsOf);
    case "turnProcess":
      return entry.steps.flatMap(messageIdsOf);
    case "compacted":
    case "fileTurn":
    case "revertMark":
    case "intentRecall":
      return [entry.record.id];
    case "channelMark":
      return [entry.mark.messageId];
    default:
      return [];
  }
}

/** 虚拟行 key → 虚拟行下标（`scrollToIndex` / 前插锚点按 key 找位置） */
export function rowIndexByKey(rows: readonly VirtualHistoryRow[]): Map<string, number> {
  const map = new Map<string, number>();
  rows.forEach((row, index) => map.set(row.entry.key, index));
  return map;
}

/** 消息 id → 虚拟行下标（同一消息占多行时取最后一行，与分支锚点口径一致） */
export function messageRowIndex(rows: readonly VirtualHistoryRow[]): Map<string, number> {
  const map = new Map<string, number>();
  rows.forEach((row, index) => {
    for (const id of messageIdsOf(row.entry)) map.set(id, index);
  });
  return map;
}

/** 历史段视图下标 → 虚拟行下标（回退预演切点按视图下标算） */
export function viewRowIndex(rows: readonly VirtualHistoryRow[]): Map<number, number> {
  const map = new Map<number, number>();
  rows.forEach((row, index) => map.set(row.index, index));
  return map;
}

/**
 * 前插锚点的目标 scrollTop：同一 key 在 prepend 后的新 start，减去触发时它相对
 * 视口顶部的偏移。`offsetTop` 是「行顶 − scrollTop」，因此目标 = 新行顶 − 旧偏移。
 * 缺失 / 非有限值返回 null（调用方退回几何差兜底）。
 */
export function prependAnchorTarget(start: number | undefined, offsetTop: number): number | null {
  if (start === undefined || !Number.isFinite(start) || !Number.isFinite(offsetTop)) return null;
  return Math.max(0, start - offsetTop);
}

export interface HeightCache {
  get(key: string): number | undefined;
  set(key: string, height: number): void;
  readonly size: number;
  clear(): void;
}

/**
 * 按行 key 的高度缓存（LRU）：`@tanstack/react-virtual` 自己的 measurements 在
 * 行数组重建 / StrictMode 重挂 / 会话切换时会回到估值；这份缓存让重挂后的首帧
 * 就拿到真实高度，不闪不跳。上限默认 4000 条（与 ZCode 同量级）。
 */
export function createHeightCache(limit = 4000): HeightCache {
  const map = new Map<string, number>();
  return {
    get(key) {
      const value = map.get(key);
      if (value === undefined) return undefined;
      // 命中即移到队尾：Map 的插入序就是 LRU 序
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, height) {
      map.delete(key);
      map.set(key, height);
      while (map.size > limit) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    get size() {
      return map.size;
    },
    clear() {
      map.clear();
    },
  };
}
