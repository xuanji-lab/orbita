/**
 * 句中 chip 的纯逻辑——token（`/skill:<slug>`、`/mcp:<server>`、`/plugin:<name>`）在输入框与气泡里
 * 的视觉包装。
 *
 * 方案 D（选型报告 §3-D，2026-10-06）：保留 textarea，token 就是普通文本，
 * 镜像层（原 copybook 修正液的镜像，现全主题常驻）把 token 区间画成 chip。
 * chip 只是视觉，**存储、草稿、发送、撤销全是同一份字符串**——这里不做任何
 * 文本改写，只算区间。
 *
 * 2026-10-30 起 chip 画成胶囊（图标 + 名字 + ×，前缀不显示）：textarea 的字透明、
 * 全部的字由镜像层画，token 原文在两层里照样占位（排版逐像素一致，光标与选区
 * 对得上），胶囊盖在原文自己的格子上。于是原文里 chip 中间的位置在屏幕上不存在了——
 * 光标与选区的端点要吸到 chip 的边上（snapSelection），× 删整颗（chipRemovalRange）。
 *
 * **token 识别复用发送端的 `findInvocationTokens`**（src/shared/invocation.ts）：
 * 发送时会组装指令块的边界（`/` 前是行首或空白、target 到下一个空白）就是 chip
 * 的边界——输入框里画成 chip 的，发送时必然被当 token 认；两边各写一条规则就会
 * 出现「看着是 chip、发出去是散文」的裂缝。
 */

import { findInvocationTokens } from "../../../shared/invocation.ts";
import { FEATURE_ICON } from "./feature-icons.ts";
import type { IconName } from "./Icon.tsx";
import type { WhiteoutSegment } from "./whiteout-segments.ts";

/** token 种类：skill 读文件，mcp 用工具，plugin 是整个插件（与 InvocationKind 同一集合） */
export type ChipKind = "skill" | "mcp" | "plugin";

/** chip 的类别图标：技能是书、MCP 是插头、插件是积木（与插件页头像同一套词汇）。输入框与气泡共用。 */
export function chipIconName(kind: ChipKind): IconName {
  return kind === "mcp" ? "plug" : kind === "plugin" ? FEATURE_ICON.plugins : "book-open";
}

/** 原文里的一个 chip：[start, end) 按 UTF-16 下标，与 textarea 的 selectionStart 同一套 */
export interface ChipSpan {
  start: number;
  end: number;
  kind: ChipKind;
  /** 冒号与下一个空白之间的 target（含粘连的标点——findInvocationTokens 的语义） */
  target: string;
}

/** 超过这个长度不再解析 chip（与 WHITEOUT_MAX_LENGTH 同一理由：每次按键重扫，
 * 粘一大段日志的代价是实打实的卡顿，换来的只是装饰） */
export const CHIPS_MAX_LENGTH = 20_000;

/** 扫出原文里全部 chip 区间（就是 findInvocationTokens 的区间，换成 chip 的形状） */
export function parseChips(text: string): ChipSpan[] {
  if (text === "" || text.length > CHIPS_MAX_LENGTH) return [];
  return findInvocationTokens(text).map((token) => ({
    start: token.start,
    end: token.end,
    kind: token.kind,
    target: token.target,
  }));
}

/**
 * Backspace 的整删判定：光标正贴在 chip **尾**上时返回整个 chip——一次退格整块删。
 * 光标在 chip 中间（点进去的）不整删：那是普通的逐字编辑。
 */
export function chipRangeBefore(text: string, caret: number): ChipSpan | null {
  return parseChips(text).find((chip) => chip.end === caret) ?? null;
}

/**
 * Delete 的整删判定：光标正贴在 chip **头**上时返回整个 chip——前向整块删。
 */
export function chipRangeAfter(text: string, caret: number): ChipSpan | null {
  return parseChips(text).find((chip) => chip.start === caret) ?? null;
}

/**
 * 光标 / 选区（textarea 的 selectionStart / selectionEnd 口径）。
 */
export interface TextSelection {
  start: number;
  end: number;
}

/** chip 「严格包含」这个位置（两端不算——停在 chip 头 / 尾是合法的光标位） */
function chipAround(chips: readonly ChipSpan[], position: number): ChipSpan | undefined {
  return chips.find((chip) => chip.start < position && position < chip.end);
}

/**
 * 选区的端点不许停在 chip 中间：胶囊只显示名字，原文里 `/skill:` 那几个位置在屏幕上
 * 没有对应的地方，光标停进去就是「看不见的光标」，打的字还会把 token 拆碎。
 *
 * - prev = 上一次的选区，键盘移动（←→ / Shift+←→ / ↑↓ / 按词跳）时给，用来判方向：
 *   光标从左边进来就跨到右边，从右边进来就跨到左边——一步跨过整颗；
 *   扩选时端点进了 chip 就把整颗选上，缩选时端点退进 chip 就整颗让出去。
 * - prev = null：指针（点击、拖选、双击），没有方向——光标落到最近的一边，
 *   选区的端点一律向外扩（点进胶囊 / 双击胶囊 = 选中整颗）。
 *
 * 不在 chip 中间的端点原样返回；没有 chip 时原样返回。
 */
