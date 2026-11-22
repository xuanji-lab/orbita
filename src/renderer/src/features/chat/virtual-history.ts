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

/**
 * 历史段未测行的典型行高。**不是一屏高**：L3a 用滚动容器 `clientHeight`（实测
 * 581px）估未测行，滚动时逐行换成真实高度，`scrollHeight` 一路收缩、Layout 跟着
 * 抖（B2 卡帧 32/38 含 Layout）。实测 86 MB fixture 三页 190 行，平均真实行高
 * 236px（首屏 36 行 238px）；取 230 略低一档——宁可让总高估大一点，也别让视口
 * 上方的未测行在滚动中把内容高度往下拉。
 */
export const DEFAULT_ROW_ESTIMATE = 230;

/**
 * 未测行估值的上下界：32 以下会把总高估得太短（滚动条与 scrollHeight 一起抖），
 * 1200 以上会让程序化跳转的落点偏太多；更大的行长靠实测，不靠猜。实测最小行
 * 38px（revertMark），工具/压缩/折叠行 62–81px——下限取 80 会把这类行抬贵。
 */
export const MIN_ROW_ESTIMATE = 32;
export const MAX_ROW_ESTIMATE = 1200;

/** 把估值夹进合理范围；非有限值回退典型初值（测量失败不该把总高变成 0）。 */
export function clampRowEstimate(height: number): number {
  if (!Number.isFinite(height)) return DEFAULT_ROW_ESTIMATE;
  return Math.min(MAX_ROW_ESTIMATE, Math.max(MIN_ROW_ESTIMATE, Math.round(height)));
}

/**
 * 按行 kind 的初始估值——实测 86 MB fixture 三页 190 行：text 804、toolCall 234、
 * user 122、turnProcess 69、fileTurn 62、compacted 81、revertMark 38；没采到的
 * toolGroup / turnGroup / thinking / channelMark / intentRecall 按折叠卡量级取
 * 80–120。
 *
 * 这些只是先验，不是硬编码结论：每类收到实测后由 EMA（`factor`）校准，换会话 /
 * 换字号会自己跟过去；没有样本的种类才一直用它。
 */
export const ROW_KIND_ESTIMATES: Readonly<Record<string, number>> = {
  user: 120,
  text: 800,
  thinking: 90,
  toolCall: 230,
  toolGroup: 90,
  turnGroup: 90,
  turnProcess: 69,
  fileTurn: 62,
  compacted: 81,
  revertMark: 38,
  intentRecall: 120,
  channelMark: 80,
};

export interface RowHeightEstimator {
  /** 记一次实测行高；`kind` 让同类行单独积累估计（null / 未知走全局） */
  push(kind: string | null, height: number): void;
  /** 该类行的估值（已夹取）；该类还没有样本时用它的先验（未知种类回退全局值） */
  value(kind: string | null): number;
  /** 全局典型值（全部样本的滑动均值），给未知种类兜底 */
  readonly typical: number;
}

/**
 * 在线典型行高：全局 + 按 `kind` 各一份滑动均值（EMA），样本值先夹进合理范围。
 *
 * 为什么用滑动均值而不是中位数：虚拟器的总高是各行之和，要贴近的是**均值**。
 * 实测该会话 133 行：全体均值 224（初值 230 刚好），但中位数只有 81——长回答
 * （text 均值 752，占 58% 总高）会把中位数带偏，用它估未测行会让总高系统性偏短，
 * 滚动时反而向上长高。
 *
 * 为什么还要按 kind：同一均值 224 下，text 752、toolCall 221、user 129、
 * turnProcess 69、fileTurn 62——单值让每行都差几百 px，滚动测高时逐行补偿就把
 * 视口拉走。按 kind 分开后，每类从 `ROW_KIND_ESTIMATES` 的先验起步，收到实测
 * 再按 EMA 收敛；未知种类用全局典型值。
 *
 * `factor` 是 EMA 的步长：单次样本只走 5%，避免首屏恰好挂上一张超大卡片就把
 * 所有未测行抬到上限。只在 ref 里更新，不触发 React 渲染；下一次虚拟器测高本来
 * 就会重算测量缓存。
 */
export function createRowHeightEstimator(
  options: { initial?: number; factor?: number; kindInitial?: Readonly<Record<string, number>> } = {},
): RowHeightEstimator {
  const initial = clampRowEstimate(options.initial ?? DEFAULT_ROW_ESTIMATE);
  const factor = Math.min(0.5, Math.max(0.01, options.factor ?? 0.05));
  const kindInitial = options.kindInitial ?? ROW_KIND_ESTIMATES;
  let typical = initial;
  const byKind = new Map<string, number>();
  return {
    push(kind, height) {
      if (!Number.isFinite(height) || height <= 0) return;
      // 单次样本先夹进合理范围：展开到几万 px 的一张卡不该把整段估值拖走
      const sample = clampRowEstimate(height);
      const key = kind ?? "";
      const seed = kind === null ? undefined : kindInitial[key];
      const current = byKind.get(key) ?? (seed === undefined ? typical : clampRowEstimate(seed));
      byKind.set(key, current + (sample - current) * factor);
      typical += (sample - typical) * factor;
    },
    value(kind) {
      const key = kind ?? "";
      const own = byKind.get(key);
      if (own !== undefined) return clampRowEstimate(own);
      const seed = kind === null ? undefined : kindInitial[key];
      return seed === undefined ? clampRowEstimate(typical) : clampRowEstimate(seed);
    },
    get typical() {
      return clampRowEstimate(typical);
    },
  };
}

/**
 * 未测行的估值：同一 key 有实测缓存就先用缓存（重挂 / 会话切回时首帧即真实高度），
 * 否则用该 kind 的在线估值（没有样本时用该类先验，未知种类用全局典型值）。缓存
 * 不做夹取——实测值就该是多少是多少。
 */
export function estimateRowHeight(
  key: string,
  kind: string | null,
  cache: Pick<HeightCache, "get">,
  estimator: Pick<RowHeightEstimator, "value">,
): number {
  return cache.get(key) ?? estimator.value(kind);
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
