/**
 * 回答里的内嵌交互图（```html-embed 围栏）的纯逻辑：识别围栏、把模型写的片段包成完整文档、
 * 解析 iframe 发回来的消息、钳住高度、记住量过的高度。组件在 HtmlEmbedBlock.tsx，契约在 shared/chat-embed.ts。
 *
 * 纯模块：不 import React / CSS，`node --test` 直接加载。
 *
 * **包出来的文档长这样**：`<head>` 最前面是我们的样式（当前主题的计算值写成 :root 变量 + 几条预置样式）与
 * 引导脚本，模型的片段原样放进 `<body>`。引导脚本先于模型的任何脚本执行，所以：
 * - **高度**由它量（ResizeObserver，变了才发），不靠模型自己写上报脚本（Open WebUI 让作者自己写，忘了就被截成小框）；
 * - **主题**初始值直接写进文档（挂上就是对的颜色，不闪），之后宿主换主题发一条 `theme` 消息覆盖 :root 变量；
 * - **暂停**：宿主说「不在视口 / 窗口不在前台」时，它把 requestAnimationFrame 的回调攒起来不交给浏览器、
 *   CSS 动画 animation-play-state 设为 paused；回来时一次放出——画面停在原处，不重放；
 * - **报错**：未捕获的异常、Promise 拒绝、被 CSP 拦下的外链脚本，各发一条 `error`，宿主退回源码 + 一行原因。
 *
 * 模型的片段能伪造任何消息（同一个文档里谁都能 postMessage），所以宿主侧的 {@link parseEmbedMessage} 把每条都当
 * 不可信输入：只认四种 type、数值必须有限、文字截断——伪造的最坏结果是图变高（有上限）或退回源码。
 */
import type { PanelTheme } from "../../../../shared/plugin-panel.ts";
import { HTML_EMBED_LANG } from "../../../../shared/chat-embed.ts";

export { HTML_EMBED_LANG, HTML_EMBED_MAX_BYTES } from "../../../../shared/chat-embed.ts";

/** iframe 的 sandbox：只给脚本。不给 same-origin / top-navigation / popups / forms / modals */
export const EMBED_IFRAME_SANDBOX = "allow-scripts";

/** 高度下限 / 上限（CSS px）。超上限的图在 iframe 里自己滚动；下限防一张空图塌成一条线 */
export const EMBED_MIN_HEIGHT = 48;
export const EMBED_MAX_HEIGHT = 720;
/** 第一次挂、还没量到高度时占的高（量过的会记在缓存里，回到视口重挂时直接用，不跳） */
export const EMBED_DEFAULT_HEIGHT = 200;
/** 挂上之后多久还没收到 ready 就算超时（死循环、脚本卡住），卸掉 iframe、退回源码 */
export const EMBED_READY_TIMEOUT_MS = 5000;
/** 错误原因最长字符数（一行） */
export const EMBED_ERROR_MAX_CHARS = 160;

/** 消息信封的标记字段：别的东西（看板卡、浏览器扩展）发来的消息不会碰巧带它 */
const ENVELOPE = "orbitaEmbed";

/** 围栏语言是不是内嵌交互图（大小写不敏感，只认整词） */
export function isHtmlEmbedLang(lang: string | undefined): boolean {
  return lang !== undefined && lang.toLowerCase() === HTML_EMBED_LANG;
}

// ---------- iframe → 宿主 ----------

export type EmbedMessage =
  | { kind: "ready"; height: number | null }
  | { kind: "height"; height: number }
  /** 指针进出 iframe：iframe 是独立进程的框架，指针在里面时外层收不到 :hover，悬停键要靠它来亮 */
  | { kind: "pointer"; inside: boolean }
  /** blocked = 外链资源被 CSP 拦下（message 是被拦的地址）；script = 脚本异常（message 可能为空） */
  | { kind: "error"; code: "script" | "blocked"; message: string };

/**
 * 高度钳到 [EMBED_MIN_HEIGHT, EMBED_MAX_HEIGHT] 并取整；不是有限的正数（负数、0、NaN、Infinity、字符串）回 null——
 * null 表示「忽略这条」，不是「设成 0」：图不能被一条坏消息压没。
 */
export function clampEmbedHeight(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(EMBED_MAX_HEIGHT, Math.max(EMBED_MIN_HEIGHT, Math.ceil(value)));
}

