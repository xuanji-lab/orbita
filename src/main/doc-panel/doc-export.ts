/**
 * 文档导出的生成函数（**纯 node**，UI 的导出与 agent 的 `doc_export` 共用，一处真源两个入口）。
 * 打印 PDF 要 electron 的窗口，由调用方注入 `printPdf`（主进程用 `print-doc-pdf.ts`，agent 经主进程转交）。
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import type { DocExportDocFormat } from "../../shared/doc.ts";
import type { FileRoot } from "../../shared/files.ts";
import { ofmToPlainMarkdown } from "../../shared/ofm/plain.ts";
import { findWikiLinks, isImageName } from "../../shared/ofm/syntax.ts";
import { documentHtml, markdownToHtmlBody } from "./doc-html.ts";
import { markdownToDocx } from "./export-docx.ts";
import { IMAGE_MAX_BYTES, resolveTargets } from "./ofm-files.ts";

const MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
};

export interface BuiltExport {
  bytes: Uint8Array;
  /** 不带点的扩展名（保存对话框的默认后缀） */
  ext: "docx" | "pdf" | "md";
}

/** 读文档里引用的一张图（解析目标 → 读字节，≤ 25 MB）；找不到 / 太大 = null */
function imageReader(roots: readonly FileRoot[], docReal: string) {
  return async (target: string): Promise<{ bytes: Uint8Array; ext: string } | null> => {
    const [hit] = await resolveTargets(roots, docReal, [{ target, kind: "image" }]);
    if (hit === null || hit === undefined) return null;
    if (!isImageName(hit.path)) return null;
    const info = await stat(hit.path);
    if (!info.isFile() || info.size > IMAGE_MAX_BYTES) return null;
    return { bytes: await readFile(hit.path), ext: hit.path.slice(hit.path.lastIndexOf(".") + 1).toLowerCase() };
  };
}

export async function buildDocExport(opts: {
  format: DocExportDocFormat;
  text: string;
  docReal: string;
  roots: readonly FileRoot[];
  title: string;
  /** 把自包含 HTML 打成 PDF；缺席时导出 pdf 报错 */
  printPdf?: (html: string) => Promise<Uint8Array>;
}): Promise<BuiltExport> {
  const { format, text, docReal, roots } = opts;
  const read = imageReader(roots, docReal);
  if (format === "md") return { bytes: Buffer.from(text, "utf8"), ext: "md" };
  if (format === "docx") {
    const bytes = await markdownToDocx(text, { loadImage: async (target) => (await read(target))?.bytes ?? null });
    return { bytes, ext: "docx" };
  }
  if (format === "pdf") {
    if (opts.printPdf === undefined) throw new Error("这里没有打印能力，无法导出 PDF");
    const body = await markdownToHtmlBody(text, async (target) => {
      const image = await read(target);
      return image === null ? null : `data:${MIME[image.ext] ?? "application/octet-stream"};base64,${Buffer.from(image.bytes).toString("base64")}`;
    });
    return { bytes: await opts.printPdf(documentHtml(opts.title, body)), ext: "pdf" };
  }
  // md-plain：图片嵌入要写成相对文档的路径，先把用到的目标都解析一遍
  const embeds = [...new Set(findWikiLinks(text).filter((l) => l.embed && isImageName(l.target)).map((l) => l.target))];
  const resolved = await resolveTargets(roots, docReal, embeds.map((target) => ({ target, kind: "image" as const })));
  const paths = new Map<string, string>();
  embeds.forEach((target, i) => {
    const hit = resolved[i];
    if (hit !== null && hit !== undefined) paths.set(target, relative(dirname(docReal), hit.path).split(sep).join("/"));
  });
  const plain = ofmToPlainMarkdown(text, { imagePath: (target) => paths.get(target) ?? null });
  return { bytes: Buffer.from(plain, "utf8"), ext: "md" };
}
