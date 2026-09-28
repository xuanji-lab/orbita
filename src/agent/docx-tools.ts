import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import JSZip from "jszip";
import mammoth from "mammoth";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { imageMimeOf, shrinkIfNeeded } from "./image-tools.ts";

/**
 * agent 的 Word 工具：read_docx。
 *
 * docx 是 zip + OOXML：正文在 word/document.xml，pi 协议的用户块只有
 * text | image，read 读它出来是压缩二进制乱码（本仓 patch 让 read 对
 * .docx 返回指路文案）。结构化提取由此工具承载，与 read_pdf 同一个
 * 设计语言：模型按需调用、按块分片读。
 *
 * **解析**：mammoth（纯 JS，微软 markitdown 的 docx 内核同款路线）把
 * OOXML 语义映射成 HTML（标题/列表/表格/链接/脚注/批注，丢视觉格式与
 * 页——docx 文件里没有页，分页是渲染概念），再经自写的薄转换
 * （htmlToMarkdown，~150 行）落成 markdown。不引 turndown：mammoth 的
 * 输出标签子集小且完全可控（实测见 docx-tools.test.ts 夹具），转换是
 * 纯函数好钉测试。
 *
 * **分片轴是顶层块号**（段落/标题/表格/列表/图片占位各占一号），不是
 * read_pdf 的页码——docx 给不了可靠页码（页码是域，渲染时才求值）。
 * 头注带 Sections 大纲（heading → 起始块号），等价 read_pdf 图表索引
 * 的定位层：模型按大纲直接跳块。
 *
 * **内嵌图片**：mammoth 默认把图转 base64 塞进 HTML 的 src——会撑爆
 * 字符封顶，故 convertImage 钩子里只收 buffer、HTML 放 `docximg:N`
 * 占位 URI，正文出 `[image N: alt]` 文本占位。images=true 时当前块范围
 * 内的图转成 pi image 块（仅视觉模型；read_pdf 同款降级），并过
 * show_image 的转录纪律（长边 >2000 缩放重编码——转录不存原图）。
 *
 * 批注：mammoth 默认丢弃，styleMap `comment-reference => sup` 让正文
 * 锚点出 `[Z1]` 上标、文末自动附批注内容（协作审阅场景）。修订按
 * accept、页眉页脚不读（mammoth 不支持，挂账）。
 *
 * **agent 进程直读文件，不过主进程**（read_pdf 同一信任边界），
 * READ_ONLY_TOOLS 收编。
 */

/** 单次最多输出多少字符的正文。上下文护栏：read_pdf 20 页密排文本同量级 */
export const DOCX_MAX_CHARS_PER_CALL = 30000;

/** images=true 时单次最多带几张内嵌图（show_image 的画廊上限同款） */
export const DOCX_IMAGE_MAX_COUNT = 6;

/** 内嵌图长边上限（转录不存原图——show_image 的 SHOW_IMAGE_MAX_EDGE 同款纪律） */
export const DOCX_IMAGE_MAX_EDGE = 2000;

/** 单张内嵌图体积上限（SHOW_IMAGE_MAX_BYTES 同口径——超出多半是误嵌） */
const DOCX_IMAGE_MAX_BYTES = 30 * 1024 * 1024;

/** 头注大纲最多列几个 heading（read_pdf 图表索引 15 条同款护栏） */
export const DOCX_OUTLINE_MAX = 15;

// ─── HTML → markdown 薄转换 ────────────────────────────────────────────────
// mammoth 的输出是单行拼接的规整 HTML（它自己生成的，属性无裸 >），标签
// 子集小：h1-6/p/strong/em/s/sup/sub/br/a/img/table/tr/td/ul/ol/li（+
// 批注区的 dt/dd）。tokenizer 按标签切、递归下降组块；不认识的标签跳
// 标签保内容——新标签出现时输出退化为纯文本而不是崩。

/** 内联节点：文本或一个已定位的内嵌图占位（N = 全文档图序号） */
type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong" | "em" | "strike"; children: Inline[] }
  | { kind: "sup" | "sub"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] }
  | { kind: "break" }
  | { kind: "image"; n: number; alt: string };

