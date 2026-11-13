/**
 * 插图 / 粘贴文字放哪：光标位置的规整（纯函数）。
 * - 光标在 frontmatter 里（含文首）：挪到 frontmatter 之后——图片插进属性区会把文档头弄坏；
 * - 光标在空行：原样插入；
 * - 行首 / 行尾：另起一段（前后补空行），免得图片贴在句子上；
 * - 句子中间：就地插入（行内图片）。
 */
import { splitFrontmatter } from "../../../../shared/ofm/properties.ts";

export interface Placement {
  from: number;
  to: number;
  insert: string;
}

export function placeInsertion(doc: string, from: number, to: number, text: string): Placement {
  const bodyStart = splitFrontmatter(doc).bodyStart;
  if (from < bodyStart) {
    from = bodyStart;
    to = bodyStart;
  }
  const lineStart = doc.lastIndexOf("\n", from - 1) + 1;
  const eol = doc.indexOf("\n", to);
  const lineEnd = eol === -1 ? doc.length : eol;
  const line = doc.slice(lineStart, lineEnd);
  if (line.trim() === "" || (from === lineStart && to === lineEnd)) return { from, to, insert: text };
  if (from === lineEnd) return { from, to, insert: `\n\n${text}` };
  if (from === lineStart) return { from, to, insert: `${text}\n\n` };
  return { from, to, insert: text };
}
