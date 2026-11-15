/**
 * docx 导出的契约 —— IPC 四层 / agent 工具共用的第 1 层。
 *
 * 这条链路做的是「从源（.md / .tex）起草一份学校能用的 .docx」：
 *
 *   pandoc（粗转，带 --reference-doc）→ 我们把 OOXML 后处理（三线表 / 公式编号 /
 *   updateFields / 封面分节）→ 公式守门 → 临时文件原子替换。
 *
 * **生成与编辑共用同一个 `.docx`**：产物直接进文件面板的 folio 编辑器（#308），
 * 目录页码交给既有的自愈；这里不引入第二套格式，也不在应用内重新排版。
 *
 * **pandoc ≥ 3.10.2**：3.10.2 修了 `\tag`（公式编号）的转换。低版本不是「慢一点」，
 * 是转换结果不对——所以探测结果里 supported 是硬判据，界面与工具都据此给出
 * 升级提示，不静默降级。
 *
 * 本文件在 `src/shared/`：**禁 node 内置**（渲染层要用这些类型与文案）。版本解析、
 * 判断都是纯函数，主进程与设置页读同一份。
 */

/** 一次导出的硬上限（pandoc 转换部分）。与工具等回执的上限同源 */
export const DOCX_EXPORT_TIMEOUT_MS = 300_000;
/** 工具等主进程回执的上限：必须长于转换本身，否则第 31 秒就报「没回执」而 pandoc 还在跑 */
export const DOCX_EXPORT_BROKER_TIMEOUT_MS = DOCX_EXPORT_TIMEOUT_MS + 30_000;

/** 我们要求的最低 pandoc 版本（`\tag` 修复从 3.10.2 起） */
export const DOCX_EXPORT_MIN_PANDOC = "3.10.2";

/** 推荐版本：真实论文常用的 3.12 线（本仓验收用的就是 3.12.1） */
export const DOCX_EXPORT_RECOMMENDED_PANDOC = "3.12.1";

export interface PandocVersion {
  major: number;
  minor: number;
  patch: number;
}

