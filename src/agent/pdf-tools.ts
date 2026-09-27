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

/** 页图单次最多几页。一页图约 1-1.5k token——批转（images: true）与精准转（image_pages）同限 */
export const PDF_IMAGE_MAX_PAGES_PER_CALL = 5;

/**
 * 批转（images: true）渲染宽度。浏览口径（Claude Code 同款），省 token——
 * 低于 pi 的 2000px 内联上限，无需二次缩放
 */
export const PDF_IMAGE_WIDTH = 1080;

/**
 * 精准转（image_pages）渲染宽度。**细看就要清晰**：1080px 页宽下论文双栏里的图
 * 只剩 ~500px 宽，模型看不清会绕路自救（2026-09-27 实测会话 09a4af6c：模型
 * 用 bash+pymupdf+PIL 十几轮裁剪重渲、巨图塞满上下文后最终答不出正文）。
 * 2000 是 pi 内联上限，图区域分辨率直接翻倍，自助绕路失去动机。
 */
export const PDF_IMAGE_HD_WIDTH = 2000;

/** 全文低于这个字符数视为无文本层（扫描件）。取小值防误伤只有几行字的真 PDF */
export const PDF_NO_TEXT_LAYER_MIN_CHARS = 50;

/**
 * 一页文本低于这个字符数算「稀疏页」——大概率是图表/整页插图（图注加轴标签通常
 * 只有几十字符）。头注把稀疏页列给模型，它才知道该对哪几页要图：配合式读法的
 * 依据——纯文本先看全景，再 image_pages 精准转图细看。
 */
export const PDF_SPARSE_PAGE_CHARS = 80;

/** 稀疏页提示最多列几页。扫描件一半页都稀疏时不该刷屏，截前几个即够指路 */
const SPARSE_HINT_MAX = 10;

/** pi read 读图的同款文案：图省略的原因要说给模型听，不然它以为图丢了 */
const NON_VISION_NOTE = "[Current model does not support images. The image will be omitted from this request.]";

/** 视觉判定：pi 的 Model.input 是 ["text"] 或 ["text","image"]（read 工具同口径） */
function visionCapable(ctx: ExtensionContext | undefined): boolean {
  return ctx?.model?.input.includes("image") ?? false;
}

/**
 * 页码串 → 去重升序页码列表。语法与 read_task 的 rounds 同款："3"、"2-5"、"1,4"。
 * 越界 / 倒序 / 非数字 / 超页数上限都报错并带有效范围——报错是给模型改道用的，
 * 要能指导下一次调用（selectRounds 的口径）。
 */
export function parsePageNumbers(
  spec: string,
  totalPages: number,
  maxPages: number,
): { ok: true; pages: number[] } | { ok: false; error: string } {
  const picked = new Set<number>();
  for (const part of spec.split(",")) {
    const piece = part.trim();
    const single = /^(\d+)$/.exec(piece);
    const range = /^(\d+)-(\d+)$/.exec(piece);
    if (single !== null) {
      picked.add(Number(single[1]));
    } else if (range !== null) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to) return { ok: false, error: `Invalid range ${piece}: start is greater than end.` };
      for (let page = from; page <= to; page++) picked.add(page);
    } else {
      return { ok: false, error: `"${piece}" is not a page number; use forms like "3", "2-5", "1,4".` };
    }
  }
  const pages = [...picked].sort((a, b) => a - b);
  for (const page of pages) {
    if (page < 1 || page > totalPages) {
      return { ok: false, error: `Page ${page} does not exist; valid pages are 1-${totalPages}.` };
    }
  }
  if (pages.length > maxPages) {
    return { ok: false, error: `At most ${maxPages} image pages per call (asked for ${pages.length}).` };
  }
  return { ok: true, pages };
}

/** 全文档里文本稀少的页（图表候选）。空文本层文档不列——整个都是图，列了没有信息量 */
function sparsePages(text: readonly string[], totalChars: number): number[] {
  if (totalChars < PDF_NO_TEXT_LAYER_MIN_CHARS) return [];
  const pages: number[] = [];
  for (let i = 0; i < text.length && pages.length < SPARSE_HINT_MAX; i++) {
    if ((text[i] ?? "").trim().length < PDF_SPARSE_PAGE_CHARS) pages.push(i + 1);
  }
  return pages;
}