/** 顶层块：分片轴的「块」。图片占位在段落的 inline 里，不单独占号 */
type Block =
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "para"; inline: Inline[] }
  | { kind: "list"; ordered: boolean; items: ListItem[] }
  | { kind: "table"; rows: Inline[][][] };

interface ListItem {
  inline: Inline[];
  children: { ordered: boolean; items: ListItem[] }[];
}

/** 解码 mammoth 会输出的实体（文本段必经；数字实体通用处理） */
function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&apos;": "'",
    "&nbsp;": " ",
  };
  return text.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/g, (whole, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity.startsWith("#x") || entity.startsWith("#X") ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return named[`&${entity};`] ?? whole;
  });
}

interface Token {
  text?: string;
  /** 开标签名（小写）；自闭合标签 close 同步为 true */
  tag?: string;
  close?: boolean;
  selfClosed?: boolean;
  attrs?: Record<string, string>;
}

/** 单行 HTML → token 流。标签属性只留 src/alt/href 三个（够用），其余丢弃 */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /<(\/?[a-zA-Z][a-zA-Z0-9]*)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    if (match[4] !== undefined) {
      const text = decodeEntities(match[4]);
      if (text !== "") tokens.push({ text });
      continue;
    }
    const raw = match[1]!.toLowerCase();
    const isClose = raw.startsWith("/");
    const tag = isClose ? raw.slice(1) : raw;
    const attrs: Record<string, string> = {};
    const attrPattern = /([\w:-]+)\s*=\s*"([^"]*)"/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrPattern.exec(match[2] ?? "")) !== null) {
      const key = attrMatch[1]!.toLowerCase();
      if (key === "src" || key === "alt" || key === "href") attrs[key] = attrMatch[2]!;
    }
    tokens.push({ tag, close: isClose, selfClosed: match[3] === "/", attrs });
  }
  return tokens;
}

