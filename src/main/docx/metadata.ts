/**
 * docx 的**作者身份**：应用保存出去的文档，作者是用户本人，不是一个生成工具。
 *
 * 为什么必须在主进程写盘前改：renderer 侧负责序列化的是 `@stll/folio`，它的
 * `docProps/core.xml` 在文档没带作者时写死 `Stella`，`docProps/app.xml` 写死
 * `<Application>stella</Application>`。于是「在应用里改了一个字」就等于把上游工具名
 * 刻进了用户的论文元数据——作者栏、文档属性面板、Word 的修订记录里都看得见。
 * 这一层只做三件事，都在**字节层面**完成（见 `zip.ts`，没碰过的条目一个字节都不动）：
 *
 * 1. `core.xml`：`dc:creator` / `cp:lastModifiedBy` / `dcterms:created` / `dcterms:modified`；
 * 2. `app.xml`、`custom.xml`：写工具名的字段（`Application` / `Company` / 自定义属性……）；
 * 3. `comments.xml`、`people.xml`、`document.xml` 等：修订与批注的 `w:author`。
 *
 * **不覆盖已有作者**：原文档的 `creator` 是别人（导师、合作者、模板作者）时保持原值——
 * 只在原名缺席、是生成工具的名字、或本次才建的文件上写用户。`lastModifiedBy` 则按
 * Word 的语义在每次保存时更新为用户。
 */
import { userInfo } from "node:os";
import { readZipEntryText, rewriteZipEntries } from "./zip.ts";

/**
 * 生成工具留下的名字。命中就不算「用户本人的作者」——`stella` / `folio` 是本仓用的
 * 引擎，其余是 issue #275 点名的与常见的 office 生成器。
 */
const TOOL_MARKERS = [
  "pandoc",
  "python-docx",
  "python",
  "orbita",
  "codex",
  "claude",
  "stella",
  "folio",
  "mammoth",
  "libreoffice",
  "openoffice",
  "aspose",
  "docx4j",
  "unoconv",
];

const CORE_PART = "docProps/core.xml";
const APP_PART = "docProps/app.xml";
const CUSTOM_PART = "docProps/custom.xml";

/** 修订（`w:ins` / `w:del` / `w:moveFrom`…）与批注落作者名的部件 */
const AUTHOR_PARTS = [
  "word/comments.xml",
  "word/people.xml",
  "word/document.xml",
  "word/footnotes.xml",
  "word/endnotes.xml",
];

/** app.xml 里可能是对方工具名的字段（其余字段是字数页数一类，不碰） */
const APP_TOOL_FIELDS = ["Application", "AppVersion", "Company", "Manager", "Template", "HyperlinkBase"];

/**
 * 系统用户名。设置里目前没有「Office 用户名」这一项（不在这一个 PR 里加设置界面），
 * 所以回退到系统账户名；Windows 上 `userInfo().username` 就是 `USERNAME`。
 * 取不到返回空串，调用方据此放弃写作者名（宁可留空，也不编一个名字）。
 */
export function systemUserName(): string {
  try {
    const name = userInfo().username.trim();
    if (name !== "") return name;
  } catch {
    // 少见的容器环境里 userInfo 会抛；退回环境变量
  }
  return (process.env["USERNAME"] ?? process.env["USER"] ?? "").trim();
}

