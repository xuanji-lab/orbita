/**
 * Zotero 只读底座的契约 —— agent 的三个工具（zotero_search / zotero_item / zotero_fulltext）
 * 经 agent-ipc 的 zoteroRequest / zoteroResult 问答通道找主进程（src/main/zotero/）。
 *
 * **数据来源是 Zotero 的数据目录，不是 Zotero 进程**（2026-11-14 用户：Zotero 常驻内存约 4 GB，
 * 「这些都要 Zotero 开着才能用」不能接受）：条目、作者、分类、附件、批注从 `zotero.sqlite` 只读读
 * （Zotero 开着时数据库被它占着，读的是克隆出来的临时副本），全文读每个附件目录里的 `.zotero-ft-cache`，
 * PDF 就是 `storage/<附件 key>/` 里的原文件。对数据目录零写入。
 *
 * **数据形状是我们自己的窄类型**：标题、作者摘要、年份、条目类型、key、有无 PDF、摘要、分类、附件、批注、
 * 全文片段。Zotero 的表结构只在主进程里被读，不透传到 agent / renderer。
 *
 * PDF 一律给 **Zotero 存储里的原路径**（不拷贝）；模型把它交给 read_pdf / cite_pdf，
 * cite_pdf 核验过的路径走「被引用的 PDF 原地授权」（shared/files.ts 的 `cited` 根）在文件面板里打开。
 */

/** 查文献默认 / 最多返回几条 */
export const ZOTERO_SEARCH_DEFAULT_LIMIT = 20;
export const ZOTERO_SEARCH_MAX_LIMIT = 50;

/** 读条目时批注一页几条 / 最多几条 */
export const ZOTERO_ANNOTATION_DEFAULT_LIMIT = 30;
export const ZOTERO_ANNOTATION_MAX_LIMIT = 100;

/** 读全文一段默认 / 最多多少字符 */
export const ZOTERO_FULLTEXT_DEFAULT_CHARS = 20_000;
export const ZOTERO_FULLTEXT_MAX_CHARS = 40_000;

/**
 * 读不了时是哪一种：
 * - `no-data-dir`：没找到 Zotero 的数据目录（没装 Zotero，或数据目录里没有 zotero.sqlite）；
 * - `schema-too-new`：数据库版本比我们核对过表结构的范围新（Zotero 升级了）——不乱读；
 * - `schema-too-old`：比范围旧（Zotero 6 以前）。
 */
export type ZoteroUnavailable = "no-data-dir" | "schema-too-new" | "schema-too-old";

/** 一条文献的摘要行（查文献的结果、读条目的头部） */
export interface ZoteroItemSummary {
  key: string;
  title: string;
  /** 作者摘要：Zotero 自己算的 creatorSummary（「Vaswani et al.」「张三和李四」） */
  creators: string;
  /** 年份（四位）；没有日期 = null */
  year: string | null;
  /** Zotero 的条目类型 id（journalArticle / book / thesis …） */
  itemType: string;
  /** 最佳附件是 PDF */
  hasPdf: boolean;
}

export interface ZoteroCollectionRef {
  key: string;
  /** 从顶层到它的路径：「博士论文 / 第二章」 */
  path: string;
}

export interface ZoteroAttachment {
  key: string;
  title: string;
  /** 文件名；链接网址没有 */
  filename: string | null;
  contentType: string | null;
  /** Zotero 的 linkMode：imported_file / imported_url / linked_file / linked_url / embedded_image */
  linkMode: string;
  /** 本机绝对路径（Zotero storage 里的原文件，或链接文件的位置）；链接网址 = null */
  path: string | null;
  /** 文件此刻在不在本机（主进程 stat 过） */
  onDisk: boolean;
}

export interface ZoteroAnnotation {
  key: string;
  /** highlight / underline / note / image / ink / text */
  type: string;
  /** 原文摘录（只有 highlight / underline 有） */
  text: string;
  /** 批注文字 */
  comment: string;
  /** 颜色，如 #ffd400 */
  color: string;
  /** 页码标签（PDF 里印的页码，不一定等于物理页号） */
  pageLabel: string;
  /** 挂在哪个附件上 */
  attachmentKey: string;
}

