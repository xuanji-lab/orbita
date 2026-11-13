/**
 * 演示文稿导出的契约（四层里的第 1 层）：菜单点导出（renderer → 主进程 IPC）与 agent 的
 * `slides_export`（agent → 主进程 requestId 问答）走**同一个实现**（`main/slides/export.ts`），
 * 因为 PDF / PNG 要主进程开隐藏窗口，pptx / html 也一并放那里，免得两处各养一份。
 */
export type SlidesExportFormat = "pdf" | "html" | "png" | "pptx" | "pptx-basic";

export const SLIDES_EXPORT_FORMATS: readonly SlidesExportFormat[] = ["pdf", "html", "png", "pptx", "pptx-basic"];

export const SLIDES_EXPORT_EXT: Readonly<Record<SlidesExportFormat, string>> = {
  pdf: "pdf",
  html: "html",
  png: "png",
  pptx: "pptx",
  "pptx-basic": "pptx",
};

export function isSlidesExportFormat(value: unknown): value is SlidesExportFormat {
  return typeof value === "string" && (SLIDES_EXPORT_FORMATS as readonly string[]).includes(value);
}

/** 菜单点导出：弹保存对话框，取消回 saved: null */
export interface SlidesExportRequest {
  sessionId: string | null;
  workspaceId: string | null;
  /** .slides.json 的绝对路径（renderer 已先把没写的写盘） */
  path: string;
  format: SlidesExportFormat;
  /** png 用：哪一页（1 起） */
  page?: number;
}

export interface SlidesExportResult {
  saved: string | null;
}

/** agent 的 slides_export：不弹对话框，写到 out（缺省在演示文稿旁边）；经 agent-ipc 的 slidesRequest */
export interface SlidesAgentRequest {
  path: string;
  format: SlidesExportFormat;
  page?: number;
  /** 输出路径（绝对或相对演示文稿所在目录）；缺省 `<名字>.<ext>`（png 为 `<名字>-p<页>.png`） */
  out?: string;
}

export type SlidesOutcome =
  | { ok: true; path: string; bytes: number; pages: number }
  | { ok: false; error: string };

/** 保底字体集合：「通用字体」版 pptx 里所有 run 的字体都必须落在这里 */
export const BASIC_FONTS: readonly string[] = ["Arial", "Microsoft YaHei"];

/** `slides:read-asset`：读演示文稿旁边 assets 里的一张图 */
export interface SlidesReadAssetRequest {
  sessionId: string | null;
  workspaceId: string | null;
  /** .slides.json 绝对路径 */
  path: string;
  /** deck 里记的相对路径 */
  src: string;
}

export interface SlidesAssetBytes {
  bytes: Uint8Array;
  mime: string;
}

/** `slides:add-asset`：用户拖入 / 粘贴 / 选择的图片 */
export interface SlidesAddAssetRequest {
  sessionId: string | null;
  workspaceId: string | null;
  path: string;
  /** 原文件名（粘贴的截图没有名字时给 `image`） */
  name: string;
  bytes: Uint8Array;
}

export interface SlidesAddedAsset {
  src: string;
  width: number;
  height: number;
}

/** `slides:convert-marp`：旧 .md 演示文稿 → 新格式 */
export interface SlidesConvertRequest {
  sessionId: string | null;
  workspaceId: string | null;
  /** 旧 .md 的绝对路径 */
  path: string;
}

export interface SlidesConverted {
  /** 新建的 .slides.json 绝对路径 */
  path: string;
  pages: number;
}