/** 解析 iframe 发来的一条消息；不是我们的信封、type 不认识、字段不合规都回 null */
export function parseEmbedMessage(data: unknown): EmbedMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record[ENVELOPE] !== 1) return null;
  switch (record["type"]) {
    case "ready":
      return { kind: "ready", height: clampEmbedHeight(record["height"]) };
    case "height": {
      const height = clampEmbedHeight(record["height"]);
      return height === null ? null : { kind: "height", height };
    }
    case "pointer":
      return typeof record["inside"] === "boolean" ? { kind: "pointer", inside: record["inside"] } : null;
    case "error": {
      const raw = record["message"];
      const code = record["code"] === "blocked" ? "blocked" : "script";
      const text = (typeof raw === "string" ? raw : "").replace(/\s+/g, " ").trim();
      const message = text.length > EMBED_ERROR_MAX_CHARS ? `${text.slice(0, EMBED_ERROR_MAX_CHARS)}…` : text;
      return { kind: "error", code, message };
    }
    default:
      return null;
  }
}

// ---------- 宿主 → iframe ----------

export interface EmbedThemeMessage {
  orbitaEmbed: 1;
  type: "theme";
  scheme: "light" | "dark";
  vars: Record<string, string>;
}

export interface EmbedActiveMessage {
  orbitaEmbed: 1;
  type: "active";
  active: boolean;
}

export function themeMessage(theme: PanelTheme): EmbedThemeMessage {
  return { orbitaEmbed: 1, type: "theme", scheme: theme.scheme, vars: { ...theme.vars } };
}

export function activeMessage(active: boolean): EmbedActiveMessage {
  return { orbitaEmbed: 1, type: "active", active };
}

// ---------- 文档 ----------

/**
 * 常见的别名：模型在别处（Claude 的可视化、MCP Apps 规范）学到的变量名，映射到我们下发的那套，
 * 写了别家的名字也能跟主题走。只收最常用的几个，不追全。
 */
const VAR_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["--color-background-primary", "--color-bg-panel"],
  ["--color-background-secondary", "--color-bg-muted"],
  ["--color-border-primary", "--color-border-strong"],
  ["--color-border-secondary", "--color-border-default"],
  ["--color-border-tertiary", "--color-border-subtle"],
  ["--color-text-info", "--color-info"],
  ["--color-text-success", "--color-success"],
  ["--color-text-warning", "--color-warning"],
  ["--color-text-danger", "--color-danger"],
  ["--font-sans", "--font-family-base"],
  ["--font-mono", "--font-family-mono"],
  ["--border-radius-md", "--radius-md"],
];

/** CSS 值里不许出现能跳出 `<style>` 或声明块的字符（值来自我们自己的计算样式，这里只是兜底） */
function safeCssValue(value: string): string {
  return value.replace(/[<>{};\\]/g, "");
}

/** 主题变量 → `:root { … }` 的声明串 */
export function themeDeclarations(theme: PanelTheme): string {
  const lines = Object.entries(theme.vars)
    .filter(([name]) => /^--[a-z0-9-]+$/.test(name))
    .map(([name, value]) => `${name}:${safeCssValue(value)};`);
  for (const [alias, target] of VAR_ALIASES) lines.push(`${alias}:var(${target});`);
  lines.push(`color-scheme:${theme.scheme};`);
  return lines.join("");
}

/**
 * 预置样式：透明底（宿主给底色）、正文跟随界面字号与字体、几种常用控件长得像 Orbita 的安静控件。
 * 模型写的样式在后面，想覆盖随便覆盖。值全是变量——这里不写死任何颜色。
 */
const BASE_CSS = [
  "*,*::before,*::after{box-sizing:border-box}",
  "html,body{margin:0;padding:0;background:transparent}",
  // flow-root：首尾子元素的外边距不穿出 body 折叠掉——否则量到的高度少了这两段，图底部被裁（Kimi 的快排图实测少 14px+）
  "body{display:flow-root;color:var(--color-text-primary);font-family:var(--font-family-base);font-size:var(--font-size-base);line-height:1.5;overflow-wrap:anywhere}",
  "button{font:inherit;font-size:var(--font-size-sm);color:var(--color-text-secondary);background:transparent;border:1px solid var(--color-border-default);border-radius:var(--radius-md);padding:4px 12px;min-height:28px;cursor:pointer}",
  "button:hover{background:var(--color-bg-muted);color:var(--color-text-primary)}",
  "button:disabled{opacity:.5;cursor:default}",
  "button:focus-visible{outline:2px solid var(--color-accent);outline-offset:1px}",
  "svg{max-width:100%;height:auto}",
  "code{font-family:var(--font-family-mono);font-size:.92em}",
  "html.orbita-paused *,html.orbita-paused *::before,html.orbita-paused *::after{animation-play-state:paused!important}",
  "@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}",
].join("\n");

/**
 * 引导脚本（在 iframe 里跑，先于模型的脚本）。写成 ES5 风格的一段字符串：它进的是另一个文档，不走打包。
 * 不含 `</script` 字样（会提前结束标签）。
 */
