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
import { PREVIEW_HIGHLIGHT_LIMIT, PREVIEW_MARKDOWN_LIMIT, PREVIEW_ROW_CHARS, PREVIEW_WINDOW_LIMIT } from "../../../../shared/files.ts";
import { langFromPath } from "../chat/highlight.ts";
import { formatSize } from "./tree-view.ts";
import type { Messages } from "../../messages-en.ts";

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




/** 窗口化时可视区上下各多渲多少行：预读够一次滚轮 / 一次 PageDown 不露白 */
export const WINDOW_OVERSCAN = 200;

/**
 * 一段文本该走哪条渲染路径。
 * - `markdown`：MarkdownBlock（小于 PREVIEW_MARKDOWN_LIMIT 的 md，现有行为）
 * - `highlight`：shiki 代码高亮（小于 PREVIEW_HIGHLIGHT_LIMIT 的代码，现有行为）
 * - `windowed`：只渲染可视区附近的行（大文件；也是最省内存的那条）
 * - `plain`：整篇等宽原文（小文件，一个文本节点）
 *
 * 阈值判定用 `<=`：恰好等于上限时仍走上限那侧（128 KB 的 md 在 64 KB 上限下退化，
 * 64 KB 整的仍是 markdown）。
 */
export type TextRenderKind = "markdown" | "highlight" | "windowed" | "plain";

export function textRenderKind(
  previewMode: "markdown" | "code" | "plain",
  mode: "rendered" | "source",
  length: number,
): TextRenderKind {
  if (previewMode === "markdown" && mode === "rendered" && length <= PREVIEW_MARKDOWN_LIMIT) {
    return "markdown";
  }
  if (previewMode === "code" && length <= PREVIEW_HIGHLIGHT_LIMIT) return "highlight";
  if (length > PREVIEW_WINDOW_LIMIT) return "windowed";
  return "plain";
}

/** 按行切分（保留末尾换行造成的那个空行，与 `<pre>` 的显示一致） */
export function textLines(text: string): string[] {
  return text.split("\n");
}


/**
 * 窗口化正文的显示行：先按 `\n` 切行，再把超过 `maxChars` 的行硬切成多条。
 * 纯函数（`node --test` 可测）；只影响显示，不动原始文本。
 *
 * 切分点落在代理对中间时多带一个码元——否则 emoji / 罕用字会变成两个孤立代理码元，
 * 渲染成两个替换方块（与主进程那边 UTF-8 截断回退同一类问题）。
 */
export function textRows(text: string, maxChars: number = PREVIEW_ROW_CHARS): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  const rows: string[] = [];
  for (const line of textLines(text)) {
    if (line.length <= limit) {
      rows.push(line);
      continue;
    }
    let at = 0;
    while (at < line.length) {
      let end = Math.min(line.length, at + limit);
      if (end < line.length) {
        const code = line.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end += 1; // 高代理码元：把低代理一起带走
      }
      rows.push(line.slice(at, end));
      at = end;
    }
  }
  return rows;
}

/** 一帧要渲染的窗口：`[start, end)` 的行，外加顶部 / 底部占位行数 */
export interface TextWindow {
  totalLines: number;
  start: number;
  end: number;
  /** 顶部占位行数（= start） */
  padTop: number;
  /** 底部占位行数 */
  padBottom: number;
}

/**
 * 算当前该渲染哪几行。纯函数（`node --test` 直接可测），组件只管把 scrollTop /
 * 视口高度 / 行高喂进来。
 *
 * - `rowHeight <= 0`（还没量出行高，首帧就是这种情况）：只给首屏 + 上下 overscan
 *   那一段，绝不退化成「全渲染」。
 * - 滚到底：`end` 夹到 `totalLines`，`padBottom` 归零。
 * - 文件比一屏还短：`start = 0`、`end = totalLines`，占位都是 0。
 */
export function textWindow(
  totalLines: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number = WINDOW_OVERSCAN,
): TextWindow {
  const total = Math.max(0, Math.floor(totalLines));
  const pad = Math.max(0, Math.floor(overscan));
  if (total === 0) return { totalLines: 0, start: 0, end: 0, padTop: 0, padBottom: 0 };
  if (!(rowHeight > 0)) {
    const end = Math.min(total, 2 * pad + 1);
    return { totalLines: total, start: 0, end, padTop: 0, padBottom: total - end };
  }
  const firstVisible = Math.min(total - 1, Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight)));
  const visibleRows = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / rowHeight));
  const start = Math.max(0, firstVisible - pad);
  const end = Math.min(total, firstVisible + visibleRows + pad);
  return { totalLines: total, start, end, padTop: start, padBottom: total - end };
}

/**
 * 大文件提示条的文案（没有提示条时 null）。大文本被截断 / 退化时，用户要知道
 * 「看到的不是全部」，条上还要有出口（用默认应用打开，由组件补）——所以文案按
 * 走了哪条路径分开说：
 * - md 退化：排版形态变了（Markdown → 纯文本），说清「按纯文本显示」；
 * - 窗口化：txt / 代码的排版没变，变的是「只渲染可见区」，说清这一点。
 *
 * md 的 Source 模式不提示：用户自己切到源码看的，不是退化。
 */
export function largeTextNotice(
  previewMode: "markdown" | "code" | "plain",
  mode: "rendered" | "source",
  textLength: number,
  sizeBytes: number,
  t: Messages,
): string | null {
  const kind = textRenderKind(previewMode, mode, textLength);
  const degradedMd = previewMode === "markdown" && mode === "rendered";
  if (kind === "windowed") {
    return degradedMd
      ? t.files.largeTextPlain(formatSize(sizeBytes))
      : t.files.largeTextWindowed(formatSize(sizeBytes));
  }
  if (kind === "plain" && degradedMd) return t.files.largeTextPlain(formatSize(sizeBytes));
  return null;
}

/** 截断提示：`Showing the first 16 MB of 140 MB`。 */
export function truncatedNotice(shownBytes: number, totalBytes: number, t: Messages): string {
  return t.files.truncated(formatSize(shownBytes), formatSize(totalBytes));
}
