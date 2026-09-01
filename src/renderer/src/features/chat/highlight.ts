/**
 * 聊天代码块的 shiki 高亮（B-1）。
 *
 * - **精简引入**：`shiki/core` + JS 正则引擎（免 Oniguruma WASM），语言与主题
 *   全部顶层静态 import（仓规禁 inline import），只装 14 种精选语言——
 *   未预置的 fence 静默无色，不报错。
 * - **双主题一次产出**：`codeToHtml` 带 `themes: { light, dark }`，每个 span 同时
 *   写入浅色内联色与 `--shiki-dark` 变量，明暗切换纯 CSS（styles.css），不重算。
 * - **初始化是异步的**：模块加载即起单例 `highlighterReady`；就绪前
 *   `highlightBlock` 返回 null，调用方先渲染无色代码块，就绪后重渲上色
 *   （每个组件实例只闪一次，之后缓存命中同步返回）。
 * - **缓存按「语言 + 内容」**：流式中增长中的代码块每次都是新 key、整块重算
 *   （与旧 rehype-highlight 同步路径等价，TextMate 引擎对小代码块足够快）。
 *   ponytail: Map 无上限——会话内块数 × 每块几 KB HTML，封顶几 MB；实测超了再换 LRU。
 *
 * 纯模块：不 import React，`node --test` 可直接加载（shiki 引擎无 DOM 依赖）。
 */
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import langBash from "shiki/langs/bash.mjs";
import langCss from "shiki/langs/css.mjs";
import langDiff from "shiki/langs/diff.mjs";
import langHtml from "shiki/langs/html.mjs";
import langJavascript from "shiki/langs/javascript.mjs";
import langJson from "shiki/langs/json.mjs";
import langJsx from "shiki/langs/jsx.mjs";
import langMarkdown from "shiki/langs/markdown.mjs";
import langPowershell from "shiki/langs/powershell.mjs";
import langPython from "shiki/langs/python.mjs";
import langToml from "shiki/langs/toml.mjs";
import langTsx from "shiki/langs/tsx.mjs";
import langTypescript from "shiki/langs/typescript.mjs";
import langYaml from "shiki/langs/yaml.mjs";

import themeGithubLight from "shiki/themes/github-light.mjs";
import themeGithubDark from "shiki/themes/github-dark.mjs";

type Highlighter = Awaited<ReturnType<typeof createHighlighterCore>>;

/** import 即预热；resolve 后 `highlightBlock` 才会真正产出 HTML */
export const highlighterReady: Promise<Highlighter> = createHighlighterCore({
  themes: [themeGithubLight, themeGithubDark],
  langs: [
    langBash,
    langCss,
    langDiff,
    langHtml,
    langJavascript,
    langJson,
    langJsx,
    langMarkdown,
    langPowershell,
    langPython,
    langToml,
    langTsx,
    langTypescript,
    langYaml,
  ],
  engine: createJavaScriptRegexEngine(),
});

let highlighter: Highlighter | null = null;
/** 已注册语言名集合（含语法自带的别名：ts/sh/shell/yml/py/ps1/js/cjs/mjs…） */
let loadedLangs: ReadonlySet<string> = new Set();

void highlighterReady.then((h) => {
  highlighter = h;
  loadedLangs = new Set(h.getLoadedLanguages());
});

/** 语法没注册的常用 fence 归一；grammar 自带别名已在 loadedLangs 里 */
const FENCE_ALIASES: Readonly<Record<string, string>> = {
  patch: "diff",
  jsonc: "json",
};

/** fence 名 → 可高亮语言名；未预置返回 null（调用方无色渲染） */
export function resolveLang(fence: string): string | null {
  const name = FENCE_ALIASES[fence] ?? fence;
  return loadedLangs.has(name) ? name : null;
}

const cache = new Map<string, string>();

/**
 * 代码块 → 双主题 HTML（`<pre class="shiki">…</pre>`，含内联浅色 + --shiki-dark 变量）。
 * 引擎未就绪或语言未预置返回 null——不抛错、不等待。
 */
export function highlightBlock(code: string, fence: string): string | null {
  if (highlighter === null) return null;
  const lang = resolveLang(fence);
  if (lang === null) return null;
  const key = `${lang}\u0000${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const html = highlighter.codeToHtml(code, {
    lang,
    themes: { light: "github-light", dark: "github-dark" },
  });
  cache.set(key, html);
  return html;
}
