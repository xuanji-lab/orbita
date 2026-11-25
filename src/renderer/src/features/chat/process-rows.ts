/**
 * 过程与产物怎么显示的纯推导（2026-11-22 用户讨论「最后一公里 · 文档与演示文稿」）。
 *
 * 用户原话：「本来设计这个卡片是为了最终产出的，但是它中间过程也会继承这个卡片」「更完整的工具调用的话，
 * 我希望语义能更统一一些」「完全折叠以后，我们其实只考虑产出，产出的话，结果都放在底部」。
 * 于是一轮只分两处：
 * - **过程**：每一步都是同一种行——动作（中文动词）· 对象 · 量，行尾可带缩略图；不出卡、不分胶囊 / 药丸。
 * - **产物**：这一轮做出来、交给用户的东西（演示文稿、文档、导出的文件），收在这一轮的结尾，一份一行。
 *
 * 纯模块：不 import React，可被 node --test 直接加载。
 */
import { readCommandCard } from "../../../../shared/builtin-command.ts";
import { mediaArtifactKind } from "../../../../shared/files.ts";
import type { MediaArtifact } from "../../../../shared/revert.ts";
import { parseQualifiedToolName } from "../../../../shared/mcp.ts";
import { skillForReadPath } from "../../../../shared/skill.ts";
import { builtinCommand, docEditPath, docEditLabel, fileLabel } from "./builtin-commands.ts";
import type { ProcessStep, ToolCallUnit, ToolResultIndex } from "./tool-results.ts";
import { toolCallSummary } from "./tool-results.ts";
import { processCalls } from "./turn-process.ts";

/** 过程行的中文动词（界面文案表给，中英各一份） */
export interface StepVerbWords {
  command: string;
  read: string;
  write: string;
  edit: string;
  list: string;
  find: string;
  search: string;
  readTask: string;
  plan: string;
  goal: string;
  terminal: string;
  document: string;
  image: string;
  config: string;
  plugin: string;
  /** 装插件 / 放插件看板：这两个工具各有动词，不笼统写「用插件」 */
  installPlugin: string;
  pluginBoard: string;
  askUser: string;
  report: string;
  delegate: string;
  reply: string;
  /** 子会话报告给主会话：按 kind 说（done / question / failed / progress） */
  reportDone: string;
  reportQuestion: string;
  reportFailed: string;
  reportProgress: string;
  memorySearch: string;
  memoryEdit: string;
  automation: string;
  web: string;
  browse: string;
  skill: string;
  other: string;
  mcp: (server: string) => string;
}

const VERB_OF_TOOL: Readonly<Record<string, keyof Omit<StepVerbWords, "mcp">>> = {
  bash: "command",
  powershell: "command",
  read: "read",
  write: "write",
  edit: "edit",
  ls: "list",
  find: "find",
  grep: "search",
  read_task: "readTask",
  update_plan: "plan",
  update_goal: "goal",
  terminal_open: "terminal",
  terminal_execute: "terminal",
  terminal_read: "terminal",
  terminal_list: "terminal",
  terminal_interrupt: "terminal",
  terminal_close: "terminal",
  read_pdf: "document",
  cite_pdf: "document",
  read_docx: "document",
  show_image: "image",
  create_skill: "config",
  add_mcp_server: "config",
  install_plugin: "installPlugin",
  preview_plugin: "plugin",
  list_plugins: "plugin",
  show_plugin_board: "pluginBoard",
  request_user_action: "askUser",
  report_to_parent: "report",
  delegate: "delegate",
  reply_subsession: "reply",
  memory_search: "memorySearch",
  memory_revise: "memoryEdit",
  memory_retire: "memoryEdit",
  automation_create: "automation",
  automation_list: "automation",
  automation_cancel: "automation",
  automation_update: "automation",
  web_search: "web",
  web_fetch: "browse",
};

export interface StepVerb {
  /** 行首的动作词：永远是中文（英文界面是英文），不露工具原名 */
  verb: string;
  /** 动作的对象：文件名、技能名、命令、页码……没有就 null */
  object: string | null;
  /** 工具原名：动词表里没有的工具落「用工具」，原名放悬停里，不藏起来 */
  raw: string | null;
}

