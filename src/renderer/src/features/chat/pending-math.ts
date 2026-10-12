/**
 * 流式 pending：模型正在打字时，尾部未闭合的 `$…` / `$$…` 会被 remark-math 判成
 * 「不是公式」而裸奔为纯文本；这里在 parse 前把闭合符补上，公式随流式逐字成形
 * （docs/plans/2026-09-04-数学公式渲染.md 决定 4）。
 *
 * 扫描器跳过三类假信号：代码围栏（``` / ~~~）、行内 code span、`\$` 转义——
 * 它们里面的 `$` 不是公式定界符。`$$` 打开时遇到单个 `$` 视作公式内容忽略。
 *
 * ponytail: 围栏只认行首 ≥3 个的 ` 或 ~，列表内缩进围栏、转义的围栏标记不管；
 * 真出现误判再加行上下文。
 */
export function closePendingMath(text: string): string {
  let openDelim: "$$" | "$" | null = null;
  let inFence = false;
  let fenceChar: "`" | "~" | null = null;
  let inCode = false;
  let codeLen = 0;
  let i = 0;
  let atLineStart = true;

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === "\n") {
      atLineStart = true;
      i += 1;
      continue;
    }

    if (inFence) {
      // 围栏内只认行首同字符 ≥3 连——那是闭合围栏
      if (atLineStart && (ch === "`" || ch === "~") && runOf(text, i) >= 3 && ch === fenceChar) {
        inFence = false;
        fenceChar = null;
        i += runOf(text, i);
        atLineStart = false;
        continue;
      }
      i += 1;
      atLineStart = false;
      continue;
    }

    // 行内 code span 内除反引号外一切都是字面内容——里面的 `$`、`\` 都不是定界符 /
    // 转义（2026-10 事故：句中 `` `$` `` 的 $ 被当成开定界符，回复结尾凭空多出一个 $）。
    // 放在围栏判定之前：span 里行首的 ``` 长串也只是内容，不开围栏。
    if (inCode && ch !== "`") {
      i += 1;
      atLineStart = false;
      continue;
    }

    // 围栏开：行首 ≥3 连的 ` 或 ~
    if (atLineStart && (ch === "`" || ch === "~")) {
      const n = runOf(text, i);
      if (n >= 3) {
        inFence = true;
        fenceChar = ch;
        i += n;
        atLineStart = false;
        continue;
      }
    }

    // 行内 code span：等长反引号串开、等长反引号串关
    if (ch === "`") {
      const n = runOf(text, i);
      if (inCode) {
        if (n === codeLen) {
          inCode = false;
          codeLen = 0;
        }
        i += n; // 不等长的串在 span 内是内容
        atLineStart = false;
        continue;
      }
      inCode = true;
      codeLen = n;
      i += n;
      atLineStart = false;
      continue;
    }

    // 转义：\$ 不是定界符，连下一个字符一起跳过
    if (ch === "\\") {
      i += 2;
      atLineStart = false;
      continue;
    }

    if (ch === "$") {
      const delim: "$$" | "$" = text[i + 1] === "$" ? "$$" : "$";
      if (openDelim === null) {
        openDelim = delim;
      } else if (openDelim === delim) {
        openDelim = null;
      }
      // 不同制式（$$ 开后遇单个 $）视作公式内容，忽略
      i += delim.length;
      atLineStart = false;
      continue;
    }

    i += 1;
    atLineStart = false;
  }

  if (openDelim === null) return text;
  return text + openDelim;
}

/** text 从 i 开始的同字符连跑长度 */
function runOf(text: string, i: number): number {
  const ch = text[i];
  let n = 0;
  while (i + n < text.length && text[i + n] === ch) n += 1;
  return n;
}