export interface DocxAuthorStampOptions {
  /** 写进文档的用户名；空串表示取不到，作者字段保持原样 */
  name: string;
  /** 保存时刻（ms），默认现在 */
  now?: number;
  /** 磁盘上的上一版字节：新包丢了原作者时从这里继承 */
  previous?: Uint8Array | null;
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** 只解命名实体与数字实体；作者名 / 属性值里不会有别的 */
function decodeXmlText(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** 空值也算「不是用户写的」：Word 新建但没填作者时 creator 是空元素 */
function isToolName(value: string): boolean {
  const normalized = decodeXmlText(value).trim().toLowerCase();
  if (normalized === "") return true;
  return TOOL_MARKERS.some((marker) => normalized.includes(marker));
}

/** 元素的内部文本（不含标签）；元素不存在或自闭合返回 null */
function elementBody(xml: string, localName: string): string | null {
  const pattern = new RegExp(`<((?:[\\w.-]+:)?)${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</\\1${localName}>`);
  const match = pattern.exec(xml);
  return match === null ? null : (match[2] ?? "");
}

/**
 * 把元素内容替换成**已经是 XML 的** rawInner；元素不存在时返回 null（由调用方决定补不补）。
 * 自闭合形式 `<dc:creator/>` 也要认：Word 与引擎都会这么写空的作者元素。
 */
function replaceElementBody(xml: string, localName: string, rawInner: string): string | null {
  const paired = new RegExp(`<((?:[\\w.-]+:)?)${localName}(?:\\s[^>]*)?>[\\s\\S]*?</\\1${localName}>`);
  const pairedMatch = paired.exec(xml);
  if (pairedMatch !== null) {
    const whole = pairedMatch[0];
    return xml.replace(whole, `${whole.slice(0, whole.indexOf(">") + 1)}${rawInner}</${pairedMatch[1]}${localName}>`);
  }
  const empty = new RegExp(`<((?:[\\w.-]+:)?)${localName}((?:\\s[^>]*)?)\\s*/>`);
  const emptyMatch = empty.exec(xml);
  if (emptyMatch === null) return null;
  return xml.replace(
    emptyMatch[0],
    `<${emptyMatch[1]}${localName}${emptyMatch[2] ?? ""}>${rawInner}</${emptyMatch[1]}${localName}>`,
  );
}

function namespacePrefix(xml: string, uriFragment: string): string | null {
  const declaration = /xmlns:([\w.-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(xml)) !== null) {
    if ((match[2] ?? "").includes(uriFragment)) return match[1] ?? null;
  }
  return null;
}

function w3cDate(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 首字母：中文取首字，拉丁名取前两个词的首字母（Word 的修订标记里显示这个） */
function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return "";
  const words = trimmed.split(/\s+/);
  if (words.length > 1 && words.every((word) => /^[\x20-\x7e]+$/.test(word))) {
    return words
      .slice(0, 2)
      .map((word) => word.charAt(0).toUpperCase())
      .join("");
  }
  return trimmed.slice(0, 1);
}

/** 原作者：先看这次要写出去的包，再看磁盘上的上一版（renderer 丢了元数据时靠它兜底） */
function pickCreator(incoming: string | null, previous: string | null, name: string): string | null {
  if (incoming !== null && !isToolName(incoming)) return decodeXmlText(incoming).trim();
  if (previous !== null && !isToolName(previous)) return previous.trim();
  return name === "" ? null : name;
}

function insertBeforeCoreClose(xml: string, fragment: string): string {
  return xml.replace(/(<\/(?:[\w.-]+:)?coreProperties\s*>)/, `${fragment}$1`);
}

function stampCore(xml: string, name: string, now: number, previousCreator: string | null): string | null {
  if (!/<\/(?:[\w.-]+:)?coreProperties\s*>/.test(xml)) return null;

  const creator = pickCreator(elementBody(xml, "creator"), previousCreator, name);
  const originalCreated = (elementBody(xml, "created") ?? "").trim();
  const originalModified = (elementBody(xml, "modified") ?? "").trim();
  let out = xml;

  if (creator !== null) {
    const written = replaceElementBody(out, "creator", escapeXmlText(creator));
    if (written !== null) out = written;
    else {
      const dc = namespacePrefix(out, "/dc/elements/1.1/");
      if (dc !== null) out = insertBeforeCoreClose(out, `<${dc}:creator>${escapeXmlText(creator)}</${dc}:creator>`);
    }
  }

  if (name !== "") {
    const written = replaceElementBody(out, "lastModifiedBy", escapeXmlText(name));
    if (written !== null) out = written;
    else {
      const cp = namespacePrefix(out, "metadata/core-properties");
      if (cp !== null) {
        out = insertBeforeCoreClose(out, `<${cp}:lastModifiedBy>${escapeXmlText(name)}</${cp}:lastModifiedBy>`);
      }
    }
  }

  // created 只在缺席时补：原文档的创建时间是事实，改它等于篡改
  if (originalCreated === "") {
    const value = originalModified === "" ? w3cDate(now) : originalModified;
    const written = replaceElementBody(out, "created", value);
    if (written !== null) out = written;
    else {
      const dcterms = namespacePrefix(out, "/dcterms/");
      if (dcterms !== null) out = insertBeforeCoreClose(out, dctermsElement(dcterms, "created", value));
    }
  }

  const modifiedWritten = replaceElementBody(out, "modified", w3cDate(now));
  if (modifiedWritten !== null) out = modifiedWritten;
  else {
    const dcterms = namespacePrefix(out, "/dcterms/");
    if (dcterms !== null) out = insertBeforeCoreClose(out, dctermsElement(dcterms, "modified", w3cDate(now)));
  }

  return out;
}

function dctermsElement(prefix: string, localName: string, value: string): string {
  return `<${prefix}:${localName} xsi:type="${prefix}:W3CDTF">${value}</${prefix}:${localName}>`;
}

/** app.xml：把写着工具名的字段整块删掉，其余字段（字数、页数、模板）原样保留 */
function scrubApp(xml: string): string | null {
  let out = xml;
  for (const field of APP_TOOL_FIELDS) {
    const paired = new RegExp(`<((?:[\\w.-]+:)?)${field}(?:\\s[^>]*)?>([\\s\\S]*?)</\\1${field}>`, "g");
    out = out.replace(paired, (whole, _prefix: string, body: string) => (isToolName(body) ? "" : whole));
    // 空的字段（`<Application/>`）没有任何信息，一并去掉
    const empty = new RegExp(`<((?:[\\w.-]+:)?)${field}(?:\\s[^>]*)?\\s*/>`, "g");
    out = out.replace(empty, "");
  }
  return out === xml ? null : out;
}

/** custom.xml：任何一条「名字或值写着工具名」的自定义属性整条删掉 */
function scrubCustom(xml: string): string | null {
  const paired = /<((?:[\w.-]+:)?)property(\s[^>]*)?>([\s\S]*?)<\/\1property>/g;
  const out = xml.replace(paired, (whole, _prefix: string, attrs: string | undefined, body: string) => {
    const name = /name\s*=\s*"([^"]*)"/.exec(attrs ?? "")?.[1] ?? "";
    return isToolName(name) || isToolName(body) ? "" : whole;
  });
  return out === xml ? null : out;
}

