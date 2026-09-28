/**
 * browser_extract 的页面正文：页内脚本取原料，这里（纯函数）做规整、分段与排版。
 *
 * 页内脚本只取 `document.body.innerText`（按渲染取可见文字、保留阅读顺序与换行）与链接；
 * 规整和分段放在主进程，好测，也不让网页的 JS 环境影响格式。
 */

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

export interface PageRaw {
  text: string;
  links: [string, string][];
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
  options: { offset?: number; maxChars?: number; links?: boolean },
): string {
  const text = normalizeText(raw.text);
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
        ? `Text: characters ${offset}–${end} of ${text.length}. Call browser_extract with offset ${end} to continue.`
        : `Text: characters ${offset}–${end} of ${text.length} (end of page).`,
  ];
  const body = text === "" ? [] : ["<page-text untrusted>", chunk, "</page-text>"];
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
