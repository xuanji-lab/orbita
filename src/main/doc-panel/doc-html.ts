/**
 * 文档 → 自包含的 HTML（导出 PDF 用）。**纯 node 模块**（不 import electron）：
 * UI 的「导出 PDF」与 agent 的 `doc_export(pdf)` 走同一份生成函数，打印在 `print-doc-pdf.ts`。
 *
 * - 管线：remark-parse + frontmatter + gfm + 自写 OFM 插件 → remark-rehype（**不放行原始 HTML**，
 *   导出页要的是静态排版，文档里的 `<script>` / 远程图在这里就是文字）→ rehype-callouts（提醒框，
 *   折叠的在 PDF 里强制展开）→ 补 `data-kind` → rehype-stringify；
 * - 图片：由调用方给 `loadImage`（解析目标 + 读字节），内联成 data: URL（打印窗口不联网、不读盘）；
 *   读不到 / 不是图片 = 一个带图名的占位框，不整份失败；
 * - 样式：阅读视图的纸面（见 `PRINT_CSS`）。颜色是**纸面固定色**——PDF 是交付物、不是应用界面，
 *   不跟应用主题走，所以这里不用设计系统 token；字体走系统中文字体栈。
 */
import rehypeCallouts from "rehype-callouts";
import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { rehypeCalloutKind } from "../../shared/ofm/rehype-callout-kind.ts";
import { remarkOfm } from "../../shared/ofm/remark-ofm.ts";

interface Md {
  type: string;
  url?: string;
  children?: Md[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/** 读一张图 → data: URL；读不到 = null。`kind` 区分 `![[…]]` 与 `![](…)` */
export type LoadImageUrl = (target: string, kind: "embed" | "markdown") => Promise<string | null>;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function collectImages(node: Md, into: Md[]): void {
  if (node.type === "image") into.push(node);
  else if (node.type === "ofmEmbed" && node.data?.hName === "img") into.push(node);
  for (const child of node.children ?? []) collectImages(child, into);
}

export async function markdownToHtmlBody(markdown: string, loadImage?: LoadImageUrl): Promise<string> {
  const base = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkGfm).use(remarkOfm, { properties: true });
  const tree = base.runSync(base.parse(markdown.replace(/\r\n?/g, "\n"))) as unknown as Md;
  const images: Md[] = [];
  collectImages(tree, images);
  await Promise.all(
    images.map(async (node) => {
      const embed = node.type === "ofmEmbed";
      const target = embed ? String(node.data?.hProperties?.["data-ofm-embed"] ?? "") : (node.url ?? "");
      let url: string | null = null;
      try {
        url = loadImage === undefined ? null : await loadImage(target, embed ? "embed" : "markdown");
      } catch {
        url = null;
      }
      if (url !== null) {
        if (embed) node.data = { ...node.data, hProperties: { ...node.data?.hProperties, src: url } };
        else node.url = url;
      } else {
        // 读不到：换成带图名的占位（不留一个会去联网的 <img src>）
        const name = embed ? target : target === "" ? "image" : target.split("/").pop() ?? target;
        Object.assign(node, {
          type: "ofmMissingImage",
          url: undefined,
          children: [{ type: "text", value: `[${name}]` }],
          data: { hName: "span", hProperties: { className: ["ofm-missing"] } },
        });
      }
    }),
  );
  const processor = unified()
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeCallouts)
    .use(rehypeCalloutKind)
    .use(rehypeStringify);
  const html = processor.stringify(await processor.run(tree as never));
  // 折叠的提醒框在纸上要展开：静态 HTML 里关着的 <details> 内容不打印
  return String(html).replace(/<details class="callout"/g, '<details class="callout" open');
}