/**
 * 一步工具调用 → 一行的「动作 · 对象」。技能、外接工具、内置命令、子会话、计划都走这里，
 * 区别只在动作词（和视图层挑的图标），不再各长一种胶囊 / 药丸 / 卡。
 */
export function stepVerb(
  toolName: string,
  input: unknown,
  words: StepVerbWords,
  skills: ReadonlyArray<{ slug: string; name: string }> = [],
  /** 子会话 id → 标题（回复子会话那一步写「回复了「标题」」）；不给就不写对象 */
  peerTitle?: (childId: string) => string,
): StepVerb {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  // 主会话回复子会话：「回复了「标题」」，展开看原文
  if (toolName === "reply_subsession") {
    const childId = str(record["childId"]);
    const title = childId === null || peerTitle === undefined ? "" : peerTitle(childId);
    return { verb: words.reply, object: title === "" ? null : `「${title}」`, raw: null };
  }
  // 子会话报告给主会话：「报告给主会话 / 问了主会话 / 报告失败」，对象是报告第一行
  if (toolName === "report_to_parent") {
    const kind = str(record["kind"]);
    const verb = kind === "question" ? words.reportQuestion : kind === "failed" ? words.reportFailed : kind === "progress" ? words.reportProgress : words.reportDone;
    const first = (str(record["text"]) ?? "").split("\n").find((line) => line.trim() !== "")?.trim() ?? null;
    return { verb, object: first, raw: null };
  }
  // 读某个技能的 SKILL.md = 在用这个技能
  if (toolName === "read" && typeof record["path"] === "string") {
    const skill = skillForReadPath(record["path"], skills);
    if (skill !== null) return { verb: words.skill, object: skill.name, raw: null };
  }
  const mcp = parseQualifiedToolName(toolName);
  if (mcp !== null) return { verb: words.mcp(mcp.server), object: mcpBrief(mcp.tool, input), raw: null };
  // 文档上的 edit / write：「改文档 / 写文档 · 文件名」
  const docLabel = docEditLabel(toolName, input);
  const docPath = docEditPath(toolName, input);
  if (docLabel !== null && docPath !== null) return { verb: docLabel, object: fileLabel(docPath), raw: null };
  const builtin = builtinCommand(toolName);
  if (builtin !== null) return { verb: builtin.label, object: builtin.summary(input), raw: null };
  if (toolName.startsWith("browser_")) return { verb: words.browse, object: str(record["url"]) ?? str(record["text"]) ?? null, raw: null };
  const key = VERB_OF_TOOL[toolName];
  const object = objectOf(toolName, record);
  if (key !== undefined) return { verb: words[key], object, raw: null };
  return { verb: words.other, object, raw: toolName };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter((part) => part !== "").pop() ?? path;
}

function objectOf(toolName: string, record: Record<string, unknown>): string | null {
  switch (toolName) {
    case "read":
    case "write":
    case "edit":
    case "read_pdf":
    case "read_docx":
    case "cite_pdf": {
      const path = str(record["path"]);
      return path === null ? null : basename(path);
    }
    case "ls": {
      const path = str(record["path"]);
      return path === null ? null : basename(path);
    }
    case "update_plan": {
      const items = record["items"];
      if (!Array.isArray(items)) return null;
      const rows = items.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
      const now = rows.find((item) => item["status"] === "in_progress");
      if (now !== undefined) return str(now["text"]);
      // 没有在做的那一步（全做完了，或只是改了清单）：写进度，不留空
      return rows.length === 0 ? null : `${rows.filter((item) => item["status"] === "done").length}/${rows.length}`;
    }
    case "update_goal":
      return str(record["goal"]);
    case "delegate":
      return str(record["title"]);
    case "show_image": {
      const paths = record["paths"];
      return Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string").map(basename).join("、") || null : null;
    }
    case "web_search":
      return str(record["query"]) ?? str(record["search_query"]);
    default:
      return toolCallSummary(toolName, record);
  }
}

