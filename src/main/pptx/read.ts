/**
 * `fs:read-pptx` 的实做（契约在 `shared/pptx.ts`）。**纯模块**（同 `files/read.ts`、
 * `xlsx/read.ts` 的先例）：不 import electron，白名单校验在 ipc.ts 做完才把真实路径
 * 传进来，这里只管「给一条路径，读出可读的大纲」，`node --test` 能直接加载测。
 *
 * 解析路线是 jszip 解包 + 自写的小 XML 树（`xml.ts`，零新依赖）：pptx 是 OOXML，
 * 我们要的只是页序、标题、正文层级、表格、备注——足够小，不值得为它引一个 XML
 * 解析器或 office 全家桶。**不做渲染 / 缩略图**（理由见 shared/pptx.ts 顶注释）。
 *
 * 页序的权威是 `ppt/presentation.xml` 的 `sldIdLst`：幻灯片文件名不保证与页序一致
 * （复制 / 重排过的文件里 `slide3.xml` 可能是第 1 页），按文件名排会给出错误的顺序。
 * 每一页经 `ppt/_rels/presentation.xml.rels` 映射到 parts 里的真实文件名。
 *
 * 样式继承（layout → master → theme）第一版不做：字号 / 颜色 / 主题的最终形态要沿三层链
 * 求值，读错了比不读更误导。唯一接上的是版式里的**占位符类型**（`p:ph idx` → type）：
 * 真实幻灯片常省略 type，不接这一层，封面副标题会被误当成正文而多出一个项目符号。
 *
 * 读不了的文件**不抛错**，回 `unreadable`：说清是「太大 / 有密码 / 坏了」比抛一句
 * 英文异常有用。抛错的只有「这不是一个文件」这类调用方的错。
 */
import { readFile, stat } from "node:fs/promises";
import JSZip from "jszip";
import {
  PPTX_MAX_BYTES,
  PPTX_MAX_SLIDES,
  PPTX_SLIDE_TEXT_LIMIT,
  type PptxParagraph,
  type PptxPreview,
  type PptxSlide,
  type PptxTable,
} from "../../shared/pptx.ts";
import { childrenNamed, descendants, firstDescendant, parseXml, type XmlElement } from "./xml.ts";

export interface PptxReadOptions {
  /** 以下三个只为测试注入小上限，生产路径用契约常量 */
  limit?: number;
  maxSlides?: number;
  textLimit?: number;
}

/** zip 的本地文件头（真正的 .pptx 是 OOXML = zip 容器） */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
/** OLE2 复合文档头：加密的 .pptx 与旧版 .ppt 都长这样 */
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

/**
 * 单个 XML 部件解压后的上限。压缩包 50 MB 但单条 entry 解出几百 MB 的 zip bomb
 * 不该把主进程拖垮；正常的 slide 部件远小于这个数。
 */
const XML_ENTRY_MAX_BYTES = 16 * 1024 * 1024;

/** 正文占位符之外不可能是正文的占位符（页脚 / 页码 / 日期 / 媒体） */
const NOT_BODY_PH = new Set(["sldNum", "hdr", "ftr", "dt", "pic", "chart", "tbl", "media", "sldImg"]);
/** 备注页里不该算进备注的占位符（页码 / 页眉 / 页脚 / 日期） */
const NOT_NOTES_PH = new Set(["sldNum", "hdr", "ftr", "dt"]);

const failMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** 文件头是不是指定的那几个字节（文件比 magic 短就当不是） */
function startsWith(buffer: Buffer, magic: readonly number[]): boolean {
  if (buffer.length < magic.length) return false;
  return magic.every((byte, index) => buffer[index] === byte);
}

/** zip 里的一条 entry（只用到解压成字符串；`_data` 拿未压缩尺寸做护栏） */
type ZipEntry = {
  async(type: "string"): Promise<string>;
  _data?: { uncompressedSize?: number };
};

/**
 * 读一个 XML 部件并建树。缺件抛错（由 readPptx 统一落成 unreadable），
 * 解压前先看未压缩尺寸，挡住 zip bomb。
 */
async function readXmlPart(zip: JSZip, part: string): Promise<XmlElement> {
  const entry = zip.file(part) as unknown as ZipEntry | null;
  if (entry === null) throw new Error(`Missing ${part}`);
  const size = entry._data?.uncompressedSize ?? 0;
  if (size > XML_ENTRY_MAX_BYTES) throw new Error(`${part} is too large (${size} bytes)`);
  return parseXml(await entry.async("string"));
}

