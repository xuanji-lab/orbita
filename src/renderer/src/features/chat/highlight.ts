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

/**
 * github-dark（旧版调色板）只有函数**声明**的规则（entity.name → #b392f0），
 * **调用位**（代码里的大多数 `foo()`）没有规则，落到与正文同色的默认前景——
 * 函数在代码里隐身（2026-09-04 用户反馈）。补一条 GitHub 新版暗色的函数紫
 * #d2a8ff：声明与调用一视同仁，且比旧紫亮一档。TextMate 最长 scope 胜出，
 * 这条会压过同名的宽规则。浅色主题不动。
 */
const GITHUB_DARK = {
  ...themeGithubDark,
  tokenColors: [
    ...(themeGithubDark.tokenColors ?? []),
    {
      scope: [
        "entity.name.function",
        "variable.function",
        "support.function",
        "meta.function-call entity.name.function",
        "meta.function-call.generic entity.name.function",
        "meta.function-call.method entity.name.function",
      ],
      settings: { foreground: "#d2a8ff" },
    },
  ],
};

type Highlighter = Awaited<ReturnType<typeof createHighlighterCore>>;

/** import 即预热；resolve 后 `highlightBlock` 才会真正产出 HTML */
export const highlighterReady: Promise<Highlighter> = createHighlighterCore({
  themes: [themeGithubLight, GITHUB_DARK],
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

/** 文件路径 → 可高亮语言名（按扩展名）；无扩展名、点文件、未预置语言返回 null。
 * 扩展名与 fence 同池归一——ts/md/py/yml/ps1 这些短名本就是语法自带别名。 */
export function langFromPath(path: string): string | null {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return resolveLang(base.slice(dot + 1).toLowerCase());
}

/** 行级 token：text 是片段原文，style 是 shiki 双主题内联样式（浅色 color + --shiki-dark 变量） */
export interface TokenSpan {
  text: string;
  style: Readonly<Record<string, string>> | undefined;
}

/** 一行的高亮结果：token 序列；拼起来等于该行原文 */
export type HighlightedLine = readonly TokenSpan[];

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

const lineCache = new Map<string, readonly HighlightedLine[]>();

/**
 * 代码 → 行级双主题 token（工具行展开体用：行号列要与正文逐行对齐，整块 HTML 拆不动）。
 * 引擎未就绪或语言未预置返回 null——调用方按纯文本行渲染，行号列照常有。
 */
export function highlightLines(code: string, fence: string): readonly HighlightedLine[] | null {
  if (highlighter === null) return null;
  const lang = resolveLang(fence);
  if (lang === null) return null;
  const key = `${lang}\u0000${code}`;
  const hit = lineCache.get(key);
  if (hit !== undefined) return hit;
  const { tokens } = highlighter.codeToTokens(code, {
    lang,
    themes: { light: "github-light", dark: "github-dark" },
  });
  const lines = tokens.map((line) =>
    line.map((token) => ({
      text: token.content,
      style:
        token.htmlStyle !== undefined && Object.keys(token.htmlStyle).length > 0
          ? token.htmlStyle
          : undefined,
    })),
  );
  lineCache.set(key, lines);
  return lines;
}
