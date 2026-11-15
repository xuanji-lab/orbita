/**
 * PDF 阅读器（实验功能「PDF 阅读器」）的契约 —— IPC 四层的第 1 层，外加阅读器页面与面板之间的消息。
 *
 * **形态**：右侧文件面板里一个 iframe，地址 `orbita-reader://app/reader.html`。页面是 zotero/reader 的
 * web 构建（AGPL-3.0，钉提交，构建见 scripts/fetch-pdf-reader.mjs），主进程从 build/pdf-reader/app 给出，
 * 并在页面里加一段我们自己的桥脚本（src/reader-host/host.ts）。桥只做两件事：按面板发来的命令调阅读器的
 * 公开方法，把阅读器的回调（存 / 删批注、页码、侧栏开合）转成消息发回面板。面板与它跨源，只靠 postMessage。
 *
 * **批注归我们**：阅读器自己不存盘。批注整条（位置、颜色、类型、原句、评论）只存在 PDF 旁边的数据文件里
 * （`annotationsFileName`），那是唯一的一份。读写都在主进程，凭 `pdf-reader:open` 发的一次性 token——
 * 主进程只认得「当前打开的那一份 PDF」与它的数据文件，renderer 传不进任何路径。
 */
import type { FileListRequest } from "./files.ts";
import type { Language } from "./settings.ts";

// ---------- 协议 ----------

/** 阅读器页面的协议名与固定主机段 */
export const PDF_READER_SCHEME = "orbita-reader";
export const PDF_READER_HOST = "app";
export const PDF_READER_ORIGIN = `${PDF_READER_SCHEME}://${PDF_READER_HOST}`;
/** iframe 的入口页（主进程给的时候在里面加上桥脚本） */
export const PDF_READER_PAGE_URL = `${PDF_READER_ORIGIN}/reader.html`;
/** 当前打开的 PDF 的字节：`/doc/<token>`（支持 Range） */
export const PDF_READER_DOC_PREFIX = "/doc/";

/** 构建产物该是哪个提交（与 scripts/fetch-pdf-reader.mjs 的 READER.commit 同值，测试核对） */
export const PDF_READER_COMMIT = "5581a8daa72013ae7424d41688dfbab5100b47ec";

// ---------- 数据文件 ----------

/** 数据文件的格式版本：结构变了就 +1，读的一侧遇到更高的版本只读不写 */
export const PDF_ANNOTATIONS_SCHEMA = 1;
/** 数据文件的自我标识：同名文件不是我们写的就不碰 */
export const PDF_ANNOTATIONS_KIND = "orbita.pdf-annotations";

/** `paper.pdf` 的批注放在同目录的 `paper.pdf.annotations.json` */
export function annotationsFileName(pdfFileName: string): string {
  return `${pdfFileName}.annotations.json`;
}

export const READER_ANNOTATION_TYPES = ["highlight", "underline", "note", "text", "image", "ink"] as const;
export type ReaderAnnotationType = (typeof READER_ANNOTATION_TYPES)[number];

/**
 * 一条批注：阅读器的 Annotation 对象原样存（`id`、`type`、`position`、`color`、`text`、`comment`、
 * `pageLabel`、`sortIndex`、`dateCreated`、`dateModified`、`tags`、`image`……）。我们只校验 id 与 type，
 * 其余字段不解释——字段集跟着阅读器走，不在这里抄一份会过期的清单。
 */
export interface ReaderAnnotation {
  id: string;
  type: ReaderAnnotationType;
  [field: string]: unknown;
}

/** 数据文件本体 */
export interface PdfAnnotationsFile {
  schema: number;
  kind: typeof PDF_ANNOTATIONS_KIND;
  /** 对应的 PDF 文件名（只是提示，不参与查找：找数据文件靠同目录 + 文件名规则） */
  pdf: string;
  annotations: ReaderAnnotation[];
}

