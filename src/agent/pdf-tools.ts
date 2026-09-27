import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import * as ncanvas from "@napi-rs/canvas";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { extractText, getDocumentProxy, renderPageAsImage } from "unpdf";

/**
 * agent 的 PDF 工具：read_pdf。
 *
 * pi 协议的用户块只有 text | image，read 工具对非图片一律按 UTF-8 读——PDF 的
 * 压缩二进制出来就是乱码（本仓 patch 让 read 对 PDF 返回指路文案）。PDF 的文本
 * 提取由此工具承载：模型按需调用、按页分页读，与 read 对长文件的 offset 续读
 * 同一个设计语言（Claude Code 的 Read 对 PDF 也是这个形态）。
 *
 * **页图模式**（`images: true`）：文本层只承载文字，图表（矢量绘图指令）与扫描页
 * 对它不可见。带 images 时指定页同时渲染成 PNG 走 pi 的 image 块（read 读图同一
 * 通道），模型用眼睛看版式与图表——Claude Code 的「文本 + 页图」双通道同款。
 * 一页图约 1-1.5k token，故带图时单次页数收紧到 5（纯文本仍是 20）。**扫描件
 * （无文本层）+ 视觉模型自动转图**：此时页图是唯一可看的东西，逼模型报错重试
 * 一轮纯属浪费；非视觉模型维持报错（图给了也看不见）。
 *
 * 渲染：unpdf 的 `renderPageAsImage` 在 Node 下注入 @napi-rs/canvas（预编译 Skia
 * 二进制、N-API 稳定 ABI，Electron 免重编；2026-09-27 实测 42ms/页）。宽度固定
 * 1080px——Claude Code 同口径，远低于 pi 内联上限（2000px / 4.5MB），无需缩放管线。
 * **agent 进程直读文件，不过主进程**：附件副本本来就落在「agent read 的边界内」
 * （`saveExternalFiles` 的设计前提），工作区 PDF 更是如此。
 *
 * 扫描件在纯文本路径门口挡下：全文提取不足 PDF_NO_TEXT_LAYER_MIN_CHARS 即报
 * 「无文本层」——pdf.js 对图片页提出来的是空串，静默返回空文本会让模型把
 * 「读不到」当「文件是空的」。混合文档不拦：有字的页照给，空页在位注明。
 * 加密 PDF 如实上屏。
 */

/** 纯文本模式单次最多读几页。上下文护栏：一页密排文本可到 3k 字符，20 页已是一大口 */
export const PDF_MAX_PAGES_PER_CALL = 20;

/** 页图模式单次最多读几页。一页图约 1-1.5k token，20 页图就是 30k token——收紧到 5 */
export const PDF_IMAGE_MAX_PAGES_PER_CALL = 5;

/** 页图渲染宽度。Claude Code 同口径；低于 pi 的 2000px 内联上限，无需二次缩放 */
export const PDF_IMAGE_WIDTH = 1080;

/** 全文低于这个字符数视为无文本层（扫描件）。取小值防误伤只有几行字的真 PDF */
export const PDF_NO_TEXT_LAYER_MIN_CHARS = 50;

/** pi read 读图的同款文案：图省略的原因要说给模型听，不然它以为图丢了 */
const NON_VISION_NOTE = "[Current model does not support images. The image will be omitted from this request.]";

/** 视觉判定：pi 的 Model.input 是 ["text"] 或 ["text","image"]（read 工具同口径） */
function visionCapable(ctx: ExtensionContext | undefined): boolean {
  return ctx?.model?.input.includes("image") ?? false;
}

