/**
 * 句中 chip 的纯逻辑——token（`/skill:<slug>`、`/mcp:<server>`）在输入框与气泡里
 * 的视觉包装。
 *
 * 方案 D（选型报告 §3-D，2026-10-06）：保留 textarea，token 就是普通文本，
 * 镜像层（原 copybook 修正液的镜像，现全主题常驻）把 token 区间画成 chip。
 * chip 只是视觉，**存储、草稿、发送、撤销全是同一份字符串**——这里不做任何
 * 文本改写，只算区间。
 *
 * **token 识别复用发送端的 `findInvocationTokens`**（src/shared/invocation.ts）：
 * 发送时会组装指令块的边界（`/` 前是行首或空白、target 到下一个空白）就是 chip
 * 的边界——输入框里画成 chip 的，发送时必然被当 token 认；两边各写一条规则就会
 * 出现「看着是 chip、发出去是散文」的裂缝。
 */

import { findInvocationTokens } from "../../../shared/invocation.ts";
import type { WhiteoutSegment } from "./whiteout-segments.ts";

/** token 种类：skill 读文件，mcp 用工具（与 InvocationKind 同一集合） */
export type ChipKind = "skill" | "mcp";

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
 * 把修正液分段按 chip 边界再切一刀，再按粘贴展开段切一刀。**chip 优先于两层**：
 * 小学作业主题里 token 本来是英文段（会垫修正液），chip 自己的 pill 已经盖住竖格线，
 * 再垫一层白底只会把 chip 画没；展开段里手打了 token 的形状时同理——chip 是更强的
 * 视觉，先切。非 copybook 主题传 `[{ text, whiteout: false }]` 进来（只切 chip 与段）。
 */
export function mirrorSegments(
  segments: readonly WhiteoutSegment[],
  /** 画成胶囊的区间（skill / mcp 的 token 与收起的粘贴 token）；kind 缺省 =
   *  中性胶囊（粘贴 token）——上色量入，区间与边界仍是发送端的事 */
  chips: readonly { start: number; end: number; kind?: ChipKind | null }[],
  pasteRuns: readonly { start: number; end: number }[] = [],
): MirrorSegment[] {
  const out: MirrorSegment[] = [];
  let offset = 0;
  for (const segment of segments) {
    let from = 0;
    for (const span of [
      ...chips.map((chip) => ({ start: chip.start, end: chip.end, chip: true, kind: chip.kind ?? null })),
      ...pasteRuns.map((run) => ({ start: run.start, end: run.end, chip: false, kind: null })),
    ].sort((a, b) => a.start - b.start)) {
      const relStart = Math.max(span.start - offset, from);
      const relEnd = Math.min(span.end - offset, segment.text.length);
      // 与已切过的重叠（chip 与展开段交叠时，后切的让路）或空区间：跳过
      if (relEnd <= from || relStart >= relEnd) continue;
      if (relStart > from) {
        out.push({ text: segment.text.slice(from, relStart), whiteout: segment.whiteout, chip: false, pasteRun: false });
      }
      out.push({
        text: segment.text.slice(relStart, relEnd),
        whiteout: false,
        chip: span.chip,
        ...(span.chip && span.kind !== null ? { chipKind: span.kind } : {}),
        pasteRun: !span.chip,
      });
      from = relEnd;
    }
    if (from < segment.text.length) {
      out.push({ text: segment.text.slice(from), whiteout: segment.whiteout, chip: false, pasteRun: false });
    }
    offset += segment.text.length;
  }
  return out;
}
