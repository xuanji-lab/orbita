import type { IconName } from "../../shell/Icon.tsx";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";

/**
 * 内置命令注册表 —— 聊天过程行怎么显示「原生内置命令」的**唯一真源**。
 *
 * 内置命令（slides_create、doc_open …）是 agent 侧的真工具（`src/agent/*-tools.ts`），
 * 过程行不显示英文 id，而是：`[图标] 中文名  参数摘要`（「新建演示文稿 · 花园城市新加坡 · 16:9」）。
 * 展开能看到完整参数与结果（走通用的 PlainToolBody，不在这里）。
 *
 * **加一个命令 = 在 BUILTIN_COMMANDS 里加一项**，其余（行首、图标、摘要、不并组、完成卡）自动跟上：
 * - `label`：中文名；
 * - `icon`：lucide 图标（IconName，须已在 Icon.tsx 登记）；
 * - `summary(input)`：从工具入参摘一句话；缺字段 / 类型不对 = null（宁缺毋编）；
 * - `pinCard`：完成后在轮尾钉一张卡（工具结果 `details.card`，约定见 shared/builtin-command.ts）。
 *
 * 结果 details 里的 `openPanel` 由 App 的自动开面板钩子读（`useAutoOpenPanel.ts`），不经本表。
 */
export interface BuiltinCommand {
  label: string;
  icon: IconName;
  summary(input: unknown): string | null;
  /** 完成后钉一张卡（折叠之外、结尾回复之前）；缺席 = 只有过程行 */
  pinCard?: boolean;
}

function record(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
}

function str(input: unknown, key: string): string | null {
  const value = record(input)?.[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function num(input: unknown, key: string): number | null {
  const value = record(input)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 路径取文件名；演示文稿去掉 .slides.json，让摘要读起来是「标题」而不是文件名 */
export function fileLabel(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.replace(/\.slides\.json$/i, "").replace(/\.md$/i, "");
}

/** 1-based 页号集合 → 「第 3 页」「第 1–5 页」「第 1、3、5 页」 */
export function pagesLabel(pages: readonly number[]): string | null {
  const sorted = [...new Set(pages.filter((n) => Number.isInteger(n) && n >= 1))].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const first = sorted[0] as number;
  const last = sorted[sorted.length - 1] as number;
  if (sorted.length === 1) return `第 ${first} 页`;
  if (last - first + 1 === sorted.length) return `第 ${first}–${last} 页`;
  return `第 ${sorted.join("、")} 页`;
}

const KIND_NAME: Readonly<Record<string, string>> = {
  text: "文字",
  image: "图片",
  table: "表格",
  shape: "形状",
  line: "线条",
};

/** 一批元素 → 「文字 ×3 · 表格 · 箭头」；line 带箭头头时叫「箭头」 */
function elementTally(elements: readonly unknown[]): string | null {
  const counts = new Map<string, number>();
  for (const element of elements) {
    const item = record(element);
    if (item === null) continue;
    const kind = typeof item["kind"] === "string" ? item["kind"] : "";
    const arrow = kind === "line" && (item["endArrow"] === "arrow" || item["startArrow"] === "arrow");
    const name = arrow ? "箭头" : (KIND_NAME[kind] ?? "");
    if (name === "") continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const parts = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
  return parts.length === 0 ? null : parts.join(" · ");
}

function join(parts: readonly (string | null)[]): string | null {
  const real = parts.filter((part): part is string => part !== null && part !== "");
  return real.length === 0 ? null : real.join(" · ");
}

function slidesWriteSummary(input: unknown): string | null {
  const slides = record(input)?.["slides"];
  if (!Array.isArray(slides) || slides.length === 0) {
    // 单页写法：{ slide, elements }
    const at = record(input)?.["slide"];
    const elements = record(input)?.["elements"];
    const where = at === "append" ? "追加一页" : typeof at === "number" ? pagesLabel([at]) : null;
    return join([where, Array.isArray(elements) ? elementTally(elements) : null]);
  }
  const numbered: number[] = [];
  let appended = 0;
  const all: unknown[] = [];
  for (const entry of slides) {
    const item = record(entry);
    if (item === null) continue;
    const at = item["at"];
    if (typeof at === "number") numbered.push(at);
    else appended += 1;
    if (Array.isArray(item["elements"])) all.push(...(item["elements"] as unknown[]));
  }
  const where = join([pagesLabel(numbered), appended > 0 ? `追加 ${appended} 页` : null]);
  return join([where, elementTally(all)]);
}

function slidesEditSummary(input: unknown): string | null {
  const ops = record(input)?.["ops"];
  if (!Array.isArray(ops) || ops.length === 0) return null;
  const pages: number[] = [];
  for (const entry of ops) {
    const item = record(entry);
    const slide = item?.["slide"];
    if (typeof slide === "number") pages.push(slide);
  }
  return join([pagesLabel(pages), ops.length > 1 ? `${ops.length} 处改动` : "1 处改动"]);
}

const FORMAT_NAME: Readonly<Record<string, string>> = {
  pdf: "PDF",
  html: "网页",
  png: "当前页图片",
  pptx: "PowerPoint · 保留字体",
  "pptx-basic": "PowerPoint · 通用字体",
};

export const BUILTIN_COMMANDS: Readonly<Record<string, BuiltinCommand>> = {
  slides_create: {
    label: "新建演示文稿",
    icon: FEATURE_ICON.slides,
    summary: (input) => join([str(input, "title"), str(input, "aspect")]),
    pinCard: true,
  },
  slides_read: {
    label: "读演示文稿",
    icon: FEATURE_ICON.slides,
    summary: (input) => {
      const path = str(input, "path");
      const slide = num(input, "slide");
      return join([path === null ? null : fileLabel(path), slide === null ? null : pagesLabel([slide])]);
    },
  },
  slides_write: {
    label: "写幻灯片",
    icon: "pencil-line",
    summary: slidesWriteSummary,
  },
  slides_edit: {
    label: "改幻灯片",
    icon: "pencil-line",
    summary: slidesEditSummary,
  },
  slides_insert_image: {
    label: "插入图片",
    icon: "image",
    summary: (input) => {
      const slide = num(input, "slide");
      const image = str(input, "image_path");
      return join([slide === null ? null : pagesLabel([slide]), image === null ? null : (image.split(/[\\/]/).pop() ?? image)]);
    },
  },
  slides_export: {
    label: "导出演示文稿",
    icon: "download",
    summary: (input) => {
      const format = str(input, "format");
      const page = num(input, "page");
      const name = format === null ? null : (FORMAT_NAME[format] ?? format);
      return join([name, format === "png" && page !== null ? pagesLabel([page]) : null]);
    },
    pinCard: true,
  },
};

export function builtinCommand(toolName: string): BuiltinCommand | null {
  return Object.hasOwn(BUILTIN_COMMANDS, toolName) ? (BUILTIN_COMMANDS[toolName] as BuiltinCommand) : null;
}

export function isBuiltinCommand(toolName: string): boolean {
  return builtinCommand(toolName) !== null;
}

/** 需要在轮尾钉卡的命令名（groupToolUnits / foldSegment 读） */
export const PINNED_CARD_COMMANDS: ReadonlySet<string> = new Set(
  Object.entries(BUILTIN_COMMANDS)
    .filter(([, command]) => command.pinCard === true)
    .map(([name]) => name),
);
