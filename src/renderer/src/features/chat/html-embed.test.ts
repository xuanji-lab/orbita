import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, isValidElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PanelTheme } from "../../../../shared/plugin-panel.ts";
import {
  EMBED_IFRAME_SANDBOX,
  EMBED_MAX_HEIGHT,
  EMBED_MIN_HEIGHT,
  EmbedHeightCache,
  activeMessage,
  buildEmbedDocument,
  clampEmbedHeight,
  isHtmlEmbedLang,
  parseEmbedMessage,
  themeDeclarations,
  themeMessage,
} from "./html-embed.ts";
import { splitMarkdownBlocks } from "./markdown-blocks.ts";
import { endsInsideFence } from "./mermaid-render.ts";

const THEME: PanelTheme = {
  name: "light",
  scheme: "light",
  vars: { "--color-text-primary": "rgb(20, 20, 20)", "--color-bg-panel": "rgb(254, 254, 254)", "--font-family-base": '"Manrope", sans-serif' },
};

// ---------- 围栏识别 ----------

test("isHtmlEmbedLang：只认整词 html-embed，大小写不敏感；普通 html 不算", () => {
  assert.equal(isHtmlEmbedLang("html-embed"), true);
  assert.equal(isHtmlEmbedLang("HTML-Embed"), true);
  assert.equal(isHtmlEmbedLang("html"), false);
  assert.equal(isHtmlEmbedLang("html-embedx"), false);
  assert.equal(isHtmlEmbedLang(undefined), false);
});

/** 与 CodeBlock.tsx 的 MdPre 同一条取语言的口径：pre > code.language-x */
function fenceLangs(markdown: string): string[] {
  const langs: string[] = [];
  const pre = (props: { children?: ReactNode }) => {
    const child = Array.isArray(props.children) ? props.children[0] : props.children;
    if (isValidElement<{ className?: string }>(child)) {
      const lang = /^language-(\S+)$/.exec(child.props.className ?? "")?.[1];
      if (lang !== undefined) langs.push(lang);
    }
    return null;
  };
  renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm], components: { pre }, children: markdown }));
  return langs;
}

test("```html-embed 经 react-markdown 后语言是 html-embed，带属性的 info string 也只取第一个词", () => {
  const langs = fenceLangs("前文\n\n```html-embed\n<div>a</div>\n```\n\n```html\n<p>代码</p>\n```\n\n```html-embed title=x\n<b/>\n```\n");
  assert.deepEqual(langs, ["html-embed", "html", "html-embed"]);
  assert.deepEqual(langs.map(isHtmlEmbedLang), [true, false, true]);
});

test("未闭合的 html-embed 围栏判为 pending（流式中不挂载），闭合后才挂", () => {
  assert.equal(endsInsideFence("讲一下：\n\n```html-embed"), true);
  assert.equal(endsInsideFence("```html-embed\n<div>\n\n<script>let a=1</script>"), true);
  assert.equal(endsInsideFence("```html-embed\n<div>\n``"), true);
  assert.equal(endsInsideFence("```html-embed\n<div></div>\n```"), false);
  // 图里面的 ``` 字样（模型在图里写了 markdown 示例）不会提前收尾：更长的外层围栏
  assert.equal(endsInsideFence("````html-embed\n<pre>```</pre>\n```\n"), true);
});

test("分块：html-embed 围栏里的空行不是切点，整张图是一块", () => {
  const text = "先说两句。\n\n```html-embed\n<div>第一步</div>\n\n<div>第二步</div>\n\n<script>x()</script>\n```\n\n后文。\n";
  const blocks = splitMarkdownBlocks(text);
  assert.equal(blocks.join(""), text);
  const fence = blocks.find((block) => block.includes("```html-embed"));
  assert.ok(fence !== undefined && fence.includes("第二步") && fence.includes("<script>"));
});

// ---------- 沙箱与 CSP ----------

test("iframe 的 sandbox 只给脚本：没有 same-origin / top-navigation / popups / forms / modals", () => {
  assert.equal(EMBED_IFRAME_SANDBOX, "allow-scripts");
  for (const flag of ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms", "allow-modals"]) {
    assert.ok(!EMBED_IFRAME_SANDBOX.includes(flag), flag);
  }
});

test("包出来的文档：主题与引导脚本在模型片段之前，引导脚本里没有能提前结束标签的字样", () => {
  const html = buildEmbedDocument('<div id="m">图</div><script>window.x=1</script>', THEME);
  const head = html.indexOf("<head>");
  const bootstrap = html.indexOf("<script>");
  const model = html.indexOf('<div id="m">');
  assert.ok(head >= 0 && head < bootstrap && bootstrap < model);
  const bootstrapBody = html.slice(bootstrap + "<script>".length, html.indexOf("</script>", bootstrap));
  assert.ok(!/<\/script/i.test(bootstrapBody));
  assert.ok(bootstrapBody.includes("requestAnimationFrame"));
  assert.ok(html.includes("--color-text-primary:rgb(20, 20, 20);"));
  assert.ok(html.includes("color-scheme:light;"));
});