/** 一条批注序列化后的上限：圈图批注带图（dataURL）也够；再大就是坏数据 */
export const ANNOTATION_MAX_BYTES = 8 * 1024 * 1024;
/** 一次存的条数上限（阅读器一次只传变化的那几条；导入大批量时也远低于它） */
export const ANNOTATIONS_PER_SAVE_MAX = 5000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 校验一条批注：id 与 type 对得上才收，其余字段原样保留。不合格回 null */
export function parseAnnotation(raw: unknown): ReaderAnnotation | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const { id, type } = record;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  if (typeof type !== "string" || !(READER_ANNOTATION_TYPES as readonly string[]).includes(type)) return null;
  if (JSON.stringify(record).length > ANNOTATION_MAX_BYTES) return null;
  return { ...record, id, type: type as ReaderAnnotationType };
}

export type ParsedAnnotationsFile =
  | { ok: true; file: PdfAnnotationsFile }
  /** 文件在但读不懂（坏 JSON / 不是我们的 / 版本更高）：**不覆盖它**，按只读打开 */
  | { ok: false; reason: "corrupt" | "foreign" | "newer" };

/** 解析数据文件正文。坏条目丢掉（不整份作废）；整份不认识就回 ok:false，调用方据此拒写 */
export function parseAnnotationsFile(text: string): ParsedAnnotationsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "corrupt" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "corrupt" };
  const record = raw as Record<string, unknown>;
  if (record["kind"] !== PDF_ANNOTATIONS_KIND) return { ok: false, reason: "foreign" };
  const schema = record["schema"];
  if (typeof schema !== "number" || !Number.isInteger(schema)) return { ok: false, reason: "corrupt" };
  if (schema > PDF_ANNOTATIONS_SCHEMA) return { ok: false, reason: "newer" };
  const list = Array.isArray(record["annotations"]) ? record["annotations"] : [];
  const annotations: ReaderAnnotation[] = [];
  for (const item of list) {
    const parsed = parseAnnotation(item);
    if (parsed !== null) annotations.push(parsed);
  }
  const pdf = typeof record["pdf"] === "string" ? record["pdf"] : "";
  return { ok: true, file: { schema: PDF_ANNOTATIONS_SCHEMA, kind: PDF_ANNOTATIONS_KIND, pdf, annotations } };
}

/** 空数据文件 */
export function emptyAnnotationsFile(pdf: string): PdfAnnotationsFile {
  return { schema: PDF_ANNOTATIONS_SCHEMA, kind: PDF_ANNOTATIONS_KIND, pdf, annotations: [] };
}

/**
 * 按 id 合并：已有的就地浅合并（阅读器改评论 / 颜色时只传那一条的完整对象，浅合并保住它没传的字段），
 * 新的追加。最后按 `sortIndex`（阅读器生成的「页-位置」排序键，字符串）排，没有的排在后面且保持原序。
 */
export function mergeAnnotations(current: readonly ReaderAnnotation[], incoming: readonly ReaderAnnotation[]): ReaderAnnotation[] {
  const out = current.map((item) => ({ ...item }));
  const index = new Map(out.map((item, i) => [item.id, i]));
  for (const item of incoming) {
    const at = index.get(item.id);
    if (at === undefined) {
      index.set(item.id, out.length);
      out.push({ ...item });
    } else {
      out[at] = { ...out[at], ...item };
    }
  }
  const key = (item: ReaderAnnotation): string | null => (typeof item["sortIndex"] === "string" ? item["sortIndex"] : null);
  return out
    .map((item, order) => ({ item, order }))
    .sort((a, b) => {
      const ka = key(a.item);
      const kb = key(b.item);
      if (ka !== null && kb !== null && ka !== kb) return ka < kb ? -1 : 1;
      if (ka === null && kb !== null) return 1;
      if (ka !== null && kb === null) return -1;
      return a.order - b.order;
    })
    .map(({ item }) => item);
}

/** 按 id 删除 */
export function removeAnnotations(current: readonly ReaderAnnotation[], ids: readonly string[]): ReaderAnnotation[] {
  const gone = new Set(ids);
  return current.filter((item) => !gone.has(item.id));
}

