/**
 * 页内序列化出的 DOM 节点树 → Markdown（纯函数，node --test 直接加载，不需要 DOM）。
 *
 * 为什么分两层：页内脚本只把 DOM 子树变成 plain object（page-text.ts 的 SERIALIZE_TREE_FN），
 * 排版规则全留在这里——不受网页自身 JS 环境影响，也能脱离浏览器测（嵌套列表、表格、空链接、
 * 深层嵌套这些边界都在本文件的测试里）。
 *
 * 取舍（参考 Obscura，Apache-2.0，crates/obscura-js/src/markdown.rs 的 HTML_TO_MARKDOWN_JS）：
 * 只保留对模型有用的结构——标题、列表、链接、表格、强调、代码；其余容器（div / span / section…）
 * 透明展开，行内内容合成一段，含块级子节点的容器才拆成多块。script / style / noscript 在页内
 * 序列化时就跳过了，这里不再判。
 */

/** 页内脚本产出的节点：`#text` 是文本节点，其余是元素（tag 小写） */
export interface DomNode {
  tag: string;
  /** 文本节点的文字 */
  text?: string;
  attrs?: { href?: string; alt?: string; src?: string };
  children?: DomNode[];
}

/** 会独立成块的标签：容器里出现它们就把容器拆成多块，否则整块按行内文字处理 */
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "nav",
  "aside",
  "body",
  "form",
  "figure",
  "figcaption",
  "details",
  "summary",
  "fieldset",
  "blockquote",
  "pre",
  "table",
  "ul",
  "ol",
  "li",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "dl",
  "dt",
  "dd",
  "address",
  "center",
]);

const HEADING_RE = /^h([1-6])$/;

/** 节点树 → markdown。空树 / 全空白回空串 */
export function domToMarkdown(root: DomNode | null | undefined): string {
  if (root === null || root === undefined) return "";
  const blocks = block(root).filter((part) => part !== "");
  return normalizeMarkdown(blocks.join("\n\n"));
}

