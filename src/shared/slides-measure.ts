/**
 * 文字尺寸的**估算**（agent 进程没有 DOM，量不了真字体）：版式落元素与体检共用这一份。
 * CJK 字宽 ≈ 字号，拉丁 ≈ 0.55 字号（偏宽一点，宁可估高也不要装不下被裁）。
 * 真机上 6 套主题的实测对照见 slides-layouts.test.ts 之外的验收报告。
 */

const CJK_CHAR = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

export interface MeasureOptions {
  /** 行高倍数，缺省 1.25 */
  lineHeight?: number;
  /** 字距（px），每个字符多占这么宽 */
  letterSpacing?: number;
  /** 是否粗体（拉丁字更宽一点） */
  bold?: boolean;
}

/** 字号达到它的文字按「标题折行」排：word-break:keep-all（只在标点 / 空格处断行，实在放不下才硬断）+ text-wrap:balance。渲染层与估算共用这个阈值 */
export const HEADING_WRAP_MIN_SIZE = 36;

const DIGIT_LIKE = /[0-9%+$¥€.,]/;

/** 单个字符的显示宽度（px）：CJK = 字号；数字与 % + 等 ≈ 0.6（等宽数字比平均拉丁字母宽，大号统计数字实测会比 0.55 估的宽 8%）；其余拉丁 ≈ 0.55 */
function charWidth(ch: string, fontSize: number, bold: boolean): number {
  if (CJK_CHAR.test(ch)) return fontSize;
  if (DIGIT_LIKE.test(ch)) return fontSize * (bold ? 0.66 : 0.6);
  return fontSize * (bold ? 0.6 : 0.55);
}

/** 一行（不含换行）的显示宽度（px，不折行） */
export function textWidth(line: string, fontSize: number, options: MeasureOptions = {}): number {
  let used = 0;
  for (const ch of line) used += charWidth(ch, fontSize, options.bold === true) + (options.letterSpacing ?? 0);
  return used;
}

// keep-all 下的断行机会：标点之后、空格之后
const BREAK_AFTER = /[，。、；：！？）》」』”’,.;:!?)\]\s—–-]/;

/** 把一行切成「不可再分」的片段（keep-all：只在标点 / 空格之后断） */
function segmentsOf(line: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of line) {
    current += ch;
    if (BREAK_AFTER.test(ch)) {
      out.push(current);
      current = "";
    }
  }
  if (current !== "") out.push(current);
  return out;
}

/** 一段文字（可含 \n）折行后的行数 */
export function countLines(plain: string, fontSize: number, width: number, options: MeasureOptions = {}): number {
  const usable = Math.max(width, fontSize);
  const extra = options.letterSpacing ?? 0;
  const step = (ch: string): number => charWidth(ch, fontSize, options.bold === true) + extra;
  const keepAll = fontSize >= HEADING_WRAP_MIN_SIZE;
  let lines = 0;
  for (const line of plain.split("\n")) {
    let used = 0;
    let count = 1;
    // 非 keep-all 时每个字符就是一个片段（任意处可断）
    const pieces = keepAll ? segmentsOf(line) : Array.from(line);
    for (const piece of pieces) {
      let width_ = 0;
      for (const ch of piece) width_ += step(ch);
      if (used + width_ <= usable) {
        used += width_;
        continue;
      }
      if (width_ <= usable) {
        // 整段挪到下一行
        count += 1;
        used = width_;
        continue;
      }
      // 片段本身比一行还宽：先另起一行，再硬断（overflow-wrap:anywhere 只在整段放不下一整行时才硬断）
      if (used > 0) {
        count += 1;
        used = 0;
      }
      for (const ch of piece) {
        const w = step(ch);
        if (used + w > usable) {
          count += 1;
          used = w;
        } else used += w;
      }
    }
    lines += count;
  }
  return lines;
}

/** 文字在宽 width 的框里要多高（px） */
export function estimateTextHeight(plain: string, fontSize: number, width: number, options: MeasureOptions = {}): number {
  return countLines(plain, fontSize, width, options) * fontSize * (options.lineHeight ?? 1.25);
}

/** 列表：每项各自折行；ul 的缩进约 1.3em；项间距 gap */
export function estimateListHeight(items: readonly string[], fontSize: number, width: number, gap: number, options: MeasureOptions = {}): number {
  const inner = Math.max(width - fontSize * 1.3, fontSize);
  const lineHeight = options.lineHeight ?? 1.25;
  const lines = items.reduce((sum, item) => sum + countLines(item, fontSize, inner, options), 0);
  return lines * fontSize * lineHeight + Math.max(items.length - 1, 0) * gap;
}

/** 「字数」：CJK 算 1，拉丁字母 / 数字算 0.5（工具描述里的「标题 ≤ 16 字」按它数） */
export function visualLength(text: string): number {
  let n = 0;
  for (const ch of text) n += CJK_CHAR.test(ch) ? 1 : ch === " " ? 0.4 : 0.5;
  return n;
}