/** token 流 → 顶层块列表。占位图编号来自 src 的 docximg:N（图片钩子编好的全文档序号） */
function parseBlocks(tokens: readonly Token[]): Block[] {
  let i = 0;

  function inline(stopAt: readonly string[]): Inline[] {
    const out: Inline[] = [];
    loop: for (; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.text !== undefined) {
        out.push({ kind: "text", text: t.text });
        continue;
      }
      const tag = t.tag!;
      if (t.close === true) {
        if (stopAt.includes(tag)) break loop;
        continue; // 非本层闭合标签：跳过（容错）
      }
      // 块级标签是行内内容的天花板——嵌套列表等结构交还外层的块解析。
      // p 不在名单：mammoth 只在 td/li 里放 p 壳（剥壳归内容），行内不撞裸 p
      if (tag === "ul" || tag === "ol" || tag === "table" || /^h[1-6]$/.test(tag)) break loop;
      switch (tag) {
        case "br":
          out.push({ kind: "break" });
          break;
        case "strong":
        case "b":
          i++; // 消费开标签再递归；配对闭合由递归层的 stopAt 吸收
          out.push({ kind: "strong", children: inline([...stopAt, "strong"]) });
          break;
        case "em":
        case "i":
          i++;
          out.push({ kind: "em", children: inline([...stopAt, "em"]) });
          break;
        case "s":
        case "del":
          i++;
          out.push({ kind: "strike", children: inline([...stopAt, "s"]) });
          break;
        case "sup":
          i++;
          out.push({ kind: "sup", children: inline([...stopAt, "sup"]) });
          break;
        case "sub":
          i++;
          out.push({ kind: "sub", children: inline([...stopAt, "sub"]) });
          break;
        case "a":
          i++;
          out.push({ kind: "link", href: t.attrs?.["href"] ?? "", children: inline([...stopAt, "a"]) });
          break;
        case "img": {
          const src = t.attrs?.["src"] ?? "";
          const hit = /^docximg:(\d+)$/.exec(src);
          if (hit !== null) {
            out.push({ kind: "image", n: Number(hit[1]), alt: t.attrs?.["alt"] ?? "" });
          } else {
            const alt = t.attrs?.["alt"] ?? "";
            if (alt !== "") out.push({ kind: "text", text: `[${alt}]` });
          }
          break;
        }
        default:
          break; // 不认识的开标签：不递归（配对闭合由 close 分支吸收），内容落在本层
      }
    }
    return out;
  }

  function listItem(): ListItem {
    const item: ListItem = { inline: [], children: [] };
    item.inline = inline(["li"]);
    for (; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.tag === "li" && t.close === true) {
        i++;
        break;
      }
      if ((t.tag === "ul" || t.tag === "ol") && t.close !== true) {
        item.children.push(listBlock());
        continue;
      }
      break;
    }
    return item;
  }

  function listBlock(): { ordered: boolean; items: ListItem[] } {
    const t = tokens[i]!;
    const ordered = t.tag === "ol";
    i++; // 开标签
    const items: ListItem[] = [];
    while (i < tokens.length) {
      const h = tokens[i]!;
      if (h.tag !== undefined && h.close === true && (h.tag === "ul" || h.tag === "ol")) {
        i++;
        break;
      }
      if (h.tag === "li" && h.close !== true) {
        i++;
        items.push(listItem());
        continue;
      }
      i++; // 容错推进
    }
    return { ordered, items };
  }

  function tableBlock(): Block {
    i++; // <table>
    const rows: Inline[][][] = [];
    while (i < tokens.length) {
      const t = tokens[i]!;
      if (t.tag === "table" && t.close === true) {
        i++;
        break;
      }
      if (t.tag === "tr" && t.close !== true) {
        i++;
        const cells: Inline[][] = [];
        while (i < tokens.length) {
          const c = tokens[i]!;
          if (c.tag === "tr" && c.close === true) {
            i++;
            break;
          }
          if ((c.tag === "td" || c.tag === "th") && c.close !== true) {
            i++;
            cells.push(inline(["td", "th", "tr"]));
            continue;
          }
          if (c.tag === "p" && c.close !== true) {
            i++; // td 里的 <p> 壳：剥掉，内容归格子（mammoth 表格格子的固定形态）
            continue;
          }
          i++;
        }
        rows.push(cells);
        continue;
      }
      i++;
    }
    return { kind: "table", rows };
  }

  const blocks: Block[] = [];
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.text !== undefined) {
      i++;
      continue; // 块级层面不该有裸文本（mammoth 输出的形态），跳过
    }
    if (t.close === true) {
      i++;
      continue;
    }
    switch (t.tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const level = Number(t.tag.slice(1));
        i++;
        blocks.push({ kind: "heading", level, inline: inline([`h${level}`]) });
        break;
      }
      case "p": {
        i++;
        blocks.push({ kind: "para", inline: inline(["p"]) });
        break;
      }
      case "ul":
      case "ol": {
        blocks.push({ kind: "list", ...listBlock() });
        break;
      }
      case "table":
        blocks.push(tableBlock());
        break;
      case "dt":
      case "dd": {
        // 批注区（mammoth 文末附的 comment 列表）：当普通段落收
        const tag = t.tag;
        i++;
        blocks.push({ kind: "para", inline: inline([tag]) });
        break;
      }
      default:
        i++; // 未知块级标签：跳标签保内容（内容会落到后续块的裸文本路径之外，可接受）
    }
  }
  return blocks;
}

/** 内联节点 → markdown 文本。sup/sub 无 markdown 等价物，平铺为普通文本 */
function inlineToMarkdown(nodes: readonly Inline[]): string {
  const parts: string[] = [];
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        parts.push(node.text);
        break;
      case "strong":
        parts.push(`**${inlineToMarkdown(node.children)}**`);
        break;
      case "em":
        parts.push(`*${inlineToMarkdown(node.children)}*`);
        break;
      case "strike":
        parts.push(`~~${inlineToMarkdown(node.children)}~~`);
        break;
      case "sup":
      case "sub":
        parts.push(inlineToMarkdown(node.children));
        break;
      case "link": {
        const text = inlineToMarkdown(node.children).trim();
        // 锚链（脚注/批注的内部跳转）没有外部信息量，只留文字；文末条目的
        // 回链固定是「↑」一个符号，纯噪音直接丢
        if (text === "" || (node.href.startsWith("#") && text === "↑")) break;
        parts.push(node.href.startsWith("#") || node.href === "" ? text : `[${text}](${node.href})`);
        break;
      }
      case "break":
        parts.push("\n");
        break;
      case "image":
        parts.push(`[image ${node.n}: ${node.alt}]`);
        break;
    }
  }
  return parts.join("");
}