/** 外接工具的对象：参数里第一个像话的字符串（查询词、URL、路径） */
function mcpBrief(tool: string, input: unknown): string {
  if (typeof input === "object" && input !== null) {
    for (const value of Object.values(input as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim() !== "") return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

// ───────────────────────── 留在过程外的行失败时 ─────────────────────────

export interface OutsideFailWords {
  actions: Readonly<Record<string, string>>;
  failed: (action: string) => string;
  notFound: string;
}

/**
 * 留在过程外的那些行（装插件、派活、交回、定时任务、放看板、给你看图、请你操作）成功时各有自己的卡，
 * 失败时走通用红行——行首以前是英文工具名（`install_plugin 失败`）。这里给它中文动作词：「装插件失败 · 路径不存在」。
 * 原因取错误文本第一行（截断），已知的「找不到」类换成一句中文；展开仍看错误原文。不认识的工具返回 null（照旧）。
 */
export function outsideFailure(toolName: string, errorText: string, words: OutsideFailWords): { head: string; reason: string | null } | null {
  const action = words.actions[toolName];
  if (action === undefined) return null;
  const first = errorText.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
  let reason: string | null = first === "" ? null : first.length > 80 ? `${first.slice(0, 80)}…` : first;
  if (/not found|ENOENT|no such file|does not exist/i.test(first)) reason = words.notFound;
  return { head: words.failed(action), reason };
}

// ───────────────────────── 产物 ─────────────────────────

/** 一份产物：结尾那一处收的一行 */
export interface TurnOutput {
  /**
   * 按**文件类型**分（2026-11-22 用户：「这个导出的文件是什么意思」）：演示文稿（含导出的 PowerPoint）、文档（含导出的 Word / Markdown）、
   * PDF、网页。不再有「导出的文件」这一类。`format` 非 null = 这份是导出来的文件：预览在文件面板里开，不进演示文稿 / 文档编辑面板。
   */
  kind: "slides" | "doc" | "pdf" | "web" | "audio" | "video";
  /** 绝对路径（去重键） */
  path: string;
  title: string;
  /** 演示文稿的页数（这一轮最后一次写 / 改之后的；量不到 null） */
  pages: number | null;
  /** 导出的格式名（PDF、PowerPoint、Word…，行尾类型字）；不是导出的 null */
  format: string | null;
  /** 导出文件的说明（「PDF · 3 页 · 171 KB」，工具结果卡上带的）；没有 null */
  detail: string | null;
  /** 音视频的时长（秒；agent 读容器头量到才有，量不到缺席 = 不显示） */
  duration?: number;
  /** 这份是哪个子会话交回来的（和主会话自己的产物摆在同一摞里，卡上多一行「来自子会话…」）；主会话自己的没有 */
  source?: OutputSource;
}

/** 来自哪个子会话：点那行小字打开它；模型名同子会话卡标题后的小字（modelDisplayName） */
export interface OutputSource {
  sessionId: string;
  title: string;
  modelName: string;
}

/** 写演示文稿的工具：结果里带「the deck now has N slide(s)」 */
const DECK_WRITERS = new Set(["slides_write", "slides_edit", "slides_insert_image"]);

/** PNG 是 agent 自己看排版用的（一页一张）：留在过程里当缩略图，不算交给用户的产物 */
const SELF_CHECK_EXPORT = new Set(["png"]);

/** 导出格式的类型字（中文界面的英文词白名单里没有 PPTX，写 PowerPoint） */
const FORMAT_NAME: Readonly<Record<string, string>> = {
  pdf: "PDF",
  html: "HTML",
  pptx: "PowerPoint",
  "pptx-basic": "PowerPoint",
  docx: "Word",
  md: "Markdown",
  "md-plain": "Markdown",
};

/** 导出的格式 → 归哪一类：PDF 自成一类，PowerPoint 并进演示文稿，Word / Markdown 并进文档，HTML 归网页 */
const KIND_OF_FORMAT: Readonly<Record<string, TurnOutput["kind"]>> = {
  pdf: "pdf",
  pptx: "slides",
  "pptx-basic": "slides",
  docx: "doc",
  md: "doc",
  "md-plain": "doc",
  html: "web",
};

function exportKind(format: string | null, path: string): { kind: TurnOutput["kind"]; format: string | null } {
  if (format !== null) return { kind: KIND_OF_FORMAT[format] ?? "doc", format: FORMAT_NAME[format] ?? format };
  // 入参没写格式：按扩展名认
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  const known = ext === "pptx" ? "pptx" : ext;
  return { kind: KIND_OF_FORMAT[known] ?? "doc", format: FORMAT_NAME[known] ?? (ext === "" ? null : ext.toUpperCase()) };
}

/** 导出文件的说明：类型字 + 工具结果卡上带的其余部分（「3 页 · 171 KB」）；卡上第一段是工具自己的格式名（PPTX），换成类型字 */
function exportDetail(format: string | null, subtitle: string | undefined): string | null {
  if (format === null) return subtitle ?? null;
  const rest = subtitle === undefined ? [] : subtitle.split(" · ").slice(1);
  return [format, ...rest].join(" · ");
}

function inputPath(call: ToolCallUnit): string | null {
  const value = (call.input as Record<string, unknown> | null)?.["path"];
  return typeof value === "string" && value !== "" ? value : null;
}

function resultText(results: ToolResultIndex, call: ToolCallUnit): string {
  const result = results.get(call.toolCallId);
  if (result === undefined) return "";
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

/** 「the deck now has 3 slide(s)」「the deck has 3 slide(s)」→ 3 */
export function deckPagesFrom(text: string): number | null {
  const match = /the deck (?:now )?has (\d+) slide/.exec(text);
  return match === null ? null : Number(match[1]);
}

/**
 * 一轮里交给用户的产物，按第一次出现的顺序，一份一行。
 * - 演示文稿：新建或写过的那份；页数取这一轮最后一次写 / 改的结果。
 * - 文档：打开过（doc_open）的那份。
 * - 导出：PDF / Word / PPTX / HTML 是交给用户的文件；PNG 是自检，留在过程里。
 * 失败的调用不算；还在跑的不算。
 */
export function turnOutputs(calls: readonly ToolCallUnit[], results: ToolResultIndex): TurnOutput[] {
  const byPath = new Map<string, TurnOutput>();
  const order: string[] = [];
  const put = (output: TurnOutput) => {
    const prev = byPath.get(output.path);
    if (prev === undefined) order.push(output.path);
    byPath.set(output.path, { ...prev, ...output, pages: output.pages ?? prev?.pages ?? null });
  };
  // 演示文稿的路径：create 结果卡上的是真路径；模型之后传的 path 可能是相对的，按文件名对回去
  const deckByName = new Map<string, string>();
  const deckPath = (raw: string | null): string | null => {
    if (raw === null) return null;
    return deckByName.get(basename(raw)) ?? raw;
  };
  for (const call of calls) {
    const result = results.get(call.toolCallId);
    if (result === undefined || result.status !== "complete") continue;
    const card = readCommandCard(result.details);
    if (call.toolName === "slides_create" && card !== null) {
      deckByName.set(basename(card.path), card.path);
      put({ kind: "slides", path: card.path, title: card.title, pages: 0, format: null, detail: null });
      continue;
    }
    if (DECK_WRITERS.has(call.toolName)) {
      const path = deckPath(inputPath(call));
      if (path === null) continue;
      const prev = byPath.get(path);
      put({ kind: "slides", path, title: prev?.title ?? fileLabel(path), pages: deckPagesFrom(resultText(results, call)), format: null, detail: null });
      continue;
    }
    if (call.toolName === "doc_open" && card !== null) {
      put({ kind: "doc", path: card.path, title: card.title, pages: null, format: null, detail: null });
      continue;
    }
    if ((call.toolName === "slides_export" || call.toolName === "doc_export") && card !== null) {
      const format = str((call.input as Record<string, unknown> | null)?.["format"]);
      if (format !== null && SELF_CHECK_EXPORT.has(format)) continue;
      const made = exportKind(format, card.path);
      put({ kind: made.kind, path: card.path, title: card.title, pages: null, format: made.format, detail: exportDetail(made.format, card.subtitle) });
    }
  }
  return order.map((path) => byPath.get(path)).filter((output): output is TurnOutput => output !== undefined);
}

/**
 * 这一轮写出来的文件（文件账里的绝对路径）→ 产物：网页（2026-11-22 用户：「这个东西就应该放在，就是单独一个卡片……
 * 而不是放在编辑了哪些文件的这个框框里面」）与文档（「它们就是跟文档是同一个功能……应该有个预览的卡片」）。去重、按出现顺序。
 */
export function fileOutputs(kind: "web" | "doc", paths: readonly string[]): TurnOutput[] {
  const seen = new Set<string>();
  const out: TurnOutput[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ kind, path, title: basename(path), pages: null, format: null, detail: null });
  }
  return out;
}

/**
 * 回答里点了名的音视频 → 产物行（类型由扩展名定，量得到时长就带上）。调用方已按点名过滤（named-outputs.ts）。
 */
export function mediaOutputs(media: readonly MediaArtifact[]): TurnOutput[] {
  const out: TurnOutput[] = [];
  for (const item of media) {
    const kind = mediaArtifactKind(item.path);
    if (kind === null) continue;
    out.push({ kind, path: item.path, title: basename(item.path), pages: null, format: null, detail: null, ...(item.duration !== undefined ? { duration: item.duration } : {}) });
  }
  return out;
}

/**
 * 结尾这一摞产物：工具做出来的（演示文稿、文档、导出）+ 这一轮写的文档 + 网页，按路径去重（doc_open 打开过、
 * 又被 edit 改过的文档只算一份）。顺序：演示文稿与文档在前，导出的文件，最后网页。
 */
/** 结尾那摞的顺序：演示文稿与文档在前，PDF，最后网页；同一类里保持原顺序（稳定排序） */
export function sortOutputs(outputs: readonly TurnOutput[]): TurnOutput[] {
  const order = (output: TurnOutput) =>
    output.kind === "slides" || output.kind === "doc" ? 0 : output.kind === "pdf" ? 1 : output.kind === "audio" ? 2 : output.kind === "video" ? 3 : 4;
  return [...outputs].sort((a, b) => order(a) - order(b));
}

/**
 * 主会话自己的产物与子会话交回的产物合成同一摞（2026-11-22 用户：「让它跟主会话的产出摆在一起」）：主会话的在前、子会话的在后
 * （主会话的是给用户的答案本身，子会话的是它派出去的活的产出；子会话之间按交回先后），再按类稳定排序，同一类相邻——
 * 三份以上收组时主会话与子会话合计算。同一路径只留一份（主会话的）。
 */
export function mergeOutputs(main: readonly TurnOutput[], fromChildren: readonly TurnOutput[]): TurnOutput[] {
  const norm = (path: string) => path.replace(/\\/g, "/");
  const seen = new Set(main.map((output) => norm(output.path)));
  const extra: TurnOutput[] = [];
  for (const output of fromChildren) {
    if (seen.has(norm(output.path))) continue;
    seen.add(norm(output.path));
    extra.push(output);
  }
  return sortOutputs([...main, ...extra]);
}

export function allOutputs(
  calls: readonly ToolCallUnit[],
  results: ToolResultIndex,
  docs: readonly string[],
  web: readonly string[],
  media: readonly MediaArtifact[] = [],
): TurnOutput[] {
  const norm = (path: string) => path.replace(/\\/g, "/");
  const made = turnOutputs(calls, results);
  const seen = new Set(made.map((output) => norm(output.path)));
  const more = [...fileOutputs("doc", docs), ...fileOutputs("web", web), ...mediaOutputs(media)].filter((output) => !seen.has(norm(output.path)));
  return sortOutputs([...made, ...more]);
}


// ───────────────────────── 缩略图 ─────────────────────────

/**
 * 过程里出现过的图：工具结果里的图（读图、读 PDF 页图）或导出到盘上的图（PNG 自检）。
 * `key` 是「这张图是哪张」：盘上的图按路径认，同一个文件先被导出、再被读回来看，是同一张。
 */
export type ProcessImage =
  | { kind: "inline"; key: string; data: string; mimeType: string; name: string }
  | { kind: "file"; key: string; path: string; name: string };

/** 一行最多露几张缩略图；多的不再画，旁边写总数 */
export const THUMBS_SHOWN = 3;

function pathKey(path: string): string {
  return path.replace(/\\/g, "/");
}

/** 一步自己带出来的图（不管前面出现过没有） */
export function stepImages(call: ToolCallUnit, results: ToolResultIndex): ProcessImage[] {
  const result = results.get(call.toolCallId);
  if (result === undefined || result.status !== "complete") return [];
  const images: ProcessImage[] = [];
  const path = inputPath(call);
  const blocks = result.content.filter((block): block is Extract<(typeof result.content)[number], { type: "image" }> => block.type === "image");
  blocks.forEach((block, index) => {
    // 读一张图：就是那个文件；读 PDF 这类一次出几页：按页认
    const key = path === null ? `${call.toolCallId}:${index}` : blocks.length === 1 ? pathKey(path) : `${pathKey(path)}#${index}`;
    images.push({ kind: "inline", key, data: block.data, mimeType: block.mimeType, name: path === null ? call.toolName : basename(path) });
  });
  if (images.length > 0) return images;
  if (call.toolName === "slides_export") {
    const card = readCommandCard(result.details);
    if (card !== null && /\.png$/i.test(card.path)) images.push({ kind: "file", key: pathKey(card.path), path: card.path, name: basename(card.path) });
  }
  return images;
}

/**
 * 一轮里每一步该挂哪几张图（2026-11-22 用户：「每一层折叠都是下一层的图片的总数」）：同一张图只挂在它**第一次出现**
 * 的那一步上——导出第 1 页、再读回来看，图挂在导出那一步，读那一步不再重复。于是每一层的数都是下一层的和：
 * 一段的张数 = 这段每一步的张数相加，一轮的张数 = 每段相加，不会出现「上面写 3 张、点开有 6 张」。
 */
export function assignImages(steps: readonly ProcessStep[], results: ToolResultIndex): ReadonlyMap<string, ProcessImage[]> {
  const seen = new Set<string>();
  const byCall = new Map<string, ProcessImage[]>();
  for (const call of processCalls(steps)) {
    const fresh = stepImages(call, results).filter((image) => {
      if (seen.has(image.key)) return false;
      seen.add(image.key);
      return true;
    });
    if (fresh.length > 0) byCall.set(call.toolCallId, fresh);
  }
  return byCall;
}

/** 一串步骤合起来的图（按 assignImages 的挂法，顺序同步骤） */
export function imagesOf(steps: readonly ProcessStep[], byCall: ReadonlyMap<string, ProcessImage[]>): ProcessImage[] {
  return processCalls(steps).flatMap((call) => byCall.get(call.toolCallId) ?? []);
}

// ───────────────────────── 折叠行那一句 ─────────────────────────

export interface HeadlineWords {
  wroteFiles: (n: number) => string;
  madeDecks: (n: number) => string;
  openedDocs: (n: number) => string;
  exported: (n: number) => string;
  delegated: (n: number) => string;
  /** 「还有 N 步」：前面有说法时 */
  moreSteps: (n: number) => string;
  /** 只有步数：前面什么都没说出来时 */
  steps: (n: number) => string;
  /** 说法之间的分隔（中文「、」英文「, 」）与说法和「还有 N 步」之间的连接 */
  listSep: string;
  restSep: string;
}

/**
 * 折叠行那一句（照 Claude「Created 3 files, shared a file, and 107 more steps」）：先说做出来的东西，
 * 再说「还有 N 步」。步数是展开后的行数（改计划、定目标各一行，也算）；做出东西的那几步从「还有」里扣掉。
 */
export function processHeadline(
  steps: readonly ProcessStep[],
  results: ToolResultIndex,
  files: number,
  words: HeadlineWords,
): string {
  // 改计划、定目标也算一步：展开后它们各占一行，段里写的步数也数它们，折叠行要对得上
  const calls = processCalls(steps);
  const outputs = turnOutputs(calls, results);
  // 导出来的（format 非 null）单算「导出 N 个」，不再混进做出的演示文稿 / 打开的文档里
  const decks = outputs.filter((output) => output.kind === "slides" && output.format === null).length;
  const docs = outputs.filter((output) => output.kind === "doc" && output.format === null).length;
  const exported = outputs.filter((output) => output.format !== null).length;
  const delegated = calls.filter((call) => call.toolName === "delegate").length;
  const parts: string[] = [];
  let accounted = 0;
  if (files > 0) {
    parts.push(words.wroteFiles(files));
    accounted += calls.filter((call) => call.toolName === "write" || call.toolName === "edit").length;
  }
  if (decks > 0) {
    parts.push(words.madeDecks(decks));
    accounted += calls.filter((call) => call.toolName === "slides_create" || DECK_WRITERS.has(call.toolName)).length;
  }
  if (docs > 0) {
    parts.push(words.openedDocs(docs));
    accounted += calls.filter((call) => call.toolName === "doc_open").length;
  }
  if (exported > 0) {
    parts.push(words.exported(exported));
    accounted += exported;
  }
  if (delegated > 0) {
    parts.push(words.delegated(delegated));
    accounted += delegated;
  }
  const rest = Math.max(0, calls.length - accounted);
  if (parts.length === 0) return words.steps(calls.length);
  return rest > 0 ? `${parts.join(words.listSep)}${words.restSep}${words.moreSteps(rest)}` : parts.join(words.listSep);
}

// ───────────────────────── 展开后的行 ─────────────────────────

/**
 * 「平铺」时的一行：说的话（旁白）一行，每一步工具一行。思考不单独占行（2026-11-22 用户：「一而再再而三的思考」），
 * 挂在它后面那一步上，点开那一步才看到。
 */
export type ProcessRow =
  | { kind: "say"; key: string; text: string }
  | { kind: "step"; key: string; call: ToolCallUnit; thinking: string[] };

export function processRows(steps: readonly ProcessStep[]): ProcessRow[] {
  const rows: ProcessRow[] = [];
  let thinking: string[] = [];
  for (const step of steps) {
    if (step.kind === "thinking") {
      if (step.text.trim() !== "") thinking.push(step.text.trim());
      continue;
    }
    if (step.kind === "text") {
      if (step.text.trim() !== "") rows.push({ kind: "say", key: step.key, text: step.text.trim() });
      continue;
    }
    const calls = step.kind === "toolCall" ? [step] : step.kind === "toolGroup" ? step.calls : [];
    for (const call of calls) {
      rows.push({ kind: "step", key: call.key, call, thinking });
      thinking = [];
    }
  }
  return rows;
}

/**
 * 结尾那一摞太长时按类收（2026-11-22 压力测试：一轮写了 12 个网页、4 份文档，结尾排了 20 张卡）：同一类（文档 / PDF / 网页）
 * 有 GROUP_MIN 份以上，收成一张「12 个网页」的卡，点开逐个列；演示文稿一份一张不收（通常只有一两份，又是这一轮的主产物）。
 */
export const GROUP_MIN = 3;

export type OutputGroupType = "doc" | "pdf" | "web" | "audio" | "video";
export type OutputSlot = { kind: "one"; output: TurnOutput } | { kind: "group"; type: OutputGroupType; outputs: TurnOutput[] };

export function groupOutputs(outputs: readonly TurnOutput[]): OutputSlot[] {
  const count = new Map<string, number>();
  for (const output of outputs) count.set(output.kind, (count.get(output.kind) ?? 0) + 1);
  const slots: OutputSlot[] = [];
  const groups = new Map<string, Extract<OutputSlot, { kind: "group" }>>();
  for (const output of outputs) {
    const kind = output.kind;
    if (kind !== "slides" && (count.get(kind) ?? 0) >= GROUP_MIN) {
      let group = groups.get(kind);
      if (group === undefined) {
        group = { kind: "group", type: kind, outputs: [] };
        groups.set(kind, group);
        slots.push(group);
      }
      group.outputs.push(output);
    } else {
      slots.push({ kind: "one", output });
    }
  }
  return slots;
}