export function formatPandocVersion(version: PandocVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/**
 * `pandoc --version` 的第一行（`pandoc 3.12.1` / `pandoc.exe 3.9`）→ 版本号。
 * 只认第一行的第一个三段号；解不出返回 null（宁可说「版本未知」，也不要猜）。
 */
export function parsePandocVersion(output: string): PandocVersion | null {
  const firstLine = output.split(/\r?\n/, 1)[0] ?? "";
  const match = /\b(\d+)\.(\d+)(?:\.(\d+))?\b/.exec(firstLine);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = match[3] === undefined ? 0 : Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  return { major, minor, patch };
}

/** a < b → 负数；相等 → 0；a > b → 正数（逐段比，缺的段按 0） */
export function comparePandocVersions(a: PandocVersion, b: PandocVersion): number {
  const left = [a.major, a.minor, a.patch];
  const right = [b.major, b.minor, b.patch];
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 版本是否满足最低要求（未知版本一律 false：没有证据就不放行） */
export function isPandocSupported(version: PandocVersion | null): boolean {
  if (version === null) return false;
  const min = parsePandocVersion(`pandoc ${DOCX_EXPORT_MIN_PANDOC}`);
  return min !== null && comparePandocVersions(version, min) >= 0;
}

/** `pandoc:probe` 的回执。找不到 / 版本过低 / 可用三种结局都在这里 */
export interface PandocProbeResult {
  ok: boolean;
  /** 可执行文件的绝对路径；没找到是 null */
  path: string | null;
  version: PandocVersion | null;
  versionText: string | null;
  /** 版本 ≥ DOCX_EXPORT_MIN_PANDOC */
  supported: boolean;
  minVersion: string;
  recommendedVersion: string;
  /** 人话结论（没装 / 太低 / 可用），界面与工具直接显示 */
  message: string;
  /** 没找到时列出找过的目录（与 latex 探测同一纪律：说清找过哪儿） */
  searched: string[];
}

export interface PandocProbeRequest {
  /** 忽略缓存重新探测（设置页的「重新检测」） */
  refresh?: boolean;
}

/** 模板来源：内置默认 / 项目内 template.docx / 设置里指定的学校模板 */
export const DOCX_TEMPLATE_MODES = ["default", "project", "custom"] as const;
export type DocxTemplateMode = (typeof DOCX_TEMPLATE_MODES)[number];

export function isDocxTemplateMode(value: unknown): value is DocxTemplateMode {
  return typeof value === "string" && (DOCX_TEMPLATE_MODES as readonly string[]).includes(value);
}

/** 体检结论的一行。level 只是显示层（ok / warn / info），不参与判定 */
export interface DocxTemplateFinding {
  level: "ok" | "warn" | "info";
  label: string;
  detail?: string;
}

/**
 * 模板体检报告。
 *
 * `ok` 是「pandoc 能拿它当 reference-doc」的硬判据：zip 打得开、word/document.xml
 * 存在。宏 / 缺页眉 / 没有 numbering 都只是 warning——**有宏也照样能转**，只是要
 * 在结论里说清楚（宏不会被执行，但产物会带着 vbaProject）。
 */
export interface DocxTemplateReport {
  requested: DocxTemplateMode;
  path: string | null;
  ok: boolean;
  verdict: "ok" | "warning" | "unusable";
  summary: string;
  findings: DocxTemplateFinding[];
}

/** 模板体检的结果（`docx-export:inspect`） */
export type DocxTemplateInspectOutcome = DocxTemplateReport;

/** 「选择学校模板…」：系统文件选择器 → 现体检 → 通过才写进设置 */
export type DocxTemplatePickOutcome =
  | { kind: "cancelled" }
  | { kind: "ok"; report: DocxTemplateReport }
  /** 选到了，但不是一个能用的 docx（不写设置） */
  | { kind: "invalid"; path: string; report: DocxTemplateReport };

/** 源文件类型（只认这两种） */
export type DocxInputFormat = "markdown" | "latex";

/** agent 工具 export_docx 的入参（相对路径按会话工作目录解析） */
export interface DocxExportRequest {
  /** .md / .tex，或装着 main.tex / 唯一源文件的目录 */
  source: string;
  /** 目标 .docx（必须落在会话授权目录内） */
  out: string;
  /** 可选模板 docx（项目内相对路径或绝对路径，须在授权目录内） */
  template?: string;
}

/** 产物里数出来的事实。页数不在这里：页只有排版后才知道，由 folio 打开时算 */
export interface DocxExportStats {
  paragraphs: number;
  headings: number;
  tables: number;
  /** 后处理编号了几条公式 */
  numberedEquations: number;
  /** 设为三线表的表格数 */
  threeLineTables: number;
  /** 域的数量（TOC / LOF / LOT / 公式编号） */
  fields: number;
  /** 是否插入了封面分节 */
  coverSection: boolean;
  bytes: number;
}

export interface DocxExportSuccess {
  ok: true;
  /** "ok" = 无告警；"warning" = 有非公式类告警（产物仍然写成功） */
  status: "ok" | "warning";
  path: string;
  bytes: number;
  stats: DocxExportStats;
  warnings: string[];
  template: DocxTemplateReport;
  pandocPath: string;
  pandocVersion: string;
  /** 源文件里识别到的输入格式 */
  inputFormat: DocxInputFormat;
  /** 自动插入的目录 / 图表目录（按输入有无） */
  lists: { toc: boolean; figures: boolean; tables: boolean };
}

/**
 * 失败的分类。**公式降级单独一码**：模型看到它应该改公式，而不是去改路径。
 */
export type DocxExportErrorCode =
  | "source-missing"
  | "out-of-scope"
  | "pandoc-missing"
  | "pandoc-too-old"
  | "template-invalid"
  | "formula-degraded"
  | "table-degraded"
  | "pandoc-failed"
  | "write-failed";

export interface DocxExportFailure {
  ok: false;
  code: DocxExportErrorCode;
  error: string;
  warnings: string[];
}

export type DocxExportOutcome = DocxExportSuccess | DocxExportFailure;

/** 渲染层的 IPC 通道名（preload 与主进程 handler 都读这一份） */
export const docxExportChannels = {
  probe: "docx-export:probe",
  inspect: "docx-export:inspect",
  pickTemplate: "docx-export:pick-template",
  verifyPandoc: "docx-export:verify-pandoc",
  pickPandoc: "docx-export:pick-pandoc",
} as const;

/** `docx-export:verify-pandoc`：现验一条路径能不能跑起 pandoc（不回退到 PATH） */
export interface PandocVerifyRequest {
  path: string;
}

export type PandocVerifyOutcome =
  | { ok: true; probe: PandocProbeResult }
  | { ok: false; message: string };

/**
 * 「选择 pandoc…」：系统文件选择器 → 现验 → 只回结果，**不写设置**
 * （写设置是渲染层 onChange 的事，一个写入者）。
 */
export type PandocLocateOutcome =
  | { kind: "cancelled" }
  | { kind: "ok"; path: string; probe: PandocProbeResult }
  | { kind: "invalid"; path: string; message: string };

/** `docx-export:inspect` 的入参：path 缺席 = 看设置里当前那份 */
export interface DocxTemplateInspectRequest {
  path?: string;
}

/** 「默认模板可不可用」——默认模板是 pandoc 自带的 reference.docx，用得着 pandoc 现生成 */
export interface DocxDefaultTemplateStatus {
  available: boolean;
  path: string | null;
  /** 生成失败时的原因（多为 pandoc 不可用） */
  error: string | null;
}