test("主题声明：只收 --小写名，值里能跳出 <style> 或声明块的字符被剥掉；别名指向我们的变量", () => {
  const css = themeDeclarations({
    name: "x",
    scheme: "dark",
    vars: { "--color-accent": "red;}</style><script>alert(1)</script>", "bad name": "1", "--OK": "2" },
  });
  assert.ok(!css.includes("</style"));
  assert.ok(!css.includes("}"));
  assert.ok(!css.includes("bad name"));
  assert.ok(!css.includes("--OK"));
  assert.ok(css.includes("--color-background-primary:var(--color-bg-panel);"));
  assert.ok(css.endsWith("color-scheme:dark;"));
});

// ---------- 高度与消息 ----------

test("clampEmbedHeight：负数 / 0 / NaN / Infinity / 字符串忽略；超大钳到上限，过小抬到下限，小数向上取整", () => {
  for (const bad of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "300", null, undefined, {}]) {
    assert.equal(clampEmbedHeight(bad), null, String(bad));
  }
  assert.equal(clampEmbedHeight(1e9), EMBED_MAX_HEIGHT);
  assert.equal(clampEmbedHeight(3), EMBED_MIN_HEIGHT);
  assert.equal(clampEmbedHeight(240.2), 241);
});

test("parseEmbedMessage：只认带信封的四种消息，字段不合规丢掉", () => {
  assert.equal(parseEmbedMessage(null), null);
  assert.equal(parseEmbedMessage("height"), null);
  assert.equal(parseEmbedMessage({ type: "height", height: 100 }), null, "没信封");
  assert.equal(parseEmbedMessage({ orbitaEmbed: 2, type: "height", height: 100 }), null);
  assert.equal(parseEmbedMessage({ orbitaEmbed: 1, type: "navigate", url: "https://x" }), null);
  assert.deepEqual(parseEmbedMessage({ orbitaEmbed: 1, type: "height", height: 100 }), { kind: "height", height: 100 });
  assert.equal(parseEmbedMessage({ orbitaEmbed: 1, type: "height", height: -5 }), null);
  assert.equal(parseEmbedMessage({ orbitaEmbed: 1, type: "height", height: "abc" }), null);
  assert.deepEqual(parseEmbedMessage({ orbitaEmbed: 1, type: "height", height: 99999 }), { kind: "height", height: EMBED_MAX_HEIGHT });
  assert.deepEqual(parseEmbedMessage({ orbitaEmbed: 1, type: "ready", height: Number.NaN }), { kind: "ready", height: null });
  assert.deepEqual(parseEmbedMessage({ orbitaEmbed: 1, type: "ready", height: 300 }), { kind: "ready", height: 300 });
  assert.deepEqual(parseEmbedMessage({ orbitaEmbed: 1, type: "pointer", inside: true }), { kind: "pointer", inside: true });
  assert.equal(parseEmbedMessage({ orbitaEmbed: 1, type: "pointer", inside: "yes" }), null);
});

test("parseEmbedMessage：错误压成一行、截断，code 只认 blocked，其余算 script", () => {
  const long = "x".repeat(500);
  const parsed = parseEmbedMessage({ orbitaEmbed: 1, type: "error", message: `a\n\n  b ${long}` });
  assert.ok(parsed !== null && parsed.kind === "error");
  if (parsed?.kind !== "error") return;
  assert.equal(parsed.code, "script");
  assert.ok(parsed.message.startsWith("a b x"));
  assert.ok(parsed.message.length <= 161);
  assert.deepEqual(parseEmbedMessage({ orbitaEmbed: 1, type: "error", code: "blocked", message: "https://cdn/x.js" }), {
    kind: "error",
    code: "blocked",
    message: "https://cdn/x.js",
  });
  assert.deepEqual(parseEmbedMessage({ orbitaEmbed: 1, type: "error", code: "evil", message: 42 }), { kind: "error", code: "script", message: "" });
});

test("宿主发进去的消息形状", () => {
  assert.deepEqual(activeMessage(false), { orbitaEmbed: 1, type: "active", active: false });
  const theme = themeMessage(THEME);
  assert.equal(theme.type, "theme");
  assert.equal(theme.scheme, "light");
  assert.notEqual(theme.vars, THEME.vars, "拷贝一份，不把宿主对象交出去");
});

test("EmbedHeightCache：按源码记，最近用过的留下，超限丢最旧的", () => {
  const cache = new EmbedHeightCache(2);
  cache.set("a", 100);
  cache.set("b", 200);
  cache.set("a", 110);
  cache.set("c", 300);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 110);
  assert.equal(cache.get("c"), 300);
  assert.equal(cache.size, 2);
});