/** 渲染一段页为 PNG image 块。渲染错误穿透——如实报错好过静默少图 */
async function renderPages(
  pdf: Awaited<ReturnType<typeof getDocumentProxy>>,
  first: number,
  last: number,
): Promise<{ type: "image"; data: string; mimeType: string }[]> {
  const images: { type: "image"; data: string; mimeType: string }[] = [];
  for (let page = first; page <= last; page++) {
    const png = await renderPageAsImage(pdf, page, {
      canvasImport: () => Promise.resolve(ncanvas),
      width: PDF_IMAGE_WIDTH,
    });
    images.push({ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" });
  }
  return images;
}

export function createPdfTools(cwd: string): ToolDefinition[] {
  const readPdf: ToolDefinition = {
    name: "read_pdf",
    label: "read_pdf",
    description:
      "Read a PDF file page by page: extracted text by default, or text plus a rendered image of every " +
      "requested page when you pass images=true — use that to see charts, figures, tables and layout, which " +
      "the text layer does not carry. Returns the total page count and the requested page range; use " +
      'offset/limit to page through. Text mode reads up to 20 pages per call, image mode up to 5. ' +
      "Scanned PDFs (no text layer) are automatically returned as page images when the model supports " +
      "vision. Use this instead of read for any .pdf file — read cannot show PDF content.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the PDF file (relative to the workspace or absolute)",
        },
        offset: {
          type: "number",
          description: "Page number to start reading from (1-indexed). Default 1.",
        },
        limit: {
          type: "number",
          description: "Number of pages to read. Default and maximum: 20 text pages, 5 with images.",
        },
        images: {
          type: "boolean",
          description:
            "Also render each requested page as an image (~1080px) so charts and layout are visible. " +
            "At most 5 pages per call with images.",
        },
      },
      required: ["path"],
    } as never,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const args = (params ?? {}) as Record<string, unknown>;
      const pathRaw = typeof args["path"] === "string" ? args["path"].trim() : "";
      if (pathRaw === "") throw new Error('read_pdf requires a "path" pointing at a PDF file');
      const absolute = isAbsolute(pathRaw) ? pathRaw : join(cwd, pathRaw);

      const buffer = await readFile(absolute);
      // 魔数定身份，不看扩展名——扩展名会说谎，文件头不会。窗口取前 1024 字节而非
      // 字节 0：规范允许 header 前有垃圾（邮件系统前置字节是真实场景），pdf.js 自己
      // 也按这个窗口搜——比解析器更严等于把解析器能读的文件在门口拒掉
      if (!buffer.subarray(0, 1024).toString("latin1").includes("%PDF-")) {
        throw new Error(`Not a PDF file: ${pathRaw}. Use the read tool for text files and images.`);
      }

      let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
      try {
        pdf = await getDocumentProxy(new Uint8Array(buffer));
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "PasswordException") {
          throw new Error(`The PDF is password-protected and cannot be read: ${pathRaw}`);
        }
        // 解析失败的原始错误不带文件名（"Invalid PDF structure."），模型不知道坏的
        // 是哪一个——包上路径再抛
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse PDF (${pathRaw}): ${reason}`);
      }
      // mergePages: false → 逐页一串文本，分页的根基；空页就是空串
      const { totalPages, text } = await extractText(pdf, { mergePages: false });
      const totalChars = text.reduce((sum, page) => sum + page.trim().length, 0);
      const noTextLayer = totalChars < PDF_NO_TEXT_LAYER_MIN_CHARS;

      const wantsImages = args["images"] === true;
      const canSeeImages = visionCapable(ctx);
      // 扫描件 + 视觉模型：自动转图（页图是唯一可看的东西）；非视觉维持报错
      const scannedAsImages = noTextLayer && canSeeImages;
      if (noTextLayer && !scannedAsImages) {
        throw new Error(
          `The PDF has no text layer (it is probably a scanned or image-only document): ${pathRaw}. ` +
            "Reading it as text is not supported.",
        );
      }

      // 带图的读法（显式 images 或扫描件自动转）：单次页数收紧到 5
      const imageMode = (wantsImages && canSeeImages) || scannedAsImages;
      const pageCap = imageMode ? PDF_IMAGE_MAX_PAGES_PER_CALL : PDF_MAX_PAGES_PER_CALL;

      const requested =
        typeof args["offset"] === "number" && Number.isFinite(args["offset"])
          ? Math.floor(args["offset"])
          : 1;
      const first = Math.max(1, requested);
      if (first > totalPages) {
        throw new Error(`offset ${requested} is beyond the last page (${totalPages} pages total)`);
      }
      const limitRaw =
        typeof args["limit"] === "number" && Number.isFinite(args["limit"])
          ? Math.floor(args["limit"])
          : pageCap;
      const limit = Math.min(Math.max(1, limitRaw), pageCap);
      const last = Math.min(totalPages, first + limit - 1);

      const parts: string[] = [];
      for (let page = first; page <= last; page++) {
        // 扫描件自动转图时整段文本为空，逐页「no text layer」注明没有信息量，跳过
        if (scannedAsImages) break;
        const pageText = text[page - 1] ?? "";
        const body = pageText.trim() === "" ? `[page ${page} has no text layer]` : pageText;
        parts.push(`--- Page ${page} ---\n${body}`);
      }

      let header: string;
      let images: { type: "image"; data: string; mimeType: string }[] = [];
      if (scannedAsImages) {
        images = await renderPages(pdf, first, last);
        header =
          `[Scanned PDF with no text layer: ${totalPages} pages. Rendered pages ${first}-${last} as images.` +
          `${last < totalPages ? ` Use offset=${last + 1} to continue.` : ""}]`;
      } else if (imageMode) {
        images = await renderPages(pdf, first, last);
        header =
          `[PDF with ${totalPages} pages. Showing pages ${first}-${last} of ${totalPages}; page images follow the text.` +
          `${last < totalPages ? ` Use offset=${last + 1} to continue.` : ""}]`;
      } else if (wantsImages) {
        // 带了 images 但模型看不见图：降级纯文本，说清图为什么没来
        header =
          `[PDF with ${totalPages} pages. Showing pages ${first}-${last} of ${totalPages}.\n${NON_VISION_NOTE}` +
          `${last < totalPages ? ` Use offset=${last + 1} to continue.` : ""}]`;
      } else {
        header =
          `[PDF with ${totalPages} pages. Showing pages ${first}-${last} of ${totalPages}.` +
          `${last < totalPages ? ` Use offset=${last + 1} to continue.` : ""}]`;
      }

      const bodyText = parts.length > 0 ? `${header}\n\n${parts.join("\n\n")}` : header;
      return {
        content: [{ type: "text", text: bodyText }, ...images],
        details: {},
      };
    },
  };
  return [readPdf];
}
