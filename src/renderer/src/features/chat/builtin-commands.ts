import type { IconName } from "../../shell/Icon.tsx";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { readCommandCard } from "../../../../shared/builtin-command.ts";
import { CANVAS_SIZE } from "../../../../shared/slides.ts";

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
  /**
   * 展开体：给人看的「参数 + 结果」几行。缺席（或返回 null）= 展开体走通用的原样结果文本——
   * 那是写给模型的话（「Created … 0 slides … Next: fill it with …」），用户看了只会困惑。
   */
  detail?: (input: unknown, details: unknown) => DetailRow[] | null;
}

export interface DetailRow {
  label: string;
  value: string;
  /** 路径这类机器事实用等宽字体 */
  mono?: boolean;
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
  return name.replace(/\.slides\.json$/i, "").replace(/\.(?:md|markdown|txt)$/i, "");
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

/** 导出类命令的展开体：格式 / 文件 / 卡上的说明（「PPTX 通用字体 · 7 页」） */
function exportDetail(input: unknown, details: unknown, names: Readonly<Record<string, string>>): DetailRow[] | null {
  const card = readCommandCard(details);
  const format = str(input, "format");
  const rows: DetailRow[] = [
    ...(format === null ? [] : [{ label: "格式", value: names[format] ?? format }]),
    ...(card === null ? [] : [{ label: "文件", value: card.path, mono: true }]),
    ...(card?.subtitle === undefined ? [] : [{ label: "说明", value: card.subtitle }]),
  ];
  return rows.length === 0 ? null : rows;
}

const DOC_FORMAT_NAME: Readonly<Record<string, string>> = {
  docx: "Word",
  pdf: "PDF",
  md: "Markdown",
  "md-plain": "Markdown · 通用格式",
};

export const BUILTIN_COMMANDS: Readonly<Record<string, BuiltinCommand>> = {
  doc_open: {
    label: "打开文档",
    icon: FEATURE_ICON.doc,
    summary: (input) => {
      const path = str(input, "path");
      return join([path === null ? null : fileLabel(path), record(input)?.["create"] === true ? "新建" : null]);
    },
    pinCard: true,
    detail: (input, details) => {
      const card = readCommandCard(details);
      const path = card?.path ?? str(input, "path");
      if (path === null) return null;
      return [
        { label: "文件", value: path, mono: true },
        { label: "方式", value: record(input)?.["create"] === true ? "新建空文档并在文件面板打开" : "在文件面板打开" },
      ];
    },
  },
  doc_insert_image: {
    label: "插入图片",
    icon: "image",
    summary: (input) => {
      const path = str(input, "path");
      const image = str(input, "image_path");
      const line = num(input, "after_line");
      return join([
        path === null ? null : fileLabel(path),
        image === null ? null : (image.split(/[\\/]/).pop() ?? image),
        line === null ? null : `第 ${line} 行后`,
      ]);
    },
  },
  doc_export: {
    label: "导出文档",
    icon: "download",
    summary: (input) => {
      const path = str(input, "path");
      const format = str(input, "format");
      return join([format === null ? null : (DOC_FORMAT_NAME[format] ?? format), path === null ? null : fileLabel(path)]);
    },
    pinCard: true,
    detail: (input, details) => exportDetail(input, details, DOC_FORMAT_NAME),
  },
  slides_create: {
    label: "新建演示文稿",
    icon: FEATURE_ICON.slides,
    // 摘要 = 标题 · 画幅（没给画幅就是默认的 16:9）；其余（画布尺寸、文件）进展开体
    summary: (input) => {
      const title = str(input, "title");
      const aspect = str(input, "aspect");
      return title === null && aspect === null ? null : join([title, aspect ?? "16:9"]);
    },
    pinCard: true,
    detail: (input, details) => {
      const aspect = str(input, "aspect") === "4:3" ? "4:3" : "16:9";
      const canvas = CANVAS_SIZE[aspect];
      const card = readCommandCard(details);
      return [
        { label: "标题", value: str(input, "title") ?? card?.title ?? "" },
        { label: "画幅", value: `${aspect} · 画布 ${canvas.w}×${canvas.h}` },
        ...(card === null ? [] : [{ label: "文件", value: card.path, mono: true }]),
      ].filter((row) => row.value !== "");
    },
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
    detail: (input, details) => exportDetail(input, details, FORMAT_NAME),
  },
};

/**
 * 文档正文的改写仍是通用的 edit / write（`.md` 是真身）；落在文档文件（.md / .markdown / .txt）上时
 * 过程行的药丸写「改文档 / 写文档」而不是英文工具名。只改药丸文字，分组、diff 统计、展开体都照旧。
 */
export function docEditPath(toolName: string, input: unknown): string | null {
  if (toolName !== "edit" && toolName !== "write") return null;
  const path = str(input, "path");
  return path !== null && /\.(?:md|markdown|txt)$/i.test(path) ? path : null;
}

export function docEditLabel(toolName: string, input: unknown): string | null {
  if (docEditPath(toolName, input) === null) return null;
  return toolName === "edit" ? "改文档" : "写文档";
}

const HEADING_LINE = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;

function headingText(line: string): string | null {
  const match = HEADING_LINE.exec(line);
  if (match === null) return null;
  // 去掉标题里的行内标记（加粗 / 代码 / 双链括号），只留可读文字
  const text = (match[1] ?? "").replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2").replace(/[*_`~=]/g, "").trim();
  return text === "" ? null : text;
}

/**
 * 一次文档 edit 落在哪一节：先看 diff 里首个改动行之前最近的标题（pi 的 diff 带上下文，改动贴着标题时够用），
 * 再退到「此刻开着的这份文档全文」里按首个新增行回溯到上一个标题（改动离标题远时 diff 上下文里没有）。
 * 都找不到 = null（宁缺毋编）。
 */
export function docEditSection(
  rows: readonly { kind: "add" | "del" | "ctx"; text: string }[],
  docText: string | null,
): string | null {
  let heading: string | null = null;
  let firstAdded: string | null = null;
  for (const row of rows) {
    const title = headingText(row.text);
    if (title !== null) heading = title;
    if (row.kind !== "ctx") {
      if (row.kind === "add" && row.text.trim() !== "") firstAdded = row.text;
      break;
    }
  }
  if (heading !== null) return heading;
  if (docText === null || firstAdded === null) return null;
  const lines = docText.split("\n");
  const at = lines.findIndex((line) => line === firstAdded);
  if (at < 0) return null;
  for (let index = at; index >= 0; index -= 1) {
    const title = headingText(lines[index] ?? "");
    if (title !== null) return title;
  }
  return null;
}

/** 文档 edit / write 过程行的摘要：「文件名 · 第几节」（没有节就只有文件名） */
export function docEditSummary(path: string, section: string | null): string {
  return section === null ? fileLabel(path) : `${fileLabel(path)} · ${section}`;
}

/**
 * 统计 / 步骤行里的「工具词」：内置命令写中文名（不是 `doc_export` 这种英文 id），落在文档上的 edit / write
 * 写「改文档 / 写文档」（给了 input 才认得出），其余走原来的词表。
 */
export function toolWord(rollupTool: (key: string) => string, key: string, input?: unknown): string {
  return docEditLabel(key, input) ?? builtinCommand(key)?.label ?? rollupTool(key);
}

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
