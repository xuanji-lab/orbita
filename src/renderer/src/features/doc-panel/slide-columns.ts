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

/** 一页的标题（缩略图下的说明）：第一个非空行去掉 markdown 标记；空页返回 "" */
export function pageCaption(text: string): string {
  for (const line of text.split("\n")) {
    const plain = line.replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)]|>)\s*/, "").replace(/[*_`~]/g, "").trim();
    if (plain !== "") return plain;
  }
  return "";
}

/**
 * 一页的内容是不是真被裁掉了：内容的最低一点超过了页体的底边（页体 `overflow: hidden`，超出底边的才看不见）。
 * 页体有下内边距（页脚留白）——内容落进这块留白里只是挤了页码、并没有被裁，不能报「被裁掉了」。
 * 之前用 scrollHeight > clientHeight，scrollHeight 把下内边距也算进去，对没被裁的页误报。
 * 参数是同一坐标系（屏幕像素、缩放后也行）下的两个 y；tolerance 吸收亚像素与缩放取整。
 */
export function contentClipped(contentBottom: number, bodyBottom: number, tolerance = 1): boolean {
  return contentBottom > bodyBottom + tolerance;
}