/**
 * 修订与批注的作者：只动**工具名 / 空值**，别人写的批注保持署名——那是别人说过话的
 * 记录，不是这一刀要抹掉的东西。同一标签里的 `w:initials` 跟着换。
 */
function stampRevisionAuthors(xml: string, name: string, initials: string): string | null {
  if (name === "") return null;
  const tag = /<[A-Za-z_][^>]*>/g;
  let changed = false;
  const out = xml.replace(tag, (whole: string) => {
    const author = /\s((?:[\w.-]+:)?)author\s*=\s*("([^"]*)"|'([^']*)')/.exec(whole);
    if (author === null) return whole;
    const value = author[3] ?? author[4] ?? "";
    if (!isToolName(value)) return whole;
    const prefix = author[1] ?? "";
    changed = true;
    const reattributed = whole.replace(author[0], ` ${prefix}author="${escapeXmlAttribute(name)}"`);
    if (initials === "") return reattributed;
    const initialsPattern = new RegExp(`(\\s(?:[\\w.-]+:)?initials\\s*=\\s*)("(?:[^"]*)"|'(?:[^']*)')`);
    return reattributed.replace(initialsPattern, `$1"${escapeXmlAttribute(initials)}"`);
  });
  return changed ? out : null;
}

function previousCreatorOf(previous: Uint8Array | null | undefined): string | null {
  if (previous === null || previous === undefined) return null;
  const xml = readZipEntryText(previous, CORE_PART);
  if (xml === null) return null;
  const body = elementBody(xml, "creator");
  return body === null ? null : decodeXmlText(body);
}

/**
 * 写盘前套用一次。返回**新字节**（调用方写它、算它的 hash）。
 * 不是 zip（测试里的假数据、别的调用方传来的非 docx 字节）原样放回：元数据是锦上添花，
 * 不能因为改不动它就拦住用户的保存。
 */
export function stampDocxAuthor(bytes: Uint8Array, options: DocxAuthorStampOptions): Uint8Array {
  const now = options.now ?? Date.now();
  const name = options.name.trim();
  const initials = initialsOf(name);
  const previousCreator = previousCreatorOf(options.previous);
  try {
    return rewriteZipEntries(bytes, [CORE_PART, APP_PART, CUSTOM_PART, ...AUTHOR_PARTS], (part, text) => {
      if (part === CORE_PART) return stampCore(text, name, now, previousCreator);
      if (part === APP_PART) return scrubApp(text);
      if (part === CUSTOM_PART) return scrubCustom(text);
      return stampRevisionAuthors(text, name, initials);
    });
  } catch {
    return bytes;
  }
}
