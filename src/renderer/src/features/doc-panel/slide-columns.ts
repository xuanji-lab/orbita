/**
 * 演示文稿里的分栏写法（不开 raw HTML 的前提下给「三列对比」一个安全的出口）：
 *
 * ```
 * ::: columns
 * ### 左
 * 一些文字
 * +++
 * ### 中
 * 一些文字
 * +++
 * ### 右
 * 一些文字
 * :::
 * ```
 *
 * 每一栏是一段普通 markdown，`+++` 单独成行分栏，`:::` 单独成行收尾。围栏代码块里的这些符号不算；
 * 没有收尾的 `::: columns` 当普通文字原样留着（宁可显示出来，也不吞掉后面整页内容）。
 * 纯函数：切成「普通 markdown 块 / 分栏块」交给渲染端，渲染端不用懂语法。
 */
export type SlideBlock = { kind: "md"; text: string } | { kind: "columns"; columns: string[] };

const OPEN = /^:::[ \t]*columns[ \t]*$/i;
const SPLIT = /^\+\+\+[ \t]*$/;
const CLOSE = /^:::[ \t]*$/;
const FENCE = /^\s{0,3}(```+|~~~+)/;

export function splitColumns(text: string): SlideBlock[] {
  const lines = text.split("\n");
  const blocks: SlideBlock[] = [];
  let plain: string[] = [];
  const flush = (): void => {
    if (plain.length > 0) blocks.push({ kind: "md", text: plain.join("\n") });
    plain = [];
  };
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const trimmed = line.replace(/\r$/, "");
    const open = FENCE.exec(trimmed);
    if (fence !== null) {
      if (open !== null && (open[1] as string).startsWith(fence[0] as string) && (open[1] as string).length >= fence.length) fence = null;
      plain.push(line);
      continue;
    }
    if (open !== null) {
      fence = open[1] as string;
      plain.push(line);
      continue;
    }
    if (OPEN.test(trimmed)) {
      // 找收尾（途中的围栏代码块里的 ::: 不算）
      const columns: string[] = [];
      let current: string[] = [];
      let inner: string | null = null;
      let closedAt = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        const body = lines[j] as string;
        const t = body.replace(/\r$/, "");
        const f = FENCE.exec(t);
        if (inner !== null) {
          if (f !== null && (f[1] as string).startsWith(inner[0] as string) && (f[1] as string).length >= inner.length) inner = null;
          current.push(body);
          continue;
        }
        if (f !== null) {
          inner = f[1] as string;
          current.push(body);
          continue;
        }
        if (SPLIT.test(t)) {
          columns.push(current.join("\n"));
          current = [];
        } else if (CLOSE.test(t)) {
          columns.push(current.join("\n"));
          closedAt = j;
          break;
        } else current.push(body);
      }
      if (closedAt === -1) {
        plain.push(line);
        continue;
      }
      flush();
      blocks.push({ kind: "columns", columns });
      i = closedAt;
      continue;
    }
    plain.push(line);
  }
  flush();
  return blocks;
}