/** `ppt/slides/slide1.xml` → `ppt/slides/_rels/slide1.xml.rels` */
function relsPathOf(part: string): string {
  const segments = part.split("/");
  const name = segments.pop() ?? part;
  return `${segments.join("/")}/_rels/${name}.rels`;
}

/** OOXML 的 Target（相对当前部件）解成包内绝对路径；`/ppt/...` 这种也认 */
function resolveTarget(part: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segments = part.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

interface Relationship {
  type: string;
  target: string;
}

/** rels 文档 → { Id: { type, target } } */
function relationshipsOf(doc: XmlElement): Map<string, Relationship> {
  const map = new Map<string, Relationship>();
  for (const rel of descendants(doc, "Relationship")) {
    const id = rel.attrs.Id;
    const target = rel.attrs.Target;
    if (id === undefined || target === undefined || target === "") continue;
    map.set(id, { type: rel.attrs.Type ?? "", target });
  }
  return map;
}

/** 关系表里第一条指定类型的 target（layout / notesSlide 各只有一条） */
function targetOfType(rels: Map<string, Relationship>, suffix: string): string | undefined {
  for (const rel of rels.values()) {
    if (rel.type.endsWith(suffix)) return rel.target;
  }
  return undefined;
}

/** 段落文字：只聚合 `a:r/a:t`（域 `a:fld` 不读——页码 / 日期不是正文），`a:br` 落成换行 */
function paragraphText(paragraph: XmlElement): string {
  let text = "";
  for (const child of paragraph.children) {
    if (child.name === "a:r") {
      for (const run of descendants(child, "a:t")) text += run.text;
    } else if (child.name === "a:br") {
      text += "\n";
    }
  }
  return text.replace(/\r/g, "");
}

/** `a:pPr/@lvl` 夹到 0–8（PowerPoint 只有九级）；缺省 / 坏值都是 0 */
function paragraphLevel(pPr: XmlElement | undefined): number {
  if (pPr === undefined) return 0;
  const raw = Number.parseInt(pPr.attrs.lvl ?? "", 10);
  if (!Number.isFinite(raw)) return 0;
  return Math.min(8, Math.max(0, raw));
}

/**
 * 一个形状里 `p:txBody` 的段落。`defaultBullet` 是「占位符的缺省符号」：
 * 正文占位符在 PowerPoint 里默认带项目符号，纯文本框默认不带。
 */
function shapeParagraphs(shape: XmlElement, defaultBullet: boolean): PptxParagraph[] {
  const body = firstDescendant(shape, "p:txBody");
  if (body === undefined) return [];
  const paragraphs: PptxParagraph[] = [];
  for (const paragraph of childrenNamed(body, "a:p")) {
    const pPr = childrenNamed(paragraph, "a:pPr")[0];
    const hasChar = pPr !== undefined && childrenNamed(pPr, "a:buChar").length > 0;
    const hasAutoNum = pPr !== undefined && childrenNamed(pPr, "a:buAutoNum").length > 0;
    const hasNone = pPr !== undefined && childrenNamed(pPr, "a:buNone").length > 0;
    const bullet = hasChar || hasAutoNum ? true : hasNone ? false : defaultBullet;
    paragraphs.push({
      level: paragraphLevel(pPr),
      text: paragraphText(paragraph),
      bullet,
    });
  }
  return paragraphs;
}

/** 一页的文本半边：标题 / 正文 / 表格 / 图片数 */
interface SlideParts {
  title: string;
  body: PptxParagraph[];
  tables: PptxTable[];
  pictureCount: number;
}

function readSlideParts(doc: XmlElement, layoutTypes: ReadonlyMap<string, string>): SlideParts {
  let title = "";
  const body: PptxParagraph[] = [];
  for (const shape of descendants(doc, "p:sp")) {
    const ph = firstDescendant(shape, "p:ph");
    // 真实幻灯片里 python-pptx / PowerPoint 常写 `<p:ph idx="1"/>`，type 由版式
    // 继承（版式里同一个 idx 写着 body / subTitle）。只接这一层，不做样式链
    const idx = ph?.attrs.idx ?? "0";
    const type = ph?.attrs.type ?? layoutTypes.get(idx) ?? "";
    if ((type === "title" || type === "ctrTitle") && title === "") {
      title = shapeParagraphs(shape, false)
        .map((paragraph) => paragraph.text.trim())
        .filter((text) => text !== "")
        .join(" ");
      continue;
    }
    if (NOT_BODY_PH.has(type)) continue;
    // 没有 ph 的纯文本框也是正文；占位符里 body / obj 与解析不到类型的那一类走正文的
    // 缺省符号，subTitle（封面副标题）默认不带点——这正是 PowerPoint 的样子
    const isBodyPlaceholder =
      ph !== undefined && (type === "" || type === "body" || type === "obj");
    for (const paragraph of shapeParagraphs(shape, isBodyPlaceholder)) {
      const text = paragraph.text.trim();
      if (text === "") continue;
      // 纯文本框里的多级缩进仍保留 level；显式写了 a:buChar 的也照实带符号
      body.push({ level: paragraph.level, text, bullet: paragraph.bullet });
    }
  }

  const tables: PptxTable[] = descendants(doc, "a:tbl").map((table) => ({
    rows: childrenNamed(table, "a:tr").map((row) =>
      childrenNamed(row, "a:tc").map((cell) => {
        const txBody = firstDescendant(cell, "a:txBody");
        if (txBody === undefined) return "";
        return childrenNamed(txBody, "a:p")
          .map((paragraph) => paragraphText(paragraph).trim())
          .filter((text) => text !== "")
          .join("\n");
      }),
    ),
  }));

  return {
    title,
    body,
    tables,
    pictureCount: descendants(doc, "p:pic").length,
  };
}

/** 演讲者备注：跳过页码 / 页眉 / 页脚 / 日期占位符，段落按原文顺序换行连起来 */
function readNotes(doc: XmlElement): string {
  const lines: string[] = [];
  for (const shape of descendants(doc, "p:sp")) {
    const type = firstDescendant(shape, "p:ph")?.attrs.type ?? "";
    if (NOT_NOTES_PH.has(type)) continue;
    for (const paragraph of shapeParagraphs(shape, false)) {
      const text = paragraph.text.trim();
      if (text !== "") lines.push(text);
    }
  }
  return lines.join("\n");
}

/** 版式能给的两件事：名字（页列表标签）与占位符 idx → type（slide 省略 type 时回落） */
interface LayoutInfo {
  name: string;
  placeholderTypes: Map<string, string>;
}

function layoutInfoOf(doc: XmlElement): LayoutInfo {
  const name = firstDescendant(doc, "p:cSld")?.attrs.name ?? "";
  const placeholderTypes = new Map<string, string>();
  for (const ph of descendants(doc, "p:ph")) {
    const type = ph.attrs.type;
    if (type === undefined || type === "") continue;
    placeholderTypes.set(ph.attrs.idx ?? "0", type);
  }
  return { name, placeholderTypes };
}

/**
 * 单页文字封顶。按「标题 → 正文 → 表格 → 备注」的顺序花预算：超出的截断、后面的
 * 整段丢弃，全部记在 `truncated` 上——界面据此如实说「这一页的文字被截断了」，
 * 而不是假装原文就这么短。
 */
function limitSlideText(slide: PptxSlide, limit: number): void {
  let budget = limit;
  let truncated = false;
  const take = (text: string): string => {
    if (text === "") return "";
    if (budget <= 0) {
      truncated = true;
      return "";
    }
    if (text.length <= budget) {
      budget -= text.length;
      return text;
    }
    truncated = true;
    const kept = text.slice(0, budget);
    budget = 0;
    return kept;
  };

  slide.title = take(slide.title);
  slide.body = slide.body
    .map((paragraph) => ({ ...paragraph, text: take(paragraph.text) }))
    .filter((paragraph) => paragraph.text !== "");
  slide.tables = slide.tables.map((table) => ({
    rows: table.rows.map((row) => row.map((cell) => take(cell))),
  }));
  slide.notes = take(slide.notes);
  slide.truncated = truncated;
}

interface DeckParts {
  slides: PptxSlide[];
  /** 整份演示文稿的页数（没被页数上限裁掉的真实页数） */
  slideCount: number;
}

/** 读整份 deck：页序来自 sldIdLst，每页再经 slide 自己的 rels 找版式与备注 */
async function readDeck(zip: JSZip, maxSlides: number, textLimit: number): Promise<DeckParts> {
  const presentation = await readXmlPart(zip, "ppt/presentation.xml");
  const order = firstDescendant(presentation, "p:sldIdLst");
  if (order === undefined) throw new Error("Missing p:sldIdLst in ppt/presentation.xml");
  const presentationRels = relationshipsOf(await readXmlPart(zip, "ppt/_rels/presentation.xml.rels"));

  // 页序 = sldIdLst 的顺序；文件名只是 parts 里的地址（复制 / 重排过的文件里
  // slide3.xml 可能就是第 1 页）
  const parts: string[] = [];
  for (const entry of childrenNamed(order, "p:sldId")) {
    const relId = entry.attrs["r:id"];
    if (relId === undefined) throw new Error("A p:sldId has no r:id");
    const relationship = presentationRels.get(relId);
    if (relationship === undefined) throw new Error(`No relationship for ${relId}`);
    parts.push(resolveTarget("ppt/presentation.xml", relationship.target));
  }

  // 版式信息按部件缓存：一份 20 页的演示文稿常只有 3–4 种版式
  const layouts = new Map<string, LayoutInfo>();
  const emptyLayout: LayoutInfo = { name: "", placeholderTypes: new Map() };
  const slides: PptxSlide[] = [];
  for (const [index, part] of parts.slice(0, maxSlides).entries()) {
    const doc = await readXmlPart(zip, part);

    let layout = emptyLayout;
    let notes = "";
    const relsEntry = zip.file(relsPathOf(part));
    if (relsEntry !== null) {
      const slideRels = relationshipsOf(await readXmlPart(zip, relsPathOf(part)));
      const layoutTarget = targetOfType(slideRels, "/slideLayout");
      if (layoutTarget !== undefined) {
        const layoutPart = resolveTarget(part, layoutTarget);
        const cached = layouts.get(layoutPart);
        if (cached !== undefined) {
          layout = cached;
        } else if (zip.file(layoutPart) !== null) {
          // 版式读不到只丢一个标签 / 一种默认符号，不该让整份大纲失败
          layout = layoutInfoOf(await readXmlPart(zip, layoutPart));
          layouts.set(layoutPart, layout);
        }
      }
      const notesTarget = targetOfType(slideRels, "/notesSlide");
      if (notesTarget !== undefined) {
        const notesPart = resolveTarget(part, notesTarget);
        if (zip.file(notesPart) !== null) notes = readNotes(await readXmlPart(zip, notesPart));
      }
    }

    const content = readSlideParts(doc, layout.placeholderTypes);
    const slide: PptxSlide = {
      number: index + 1,
      layoutName: layout.name,
      title: content.title,
      body: content.body,
      tables: content.tables,
      notes,
      pictureCount: content.pictureCount,
      truncated: false,
    };
    limitSlideText(slide, textLimit);
    slides.push(slide);
  }
  return { slides, slideCount: parts.length };
}

/**
 * 读一份 .pptx 的只读大纲。调用方（ipc.ts）已过白名单并确认 `.pptx` 扩展名。
 */
export async function readPptx(path: string, options: PptxReadOptions = {}): Promise<PptxPreview> {
  const limit = options.limit ?? PPTX_MAX_BYTES;
  const maxSlides = options.maxSlides ?? PPTX_MAX_SLIDES;
  const textLimit = options.textLimit ?? PPTX_SLIDE_TEXT_LIMIT;
  const stats = await stat(path);
  if (!stats.isFile()) throw new Error(`Not a file: ${path}`);
  const size = stats.size;
  const modifiedAt = stats.mtimeMs;
  if (size > limit) return { kind: "too-large", limit, size, modifiedAt };

  const buffer = await readFile(path);
  if (startsWith(buffer, OLE2_MAGIC)) {
    return {
      kind: "unreadable",
      reason: "password",
      detail: "OLE2 container (encrypted deck or legacy .ppt)",
      size,
      modifiedAt,
    };
  }
  if (!startsWith(buffer, ZIP_MAGIC)) {
    return {
      kind: "unreadable",
      reason: "corrupt",
      detail: "Not a zip container — not an .pptx file",
      size,
      modifiedAt,
    };
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (cause) {
    return { kind: "unreadable", reason: "corrupt", detail: failMessage(cause), size, modifiedAt };
  }

  try {
    const deck = await readDeck(zip, maxSlides, textLimit);
    return {
      kind: "deck",
      slides: deck.slides,
      slideCount: deck.slideCount,
      truncated: deck.slideCount > deck.slides.length,
      size,
      modifiedAt,
    };
  } catch (cause) {
    return { kind: "unreadable", reason: "corrupt", detail: failMessage(cause), size, modifiedAt };
  }
}