export interface ZoteroItemDetail extends ZoteroItemSummary {
  /**
   * 条目的规范地址（以后导出 Word 域、写 citationItems[].uris 用）：同步过的个人库
   * `http://zotero.org/users/<userID>/items/<KEY>`，没登录过同步的 `http://zotero.org/users/local/<localUserKey>/items/<KEY>`，
   * 群组库 `http://zotero.org/groups/<groupID>/items/<KEY>`（Zotero 源码 uri.js getLibraryPath）
   */
  uri: string;
  /** 其余有值的元数据字段（日期、期刊、DOI、URL …），按 Zotero 的字段名 */
  fields: { name: string; value: string }[];
  /** 全部作者（「姓, 名」或机构名），带角色 */
  creatorList: { name: string; role: string }[];
  abstract: string;
  tags: string[];
  collections: ZoteroCollectionRef[];
  attachments: ZoteroAttachment[];
  /** 子笔记条数（内容不在这里读） */
  noteCount: number;
  /** 本页批注 */
  annotations: ZoteroAnnotation[];
  annotationTotal: number;
  annotationOffset: number;
}

export interface ZoteroFulltext {
  /** 请求的条目 key（父条目或附件） */
  key: string;
  /** 真正读的那个附件 */
  attachmentKey: string;
  /** 附件的本机路径（给模型改用 read_pdf / cite_pdf） */
  path: string | null;
  /** 本段文字 */
  text: string;
  start: number;
  end: number;
  /** 全文总字符数 */
  total: number;
  indexedPages: number | null;
  totalPages: number | null;
}

/** 查文献 */
export interface ZoteroSearchRequest {
  op: "search";
  /** 标题词 / 作者 / 年份 / 出版物，空格分开的每个词都要命中（Zotero 快速搜索的「标题、作者、年份」档） */
  query?: string;
  /** 分类：key 或名字（名字不区分大小写，可以是路径的最后一段） */
  collection?: string;
  /** 条目类型（journalArticle / book …） */
  itemType?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}

export interface ZoteroItemRequest {
  op: "item";
  key: string;
  annotationOffset?: number;
  annotationLimit?: number;
}

export interface ZoteroFulltextRequest {
  op: "fulltext";
  key: string;
  start?: number;
  length?: number;
}

export type ZoteroAgentRequest = ZoteroSearchRequest | ZoteroItemRequest | ZoteroFulltextRequest;

export interface ZoteroSearchResult {
  op: "search";
  items: ZoteroItemSummary[];
  /** 符合条件的总条数（Zotero 的 Total-Results） */
  total: number;
  offset: number;
  /** 按名字解析到的分类（给模型与展开体看实际查的是哪个） */
  collection: ZoteroCollectionRef | null;
}

export interface ZoteroItemResult {
  op: "item";
  item: ZoteroItemDetail;
}

/**
 * 读全文：`fulltext` 为 null = 这条没有全文索引（没附件、附件不是 PDF、Zotero 还没建索引），
 * `pdfPath` 给出可改用 read_pdf 的本机 PDF（没有就 null）。
 */
export interface ZoteroFulltextResult {
  op: "fulltext";
  fulltext: ZoteroFulltext | null;
  title: string;
  pdfPath: string | null;
}

export type ZoteroResult = ZoteroSearchResult | ZoteroItemResult | ZoteroFulltextResult;

export type ZoteroOutcome =
  | { ok: true; result: ZoteroResult }
  | { ok: false; error: string; unavailable?: ZoteroUnavailable };