function listItemsToMarkdown(items: readonly ListItem[], ordered: boolean, depth: number): string {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  items.forEach((item, index) => {
    const marker = ordered ? `${index + 1}. ` : "- ";
    const text = inlineToMarkdown(item.inline).trim();
    lines.push(`${indent}${marker}${text}`);
    for (const child of item.children) {
      lines.push(listItemsToMarkdown(child.items, child.ordered, depth + 1));
    }
  });
  return lines.join("\n");
}

/** 表格 → GFM。首行作表头（OOXML 表格里表头行无语义标记，这是最好的近似）；td 已剥 p 壳 */
function tableToMarkdown(rows: readonly Inline[][][]): string {
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const line = (cells: readonly (readonly Inline[])[]): string =>
    `| ${Array.from({ length: width }, (_, c) => inlineToMarkdown(cells[c] ?? []).replace(/\|/g, "\\|").trim()).join(" | ")} |`;
  const header = line(rows[0]!);
  const divider = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;
  const body = rows.slice(1).map(line);
  return [header, divider, ...body].join("\n");
}

/** 一个顶层块 → markdown 文本（分片与统计的最小单元） */
export function blockToMarkdown(block: Block): string {
  switch (block.kind) {
    case "heading":
      return `${"#".repeat(block.level)} ${inlineToMarkdown(block.inline).trim()}`;
    case "para":
      return inlineToMarkdown(block.inline).trim();
    case "list":
      return listItemsToMarkdown(block.items, block.ordered, 0);
    case "table":
      return tableToMarkdown(block.rows);
  }
}

/** mammoth 的 HTML → 顶层块列表 + 每块 markdown。空块（只剩回链箭头等）过滤 */
export function htmlToBlocks(html: string): Block[] {
  const blocks = parseBlocks(tokenize(html));
  return blocks.filter((block) => blockToMarkdown(block).trim() !== "");
}

// ─── 大纲与标题 ────────────────────────────────────────────────────────────