// ---------- IPC（`pdf-reader:*`） ----------

/** 打开：与文件面板同一道 root/dir 白名单，且须是 .pdf */
export type PdfReaderOpenRequest = FileListRequest;

/** 数据文件为什么写不了（界面据此给出错态；批注仍留在阅读器里，不丢） */
export type PdfAnnotationsBlock =
  /** PDF 所在目录不可写 */
  | "read-only"
  /** 同名数据文件在但读不懂：不覆盖它 */
  | "corrupt"
  | "foreign"
  | "newer";

export type PdfReaderOpenResult =
  | {
      kind: "ready";
      /** 这次打开的一次性凭据：读字节、存、删都凭它；换文件 / 关面板即作废 */
      token: string;
      /** 阅读器加载 PDF 用的地址（`orbita-reader://app/doc/<token>`） */
      docUrl: string;
      /** 数据文件的文件名（同目录；界面只显示名字，不显示路径） */
      dataFile: string;
      annotations: ReaderAnnotation[];
      /** null = 可以写；否则是写不了的原因 */
      blocked: PdfAnnotationsBlock | null;
    }
  | PdfReaderUnavailable;

/**
 * 阅读器产物缺失 / 与钉住的版本不符 / 文件被改过：界面给出错态，不白屏。
 * `detail` 是给开发者的排查细节（路径、要跑的命令），**打包版为 null**——用户只看到「缺失或损坏」与退路。
 */
export interface PdfReaderUnavailable {
  kind: "unavailable";
  reason: "missing" | "mismatch" | "corrupt";
  detail: string | null;
}

export interface PdfReaderSaveRequest {
  token: string;
  annotations: ReaderAnnotation[];
}

export interface PdfReaderDeleteRequest {
  token: string;
  ids: string[];
}

export type PdfReaderWriteResult =
  | { ok: true; count: number }
  | {
      ok: false;
      /** blocked 的几种同 PdfAnnotationsBlock；expired = token 不是当前这份（文件已切走）；failed = 写盘出错 */
      reason: PdfAnnotationsBlock | "expired" | "failed";
      message: string;
    };

// ---------- 面板 ⇄ 阅读器页面（postMessage） ----------

export const READER_TOOLS = ["pointer", "highlight", "underline", "note", "text", "image", "ink", "eraser"] as const;
export type ReaderTool = (typeof READER_TOOLS)[number];

/** 批注颜色（阅读器的八色，名字是它的 ftl 键去掉 general- 前缀） */
export const READER_COLORS = [
  { id: "yellow", value: "#ffd400" },
  { id: "red", value: "#ff6666" },
  { id: "green", value: "#5fb236" },
  { id: "blue", value: "#2ea8e5" },
  { id: "purple", value: "#a28ae5" },
  { id: "magenta", value: "#e56eee" },
  { id: "orange", value: "#f19837" },
  { id: "gray", value: "#aaaaaa" },
] as const;

export type ReaderColorScheme = "light" | "dark";
export type ReaderLocale = "en-US" | "zh-CN";

/** 面板 → 页面 */
export type ReaderCommand =
  | {
      type: "init";
      docUrl: string;
      annotations: ReaderAnnotation[];
      colorScheme: ReaderColorScheme;
      /** 界面语言：页面从同源的 `/locales/<locale>/` 取 zotero.ftl 与 reader.ftl，品牌用 READER_BRAND_FTL。
       *  中途换语言不热切：阅读器只在创建时收 ftl，面板按语言重建 iframe */
      locale: ReaderLocale;
      sidebarOpen: boolean;
      /** 批注只读（数据文件写不了时仍可读、可看，不让用户以为划了能留下） */
      readOnly: boolean;
    }
  | { type: "zoom"; action: "in" | "out" | "page-width" }
  | { type: "page"; action: "prev" | "next" }
  | { type: "go-to-page"; label: string }
  | { type: "tool"; tool: ReaderTool; color?: string }
  | { type: "sidebar"; open: boolean }
  | { type: "find" }
  | { type: "color-scheme"; value: ReaderColorScheme }
  /** 跳到一页里的一组矩形（PDF 用户空间 [x1, y1, x2, y2]），阅读器滚过去并闪一下高亮 */
  | { type: "navigate"; pageIndex: number; rects: number[][] }
  | { type: "confirm-result"; id: number; ok: boolean }
  /** 宽度档（面板按自己的宽度判）：narrow 时批注栏浮在页面上，不挤页面 */
  | { type: "layout"; narrow: boolean };

