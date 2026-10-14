/**
 * browser_extract 的页面正文：页内脚本取原料，这里（纯函数）做规整、分段与排版。
 *
 * 页内脚本只取 `document.body.innerText`（按渲染取可见文字、保留阅读顺序与换行）与链接；
 * markdown 模式则把 DOM 子树序列化成 plain object 节点树（SERIALIZE_TREE_FN），排版交给
 * dom-markdown.ts 的纯函数——规整和分段放在主进程，好测，也不让网页的 JS 环境影响格式。
 */
import { domToMarkdown, normalizeMarkdown, type DomNode } from "./dom-markdown.ts";

/** 页内脚本：在网页里跑，返回原料。上限在页内先截一道，免得几十 MB 的页面整个过 IPC */
export function extractScript(withLinks: boolean): string {
  return `(() => {
  const text = document.body ? document.body.innerText.slice(0, 2000000) : "";
  const links = [];
  if (${withLinks ? "true" : "false"}) {
    const seen = new Set();
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href;
      if (!/^https?:/i.test(href) || seen.has(href)) continue;
      seen.add(href);
      links.push([(a.innerText || a.getAttribute("aria-label") || a.title || "").replace(/\\s+/g, " ").trim().slice(0, 200), href]);
      if (links.length >= 500) break;
    }
  }
  return { text, links };
})()`;
}

/**
 * 页内脚本：把 DOM 子树序列化成 plain object 节点树（markdown 模式的原料）。
 *
 * `this` = 要提取的根：整页时用 `(${SERIALIZE_TREE_FN}).call(document.body)`，ref 子树时由
 * CDP 的 callFunctionOn 把引用解析出的节点绑成 this。节点上限与深度上限各截一道——节点树要
 * returnByValue 过 IPC，超大页面不能整个搬过来；截断了如实回 truncated，主进程再告诉模型。
 * script / style / noscript 这类不产出正文的标签在这里就跳过，markdown 侧不再判。
 */
export const SERIALIZE_TREE_FN = `function () {
  const SKIP = new Set(["script", "style", "noscript", "template", "head", "link", "meta", "svg", "canvas", "iframe", "object", "embed"]);
  const MAX_NODES = 60000;
  const MAX_DEPTH = 100;
  let count = 0;
  let truncated = false;
  const attrsOf = (el, tag) => {
    const attrs = {};
    if (tag === "a" && el.href) attrs.href = el.href;
    if (tag === "img") {
      const alt = el.getAttribute("alt");
      const src = el.currentSrc || el.src;
      if (alt) attrs.alt = alt;
      if (src) attrs.src = src;
    }
    return attrs;
  };
  const walk = (node, depth) => {
    if (count >= MAX_NODES || depth > MAX_DEPTH) {
      truncated = true;
      return null;
    }
    if (node.nodeType === 3) {
      const text = node.nodeValue || "";
      if (text.trim() === "") return null;
      count += 1;
      return { tag: "#text", text: text };
    }
    if (node.nodeType !== 1) return null;
    const tag = node.tagName.toLowerCase();
    if (SKIP.has(tag) || node.hidden === true) return null;
    const style = node.getAttribute("style");
    if (style && /display\\s*:\\s*none/i.test(style)) return null;
    count += 1;
    const children = [];
    for (const child of node.childNodes) {
      const item = walk(child, depth + 1);
      if (item !== null) children.push(item);
    }
    const result = { tag: tag, children: children };
    const attrs = attrsOf(node, tag);
    if (Object.keys(attrs).length > 0) result.attrs = attrs;
    return result;
  };
  const root = this && this.nodeType === 1 ? this : (this && this.parentElement) || document.body;
  if (!root) return { root: null, truncated: false };
  return { root: walk(root, 0), truncated: truncated };
}`;

/** 页内脚本：只取 ref 子树自己的可见文字（text 模式 + ref）。this = 引用的节点 */
export const SUBTREE_TEXT_FN = `function () {
  const el = this && this.nodeType === 1 ? this : this && this.parentElement;
  return el ? el.innerText.slice(0, 2000000) : "";
}`;

export interface PageRaw {
  text: string;
  links: [string, string][];
  /** markdown 模式：页内序列化出的节点树（text 模式缺席） */
  tree?: DomNode | null;
  /** 节点数或深度超限，序列化被截断 */
  treeTruncated?: boolean;
}

export const EXTRACT_DEFAULT_CHARS = 20_000;
export const EXTRACT_MAX_CHARS = 50_000;
const EXTRACT_MIN_CHARS = 1_000;

/** 连续空行压成一个、行尾空白去掉、首尾空白去掉 */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatExtract(
  page: { url: string; title: string },
  raw: PageRaw,
  options: { offset?: number; maxChars?: number; links?: boolean; format?: "text" | "markdown" },
): string {
  const markdown = options.format === "markdown";
  const text = markdown ? normalizeMarkdown(domToMarkdown(raw.tree)) : normalizeText(raw.text);
  const maxChars = clamp(Math.round(options.maxChars ?? EXTRACT_DEFAULT_CHARS), EXTRACT_MIN_CHARS, EXTRACT_MAX_CHARS);
  const offset = clamp(Math.round(options.offset ?? 0), 0, text.length);
  const chunk = text.slice(offset, offset + maxChars);
  const end = offset + chunk.length;
  const head = [
    `URL: ${page.url}`,
    `Title: ${page.title}`,
    text === ""
      ? "The page has no visible text (it may still be loading, be an image or a PDF, or need a login)."
      : end < text.length
        ? `${markdown ? "Markdown" : "Text"}: characters ${offset}–${end} of ${text.length}. Call browser_extract with offset ${end} to continue.`
        : `${markdown ? "Markdown" : "Text"}: characters ${offset}–${end} of ${text.length} (end of page).`,
    ...(markdown && raw.treeTruncated === true
      ? ["The page is very large: only the first part of its structure was converted."]
      : []),
  ];
  const body =
    text === ""
      ? []
      : [`<${markdown ? "page-markdown" : "page-text"} untrusted>`, chunk, `</${markdown ? "page-markdown" : "page-text"}>`];
  const links =
    options.links === true
      ? raw.links.length === 0
        ? ["No links on the page."]
        : [
            `<page-links untrusted count="${raw.links.length}">`,
            ...raw.links.map(([label, href]) => (label === "" ? `- ${href}` : `- ${label} — ${href}`)),
            "</page-links>",
          ]
      : [];
  return [...head, ...body, ...links].join("\n");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Number.isFinite(value) ? value : min, min), max);
}