const BOOTSTRAP = `(function(){
var P=window.parent,T=${JSON.stringify(ENVELOPE)};
function send(m){m[T]=1;try{P.postMessage(m,"*")}catch(e){}}
var raf=window.requestAnimationFrame.bind(window),caf=window.cancelAnimationFrame.bind(window);
var paused=false,held=new Map(),seq=0;
window.requestAnimationFrame=function(cb){if(!paused)return raf(cb);seq+=1;var k=-seq;held.set(k,cb);return k};
window.cancelAnimationFrame=function(k){if(k<0)held.delete(k);else caf(k)};
function setPaused(p){if(p===paused)return;paused=p;var r=document.documentElement;if(p)r.classList.add("orbita-paused");else{r.classList.remove("orbita-paused");var list=Array.from(held.values());held.clear();list.forEach(function(cb){raf(cb)})}}
var last=-1,queued=false;
function height(){var b=document.body;if(!b)return 0;var r=document.documentElement.getBoundingClientRect();return Math.ceil(Math.max(r.height,b.scrollHeight,b.getBoundingClientRect().bottom))}
function report(){queued=false;var h=height();if(h>0&&h!==last){last=h;send({type:"height",height:h})}}
function schedule(){if(queued)return;queued=true;raf(report)}
var errors=0;
function fail(code,msg){if(errors>=3)return;errors+=1;send({type:"error",code:code,message:String(msg||"")})}
window.addEventListener("error",function(e){fail("script",e.message||(e.error&&e.error.message)||"")});
window.addEventListener("unhandledrejection",function(e){var r=e.reason;fail("script",r&&r.message?r.message:String(r))});
document.addEventListener("securitypolicyviolation",function(e){var d=e.effectiveDirective||e.violatedDirective||"";if(d.indexOf("script")===0)fail("blocked",e.blockedURI||d)});
window.addEventListener("message",function(e){if(e.source!==P)return;var m=e.data;if(!m||m[T]!==1)return;
if(m.type==="active")setPaused(!m.active);
else if(m.type==="theme"&&m.vars){var s=document.documentElement.style;Object.keys(m.vars).forEach(function(k){if(/^--[a-z0-9-]+$/.test(k))s.setProperty(k,String(m.vars[k]))});s.setProperty("color-scheme",m.scheme==="dark"?"dark":"light")}});
document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(a){var h=a.getAttribute("href")||"";if(h.charAt(0)!=="#")e.preventDefault()}},true);
document.documentElement.addEventListener("mouseenter",function(){send({type:"pointer",inside:true})});
document.documentElement.addEventListener("mouseleave",function(){send({type:"pointer",inside:false})});
document.addEventListener("DOMContentLoaded",function(){var ro=new ResizeObserver(schedule);ro.observe(document.documentElement);if(document.body)ro.observe(document.body);schedule()});
window.addEventListener("load",function(){var h=height();last=h;send({type:"ready",height:h});if(document.fonts&&document.fonts.ready)document.fonts.ready.then(schedule)});
})();`;

/**
 * 模型的片段 → 完整文档。片段可以是纯片段（推荐），也可以自带 `<!doctype>` / `<html>` / `<head>` / `<body>`：
 * 浏览器把正文里重复出现的这几个标签合并掉，我们的 head 仍然最先生效。
 */
export function buildEmbedDocument(source: string, theme: PanelTheme): string {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<style>:root{${themeDeclarations(theme)}}\n${BASE_CSS}</style>`,
    `<script>${BOOTSTRAP}</script>`,
    "</head><body>",
    source,
    "</body></html>",
  ].join("\n");
}

// ---------- 量过的高度 ----------

/** 最多记多少张图的高度（键是源码；一张图几十字节，上限只是防长跑会话无限涨） */
const HEIGHT_CACHE_LIMIT = 300;

/**
 * 量过的高度（按源码记，模块级）：iframe 离开视口被卸、回来重挂，或流式结束后换了一次组件，占位直接用上次量的高，
 * 对话不跳。只在内存里，重启应用后第一次挂会从默认高度长到真实高度一次。
 */
export class EmbedHeightCache {
  private readonly map = new Map<string, number>();
  private readonly limit: number;

  constructor(limit = HEIGHT_CACHE_LIMIT) {
    this.limit = limit;
  }

  get(source: string): number | undefined {
    return this.map.get(source);
  }

  set(source: string, height: number): void {
    // 先删再放：Map 按插入序，最近用过的排到最后，超限时删最前面那个
    this.map.delete(source);
    this.map.set(source, height);
    if (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

export const embedHeights = new EmbedHeightCache();