/** 页面 → 面板 */
export type ReaderEvent =
  /** 桥脚本已就位（面板此后才发 init） */
  | { type: "ready" }
  | { type: "initialized" }
  | {
      type: "state";
      pageIndex: number;
      pageLabel: string;
      pagesCount: number;
      sidebarOpen: boolean;
      tool: ReaderTool;
      color: string;
    }
  | { type: "save"; annotations: ReaderAnnotation[] }
  | { type: "delete"; ids: string[] }
  /** 一次删多条：阅读器要求同步确认，桥先拦下、问面板，面板答复后再删 */
  | { type: "confirm"; id: number; count: number }
  | { type: "open-link"; url: string }
  | { type: "error"; message: string };

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const isTool = (value: unknown): value is ReaderTool => typeof value === "string" && (READER_TOOLS as readonly string[]).includes(value);

/** 面板收页面消息时的校验（页面里跑的是第三方构建，消息形状不当可信输入） */
export function parseReaderEvent(raw: unknown): ReaderEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m["type"]) {
    case "ready":
    case "initialized":
      return { type: m["type"] };
    case "state": {
      const { pageIndex, pageLabel, pagesCount, sidebarOpen, tool, color } = m;
      if (typeof pageIndex !== "number" || typeof pagesCount !== "number" || typeof sidebarOpen !== "boolean") return null;
      return {
        type: "state",
        pageIndex,
        pageLabel: typeof pageLabel === "string" ? pageLabel : String(pageIndex + 1),
        pagesCount,
        sidebarOpen,
        tool: isTool(tool) ? tool : "pointer",
        color: typeof color === "string" ? color : READER_COLORS[0].value,
      };
    }
    case "save": {
      if (!Array.isArray(m["annotations"])) return null;
      const annotations = m["annotations"].map(parseAnnotation).filter((item): item is ReaderAnnotation => item !== null);
      return { type: "save", annotations };
    }
    case "delete":
      return isStringArray(m["ids"]) ? { type: "delete", ids: m["ids"] } : null;
    case "confirm":
      return typeof m["id"] === "number" && typeof m["count"] === "number" ? { type: "confirm", id: m["id"], count: m["count"] } : null;
    case "open-link":
      return typeof m["url"] === "string" ? { type: "open-link", url: m["url"] } : null;
    case "error":
      return typeof m["message"] === "string" ? { type: "error", message: m["message"] } : null;
    default:
      return null;
  }
}

// ---------- 主题与语言 ----------

/** Orbita 的主题 → 阅读器的深浅：两档暗色（黛 graphite、玄 black）走 dark，其余（含纸面两档）走 light */
export function readerColorScheme(resolvedTheme: string | undefined): ReaderColorScheme {
  return resolvedTheme === "graphite" || resolvedTheme === "black" ? "dark" : "light";
}

export function readerLocale(language: Language): ReaderLocale {
  return language === "zh" ? "zh-CN" : "en-US";
}

/**
 * 品牌名（替掉阅读器 brand.ftl 里的 Zotero）：界面里引用 `-app-name` 的几条（朗读、导入电子书批注）
 * 我们不露出，但万一露出，写的是我们的名字——「Zotero」是注册商标，不当我们的品牌用。
 */
export const READER_BRAND_FTL = [
  "-brand-shorter-name = Orbita",
  "-brand-short-name = Orbita",
  "-brand-full-name = Orbita",
  "-brand-product-name = Orbita",
  "-vendor-short-name = Orbita",
  "-app-name = Orbita",
  "-subscription-name = Orbita",
  "",
].join("\n");