/** Sections 大纲：heading 文本 → 起始块号（1-indexed），截前 DOCX_OUTLINE_MAX 条 */
export function outlineOf(blocks: readonly Block[]): { text: string; block: number }[] {
  const out: { text: string; block: number }[] = [];
  for (let i = 0; i < blocks.length && out.length < DOCX_OUTLINE_MAX; i++) {
    const block = blocks[i]!;
    if (block.kind !== "heading") continue;
    out.push({ text: blockToMarkdown(block).replace(/^#+\s*/, ""), block: i + 1 });
  }
  return out;
}

/** 块里引用的内嵌图占位号（全文档序号，保序去重）——images=true 时按它取 buffer */
export function imageRefsOf(block: Block): number[] {
  const found: number[] = [];
  const walkInline = (nodes: readonly Inline[]): void => {
    for (const node of nodes) {
      if (node.kind === "image") {
        if (!found.includes(node.n)) found.push(node.n);
      } else if (node.kind === "strong" || node.kind === "em" || node.kind === "strike" || node.kind === "sup" || node.kind === "sub") {
        walkInline(node.children);
      } else if (node.kind === "link") {
        walkInline(node.children);
      }
    }
  };
  switch (block.kind) {
    case "heading":
    case "para":
      walkInline(block.inline);
      break;
    case "list":
      for (const item of block.items) {
        walkInline(item.inline);
        for (const child of item.children) {
          for (const sub of child.items) {
            walkInline(sub.inline);
          }
        }
      }
      break;
    case "table":
      for (const row of block.rows) for (const cell of row) walkInline(cell);
      break;
  }
  return found;
}

/** docProps/core.xml 的 dc:title（正则抽，core.xml 是几行固定小文件） */
async function coreTitle(buffer: Buffer): Promise<string> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const core = await zip.file("docProps/core.xml")?.async("string");
    const hit = core !== undefined ? /<dc:title>([^<]*)<\/dc:title>/.exec(core) : null;
    return hit?.[1]?.trim() ?? "";
  } catch {
    return ""; // 标题是锦上添花，core.xml 坏了不拦读取
  }
}

// ─── 工具 ──────────────────────────────────────────────────────────────────

export function createDocxTools(cwd: string): ToolDefinition[] {
  const readDocx: ToolDefinition = {
    name: "read_docx",
    label: "read_docx",
    description:
      "Read a Word document (.docx) as structured markdown: headings, paragraphs, lists, tables, links, " +
      "footnotes and comments (appended at the end). Word documents have no fixed pages, so content is " +
      "addressed by block numbers — the header carries a section outline with the starting block number of " +
      "each heading; jump with offset. Embedded images appear as [image N: alt] placeholders by default; " +
      "pass images=true to receive the images of the current block range as actual image blocks (at most 6, " +
      "vision models only). Use this instead of read for any .docx file — read cannot show its content.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the .docx file (relative to the workspace or absolute)",
        },
        offset: {
          type: "number",
          description: "Block number to start from (1-indexed; the outline in the header gives each section's starting block). Default 1.",
        },
        limit: {
          type: "number",
          description: "Number of blocks to read. Default: as many as fit the character budget (about 30000 chars).",
        },
        images: {
          type: "boolean",
          description:
            "Receive the embedded images of the current block range as image blocks (at most 6 per call, " +
            "vision models only). Default false — text placeholders [image N: alt] mark where images sit.",
        },
      },
      required: ["path"],
    } as never,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const args = (params ?? {}) as Record<string, unknown>;
      const pathRaw = typeof args["path"] === "string" ? args["path"].trim() : "";
      if (pathRaw === "") throw new Error('read_docx requires a "path" pointing at a Word (.docx) file');
      const absolute = isAbsolute(pathRaw) ? pathRaw : join(cwd, pathRaw);

      const buffer = await readFile(absolute);
      // 魔数定身份。OLE2 头（D0 CF 11 E0）按扩展名细分：Word 加密保存的 .docx
      // 整包变 OLE2 容器，与 .doc 老格式同魔数——扩展名是仅剩的区分线索
      if (buffer.subarray(0, 4).toString("latin1") === "\xd0\xcf\x11\xe0") {
        if (extname(absolute).toLowerCase() === ".doc") {
          throw new Error(`Legacy .doc is not supported: ${pathRaw}. Save it as .docx first.`);
        }
        throw new Error(
          `This looks like a password-protected Word document (encrypted .docx): ${pathRaw}. ` +
            "Remove the password and save again.",
        );
      }
      if (buffer.subarray(0, 2).toString("latin1") !== "PK") {
        throw new Error(`Not a Word document: ${pathRaw}. Use the read tool for text files and images.`);
      }

      // 图片钩子：只收 buffer，HTML 里放 docximg:N 占位——mammoth 默认把图转
      // base64 塞 src，30k 字符封顶会被一张图撑爆。alt 不从钩子拿：mammoth
      // 把它放进输出 <img alt>（.d.ts 的 Image 上未声明，运行时属性不依赖）
      const collected: { n: number; buffer: Buffer; contentType: string }[] = [];
      const styleMap = ["comment-reference => sup"]; // 批注锚点出 [Z1] 上标，文末自动附批注内容
      const converted = await mammoth
        .convertToHtml(
          { buffer },
          {
            styleMap,
            convertImage: mammoth.images.imgElement(async (image) => {
              collected.push({
                n: collected.length + 1,
                buffer: Buffer.from(await image.readAsArrayBuffer()),
                contentType: image.contentType,
              });
              return { src: `docximg:${collected.length}` };
            }),
          },
        )
        .catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to parse Word document (${pathRaw}): ${reason}`);
        });

      const blocks = htmlToBlocks(converted.value);
      const markdowns = blocks.map(blockToMarkdown);
      const totalChars = markdowns.reduce((sum, text) => sum + text.length, 0);

      // 空文档：如实返回空体（docx 没有 pdf 扫描件那种「唯一可看的东西在别处」的场景）
      const title = (await coreTitle(buffer)) || outlineOf(blocks)[0]?.text || basename(pathRaw);
      if (blocks.length === 0) {
        return {
          content: [{ type: "text", text: `[Word document: ${title}. The document has no readable content.]` }],
          details: {},
        };
      }

      const requested =
        typeof args["offset"] === "number" && Number.isFinite(args["offset"]) ? Math.floor(args["offset"]) : 1;
      const first = Math.max(1, requested);
      if (first > blocks.length) {
        throw new Error(`offset ${requested} is beyond the last block (${blocks.length} blocks total)`);
      }
      const limitRaw =
        typeof args["limit"] === "number" && Number.isFinite(args["limit"]) ? Math.floor(args["limit"]) : blocks.length;
      const limit = Math.max(1, limitRaw);

      // 从 first 起收块，直到 limit 或字符封顶——截在块边界，续读提示给下一块号
      const parts: string[] = [];
      let used = 0;
      let last = first - 1;
      for (let i = first - 1; i < blocks.length && i - first + 1 < limit; i++) {
        const text = markdowns[i]!;
        if (used + text.length > DOCX_MAX_CHARS_PER_CALL && parts.length > 0) break;
        parts.push(text);
        used += text.length;
        last = i + 1;
      }
      const continueHint = last < blocks.length ? ` Use offset=${last + 1} to continue.` : "";

      // 内嵌图提取（images=true）：范围里的占位号 → buffer → 魔数复核 → 转录缩放。
      // content 的 image 块只给视觉模型（read_pdf 同款）；非视觉降级为 note
      const wantsImages = args["images"] === true;
      const canSeeImages = ctx?.model?.input.includes("image") ?? false;
      const images: { type: "image"; data: string; mimeType: string }[] = [];
      let imageNotes: string[] = [];
      if (wantsImages && canSeeImages) {
        const inRange: number[] = [];
        for (let i = first - 1; i < last; i++) {
          for (const n of imageRefsOf(blocks[i]!)) {
            if (!inRange.includes(n)) inRange.push(n);
          }
        }
        if (inRange.length > DOCX_IMAGE_MAX_COUNT) {
          imageNotes.push(
            `showing the first ${DOCX_IMAGE_MAX_COUNT} of ${inRange.length} images in this range — narrow offset/limit to see the rest`,
          );
        }
        for (const n of inRange.slice(0, DOCX_IMAGE_MAX_COUNT)) {
          const found = collected.find((entry) => entry.n === n);
          if (found === undefined) continue;
          if (found.buffer.length > DOCX_IMAGE_MAX_BYTES) {
            imageNotes.push(`image ${n} skipped: larger than 30MB`);
            continue;
          }
          // 魔数复核（Content_Types 的声明会说谎）；bmp/tiff/emf 等内联不了，跳过并点名
          const mimeType = imageMimeOf(found.buffer.subarray(0, 12));
          if (mimeType === null) {
            imageNotes.push(`image ${n} skipped: not an inlinable format (png/jpg/gif/webp)`);
            continue;
          }
          const shrunk = await shrinkIfNeeded(found.buffer, mimeType, DOCX_IMAGE_MAX_EDGE);
          images.push({ type: "image", data: shrunk.data, mimeType: shrunk.mimeType });
        }
      }
      const imageLine =
        imageNotes.length > 0 ? ` Note: ${imageNotes.join("; ")}.` : "";
      const nonVisionLine =
        wantsImages && !canSeeImages
          ? `\n[Current model does not support images. The images will be omitted from this request.]`
          : "";

      const outline = outlineOf(blocks);
      const outlineLine =
        outline.length > 0 ? ` Sections: ${outline.map((s) => `${s.text} (block ${s.block})`).join("; ")}.` : "";

      const header =
        `[Word document: ${title}. ${blocks.length} blocks, ${totalChars} chars. Showing blocks ${first}-${last}` +
        ` of ${blocks.length}.${outlineLine}${imageLine}${continueHint}]${nonVisionLine}`;

      return {
        content: [
          { type: "text", text: parts.length > 0 ? `${header}\n\n${parts.join("\n\n")}` : header },
          ...images,
        ],
        details: {},
      };
    },
  };
  return [readDocx];
}
