/**
 * 句中 chip 的纯逻辑——token（`/skill:<slug>`）在输入框与气泡里的视觉包装。
 *
 * 方案 D（选型报告 §3-D，2026-10-06）：保留 textarea，token 就是普通文本，
 * 镜像层（原 copybook 修正液的镜像，现全主题常驻）把 token 区间画成 chip。
 * chip 只是视觉，**存储、草稿、发送、撤销全是同一份字符串**——这里不做任何
 * 文本改写，只算区间。
 *
 * **token 识别复用发送端的 `findSkillTokens`**（src/shared/skill.ts）：发送时会
 * 展开 / 保留的边界（`/` 前是行首或空白、target 到下一个空白）就是 chip 的边界
 * ——输入框里画成 chip 的，发送时必然被当 token 认；两边各写一条规则就会出现
 * 「看着是 chip、发出去是散文」的裂缝。`/mcp:` 等 token 种类等发送语义 PR
 * （#148）导出自己的查找函数后再并入 `parseChips`，不在这一层另写正则。
 */

import { findSkillTokens } from "../../../shared/skill.ts";
import type { WhiteoutSegment } from "./whiteout-segments.ts";

/** token 种类。目前只有 skill；`/mcp:<server>` 由 #148 定义发送语义后加入 */
export type ChipKind = "skill";

/** 原文里的一个 chip：[start, end) 按 UTF-16 下标，与 textarea 的 selectionStart 同一套 */
export interface ChipSpan {
  start: number;
  end: number;
  kind: ChipKind;
  /** `/skill:` 与下一个空白之间的 target（含粘连的标点——findSkillTokens 的语义） */
  target: string;
}

/** 超过这个长度不再解析 chip（与 WHITEOUT_MAX_LENGTH 同一理由：每次按键重扫，
 * 粘一大段日志的代价是实打实的卡顿，换来的只是装饰） */
export const CHIPS_MAX_LENGTH = 20_000;

/** 扫出原文里全部 chip 区间（就是 findSkillTokens 的区间，换成 chip 的形状） */
export function parseChips(text: string): ChipSpan[] {
  if (text === "" || text.length > CHIPS_MAX_LENGTH) return [];
  return findSkillTokens(text).map((token) => ({
    start: token.start,
    end: token.end,
    kind: "skill",
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

/** 镜像层的渲染分段：修正液与 chip 两层区间叠在同一份文本上 */
export interface MirrorSegment {
  text: string;
  whiteout: boolean;
  chip: boolean;
}

/**
 * 把修正液分段按 chip 边界再切一刀。**chip 区间优先于修正液**：小学作业主题里
 * token 本来是英文段（会垫修正液），chip 自己的 pill 已经盖住竖格线，再垫一层
 * 白底只会把 chip 画没。非 copybook 主题传 `[{ text, whiteout: false }]` 进来
 * （只切 chip）。
 */
export function mirrorSegments(
  segments: readonly WhiteoutSegment[],
  chips: readonly ChipSpan[],
): MirrorSegment[] {
  const out: MirrorSegment[] = [];
  let offset = 0;
  for (const segment of segments) {
    let from = 0;
    for (const chip of chips) {
      const relStart = Math.max(chip.start - offset, 0);
      const relEnd = Math.min(chip.end - offset, segment.text.length);
      if (relStart >= relEnd) continue;
      if (relStart > from) {
        out.push({ text: segment.text.slice(from, relStart), whiteout: segment.whiteout, chip: false });
      }
      out.push({ text: segment.text.slice(relStart, relEnd), whiteout: false, chip: true });
      from = relEnd;
    }
    if (from < segment.text.length) {
      out.push({ text: segment.text.slice(from), whiteout: segment.whiteout, chip: false });
    }
    offset += segment.text.length;
  }
  return out;
}
