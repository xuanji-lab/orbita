/**
 * 编辑视图 OFM 外观用到的两个纯判断（不依赖 React，node:test 可直接加载）：
 * 语法树里哪些范围算「代码」（里面的 `[[` `==` `#` 不转换），以及一行里的标准图片 `![](相对路径)`。
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

const CODE_NODES = new Set(["InlineCode", "FencedCode", "CodeBlock", "CodeText", "CodeInfo", "HTMLBlock", "HTMLTag", "CommentBlock", "URL"]);
/** URL 当代码区是为了不在链接地址里认 `#锚点` / `==`；但图片的 URL 是图片语法本身的一部分，标准图片分支要看得到它 */
const IMAGE_URL_PARENT = "Image";

export interface CodeRange {
  from: number;
  to: number;
  /** 这一段是 `![](url)` 里的 url：对图片分支不算代码（否则标准图片永远被跳过），对 `#标签` / `==高亮==` 仍算 */
  imageUrl: boolean;
}

export function codeRanges(state: EditorState, from: number, to: number): CodeRange[] {
  const out: CodeRange[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (CODE_NODES.has(node.name)) {
        out.push({ from: node.from, to: node.to, imageUrl: node.name === "URL" && node.node.parent?.name === IMAGE_URL_PARENT });
        return false;
      }
      return undefined;
    },
  });
  return out;
}

export const inAny = (ranges: readonly CodeRange[], from: number, to: number): boolean =>
  ranges.some((range) => from < range.to && to > range.from);

export interface StdImage {
  from: number;
  to: number;
  url: string;
  alt: string;
}

/**
 * 一行里的标准图片 `![alt](相对路径)`：在代码里的（行内代码、围栏）不算；带协议的外链图不处理（不联网）。
 * 图片自己的 URL 子节点不算代码（见 CodeRange.imageUrl）。
 */
export function standardImages(text: string, lineFrom: number, lineCode: readonly CodeRange[]): StdImage[] {
  const out: StdImage[] = [];
  const code = lineCode.filter((range) => !range.imageUrl);
  const pattern = /!\[([^\]\n]*)\]\((<[^>\n]+>|[^)\s\n]+)(?:\s+"[^"\n]*")?\)/g;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    const from = lineFrom + m.index;
    const to = from + m[0].length;
    if (inAny(code, from, to)) continue;
    const url = (m[2] as string).replace(/^<|>$/g, "");
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) continue;
    out.push({ from, to, url, alt: m[1] as string });
  }
  return out;
}