/** 阅读视图的纸面（A4、系统字体栈）。颜色为纸面固定色，见文件头 */
export const PRINT_CSS = `
@page { size: A4; margin: 18mm 16mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #1d1d1f; background: #fff; font: 11pt/1.75 -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.4em 0 0.5em; break-after: avoid; }
h1 { font-size: 22pt; margin-top: 0; } h2 { font-size: 16pt; } h3 { font-size: 13pt; } h4, h5, h6 { font-size: 11pt; }
p { margin: 0.6em 0; }
a { color: #1a5fd0; text-decoration: none; border-bottom: 1px solid #b7cdf2; }
a.ofm-wikilink { color: #1a5fd0; }
code { font: 9.5pt/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; background: #f1f1f3; padding: 0.1em 0.35em; border-radius: 3px; }
pre { background: #f6f6f8; border: 1px solid #e4e4e8; border-radius: 6px; padding: 10px 12px; overflow: hidden; white-space: pre-wrap; word-break: break-all; break-inside: avoid; }
pre code { background: none; padding: 0; }
blockquote { margin: 0.8em 0; padding: 0.1em 0 0.1em 14px; border-left: 3px solid #c7c7cc; color: #48484a; }
hr { border: 0; border-top: 1px solid #d4d4d8; margin: 1.4em 0; }
img { max-width: 100%; height: auto; border-radius: 4px; break-inside: avoid; }
table { border-collapse: collapse; margin: 0.8em 0; width: 100%; break-inside: avoid; }
th, td { border: 1px solid #d4d4d8; padding: 5px 10px; text-align: left; vertical-align: top; }
th { background: #f1f1f3; font-weight: 600; }
ul, ol { padding-left: 1.6em; } li { margin: 0.2em 0; }
ul.contains-task-list { list-style: none; padding-left: 0.4em; }
mark, .ofm-mark { background: #fff3a3; color: inherit; padding: 0 0.15em; border-radius: 2px; }
.ofm-tag { color: #1a5fd0; background: #e8f0fd; border-radius: 10px; padding: 0.05em 0.55em; font-size: 0.92em; }
.ofm-missing { color: #8e8e93; border: 1px dashed #c7c7cc; border-radius: 4px; padding: 0 0.4em; }
.ofm-properties { display: grid; grid-template-columns: max-content 1fr; gap: 3px 18px; margin: 0 0 1.4em; padding: 10px 0; border-top: 1px solid #e4e4e8; border-bottom: 1px solid #e4e4e8; font-size: 10pt; }
.ofm-prop { display: contents; }
.ofm-prop-key { color: #8e8e93; }
.ofm-prop-val { color: #1d1d1f; }
.callout { margin: 0.9em 0; padding: 10px 14px; border-left: 4px solid var(--c, #3b6fd4); background: var(--bg, #eef3fd); border-radius: 0 6px 6px 0; break-inside: avoid; }
.callout-title { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--c, #3b6fd4); list-style: none; }
.callout-title::-webkit-details-marker { display: none; }
.callout-title-icon { display: flex; } .callout-title-icon svg { width: 1.1em; height: 1.1em; }
.callout-fold-icon { display: none; }
.callout-content > :first-child { margin-top: 0.4em; } .callout-content > :last-child { margin-bottom: 0; }
.callout[data-kind="abstract"], .callout[data-kind="todo"] { --c: #2f9bb5; --bg: #ecf7fa; }
.callout[data-kind="info"] { --c: #3b6fd4; --bg: #eef3fd; }
.callout[data-kind="tip"] { --c: #2f9e8f; --bg: #eaf7f4; }
.callout[data-kind="success"] { --c: #3e9b53; --bg: #ecf7ef; }
.callout[data-kind="question"] { --c: #c98a1b; --bg: #fbf3e3; }
.callout[data-kind="warning"] { --c: #d9822b; --bg: #fcf1e3; }
.callout[data-kind="failure"], .callout[data-kind="danger"], .callout[data-kind="bug"] { --c: #d14b4b; --bg: #fbebeb; }
.callout[data-kind="example"] { --c: #8a63d2; --bg: #f3eefb; }
.callout[data-kind="quote"] { --c: #8e8e93; --bg: #f4f4f5; }
`;

export function documentHtml(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`;
}
