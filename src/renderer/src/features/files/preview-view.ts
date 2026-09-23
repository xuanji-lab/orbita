/**
 * 文件预览面板的**纯视图函数**（判定文本预览形态 / 截断提示文案）。独立成模块
 * 而不是塞进 tree-view.ts，理由同它与 useFileTree.ts 的分工：FilePreviewPane.tsx
 * 要连 IPC + React state，这里只留纯函数，`node --test` 直接可测。
 *
 * `highlight.ts` 是纯模块（shiki/core 用 JS 正则引擎，没有 DOM 依赖，
 * `highlight.test.ts` 已经证实 `node --test` 能直接加载它），这里直接复用
 * `langFromPath` 判「代码」形态——不重新发明一份扩展名判定表，contract 里也明说
 * 「怎么排版只有 renderer 关心」，判定逻辑天然该复用已有的这一份。
 */
import { langFromPath } from "../chat/highlight.ts";
import { formatSize } from "./tree-view.ts";

/** md 系扩展名：默认渲染（MarkdownBlock），不进 highlight.ts 的代码语言判定 */
const MARKDOWN_EXTS = new Set(["md", "mdx", "markdown"]);

/** 名字里「扩展名」那一段：取最后一个 `.` 之后的部分，小写；无扩展名 / 点文件回空串 */
function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 文本文件的预览形态：md 系默认渲染；`highlight.ts` 认得语言的走代码高亮；
 * 其余（含无扩展名的 LICENSE / Makefile、highlight.ts 没预置的扩展名）等宽原文。
 */
export function textPreviewMode(name: string): "markdown" | "code" | "plain" {
  if (MARKDOWN_EXTS.has(extOf(name))) return "markdown";
  return langFromPath(name) === null ? "plain" : "code";
}

/**
 * 代码高亮的体积上限（200 KB）：shiki 在几 MB 的文件上会明显卡顿，且
 * `highlight.ts` 的 HTML 缓存没有上限——超过这个数退回等宽原文，不进高亮管线。
 */
export const HIGHLIGHT_LIMIT = 200 * 1024;

/** 截断提示：`Showing the first 2 MB of 14.3 MB`。 */
export function truncatedNotice(shownBytes: number, totalBytes: number): string {
  return `Showing the first ${formatSize(shownBytes)} of ${formatSize(totalBytes)}`;
}
