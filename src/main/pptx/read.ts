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
import { StringDecoder } from "node:string_decoder";
import { createInflateRaw } from "node:zlib";
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
import {
  childrenNamed,
  countElements,
  descendants,
  firstDescendant,
  localNameOf,
  parseXml,
  type XmlElement,
} from "./xml.ts";

export interface PptxReadOptions {
  /** 以下三个只为测试注入小上限，生产路径用契约常量 */
  limit?: number;
  maxSlides?: number;
  textLimit?: number;
  /** 单个 XML 部件最多解压多少字符（默认 1.5 M；真实 slide 远小于此） */
  maxPartChars?: number;
  /** 整份演示文稿最多解压多少 XML 字符（默认 40 M；挡住重复大页的攻击包） */
  maxDeckChars?: number;
  /** 单页最多建多少个 XML 节点（默认 50 k） */
  maxPartNodes?: number;
}

/** zip 的本地文件头（真正的 .pptx 是 OOXML = zip 容器） */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
/** OLE2 复合文档头：加密的 .pptx 与旧版 .ppt 都长这样 */
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

/**
 * 每页 / 整个 deck 的解析成本预算（评审构造包：40 页 × 15.7 MB 元素密集）。
 * 单页 1.5 M 字符已经比真实幻灯片大一两个数量级；真的超了说明这页对大綱没价值，
 * 整份选停止（与页数上限一样标 truncated）。
 */
const PPTX_MAX_PART_CHARS = 1_500_000;
const PPTX_MAX_DECK_CHARS = 40_000_000;
const PPTX_MAX_PART_NODES = 50_000;

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

/**
 * zip 条目的内部形态（jszip 3.10.2 精确锁版本）：
 * `_data.compressedContent` 是**压缩后**的字节，`compression.magic` 区分 STORE / DEFLATE。
 * 用私有字段是有意的：`internalStream` 超限后只能 pause，解压状态会留住事件句柄；
 * 用 Node 的 zlib 流可以在超限时 destroy，CPU 与内存一起停住。
 */
type CompressedEntry = {
  _data?: {
    compressedContent?: Buffer | Uint8Array;
    compression?: { magic?: string };
  };
};

interface CappedText {
  text: string;
  /** 读到的字符数超过了上限（解压已中止） */
  over: boolean;
}

/** 压缩方法首字节：0 = STORE，8 = DEFLATE（OOXML 只用这两种） */
const STORE_METHOD = 0;
const DEFLATE_METHOD = 8;

/**
 * 读一个 XML 部件，到 maxChars 就中止解压。这是 R1 的核心：`entry.async("string")`
 * 会把整条 entry 一次解压完——一个 0.9 MB 的包可以写 40 页 × 15 MB 的元素密集 XML，
 * 解压完全吃掉几秒与 1 GB 内存。这里用 Node zlib 逐块解压并计数，超限立刻 destroy，
 * 不依赖 zip 目录里的 uncompressedSize（构造包可以撒谎）。
 */
function readTextCapped(entry: JSZip.JSZipObject, maxChars: number): Promise<CappedText> {
  const data = (entry as unknown as CompressedEntry)._data;
  const content = data?.compressedContent;
  if (content === undefined) return Promise.reject(new Error("The zip entry has no compressed data"));
  const compressed = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const method = data?.compression?.magic?.charCodeAt(0) ?? STORE_METHOD;
  if (method === STORE_METHOD) {
    const text = compressed.toString("utf8");
    return Promise.resolve(
      text.length > maxChars ? { text: text.slice(0, maxChars), over: true } : { text, over: false },
    );
  }
  if (method !== DEFLATE_METHOD) return Promise.reject(new Error("Unsupported zip compression method"));

  return new Promise<CappedText>((resolve, reject) => {
    const inflate = createInflateRaw();
    const decoder = new StringDecoder("utf8");
    let text = "";
    let settled = false;
    const finish = (over: boolean, error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error !== undefined) reject(error);
      else resolve({ text, over });
    };
    inflate.on("data", (chunk: Buffer) => {
      if (settled) return;
      const piece = decoder.write(chunk);
      const room = maxChars - text.length;
      if (piece.length > room) {
        if (room > 0) text += piece.slice(0, room);
        // destroy 而不是 pause：解压线程池里的工作一起停，谁也不留句柄
        inflate.destroy();
        finish(true);
        return;
      }
      text += piece;
    });
    inflate.on("end", () => {
      if (settled) return;
      text += decoder.end();
      finish(text.length > maxChars);
    });
    inflate.on("error", (cause: Error) => finish(false, cause));
    inflate.end(compressed);
  });
}

