/**
 * 附图的编号引用——「图 N」小签的文字契约。
 *
 * 用户在输入框里说「图一、图二」，图却是塞进去的：模型凭什么对得上？这里定死一条规矩：
 * 第 N 张附图（按附上的顺序，1 起）在正文里的写法是 `[图 N]`。输入框把它画成小签、
 * 气泡里同样画成小签，**发给模型的就是这行字面文本**，再在正文后面跟一行顺序说明
 * （`imageOrderNote`），模型按序号对图。
 *
 * 写法与语言无关（界面是英文也写 `[图 N]`）：它是发给模型的字符串，不是界面文案；
 * 小签上显示「图 1」还是「Image 1」由渲染侧按界面语言定。
 *
 * 纯函数、无依赖：renderer（输入框、气泡）与 agent 进程（拼发给模型的文字）共用同一份。
 */

/** 第 N 张图在正文里的写法 */
export function imageRefToken(n: number): string {
  return `[图 ${n}]`;
}

const IMAGE_REF = /\[图\s*(\d+)\]/g;

/** 正文里的一处图引用：[start, end) 按 UTF-16 下标（与 textarea 的 selectionStart 同一套） */
export interface ImageRefSpan {
  start: number;
  end: number;
  /** 序号（1 起） */
  n: number;
}

/**
 * 扫出正文里的图引用。`count` 给了就只认 1..count——没有对应附图的 `[图 7]`
 * 是用户自己写的字（比如粘贴来的论文段落），不画成小签。
 */
export function parseImageRefs(text: string, count?: number): ImageRefSpan[] {
  const out: ImageRefSpan[] = [];
  const pattern = new RegExp(IMAGE_REF.source, "g");
  let hit: RegExpExecArray | null;
  while ((hit = pattern.exec(text)) !== null) {
    const n = Number(hit[1]);
    if (n < 1 || (count !== undefined && n > count)) continue;
    out.push({ start: hit.index, end: hit.index + hit[0].length, n });
  }
  return out;
}

function isInlineSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\u3000";
}

/**
 * 在指定位置插入若干个行内小签（图 N、会话引用等共用）：落点是附上 / 松手那一刻的位置。
 * 与前后文字之间补空格（前面是字、后面是字才补；换行与已有空白不再补），
 * 小签之间用一个空格隔开；返回新正文与插入后的光标（落在末尾空格之后）。
 */
export function insertInlineTokens(
  text: string,
  caret: number,
  tokens: readonly string[],
): { text: string; caret: number } {
  if (tokens.length === 0) return { text, caret: clamp(caret, text.length) };
  const at = clamp(caret, text.length);
  const before = text[at - 1];
  const after = text[at];
  const lead = before !== undefined && before !== "\n" && !isInlineSpace(before) ? " " : "";
  const tail = after === undefined || (after !== "\n" && !isInlineSpace(after)) ? " " : "";
  const inserted = lead + tokens.join(" ") + tail;
  return { text: text.slice(0, at) + inserted + text.slice(at), caret: at + inserted.length };
}

/** 在光标处插入若干张图的引用（附图那一刻的落点：光标在哪，小签就在哪） */
export function insertImageRefs(
  text: string,
  caret: number,
  numbers: readonly number[],
): { text: string; caret: number } {
  return insertInlineTokens(text, caret, numbers.map(imageRefToken));
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(value, max));
}

/**
 * 删掉第 `removed` 张图之后的正文：它的引用整颗删掉（连带一个相邻空格，不留双空格），
 * 序号比它大的引用各减一——编号永远是「现在第几张」。其余文字一字不动。
 */
export function removeImageRef(text: string, removed: number): string {
  let out = "";
  let last = 0;
  for (const span of parseImageRefs(text)) {
    if (span.n < removed) continue;
    out += text.slice(last, span.start);
    last = span.end;
    if (span.n === removed) {
      // 后面有空格就带走后面的；否则带走前面的（已经写进 out 的那个）
      if (isInlineSpace(text[last])) last += 1;
      else if (isInlineSpace(out[out.length - 1])) out = out.slice(0, -1);
    } else {
      out += imageRefToken(span.n - 1);
    }
  }
  return out + text.slice(last);
}

/**
 * 发给模型的顺序说明：正文之后一行，点名每张图的序号。没有附图返回空串。
 * 句末的解释让模型知道正文里的 `[图 N]` 是什么——不靠它猜「图一」指谁。
 */
export function imageOrderNote(count: number): string {
  if (count <= 0) return "";
  const names = Array.from({ length: count }, (_, i) => `图 ${i + 1}`).join("、");
  return `（附图按顺序：${names}。正文里的 [图 N] 指第 N 张。）`;
}
