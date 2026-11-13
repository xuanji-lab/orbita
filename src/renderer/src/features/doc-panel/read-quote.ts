/**
 * 阅读视图划选 → 源码区间。渲染出来的文字（没有 `**`、`[[ ]]`、`==`）要映射回 markdown 源码的偏移，
 * 引用才能给出「源码原文 + 行号」（agent 用 edit 逐字匹配）。纯函数，DOM 的部分在 useReadQuote。
 *
 * 做法：划选两端各落在一个带 `data-sl` / `data-el` 的块里（见 shared/ofm/rehype-source-lines.ts），
 * 块给出源码行范围；块内先在源码里找选中的文字——容忍夹在字之间的强调 / 高亮 / 代码标记（`**` `==` `` ` `` 等），
 * 找得到就精确到字，找不到（选区跨过了链接 / 双链语法）就退回整块的源码行。
 */
export interface BlockLines {
  sl: number;
  el: number;
}

/** 行号（1 起）→ 该行首的偏移 */
function lineFrom(text: string, line: number): number {
  let at = 0;
  for (let n = 1; n < line; n += 1) {
    const next = text.indexOf("\n", at);
    if (next === -1) return text.length;
    at = next + 1;
  }
  return at;
}

/** 行号 → 该行末（不含换行）的偏移 */
function lineTo(text: string, line: number): number {
  const from = lineFrom(text, line);
  const next = text.indexOf("\n", from);
  return next === -1 ? text.length : next;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
/** 渲染后不见了、但源码里夹在字之间的标记：强调 / 高亮 / 删除线 / 行内代码 / 空白（含换行与列表缩进） */
const BETWEEN = "[*_=~`\\s]*";

/** 在 `source` 里找渲染文字 `shown`（容忍字间标记）；返回 [from, to) 或 null。`last` = 取最后一处 */
function findShown(source: string, shown: string, last: boolean): { from: number; to: number } | null {
  const chars = [...shown.replace(/\s+/g, "")];
  if (chars.length === 0 || chars.length > 1500) return null;
  const pattern = new RegExp(chars.map((c) => c.replace(REGEX_SPECIAL, "\\$&")).join(BETWEEN), "gu");
  let found: { from: number; to: number } | null = null;
  for (let m = pattern.exec(source); m !== null; m = pattern.exec(source)) {
    found = { from: m.index, to: m.index + m[0].length };
    if (!last) break;
    if (m[0].length === 0) pattern.lastIndex += 1;
  }
  return found;
}

/** 跨块时每一端只拿选区首行 / 末行的这么多字去找（够唯一、又不容易撞上渲染差异） */
const EDGE = 40;

/**
 * `selected` 是浏览器给的选区文字（`Selection.toString()`）。返回源码里 [from, to)；空选区 / 越界 = null。
 */
export function sourceRangeOfSelection(
  text: string,
  start: BlockLines,
  end: BlockLines,
  selected: string,
): { from: number; to: number } | null {
  if (text === "" || selected.trim() === "") return null;
  const sFrom = lineFrom(text, start.sl);
  const sTo = lineTo(text, start.el);
  const eFrom = lineFrom(text, end.sl);
  const eTo = lineTo(text, end.el);
  if (sFrom > eTo) return null;
  const trimmed = selected.trim();

  if (start.sl === end.sl && start.el === end.el) {
    const slice = text.slice(sFrom, sTo);
    const hit = findShown(slice, trimmed, false);
    const from = hit === null ? sFrom : sFrom + hit.from;
    const to = hit === null ? sTo : sFrom + hit.to;
    return to > from ? { from, to } : null;
  }

  // 跨块：浏览器给的选区文字在块与块之间有换行。起点用第一行在起始块里找，终点用最后一行在结束块里找
  const rows = trimmed.split("\n").map((row) => row.trim()).filter((row) => row !== "");
  const head = [...(rows[0] ?? "")].slice(0, EDGE).join("");
  const tail = [...(rows[rows.length - 1] ?? "")].slice(-EDGE).join("");
  const headHit = findShown(text.slice(sFrom, sTo), head, false);
  const tailHit = findShown(text.slice(eFrom, eTo), tail, true);
  const from = headHit === null ? sFrom : sFrom + headHit.from;
  const to = tailHit === null ? eTo : eFrom + tailHit.to;
  return to > from ? { from, to } : null;
}

/** `.txt` 按空行切段，每段带它在文件里的起止行（划选引用用，同 data-sl / data-el 约定） */
export function plainParagraphs(text: string): { text: string; sl: number; el: number }[] {
  const out: { text: string; sl: number; el: number }[] = [];
  const newlines = (value: string): number => value.split("\n").length - 1;
  let line = 1;
  let last = 0;
  for (const gap of text.matchAll(/\n{2,}/g)) {
    const chunk = text.slice(last, gap.index);
    out.push({ text: chunk, sl: line, el: line + newlines(chunk) });
    line += newlines(chunk) + gap[0].length;
    last = gap.index + gap[0].length;
  }
  const rest = text.slice(last);
  out.push({ text: rest, sl: line, el: line + newlines(rest) });
  return out;
}