/** 解析成本预算：每部件上限 + 整份 deck 剩余的 XML 字符 */
interface ParseBudget {
  deckCharsLeft: number;
  partChars: number;
  partNodes: number;
}

interface XmlPartResult {
  doc: XmlElement | null;
  /** 这一部件因为字符 / 节点上限被放弃 */
  over: boolean;
}

/**
 * 读一个 XML 部件并建树。缺件抛错（由 readPptx 统一落成 unreadable）；
 * 超预算回 { doc: null, over: true }，由调用方决定是跳过（版式/备注）还是停掉整份。
 */
async function readXmlPart(
  zip: JSZip,
  part: string,
  budget: ParseBudget,
  optional: boolean,
): Promise<XmlPartResult> {
  const entry = zip.file(part);
  if (entry === null) {
    if (optional) return { doc: null, over: false };
    throw new Error(`Missing ${part}`);
  }
  const allowance = Math.min(budget.partChars, budget.deckCharsLeft);
  if (allowance <= 0) return { doc: null, over: true };
  const { text, over } = await readTextCapped(entry, allowance);
  budget.deckCharsLeft -= text.length;
  if (over) return { doc: null, over: true };
  const doc = parseXml(text);
  if (countElements(doc, budget.partNodes) > budget.partNodes) return { doc: null, over: true };
  return { doc, over: false };
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

/**
 * `p:sldId` 的关系 id。优先 `r:id`；前缀是书写自由，若文件改用了别的前缀，
 * 取任意一个「带前缀且本地名为 id」的属性（无前缀的 `id` 是页码 id，不能拿）。
 */
function relationshipIdOf(entry: XmlElement): string | undefined {
  const direct = entry.attrs["r:id"];
  if (direct !== undefined) return direct;
  for (const [key, value] of Object.entries(entry.attrs)) {
    const colon = key.indexOf(":");
    if (colon > 0 && key.slice(colon + 1).toLowerCase() === "id") return value;
  }
  return undefined;
}

/** 隐藏页：`<p:sld show="0">`（PowerPoint 的隐藏幻灯片）。仍计入页数，列表上标注 */
function isHiddenSlide(doc: XmlElement): boolean {
  const root = doc.children.find((child) => localNameOf(child.name) === "sld");
  const show = root?.attrs.show;
  return show === "0" || show === "false";
}

/** 段落文字：只聚合 `a:r/a:t`（域 `a:fld` 不读——页码 / 日期不是正文），`a:br` 落成换行 */
function paragraphText(paragraph: XmlElement): string {
  let text = "";
  for (const child of paragraph.children) {
    const name = localNameOf(child.name);
    if (name === "r") {
      for (const run of descendants(child, "a:t")) text += run.text;
    } else if (name === "br") {
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
    // **只有显式占位符才按占位符判**：纯文本框没有 p:ph，不能去 layoutTypes 里
    // 拿 idx=0 的类型（版式里真标题就记在 "0"）——否则普通文本框会被当成页标题，
    // 压在真标题上时还会把真标题降级成正文。
    const isPlaceholder = ph !== undefined;
    // 占位符省略 type 时用 idx 去版式找；找不到按 body（PowerPoint 正文的默认）
    const type = isPlaceholder ? (ph.attrs.type ?? layoutTypes.get(ph.attrs.idx ?? "0") ?? "body") : "";
    if (isPlaceholder && (type === "title" || type === "ctrTitle") && title === "") {
      title = shapeParagraphs(shape, false)
        .map((paragraph) => paragraph.text.trim())
        .filter((text) => text !== "")
        .join(" ");
      continue;
    }
    if (isPlaceholder && NOT_BODY_PH.has(type)) continue;
    // 没有 ph 的纯文本框也是正文；占位符里 body / obj 走正文的默认符号，
    // subTitle（封面副标题）默认不带点——这正是 PowerPoint 的样子
    const isBodyPlaceholder = isPlaceholder && (type === "body" || type === "obj");
    for (const paragraph of shapeParagraphs(shape, isBodyPlaceholder)) {
      const text = paragraph.text.trim();
      if (text === "") continue;
      // 纯文本框里的多级缩进仍保留 level；显式写了 a:buChar 的也照实带符号
      body.push({ level: paragraph.level, text, bullet: paragraph.bullet });
    }
  }

  const tables: PptxTable[] = descendants(doc, "a:tbl").map(readTable);

  return {
    title,
    body,
    tables,
    pictureCount: descendants(doc, "p:pic").length,
  };
}

/** 一个表格单元格里的文字：多段用换行连起来 */
function tableCellText(cell: XmlElement): string {
  const txBody = firstDescendant(cell, "a:txBody");
  if (txBody === undefined) return "";
  return childrenNamed(txBody, "a:p")
    .map((paragraph) => paragraphText(paragraph).trim())
    .filter((text) => text !== "")
    .join("\n");
}

/**
 * 一张表按网格展开。**合并必须算**：`gridSpan` 的锚点占多列、被盖住的 `hMerge`
 * 格子不再算一列，否则合并表后面的每列都会往右错位（评审里「右下」跑到第三列
 * 就是这一条）。纵向 `vMerge` / `rowSpan` 的占位格保留为空串，列位不动。
 */
function readTable(table: XmlElement): PptxTable {
  const grid: string[][] = [];
  for (const row of childrenNamed(table, "a:tr")) {
    const cells: string[] = [];
    for (const cell of childrenNamed(row, "a:tc")) {
      const tcPr = firstDescendant(cell, "a:tcPr");
      const hMerge = tcPr?.attrs.hMerge === "1" || tcPr?.attrs.hMerge === "true";
      // 横向合并的延续格：前一个锚点的 gridSpan 已经占掉这一列
      if (hMerge) continue;
      const rawSpan = Number.parseInt(tcPr?.attrs.gridSpan ?? "1", 10);
      const span = Number.isFinite(rawSpan) ? Math.min(64, Math.max(1, rawSpan)) : 1;
      cells.push(tableCellText(cell));
      for (let extra = 1; extra < span; extra++) cells.push("");
    }
    grid.push(cells);
  }
  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
  return {
    rows: grid.map((row) => {
      const padded = row.slice();
      while (padded.length < width) padded.push("");
      return padded;
    }),
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
  /** 整份演示文稿的页数（没被页数上限 / 成本预算裁掉的真实页数） */
  slideCount: number;
  /** 因解析成本预算提前停止（后面的页没解析） */
  budgetLimited: boolean;
}

/** 读整份 deck：页序来自 sldIdLst，每页再经 slide 自己的 rels 找版式与备注 */
async function readDeck(
  zip: JSZip,
  maxSlides: number,
  textLimit: number,
  budget: ParseBudget,
): Promise<DeckParts> {
  const presentation = await readXmlPart(zip, "ppt/presentation.xml", budget, false);
  if (presentation.doc === null) throw new Error("ppt/presentation.xml is too large to parse");
  const order = firstDescendant(presentation.doc, "p:sldIdLst");
  if (order === undefined) throw new Error("Missing p:sldIdLst in ppt/presentation.xml");
  const relsResult = await readXmlPart(zip, "ppt/_rels/presentation.xml.rels", budget, false);
  if (relsResult.doc === null) throw new Error("ppt/_rels/presentation.xml.rels is too large to parse");
  const presentationRels = relationshipsOf(relsResult.doc);

  // 页序 = sldIdLst 的顺序；文件名只是 parts 里的地址（复制 / 重排过的文件里
  // slide3.xml 可能就是第 1 页）
  const parts: string[] = [];
  for (const entry of childrenNamed(order, "p:sldId")) {
    const relId = relationshipIdOf(entry);
    if (relId === undefined) throw new Error("A p:sldId has no relationship id");
    const relationship = presentationRels.get(relId);
    if (relationship === undefined) throw new Error(`No relationship for ${relId}`);
    parts.push(resolveTarget("ppt/presentation.xml", relationship.target));
  }

  // 版式信息按部件缓存：一份 20 页的演示文稿常只有 3–4 种版式
  const layouts = new Map<string, LayoutInfo>();
  const emptyLayout: LayoutInfo = { name: "", placeholderTypes: new Map() };
  const slides: PptxSlide[] = [];
  let budgetLimited = false;
  for (const [index, part] of parts.slice(0, maxSlides).entries()) {
    // 预算已经花光：后面的页不再解压，整份标「只解析了前 N 页」
    if (budget.deckCharsLeft <= 0) {
      budgetLimited = true;
      break;
    }
    const slideResult = await readXmlPart(zip, part, budget, false);
    if (slideResult.doc === null) {
      budgetLimited = true;
      break;
    }
    const doc = slideResult.doc;

    let layout = emptyLayout;
    let notes = "";
    // 版式 / 备注是可选信息：读不到 / 超预算只丢那一块，不让整份大纲失败
    const slideRelsResult = await readXmlPart(zip, relsPathOf(part), budget, true);
    if (slideRelsResult.doc !== null) {
      const slideRels = relationshipsOf(slideRelsResult.doc);
      const layoutTarget = targetOfType(slideRels, "/slideLayout");
      if (layoutTarget !== undefined) {
        const layoutPart = resolveTarget(part, layoutTarget);
        const cached = layouts.get(layoutPart);
        if (cached !== undefined) {
          layout = cached;
        } else {
          const layoutResult = await readXmlPart(zip, layoutPart, budget, true);
          if (layoutResult.doc !== null) {
            layout = layoutInfoOf(layoutResult.doc);
            layouts.set(layoutPart, layout);
          }
        }
      }
      const notesTarget = targetOfType(slideRels, "/notesSlide");
      if (notesTarget !== undefined) {
        const notesResult = await readXmlPart(zip, resolveTarget(part, notesTarget), budget, true);
        if (notesResult.doc !== null) notes = readNotes(notesResult.doc);
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
      hidden: isHiddenSlide(doc),
      truncated: false,
    };
    limitSlideText(slide, textLimit);
    slides.push(slide);
  }
  return { slides, slideCount: parts.length, budgetLimited };
}

/**
 * 读一份 .pptx 的只读大纲。调用方（ipc.ts）已过白名单并确认 `.pptx` 扩展名。
 */
export async function readPptx(path: string, options: PptxReadOptions = {}): Promise<PptxPreview> {
  const limit = options.limit ?? PPTX_MAX_BYTES;
  const maxSlides = options.maxSlides ?? PPTX_MAX_SLIDES;
  const textLimit = options.textLimit ?? PPTX_SLIDE_TEXT_LIMIT;
  const budget: ParseBudget = {
    deckCharsLeft: options.maxDeckChars ?? PPTX_MAX_DECK_CHARS,
    partChars: options.maxPartChars ?? PPTX_MAX_PART_CHARS,
    partNodes: options.maxPartNodes ?? PPTX_MAX_PART_NODES,
  };
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
    const deck = await readDeck(zip, maxSlides, textLimit, budget);
    return {
      kind: "deck",
      slides: deck.slides,
      slideCount: deck.slideCount,
      truncated: deck.slideCount > deck.slides.length,
      budgetLimited: deck.budgetLimited,
      size,
      modifiedAt,
    };
  } catch (cause) {
    return { kind: "unreadable", reason: "corrupt", detail: failMessage(cause), size, modifiedAt };
  }
}