/**
 * 图注/表题的模式：**行首**的 Figure / Fig. / Table / 图 / 表 + 编号。图注通常独立
 * 成行且以编号开头；句中引用（"as shown in Figure 3…" / 「如图 3 所示」）不在行首，
 * 天然避开——引用指向的位置不是图所在页，混进来就是错索引。同编号取首次出现页。
 */
const CAPTION_PATTERNS: readonly { normalize: (id: string) => string; pattern: RegExp }[] = [
  { normalize: (id) => `Figure ${id}`, pattern: /^(?:Figure|Fig\.)\s*(\d+(?:[.\-]\d+)*)/i },
  { normalize: (id) => `Table ${id}`, pattern: /^Table\s*(\d+(?:[.\-]\d+)*)/i },
  { normalize: (id) => `图 ${id}`, pattern: /^图\s*(\d+(?:[.\-]\d+)*)/ },
  { normalize: (id) => `表 ${id}`, pattern: /^表\s*(\d+(?:[.\-]\d+)*)/ },
];

/** 图表索引最多列几条。论文级文档图表几十个，全列会刷屏——截断即够指路 */
const FIGURE_INDEX_MAX = 15;

/**
 * 全文档扫出图表索引（图号 → 首次出现页）。头注把它列给模型：用户问「看一下
 * 图 3.2 / 表 5-1」时，模型从头注直接拿到页码，`image_pages` 一步直达——不用
 * 翻页找图注。配合式读法的定位层。
 */
export function figureIndex(text: readonly string[]): { label: string; page: number }[] {
  const firstSeen = new Map<string, number>();
  for (let i = 0; i < text.length; i++) {
    for (const rawLine of (text[i] ?? "").split("\n")) {
      const line = rawLine.trim();
      for (const { normalize, pattern } of CAPTION_PATTERNS) {
        const hit = pattern.exec(line);
        const id = hit?.[1];
        if (id === undefined) continue;
        const label = normalize(id);
        if (!firstSeen.has(label)) firstSeen.set(label, i + 1);
      }
    }
  }
  return [...firstSeen]
    .map(([label, page]) => ({ label, page }))
    .sort((a, b) => a.page - b.page)
    .slice(0, FIGURE_INDEX_MAX);
}

/** 渲染宽度参数的合法区间。下限防马赛克（再小看不了字），上限是 pi 的 provider 内联限制 */
export const PDF_IMAGE_WIDTH_MIN = 600;
export const PDF_IMAGE_WIDTH_MAX = 2000;

