/**
 * TeX 源码里的公式区间（**纯逻辑**，`node --test` 覆盖）：鼠标停在公式上时，
 * 编辑器要交出「这一段原文 + 它在文里的位置」给 KaTeX。
 *
 * 认四种定界符（与 LaTeX 自己的写入习惯一致）：
 *   `$...$`、`$$...$$`、`\(...\)`、`\[...\]`
 *
 * 三条决定：
 * - **注释里不算**：`% $x$` 里的 `$` 不是公式（复用 tex-text.ts 的注释语义：`%`
 *   前面有奇数个反斜杠才是转义，`\%` 是字面量）。
 * - **未闭合不命中**：一个打了一半的 `$` 不返回任何区间——这正是「打字时别疯狂弹错」
 *   的源头。行内 `$...$` / `\(...\)` 必须在同一行闭合（LaTeX 允许跨行，但作者很少这么写，
 *   而一只漏写的 `$` 若去全文找闭合，会把后面几十行吞进一个「公式」）；`$$...$$` 与
 *   `\[...\]` 是块级写法，允许跨行，但搜索有上限（`MAX_DISPLAY_CHARS`）。
 * - **转义不算**：`\$5` 是美元符号，`\\(` 是换行命令 `\\` 后跟一个括号，都不是定界符。
 *
 * 跳过两类「$ 不是数学」的区域：`verbatim` / `Verbatim` / `lstlisting` / `minted` /
 * `comment` 环境，以及行内 `\verb|...|`。它们里面的字面量不该被当成公式。
 *
 * 这个模块**不 import katex**：渲染是接线层（latex-math-hover.ts）的事。纯逻辑要能
 * 在 `node --test` 里直接加载，KaTeX 的 CSS 一进来就加载不了。
 */

/** 一段公式：`[from, to)` 是文档内区间（含定界符），`body` 是交给 KaTeX 的公式体 */
export interface TexMathRange {
  /** 起始下标（含，指向开定界符的第一个字符） */
  from: number;
  /** 结束下标（不含，紧跟闭定界符之后） */
  to: number;
  /** 原文（含定界符），浮层出错时可以原样显示 */
  text: string;
  /** 去掉定界符的公式体 */
  body: string;
  /** 块级写法（`$$…$$` / `\[…\]`）：KaTeX 用 displayMode */
  display: boolean;
}

/** 块级公式最多往后找多远（字符）：漏写的 `\[` 不该去吞下一章 */
const MAX_DISPLAY_CHARS = 8000;

/** 这些环境里的内容不是数学；按出现顺序匹配，找到就整块跳过 */
const VERBATIM_ENVS = ["verbatim", "verbatim*", "Verbatim", "Verbatim*", "lstlisting", "minted", "comment"];

/** `text[index]` 前是否有奇数个反斜杠（即这个字符被转义了） */
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/** 从 `from` 起找未转义的 `needle`；找不到返回 -1 */
function indexOfUnescaped(text: string, needle: string, from: number, limit: number): number {
  let at = text.indexOf(needle, from);
  while (at !== -1 && at <= limit) {
    if (!isEscaped(text, at)) return at;
    at = text.indexOf(needle, at + 1);
  }
  return -1;
}

/** 一种定界符的闭合位置（闭定界符的起点）；找不到时 -1 */
function closeOf(text: string, open: number, close: string, limit: number): number {
  const at = indexOfUnescaped(text, close, open, limit);
  return at === -1 || at > limit ? -1 : at;
}

/** 扫全文，按出现顺序给出所有公式区间（不含注释 / 字面量环境里的） */
export function scanTexMath(text: string): TexMathRange[] {
  const out: TexMathRange[] = [];
  const length = text.length;
  let i = 0;

  const push = (from: number, to: number, bodyFrom: number, bodyTo: number, display: boolean): void => {
    out.push({ from, to, text: text.slice(from, to), body: text.slice(bodyFrom, bodyTo), display });
  };

  while (i < length) {
    const ch = text[i];

    if (ch === "%") {
      if (isEscaped(text, i)) {
        i += 1;
        continue;
      }
      const newline = text.indexOf("\n", i);
      i = newline === -1 ? length : newline + 1;
      continue;
    }

    if (ch === "\\") {
      // `\\` 是换行命令：跳过它，紧跟的 `[2pt]` 是可选参数，不是 `\[` 定界符
      if (text[i + 1] === "\\") {
        i += 2;
        continue;
      }
      // `\verb|…|` / `\verb*|…|`：字面量，跳到同一定界符
      const verb = /^\\verb\*?([^A-Za-z\s])/.exec(text.slice(i, i + 8));
      if (verb !== null && verb[1] !== undefined) {
        const close = text.indexOf(verb[1], i + verb[0].length);
        i = close === -1 ? length : close + 1;
        continue;
      }
      // 字面量环境：整块跳到最后
      const begin = /^\\begin\s*\{([A-Za-z*]+)\}/.exec(text.slice(i, i + 32));
      if (begin !== null && VERBATIM_ENVS.includes(begin[1] ?? "")) {
        const end = text.indexOf(`\\end{${begin[1]}}`, i + begin[0].length);
        i = end === -1 ? length : end + `\\end{${begin[1]}}`.length;
        continue;
      }
      const next = text[i + 1];
      if (next === "(") {
        // 行内 `\(…\)` 与 `$…$` 同样只在同一行闭合（理由见文件头）
        const lineEnd = text.indexOf("\n", i) === -1 ? length : text.indexOf("\n", i);
        const close = closeOf(text, i + 2, "\\)", lineEnd);
        if (close !== -1) {
          push(i, close + 2, i + 2, close, false);
          i = close + 2;
        } else {
          i += 2;
        }
        continue;
      }
      if (next === "[") {
        const limit = Math.min(length, i + 2 + MAX_DISPLAY_CHARS);
        const close = closeOf(text, i + 2, "\\]", limit);
        if (close !== -1) {
          push(i, close + 2, i + 2, close, true);
          i = close + 2;
        } else {
          i += 2;
        }
        continue;
      }
      i += 2;
      continue;
    }

    if (ch === "$") {
      if (text[i + 1] === "$") {
        const limit = Math.min(length, i + 2 + MAX_DISPLAY_CHARS);
        const close = closeOf(text, i + 2, "$$", limit);
        if (close !== -1 && text.slice(i + 2, close).trim() !== "") {
          push(i, close + 2, i + 2, close, true);
          i = close + 2;
        } else {
          i += 2;
        }
        continue;
      }
      // 行内 `$…$`：必须在同一行闭合（漏写的 `$` 不许吞掉后面几十行）
      const newline = text.indexOf("\n", i);
      const lineEnd = newline === -1 ? length : newline;
      const close = closeOf(text, i + 1, "$", lineEnd);
      if (close !== -1 && text.slice(i + 1, close).trim() !== "") {
        push(i, close + 1, i + 1, close, false);
        i = close + 1;
      } else {
        i += 1;
      }
      continue;
    }

    i += 1;
  }

  return out;
}

/**
 * 命中 `position` 的公式（`[from, to)` 语义：落在开定界符上算命中，落在闭定界符之后不算）。
 * 没有命中返回 null——浮层据此安静地不出现。
 */
export function findTexMath(text: string, position: number): TexMathRange | null {
  const ranges = scanTexMath(text);
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid];
    if (range === undefined) return null;
    if (position < range.from) high = mid - 1;
    else if (position >= range.to) low = mid + 1;
    else return range;
  }
  return null;
}