/** 从节点树里收集链接（文字 + 绝对 URL），按 URL 去重：markdown 模式的 links: true 用它 */
export function collectLinks(root: DomNode | null | undefined): [string, string][] {
  const out: [string, string][] = [];
  const seen = new Set<string>();
  const visit = (node: DomNode): void => {
    if (node.tag === "a") {
      const href = (node.attrs?.href ?? "").trim();
      if (href !== "" && !/^javascript:/i.test(href) && !seen.has(href)) {
        seen.add(href);
        out.push([inline(node.children ?? []).replace(/\s+/g, " ").trim().slice(0, 200), href]);
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  if (root !== null && root !== undefined) visit(root);
  return out;
}

/** 连续空行压成一个、行尾空白去掉、首尾空白去掉（与 page-text.ts 的文本规整同一套规矩） */
export function normalizeMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── 块级 ──────────────────────────────────────────────────────────────

/** 一个节点 → 若干块（每块可能多行，如列表、表格、代码块） */
function block(node: DomNode): string[] {
  if (node.tag === "#text") {
    const text = collapse(node.text ?? "").trim();
    return text === "" ? [] : [text];
  }
  const heading = HEADING_RE.exec(node.tag);
  if (heading !== null) {
    const text = inline(node.children ?? []).trim();
    return text === "" ? [] : [`${"#".repeat(Number(heading[1]))} ${text}`];
  }
  switch (node.tag) {
    case "p":
    case "li": {
      // li 正常由 list() 处理；这里只兜出现在列表外的孤立 li
      const text = inline(node.children ?? []).trim();
      return text === "" ? [] : [text];
    }
    case "ul":
    case "ol": {
      const lines = list(node, node.tag === "ol");
      return lines.length === 0 ? [] : [lines.join("\n")];
    }
    case "pre": {
      const code = codeBlock(node);
      return code === "" ? [] : [code];
    }
    case "blockquote": {
      const inner = blockNodes(node.children ?? []).join("\n\n");
      if (inner.trim() === "") return [];
      return [inner.split("\n").map((line) => (line === "" ? ">" : `> ${line}`)).join("\n")];
    }
    case "table": {
      const lines = table(node);
      return lines.length === 0 ? [] : [lines.join("\n")];
    }
    case "hr":
      return ["---"];
    default:
      // 行内元素（a / strong / code / span…）出现在块级兄弟之间（直接挂在 body / div 下）时，
      // 不能走 container()——那会把元素本身拆掉、丢掉链接与格式；按行内渲染保住它。
      if (!BLOCK_TAGS.has(node.tag)) {
        const text = inline([node]).trim();
        return text === "" ? [] : [text];
      }
      return container(node);
  }
}

/**
 * 子节点 → 块列表。**连续的行内节点先攒成一组、整组走一次 inline()**，遇到块级节点再 flush。
 * 逐个走 block() 会把一句话拆成多段：`Read <a>docs</a> now` 会变成
 * "Read\n\n[docs](…)\n\nnow"——li 里带链接在搜索结果 / 导航 / 目录里到处都是，是 2026-10-14
 * 评审实测的阻断问题。
 */
function blockNodes(nodes: readonly DomNode[]): string[] {
  const out: string[] = [];
  let run: DomNode[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const text = inline(run).trim();
    if (text !== "") out.push(text);
    run = [];
  };
  for (const node of nodes) {
    if (isInline(node)) {
      run.push(node);
      continue;
    }
    flush();
    out.push(...block(node));
  }
  flush();
  return out;
}

/** 行内节点：文本节点，以及不在 BLOCK_TAGS 里的元素 */
function isInline(node: DomNode): boolean {
  return node.tag === "#text" || !BLOCK_TAGS.has(node.tag);
}

/** 容器：有块级子节点就拆成多块；只有行内内容就合成一段 */
function container(node: DomNode): string[] {
  const children = node.children ?? [];
  const hasBlockChild = children.some((child) => child.tag !== "#text" && BLOCK_TAGS.has(child.tag));
  if (!hasBlockChild) {
    const text = inline(children).trim();
    return text === "" ? [] : [text];
  }
  return blockNodes(children);
}

/** 列表：有序 / 无序；li 里嵌的列表缩进到父项文字之下 */
function list(node: DomNode, ordered: boolean): string[] {
  const items = (node.children ?? []).filter((child) => child.tag === "li");
  const lines: string[] = [];
  let index = 1;
  for (const item of items) {
    const own: DomNode[] = [];
    const nested: DomNode[] = [];
    for (const child of item.children ?? []) {
      if (child.tag === "ul" || child.tag === "ol") nested.push(child);
      else own.push(child);
    }
    const marker = ordered ? `${index}. ` : "- ";
    const pad = " ".repeat(marker.length);
    const ownBlocks = blockNodes(own).filter((part) => part !== "");
    // 第一块可能是多行（li 里的 <br> 会合成一行一段），续行要和后续块一样缩进到文字之下
    const [firstLine = "", ...firstRest] = (ownBlocks[0] ?? "").split("\n");
    lines.push(marker + firstLine);
    for (const line of firstRest) lines.push(pad + line);
    for (const extra of ownBlocks.slice(1)) lines.push(pad + extra);
    for (const sub of nested) {
      for (const subLine of list(sub, sub.tag === "ol")) lines.push(pad + subLine);
    }
    index += 1;
  }
  return lines;
}

/** GFM 管道表：第一行当表头（有 thead 时就是它），下面接分隔行 */
function table(node: DomNode): string[] {
  const rows: DomNode[][] = [];
  collectRows(node, rows);
  const cells = rows.map((row) => row.map((cell) => cellText(cell)));
  const first = cells[0];
  if (first === undefined) return [];
  const width = Math.max(...cells.map((row) => row.length));
  if (width === 0) return [];
  const padded = (row: readonly string[]): string[] => [...row, ...Array<string>(width - row.length).fill("")];
  const lines = [`| ${padded(first).join(" | ")} |`, `| ${Array<string>(width).fill("---").join(" | ")} |`];
  for (const row of cells.slice(1)) lines.push(`| ${padded(row).join(" | ")} |`);
  return lines;
}

function collectRows(node: DomNode, rows: DomNode[][]): void {
  for (const child of node.children ?? []) {
    if (child.tag === "tr") {
      rows.push((child.children ?? []).filter((cell) => cell.tag === "td" || cell.tag === "th"));
    } else if (child.tag === "thead" || child.tag === "tbody" || child.tag === "tfoot") {
      collectRows(child, rows);
    }
  }
}

function cellText(cell: DomNode): string {
  return inline(cell.children ?? [])
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

/** 代码块：保留原始空白，内容里有 ``` 就换更长的围栏 */
function codeBlock(node: DomNode): string {
  const content = rawText(node.children ?? [])
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "");
  if (content.trim() === "") return "";
  const fence = content.includes("```") ? "````" : "```";
  return `${fence}\n${content}\n${fence}`;
}

// ── 行内 ──────────────────────────────────────────────────────────────

/** 行内内容 → 一行文字（块级边界由调用方 trim） */
function inline(nodes: readonly DomNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.tag === "#text") {
      out += collapse(node.text ?? "");
      continue;
    }
    switch (node.tag) {
      case "br":
        out += "\n";
        break;
      case "strong":
      case "b": {
        const inner = inline(node.children ?? []).trim();
        if (inner !== "") out += `**${inner}**`;
        break;
      }
      case "em":
      case "i": {
        const inner = inline(node.children ?? []).trim();
        if (inner !== "") out += `*${inner}*`;
        break;
      }
      case "del":
      case "s": {
        const inner = inline(node.children ?? []).trim();
        if (inner !== "") out += `~~${inner}~~`;
        break;
      }
      case "code":
      case "kbd":
      case "samp": {
        const inner = collapse(rawText(node.children ?? [])).trim();
        if (inner !== "") out += codeSpan(inner);
        break;
      }
      case "a":
        out += link(node);
        break;
      case "img":
        out += image(node);
        break;
      default:
        out += inline(node.children ?? []);
    }
  }
  return out;
}

/** 链接：文字空就回落到 URL 本身（`[](url)` 渲染出来什么都看不见） */
function link(node: DomNode): string {
  const href = (node.attrs?.href ?? "").trim();
  const label = escapeLinkText(inline(node.children ?? []).trim());
  if (href === "" || /^javascript:/i.test(href)) return label;
  if (label === "") return href;
  const destination = /[\s()]/.test(href) ? `<${href}>` : href;
  return `[${label}](${destination})`;
}

/**
 * 链接文字 / 图片 alt 里的方括号与反斜杠要转义：`lab]el` 直接拼出 `[lab]el](…)`，
 * markdown 结构当场断掉（2026-10-14 评审）。
 */
function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, (char) => `\\${char}`);
}

/** 图片：data: 内联图只留 alt（整段 base64 会把 token 烧光） */
function image(node: DomNode): string {
  const alt = escapeLinkText(collapse(node.attrs?.alt ?? "").trim());
  const src = (node.attrs?.src ?? "").trim();
  if (src === "" || src.startsWith("data:")) return alt;
  return `![${alt}](${src})`;
}

/** 行内代码：内容含反引号就换更长的围栏，两端贴反引号时补空格 */
function codeSpan(text: string): string {
  const fence = text.includes("`") ? "``" : "`";
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** 递归取原始文字（代码块 / 行内代码用，不折叠空白） */
function rawText(nodes: readonly DomNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.tag === "#text") out += node.text ?? "";
    else out += rawText(node.children ?? []);
  }
  return out;
}

/** 行内空白（含换行）折叠成一个空格 */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ");
}