/** 读不了时给模型的一句话（模型转述给用户）：是哪种情况、Orbita 是从哪里找的 */
export function zoteroUnavailableMessage(kind: ZoteroUnavailable, detail = ""): string {
  switch (kind) {
    case "no-data-dir":
      return (
        "Zotero was not found on this computer: no Zotero data directory with zotero.sqlite. " +
        "Orbita looks where Zotero itself keeps it — the data directory set in Zotero › Settings › Advanced › Files and Folders " +
        "(设置 › 高级 › 文件和文件夹 › 数据目录位置), or the default ~/Zotero when none is set. " +
        "Zotero does not need to be running. If the user uses Zotero, ask where their data directory is." +
        (detail === "" ? "" : ` (${detail})`)
      );
    case "schema-too-new":
      return `This Zotero database is newer than Orbita knows (${detail}); Orbita does not read databases it has not checked, so the library cannot be read until Orbita is updated.`;
    case "schema-too-old":
      return `This Zotero database is too old for Orbita (${detail}); updating Zotero (7 or later) and opening it once upgrades the database.`;
  }
}

/**
 * 工具结果的 `details.zotero`（只给界面，模型看不见）：过程行的展开体读它列出「返回了哪些条目 / 读了哪一段」。
 * 渲染层经 `readZoteroDetails` 逐字段校验后才用（同 builtin-command.ts 的 readCommandCard：坏值判 null，不编）。
 */
export type ZoteroToolDetails =
  | {
      op: "search";
      total: number;
      offset: number;
      collection: string | null;
      items: { key: string; title: string; creators: string; year: string | null }[];
    }
  | {
      op: "item";
      key: string;
      title: string;
      attachments: { name: string; path: string | null; onDisk: boolean }[];
      annotationTotal: number;
      annotationOffset: number;
      annotationShown: number;
    }
  | {
      op: "fulltext";
      title: string;
      /** 没有全文索引 = null */
      range: { start: number; end: number; total: number } | null;
      path: string | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isStr = (value: unknown): value is string => typeof value === "string";
const strOrNull = (value: unknown): string | null => (isStr(value) ? value : null);

export function readZoteroDetails(details: unknown): ZoteroToolDetails | null {
  if (!isRecord(details) || !isRecord(details["zotero"])) return null;
  const raw = details["zotero"];
  if (raw["op"] === "search") {
    if (!isNum(raw["total"]) || !isNum(raw["offset"]) || !Array.isArray(raw["items"])) return null;
    const items = raw["items"].filter(isRecord).flatMap((item) =>
      isStr(item["key"]) && isStr(item["title"])
        ? [{ key: item["key"], title: item["title"], creators: isStr(item["creators"]) ? item["creators"] : "", year: strOrNull(item["year"]) }]
        : [],
    );
    return { op: "search", total: raw["total"], offset: raw["offset"], collection: strOrNull(raw["collection"]), items };
  }
  if (raw["op"] === "item") {
    if (!isStr(raw["key"]) || !isStr(raw["title"]) || !Array.isArray(raw["attachments"])) return null;
    if (!isNum(raw["annotationTotal"]) || !isNum(raw["annotationOffset"]) || !isNum(raw["annotationShown"])) return null;
    const attachments = raw["attachments"].filter(isRecord).flatMap((a) =>
      isStr(a["name"]) ? [{ name: a["name"], path: strOrNull(a["path"]), onDisk: a["onDisk"] === true }] : [],
    );
    return {
      op: "item",
      key: raw["key"],
      title: raw["title"],
      attachments,
      annotationTotal: raw["annotationTotal"],
      annotationOffset: raw["annotationOffset"],
      annotationShown: raw["annotationShown"],
    };
  }
  if (raw["op"] === "fulltext") {
    if (!isStr(raw["title"])) return null;
    const range = raw["range"];
    const parsed =
      isRecord(range) && isNum(range["start"]) && isNum(range["end"]) && isNum(range["total"])
        ? { start: range["start"], end: range["end"], total: range["total"] }
        : null;
    return { op: "fulltext", title: raw["title"], range: parsed, path: strOrNull(raw["path"]) };
  }
  return null;
}
