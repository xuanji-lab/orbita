/**
 * Obsidian 语法 → 通用 markdown（导出「转成通用 md」用）。字符串级转换，不过 AST：
 * 导出要的是「原文只改 OFM 那几处」，AST 往返会重排用户的格式。
 *
 * - `[[页|别名]]` → 别名（没有别名就是目标名；`页#小节` → `页 > 小节`）；
 * - `![[图.png|300]]` → `![](路径)`（路径由调用方给：找得到文件就写相对文档的路径）；非图片嵌入 → 名字；
 * - `> [!warning]- 标题` → `> **标题**`（引用块里的粗体首行；内容行不动）；
 * - `==x==` → `<mark>x</mark>`（CommonMark 允许行内 HTML，GitHub 等都认）；
 * - `%%注释%%` → 删除；
 * - frontmatter 原样保留（通用工具大多认）；`#标签` 保留（在普通 md 里就是文字）。
 * 围栏代码块与行内代码里的一律不动。
 */
import {
  calloutDefaultTitle,
  fencedLineFlags,
  isImageName,
  parseCalloutHead,
  parseEmbedHint,
  splitCode,
  wikiLinkLabel,
  wikiLinkRe,
  wikiLinkFromGroups,
} from "./syntax.ts";
import { splitFrontmatter } from "./properties.ts";

export interface PlainOptions {
  /** 图片目标 → 写进 `![](…)` 的路径；找不到 = null（原样写目标名） */
  imagePath?: (target: string) => string | null;
}

function destination(path: string): string {
  return /[\s()]/.test(path) ? `<${path}>` : path;
}

function inline(segment: string, options: PlainOptions): string {
  let out = segment.includes("%%") ? segment.replace(/%%[^\n]*?%%/g, "") : segment;
  out = out.replace(wikiLinkRe(), (raw: string, bang?: string, target?: string, fragment?: string, alias?: string) => {
    const link = wikiLinkFromGroups(raw, bang, target, fragment, alias);
    if (!link.embed) return wikiLinkLabel(link);
    if (isImageName(link.target)) {
      const hint = parseEmbedHint(link.alias);
      const path = options.imagePath?.(link.target) ?? link.target;
      return `![${hint.alt ?? ""}](${destination(path)})`;
    }
    return link.alias !== null && link.alias !== "" ? link.alias : wikiLinkLabel(link);
  });
  return out.replace(/(?<!=)==(?!=)(?=\S)([^\n]*?\S)==(?!=)/g, "<mark>$1</mark>");
}

/** 提醒框头 → 引用块里的粗体标题；返回新行们 */
function calloutLines(lines: string[], flags: boolean[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const head = flags[i] === true ? null : /^((?:\s{0,3}>[ \t]?)+)(\[![A-Za-z][\w-]*\][+-]?(?:\s+.*)?)$/.exec(line);
    const callout = head === null ? null : parseCalloutHead(head[2] as string);
    if (head === null || callout === null) {
      out.push(line);
      continue;
    }
    const prefix = head[1] as string;
    const title = callout.title === "" ? calloutDefaultTitle(callout.type) : callout.title;
    out.push(`${prefix}**${title}**`);
    // 标题与内容之间留一行引用空行，免得并成同一段
    const next = lines[i + 1];
    if (next !== undefined && /^\s{0,3}>/.test(next) && next.replace(/^(\s{0,3}>[ \t]?)+/, "").trim() !== "") {
      out.push(prefix.replace(/[ \t]+$/, ""));
    }
  }
  return out;
}

export function ofmToPlainMarkdown(text: string, options: PlainOptions = {}): string {
  const { bodyStart } = splitFrontmatter(text);
  const head = text.slice(0, bodyStart);
  const body = text.slice(bodyStart);
  const lines = body.split("\n");
  const converted = calloutLines(lines, fencedLineFlags(lines)).join("\n");
  const pieces = splitCode(converted).map((piece) => (piece.code ? piece.text : inline(piece.text, options)));
  return head + pieces.join("");
}