/** crop 区域的像素坐标：x1,y1,x2,y2，左上原点，锚定「width 参数渲染出的整页图」 */
export interface CropRectPx {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** crop 源渲染的整页宽上限。crop 半页宽时源就要 4000px——封顶防极端窄条拉出巨型源图 */
const CROP_SOURCE_WIDTH_MAX = 6000;

/**
 * 解析 crop 串 "x1,y1,x2,y2"——**像素**，坐标系是你见过的那张整页图（width 渲染，
 * 头注报过它的确切尺寸）。像素坐标取代归一化 0-1（2026-09-27 用户实测裁决：模型
 * 心算小数换算不准，一次裁不准就反复迭代；它看到的图天然是像素网格，直接按像素
 * 给坐标、工具内部换算）。x 上限就是 width；y 上限渲染后按页高 clamp。
 */
export function parseCropPx(
  spec: string,
  width: number,
): { ok: true; crop: CropRectPx } | { ok: false; error: string } {
  const parts = spec.split(",").map((piece) => piece.trim());
  if (parts.length !== 4 || parts.some((piece) => !/^\d+$/.test(piece))) {
    return { ok: false, error: `crop "${spec}" is not "x1,y1,x2,y2" in pixels (e.g. "200,300,1600,1200").` };
  }
  const [x1, y1, x2, y2] = parts.map(Number) as [number, number, number, number];
  if (x1 >= x2 || y1 >= y2) {
    return { ok: false, error: `crop "${spec}": need x1<x2 and y1<y2 (left-top origin).` };
  }
  if (x2 > width) {
    return {
      ok: false,
      error: `crop x2=${x2} is beyond the page image width ${width} — coordinates are pixels on the page image you saw (its size is reported in the header).`,
    };
  }
  return { ok: true, crop: { x1, y1, x2, y2 } };
}

/** PNG 的像素尺寸（IHDR 偏移 16/20 各 4 字节 big-endian） */
function pngSize(png: ArrayBuffer): { width: number; height: number } {
  const bytes = Buffer.from(png);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * 渲染指定页列表为 PNG image 块（升序）。渲染错误穿透——如实报错好过静默少图。
 * `crop` 给定时只渲染页内区域：源整页按放大因子 `width/(x2-x1)` 渲染（像素坐标下
 * 即 `width·width/(x2-x1)`，封顶防巨型源图）再裁出区域——区域输出就是 width 宽，
 * 局部高清而 token 不涨（模型拿 PIL 裁剪自救的工具化，会话 09a4af6c 的教训）。
 * 返回的 sizeNotes 是每张图的确切像素尺寸——写进头注，模型的 crop 坐标从此有锚点。
 */
async function renderPages(
  pdf: Awaited<ReturnType<typeof getDocumentProxy>>,
  pages: readonly number[],
  width: number,
  crop: CropRectPx | null,
): Promise<{ images: { type: "image"; data: string; mimeType: string }[]; sizeNotes: string[] }> {
  const images: { type: "image"; data: string; mimeType: string }[] = [];
  const sizeNotes: string[] = [];
  const sourceWidth =
    crop === null ? width : Math.min(CROP_SOURCE_WIDTH_MAX, Math.ceil((width * width) / (crop.x2 - crop.x1)));
  for (const page of pages) {
    const png = await renderPageAsImage(pdf, page, {
      canvasImport: () => Promise.resolve(ncanvas),
      width: sourceWidth,
    });
    if (crop === null) {
      const { width: w, height: h } = pngSize(png);
      sizeNotes.push(`page ${page}: ${w}×${h}px`);
      images.push({ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" });
      continue;
    }
    const bitmap = await ncanvas.loadImage(Buffer.from(png));
    // 模型坐标基于「width 宽的整页图」；放大因子 k 对 x、y 同一（纵横比不变）。
    // y 超页高自然裁到边（ch clamp），整块在页外则报错带实际页高
    const k = bitmap.width / width;
    const left = Math.round(crop.x1 * k);
    const top = Math.round(crop.y1 * k);
    if (left >= bitmap.width || top >= bitmap.height) {
      throw new Error(
        `crop starts outside the page: the page image is ${bitmap.width}×${bitmap.height}px at this render. ` +
          `Use coordinates within that.`,
      );
    }
    const boxWidth = Math.max(1, Math.round((crop.x2 - crop.x1) * k));
    const boxHeight = Math.max(1, Math.round((crop.y2 - crop.y1) * k));
    const clipWidth = Math.min(boxWidth, bitmap.width - left);
    const clipHeight = Math.min(boxHeight, bitmap.height - top);
    const canvas = ncanvas.createCanvas(clipWidth, clipHeight);
    canvas.getContext("2d").drawImage(bitmap, -left, -top);
    const cropped = await canvas.encode("png");
    sizeNotes.push(`page ${page} crop: ${clipWidth}×${clipHeight}px`);
    images.push({ type: "image", data: Buffer.from(cropped).toString("base64"), mimeType: "image/png" });
  }
  return { images, sizeNotes };
}

export function createPdfTools(cwd: string): ToolDefinition[] {
  const readPdf: ToolDefinition = {
    name: "read_pdf",
    label: "read_pdf",
    description:
      "Read a PDF file page by page. Default returns the extracted text (up to 20 pages per call), a list of " +
      "pages with little text (likely figures), and a figures/tables index with page numbers — when the user " +
      "asks about a specific figure or table (\"图 3.2\", \"Table 5\"), look it up in that index and call again " +
      "with image_pages set to its page to render it as an image and look closely. images=true renders the whole " +
      "current range instead (at most 5 pages). Scanned PDFs (no text layer) come back automatically as page " +
      "images on vision models. Image output requires a vision model; otherwise text is returned with a note. " +
      "Use this instead of read for any .pdf file — read cannot show PDF content.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the PDF file (relative to the workspace or absolute)",
        },
        offset: {
          type: "number",
          description: "Page number to start reading text from (1-indexed). Default 1.",
        },
        limit: {
          type: "number",
          description: "Number of text pages to read. Default and maximum: 20 text pages, 5 with images=true.",
        },
        image_pages: {
          type: "string",
          description:
            'Specific pages to render as high-resolution images (~2000px wide) for looking at figures and ' +
            'layout closely, e.g. "3" or "2-5" or "1,4" (absolute page numbers, at most 5; the text range is ' +
            "unaffected). Prefer this over images=true — read the text first, then look closely at the pages " +
            "that matter.",
        },
        images: {
          type: "boolean",
          description:
            "Render every page of the current text range as an image (default ~1080px wide, see width). " +
            "At most 5 pages per call. Prefer image_pages for targeted looking.",
        },
        width: {
          type: "number",
          description:
            "Render width in pixels for image output, 600-2000 (values outside are clamped). " +
            "Default 2000 for image_pages, 1080 for images=true.",
        },
        crop: {
          type: "string",
          description:
            'Requires image_pages. Render only a region of each requested page, as "x1,y1,x2,y2" in PIXELS ' +
            'on the page image you already saw (left-top origin; the header reports each image\'s exact size, ' +
            'e.g. "200,300,1600,1200" on a 2000px-wide page). The region comes out at full render width — a ' +
            "close-up of a figure without paying tokens for the rest of the page. Look at the whole page first, " +
            "then crop by pixel coordinates.",
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
      const imagePagesSpec = typeof args["image_pages"] === "string" ? args["image_pages"].trim() : "";
      const wantsAnyImages = wantsImages || imagePagesSpec !== "";
      const canSeeImages = visionCapable(ctx);
      // 扫描件 + 视觉模型：自动转图（页图是唯一可看的东西）；非视觉维持报错
      const scannedAsImages = noTextLayer && canSeeImages;
      if (noTextLayer && !scannedAsImages) {
        throw new Error(
          `The PDF has no text layer (it is probably a scanned or image-only document): ${pathRaw}. ` +
            "Reading it as text is not supported.",
        );
      }

      // 精准转图：image_pages 指定页（绝对页码），文本部分照 offset/limit 不受影响。
      // 语法错 / 越界 / 超上限当场报错带有效范围——模型拿报错改道
      let pickedPages: number[] | null = null;
      if (imagePagesSpec !== "" && canSeeImages) {
        const parsed = parsePageNumbers(imagePagesSpec, totalPages, PDF_IMAGE_MAX_PAGES_PER_CALL);
        if (!parsed.ok) throw new Error(parsed.error);
        pickedPages = parsed.pages;
      }

      // 渲染宽度自选（600-2000，超出钳制——宽窄是偏好不是错误）；默认两档：
      // 精准转 / 扫描件 2000 细看档，批转 1080 浏览档。crop 的像素坐标系就是
      // 这个宽度渲染出的整页图——所以 crop 解析放在宽度定下来之后
      const defaultWidth = pickedPages !== null || scannedAsImages ? PDF_IMAGE_HD_WIDTH : PDF_IMAGE_WIDTH;
      const widthRaw =
        typeof args["width"] === "number" && Number.isFinite(args["width"]) ? Math.floor(args["width"]) : defaultWidth;
      const renderWidth = Math.min(PDF_IMAGE_WIDTH_MAX, Math.max(PDF_IMAGE_WIDTH_MIN, widthRaw));

      // crop 区域特写（像素坐标）：只配 image_pages（模型先看过整页才给得出坐标；
      // 批转是整页浏览、扫描件自动转时模型还没看过页面，带 crop 都是语义错误）
      const cropSpec = typeof args["crop"] === "string" ? args["crop"].trim() : "";
      let crop: CropRectPx | null = null;
      if (cropSpec !== "") {
        if (pickedPages === null) {
          throw new Error('crop requires image_pages (look at the whole page first, then crop the figure region).');
        }
        const parsed = parseCropPx(cropSpec, renderWidth);
        if (!parsed.ok) throw new Error(parsed.error);
        crop = parsed.crop;
      }

      // 批转（images: true）把文本批也收紧到 5——图与文本同批；精准转图时文本批
      // 仍是完整 20 页（图只加在指定页上，不占文本的页数预算）
      const batchImageMode = (wantsImages && canSeeImages) || scannedAsImages;
      const pageCap = batchImageMode ? PDF_IMAGE_MAX_PAGES_PER_CALL : PDF_MAX_PAGES_PER_CALL;

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

      const continueHint = last < totalPages ? ` Use offset=${last + 1} to continue.` : "";
      // 稀疏页提示与图表索引只挂在纯文本模式：配合式读法的入口——模型据此对值得的
      // 页要图，已经在拿图的调用里再列一遍是噪音
      const textOnlyCall = !batchImageMode && pickedPages === null && !scannedAsImages;
      const sparseHint = textOnlyCall ? sparsePages(text, totalChars).map((page) => `${page}`).join(", ") : "";
      const sparseLine = sparseHint !== "" ? ` Pages with little text (likely figures): ${sparseHint}.` : "";
      const figures = textOnlyCall ? figureIndex(text) : [];
      const figureLine =
        figures.length > 0
          ? ` Figures and tables: ${figures.map((f) => `${f.label} p.${f.page}`).join("; ")}.`
          : "";

      let header: string;
      let images: { type: "image"; data: string; mimeType: string }[] = [];
      let sizeNotes: string[] = [];
      if (scannedAsImages) {
        // 扫描件的页图就是正文，按高清渲（读字要分辨率）
        ({ images, sizeNotes } = await renderPages(pdf, rangeList(first, last), renderWidth, null));
        header =
          `[Scanned PDF with no text layer: ${totalPages} pages. Rendered pages ${first}-${last} as images ` +
          `(${sizeNotes.join(", ")}).${continueHint}]`;
      } else if (pickedPages !== null) {
        ({ images, sizeNotes } = await renderPages(pdf, pickedPages, renderWidth, crop));
        header =
          `[PDF with ${totalPages} pages. Text of pages ${first}-${last} of ${totalPages}; images of ` +
          `pages ${pickedPages.join(", ")} follow the text${crop === null ? "" : ` (cropped to ${cropSpec})`}. ` +
          `Image sizes: ${sizeNotes.join(", ")}. Crop coordinates are pixels on these images.${continueHint}]`;
      } else if (batchImageMode) {
        ({ images, sizeNotes } = await renderPages(pdf, rangeList(first, last), renderWidth, null));
        header =
          `[PDF with ${totalPages} pages. Showing pages ${first}-${last} of ${totalPages}; page images follow ` +
          `the text. Image sizes: ${sizeNotes.join(", ")}.${continueHint}]`;
      } else if (wantsAnyImages) {
        // 要了图但模型看不见：降级纯文本，说清图为什么没来
        header =
          `[PDF with ${totalPages} pages. Showing pages ${first}-${last} of ${totalPages}.\n${NON_VISION_NOTE}` +
          `${continueHint}${sparseLine}${figureLine}]`;
      } else {
        header =
          `[PDF with ${totalPages} pages. Showing pages ${first}-${last} of ${totalPages}.` +
          `${continueHint}${sparseLine}${figureLine}]`;
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

/** 连续页码列表（renderPages 的批转适配） */
function rangeList(first: number, last: number): number[] {
  const pages: number[] = [];
  for (let page = first; page <= last; page++) pages.push(page);
  return pages;
}
