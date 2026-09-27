import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { extractText, getDocumentProxy } from "unpdf";

/**
 * agent 的 PDF 工具：read_pdf。
 *
 * pi 协议的用户块只有 text | image，read 工具对非图片一律按 UTF-8 读——PDF 的
 * 压缩二进制出来就是乱码（本仓 patch 让 read 对 PDF 返回指路文案）。PDF 的文本
 * 提取由此工具承载：模型按需调用、按页分页读，与 read 对长文件的 offset 续读
 * 同一个设计语言（Claude Code 的 Read 对 PDF 也是这个形态：短了整读、长了带页码
 * 参数、单次封顶）。
 *
 * **agent 进程直读文件，不过主进程**：附件副本本来就落在「agent read 的边界内」
 * （`saveExternalFiles` 的设计前提），工作区 PDF 更是如此——与 pi 自己的 read
 * 工具同一待遇，不需要 request-broker 转一手。提取用 unpdf（unjs 维护的 pdf.js
 * serverless 封装，零原生依赖）：文本层是它的事，本模块只管准入、分页与报错口径。
 *
 * 扫描件在门口挡下：全文提取不足 PDF_NO_TEXT_LAYER_MIN_CHARS 即报「无文本层」
 * ——pdf.js 对图片页提出来的是空串，静默返回空文本会让模型把「读不到」当
 * 「文件是空的」。混合文档不拦：有字的页照给，空页在位注明。加密 PDF 如实上屏。
 */

/** 单次最多读几页。上下文护栏：一页密排文本可到 3k 字符，20 页已是一大口 */
export const PDF_MAX_PAGES_PER_CALL = 20;

/** 全文低于这个字符数视为无文本层（扫描件）。取小值防误伤只有几行字的真 PDF */
export const PDF_NO_TEXT_LAYER_MIN_CHARS = 50;

export function createPdfTools(cwd: string): ToolDefinition[] {
  const readPdf: ToolDefinition = {
    name: "read_pdf",
    label: "read_pdf",
    description:
      "Read the text layer of a PDF file, page by page. Use this instead of read for any .pdf file — " +
      "read cannot show PDF content. Returns the total page count and the text of the requested pages; " +
      "PDFs without a text layer (scanned documents) are rejected with an error. " +
      'Call with "path" first; add "offset"/"limit" for large files. When you need the full document, ' +
      "continue with offset until complete.",
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
          description: "Number of pages to read. Default and maximum 20.",
        },
      },
      required: ["path"],
    } as never,
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      const pathRaw = typeof args["path"] === "string" ? args["path"].trim() : "";
      if (pathRaw === "") throw new Error('read_pdf requires a "path" pointing at a PDF file');
      const absolute = isAbsolute(pathRaw) ? pathRaw : join(cwd, pathRaw);

      const buffer = await readFile(absolute);
      // 魔数定身份，不看扩展名——扩展名会说谎，文件头不会
      if (buffer.length < 5 || buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
        throw new Error(`Not a PDF file: ${pathRaw}. Use the read tool for text files and images.`);
      }

      let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
      try {
        pdf = await getDocumentProxy(new Uint8Array(buffer));
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "PasswordException") {
          throw new Error(`The PDF is password-protected and cannot be read: ${pathRaw}`);
        }
        throw error;
      }
      // mergePages: false → 逐页一串文本，分页的根基；空页就是空串
      const { totalPages, text } = await extractText(pdf, { mergePages: false });
      const totalChars = text.reduce((sum, page) => sum + page.trim().length, 0);
      if (totalChars < PDF_NO_TEXT_LAYER_MIN_CHARS) {
        throw new Error(
          `The PDF has no text layer (it is probably a scanned or image-only document): ${pathRaw}. ` +
            "Reading it as text is not supported.",
        );
      }

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
          : PDF_MAX_PAGES_PER_CALL;
      const limit = Math.min(Math.max(1, limitRaw), PDF_MAX_PAGES_PER_CALL);
      const last = Math.min(totalPages, first + limit - 1);

      const parts: string[] = [];
      for (let page = first; page <= last; page++) {
        const pageText = text[page - 1] ?? "";
        const body = pageText.trim() === "" ? `[page ${page} has no text layer]` : pageText;
        parts.push(`--- Page ${page} ---\n${body}`);
      }
      const header = `[PDF with ${totalPages} pages. Showing pages ${first}-${last} of ${totalPages}.`;
      const tail = last < totalPages ? ` Use offset=${last + 1} to continue.]` : `]`;
      return {
        content: [{ type: "text", text: `${header}${tail}\n\n${parts.join("\n\n")}` }],
        details: {},
      };
    },
  };
  return [readPdf];
}