export function snapSelection(
  chips: readonly ChipSpan[],
  next: TextSelection,
  prev: TextSelection | null,
): TextSelection {
  if (chips.length === 0) return next;
  if (next.start === next.end) {
    const chip = chipAround(chips, next.start);
    if (chip === undefined) return next;
    // 方向看上一次光标所在（折叠选区的 end 就是光标）：从左来去右、从右来去左
    const from = prev === null ? null : prev.end;
    const edge =
      from !== null && from <= chip.start
        ? chip.end
        : from !== null && from >= chip.end
          ? chip.start
          : next.start - chip.start < chip.end - next.start
            ? chip.start
            : chip.end;
    return { start: edge, end: edge };
  }
  let { start, end } = next;
  const startChip = chipAround(chips, start);
  if (startChip !== undefined) {
    // 起点从左边退进来（原先盖着这颗）= 缩选：整颗让出去；否则（扩选 / 指针）整颗选上
    start = prev !== null && prev.start <= startChip.start ? startChip.end : startChip.start;
  }
  const endChip = chipAround(chips, end);
  if (endChip !== undefined) {
    end = prev !== null && prev.end >= endChip.end ? endChip.start : endChip.end;
  }
  return start <= end ? { start, end } : { start: end, end: end };
}

/** 「空白」的口径：空格、制表、全角空格（token 的边界允许的那几种，换行除外） */
function isInlineSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\u3000";
}

/**
 * 点胶囊的 × 删掉的区间：整颗 token，连带它后面的一个空格（插入 token 时自带的那个）；
 * 后面没有空格（句末 / 换行前）就带走前面的一个——删完不留双空格，也不留行尾空格。
 * 退格整删（chipRangeBefore）只删 token 本身：光标就在 token 尾，多吃一个空格反而意外。
 */
export function chipRemovalRange(text: string, chip: { start: number; end: number }): TextSelection {
  if (isInlineSpace(text[chip.end])) return { start: chip.start, end: chip.end + 1 };
  if (chip.start > 0 && isInlineSpace(text[chip.start - 1])) return { start: chip.start - 1, end: chip.end };
  return { start: chip.start, end: chip.end };
}

/** 镜像层的渲染分段：修正液、chip 与粘贴展开段三层区间叠在同一份文本上 */
export interface MirrorSegment {
  text: string;
  whiteout: boolean;
  chip: boolean;
  /** chip 的类别（skill / mcp）——按类别上色用（2026-10 用户裁决：skill 绿、
   *  MCP 蓝）。粘贴 token 的 chip是中性的，不带这个字段，落回默认配方 */
  chipKind?: ChipKind;
  /** 粘贴块的展开段：只铺浅底色（方案 C），文字与正文同字体可直接编辑 */
  pasteRun: boolean;
}

/**
 * 把文本切成镜像层的段：先切出 chip（**整颗，不跨段切**——胶囊盖在整颗 token 的格子上，
 * 切成两截就成了两颗胶囊），chip 之外的空隙再按粘贴展开段、修正液依次切。
 *
 * **chip 优先于两层**：小学作业主题里 token 本来是英文段（会垫修正液），chip 自己的
 * 胶囊已经盖住竖格线，再垫一层白底只会把 chip 画没；展开段里手打了 token 的形状时
 * 同理——chip 是更强的视觉，展开段在它两边让路。chip 之间交叠时先来的留下（parseChips
 * 给的本来不交叠）。非 copybook 主题传 `[{ text, whiteout: false }]` 进来（只切 chip 与段）。
 */
export function mirrorSegments(
  segments: readonly WhiteoutSegment[],
  /** 画成胶囊的区间（skill / mcp 的 token 与收起的粘贴 token）；kind 缺省 =
   *  中性胶囊（粘贴 token）——上色量入，区间与边界仍是发送端的事 */
  chips: readonly { start: number; end: number; kind?: ChipKind | null }[],
  pasteRuns: readonly { start: number; end: number }[] = [],
): MirrorSegment[] {
  const text = segments.map((segment) => segment.text).join("");
  const atoms: { start: number; end: number; kind: ChipKind | null }[] = [];
  for (const chip of [...chips].sort((a, b) => a.start - b.start)) {
    const start = Math.max(chip.start, 0);
    const end = Math.min(chip.end, text.length);
    const last = atoms[atoms.length - 1];
    if (end <= start || (last !== undefined && start < last.end)) continue;
    atoms.push({ start, end, kind: chip.kind ?? null });
  }
  const runs = [...pasteRuns].sort((a, b) => a.start - b.start);
  const out: MirrorSegment[] = [];
  /** 修正液分段落在 [from, to) 里的部分（不是 chip、不是展开段的普通字） */
  const pushPlain = (from: number, to: number): void => {
    let offset = 0;
    for (const segment of segments) {
      const segStart = offset;
      const segEnd = offset + segment.text.length;
      offset = segEnd;
      const start = Math.max(from, segStart);
      const end = Math.min(to, segEnd);
      if (end <= start) continue;
      out.push({ text: text.slice(start, end), whiteout: segment.whiteout, chip: false, pasteRun: false });
    }
  };
  /** chip 之间的空隙：展开段铺底，其余落回修正液分段 */
  const pushGap = (from: number, to: number): void => {
    let cursor = from;
    for (const run of runs) {
      const start = Math.max(run.start, cursor);
      const end = Math.min(run.end, to);
      if (end <= start) continue;
      if (start > cursor) pushPlain(cursor, start);
      out.push({ text: text.slice(start, end), whiteout: false, chip: false, pasteRun: true });
      cursor = end;
    }
    if (cursor < to) pushPlain(cursor, to);
  };
  let cursor = 0;
  for (const atom of atoms) {
    if (atom.start > cursor) pushGap(cursor, atom.start);
    out.push({
      text: text.slice(atom.start, atom.end),
      whiteout: false,
      chip: true,
      ...(atom.kind !== null ? { chipKind: atom.kind } : {}),
      pasteRun: false,
    });
    cursor = atom.end;
  }
  if (cursor < text.length) pushGap(cursor, text.length);
  return out;
}
