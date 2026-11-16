/**
 * 从 Zotero 的 `zotero.sqlite` 读条目——一组同步的纯查询函数，参数是已经只读打开的库
 * （打开方式见 ../session/sqlite-readonly.ts：immutable 直读或读克隆副本）。只有 SELECT。
 *
 * 表结构的真源是本机 Zotero 10.0.9 的 `resource/schema/userdata.sql`（userdata 版本 131）；
 * 版本范围见 checkSchema。用到的表：items / itemTypesCombined / fieldsCombined / baseFieldMappingsCombined /
 * itemData / itemDataValues / creators / itemCreators / creatorTypes / itemAttachments / itemNotes /
 * itemAnnotations / tags / itemTags / collections / collectionItems / deletedItems / deletedCollections /
 * libraries / groups / settings / fulltextItems / version。
 *
 * 取值规则（出处都是 Zotero 源码）：
 * - linkMode：0 存储文件、1 存储网页快照、2 链接文件、3 链接网址、4 嵌入图片（xpcom/attachments.js）；
 * - 附件路径：存储附件 `storage:文件名` → `<数据目录>/storage/<附件 key>/文件名`；链接文件是绝对路径，
 *   或 `attachments:相对路径`（相对 baseAttachmentPath，斜杠统一为 /；attachments.js getBaseDirectoryRelativePath）；
 * - 批注类型：1 highlight、2 note、3 image、4 ink、5 underline、6 text（xpcom/annotations.js）；
 * - 日期字段存成「YYYY-MM-DD 原文」两段（multipart），年份取前四位、显示取原文；
 * - 全文缓存：`storage/<附件 key>/.zotero-ft-cache`（fulltext.js getItemCacheFile，与附件 linkMode 无关）。
 *
 * 查文献的匹配规则照 Zotero 快速搜索的「标题、作者、年份」档（search.js 的 quicksearch-titleCreatorYear）：
 * 按空白切词（双引号括起的算一个词），**每个词都要**在 标题 / 出版物 / 短标题 / 法院 / 引用键（各连同映射到它的
 * 类型字段，如 caseName → title、bookTitle → publicationTitle）/ 年份 / 任一作者的姓或名 里出现（包含，不分大小写与变音符）。中文没有空格，一段中文就是一个词，照样按包含匹配。
 * 范围：个人库与群组库里**顶层**、没进回收站的条目，不含独立笔记与批注（附件、笔记、批注这些子条目不进结果；
 * 没有父条目的独立附件算顶层，Zotero 的列表里也显示它）。分类只看直接放在里面的条目（Zotero 的
 * 「显示子分类中的条目」默认关，本机 prefs 也没开）。排序：修改时间新的在前（本机 API / Web API 的默认排序）。
 */
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  ZoteroAnnotation,
  ZoteroAttachment,
  ZoteroCollectionRef,
  ZoteroItemDetail,
  ZoteroItemSummary,
  ZoteroSearchRequest,
  ZoteroUnavailable,
} from "../../shared/zotero.ts";

/**
 * 核对过表结构的 userdata 版本范围：131 是 Zotero 10.0.9 的建表脚本；schema.js 的升级步骤里，113 把 itemAnnotations
 * 重建成现在这些列，113–131 之间的步骤（114–121、131）没有删改上面这些表里我们读的列（119/120 只给 itemAnnotations
 * 加 authorName，124 / 125 / 126 加的是我们不读的列）。所以 113–131 都按同一套查询读。
 */
export const ZOTERO_SCHEMA_MIN = 113;
export const ZOTERO_SCHEMA_MAX = 131;

const LINK_MODES = ["imported_file", "imported_url", "linked_file", "linked_url", "embedded_image"] as const;
const ANNOTATION_TYPES: Readonly<Record<number, string>> = { 1: "highlight", 2: "note", 3: "image", 4: "ink", 5: "underline", 6: "text" };

/** 库所在的位置：解析附件路径要用 */
export interface LibraryLocation {
  dataDir: string;
  baseAttachmentPath: string | null;
}

type Row = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const num = (value: unknown): number | null => (typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : null);

function all(db: DatabaseSync, sql: string, ...params: (string | number)[]): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

export function checkSchema(db: DatabaseSync): { ok: true; version: number } | { ok: false; kind: ZoteroUnavailable; detail: string } {
  let version: number | null = null;
  try {
    version = num(db.prepare("SELECT version FROM version WHERE schema='userdata'").get()?.["version"]);
  } catch {
    version = null;
  }
  if (version === null) return { ok: false, kind: "schema-too-old", detail: "no userdata version" };
  const range = `userdata schema ${version}; Orbita knows ${ZOTERO_SCHEMA_MIN}–${ZOTERO_SCHEMA_MAX}`;
  if (version > ZOTERO_SCHEMA_MAX) return { ok: false, kind: "schema-too-new", detail: range };
  if (version < ZOTERO_SCHEMA_MIN) return { ok: false, kind: "schema-too-old", detail: range };
  return { ok: true, version };
}

/** 去大小写与变音符（é → e）；中文原样 */
export function fold(text: string): string {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** 按空白切词，双引号括起的算一个词（Zotero parseSearchString 的主要行为） */
export function searchWords(query: string): string[] {
  const words: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(query)) !== null) {
    const word = (match[1] ?? match[2] ?? "").trim();
    if (word !== "") words.push(fold(word));
  }
  return words;
}

/** multipart 日期「2017-06-12 June 12, 2017」→ 年份 / 原文 */
function yearOf(value: string): string | null {
  const year = value.slice(0, 4);
  return /^\d{4}$/.test(year) && year !== "0000" ? year : null;
}

function displayDate(value: string): string {
  const match = /^\d{4}-\d{2}-\d{2} (.*)$/.exec(value);
  return match === null ? value : (match[1] as string);
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

interface CreatorRow {
  first: string;
  last: string;
  single: boolean;
  role: string;
}

function creatorName(c: CreatorRow): string {
  if (c.single || c.first === "") return c.last;
  if (c.last === "") return c.first;
  return CJK.test(c.last + c.first) ? `${c.last}${c.first}` : `${c.last}, ${c.first}`;
}

/** 作者摘要（照 Zotero firstCreator：先看作者，没有就编者，再没有就全部；1 人写姓、2 人「A and B」、更多「A et al.」） */
function creatorSummary(creators: readonly CreatorRow[]): string {
  const pick = creators.filter((c) => c.role === "author");
  const pool = pick.length > 0 ? pick : creators.filter((c) => c.role === "editor").length > 0 ? creators.filter((c) => c.role === "editor") : creators;
  const name = (c: CreatorRow): string => c.last || c.first;
  if (pool.length === 0) return "";
  if (pool.length === 1) return name(pool[0] as CreatorRow);
  if (pool.length === 2) return `${name(pool[0] as CreatorRow)} and ${name(pool[1] as CreatorRow)}`;
  return `${name(pool[0] as CreatorRow)} et al.`;
}

/** 映射到某个基础字段（title / date）的全部字段 id，含它自己 */
function fieldFamily(db: DatabaseSync, base: string): Set<number> {
  const ids = new Set<number>();
  for (const row of all(db, "SELECT fieldID FROM fieldsCombined WHERE fieldName=?", base)) ids.add(num(row["fieldID"]) ?? -1);
  for (const row of all(
    db,
    "SELECT fieldID FROM baseFieldMappingsCombined WHERE baseFieldID IN (SELECT fieldID FROM fieldsCombined WHERE fieldName=?)",
    base,
  )) {
    ids.add(num(row["fieldID"]) ?? -1);
  }
  return ids;
}

/** 回收站里的条目，以及父条目在回收站里的子条目 */
const NOT_DELETED = "itemID NOT IN (SELECT itemID FROM deletedItems)";

interface Candidate extends ZoteroItemSummary {
  itemID: number;
  libraryID: number;
  modified: string;
  haystack: string[];
  creatorHay: string;
}

/** 顶层条目的摘要行 + 搜索用的文字（个人库 + 群组库，不含订阅源） */
function candidates(db: DatabaseSync, itemIDs: readonly number[] | null): Candidate[] {
  const scope = itemIDs === null ? "" : `AND i.itemID IN (${itemIDs.map(() => "?").join(",") || "NULL"})`;
  const rows = all(
    db,
    `SELECT i.itemID, i.key, i.libraryID, i.dateModified, t.typeName
       FROM items i JOIN itemTypesCombined t ON t.itemTypeID = i.itemTypeID
       JOIN libraries l ON l.libraryID = i.libraryID
      WHERE l.type IN ('user', 'group')
        AND i.${NOT_DELETED}
        AND t.typeName NOT IN ('note', 'annotation')
        AND i.itemID NOT IN (SELECT itemID FROM itemAttachments WHERE parentItemID IS NOT NULL)
        ${scope}`,
    ...(itemIDs ?? []),
  );
  if (rows.length === 0) return [];
  const titleIds = fieldFamily(db, "title");
  const dateIds = fieldFamily(db, "date");
  // 基础字段连同映射到它的类型字段一起搜（search.js 对基础字段条件的处理）：publicationTitle 含
  // bookSection 的 bookTitle、conferencePaper 的 proceedingsTitle、webpage 的 websiteTitle 等
  const extraIds = new Set<number>();
  for (const base of ["publicationTitle", "shortTitle", "court", "citationKey"]) for (const id of fieldFamily(db, base)) extraIds.add(id);
  const fields = new Map<number, { titles: string[]; date: string; extra: string[] }>();
  for (const row of all(
    db,
    "SELECT d.itemID, d.fieldID, v.value FROM itemData d JOIN itemDataValues v ON v.valueID = d.valueID",
  )) {
    const id = num(row["itemID"]) ?? -1;
    const fieldID = num(row["fieldID"]) ?? -1;
    if (!titleIds.has(fieldID) && !dateIds.has(fieldID) && !extraIds.has(fieldID)) continue;
    const entry = fields.get(id) ?? { titles: [], date: "", extra: [] };
    const value = str(row["value"]);
    if (titleIds.has(fieldID)) entry.titles.push(value);
    else if (dateIds.has(fieldID)) entry.date = value;
    else entry.extra.push(value);
    fields.set(id, entry);
  }
  const creators = new Map<number, CreatorRow[]>();
  for (const row of all(
    db,
    `SELECT ic.itemID, c.firstName, c.lastName, c.fieldMode, ct.creatorType FROM itemCreators ic
       JOIN creators c ON c.creatorID = ic.creatorID JOIN creatorTypes ct ON ct.creatorTypeID = ic.creatorTypeID
      ORDER BY ic.itemID, ic.orderIndex`,
  )) {
    const id = num(row["itemID"]) ?? -1;
    const list = creators.get(id) ?? [];
    list.push({ first: str(row["firstName"]), last: str(row["lastName"]), single: num(row["fieldMode"]) === 1, role: str(row["creatorType"]) });
    creators.set(id, list);
  }
  const withPdf = new Set<number>();
  for (const row of all(db, `SELECT parentItemID FROM itemAttachments WHERE contentType='application/pdf' AND parentItemID IS NOT NULL AND ${NOT_DELETED}`)) {
    withPdf.add(num(row["parentItemID"]) ?? -1);
  }
  const standalonePdf = new Set<number>();
  for (const row of all(db, "SELECT itemID FROM itemAttachments WHERE contentType='application/pdf' AND parentItemID IS NULL")) {
    standalonePdf.add(num(row["itemID"]) ?? -1);
  }
  return rows.map((row) => {
    const itemID = num(row["itemID"]) ?? -1;
    const f = fields.get(itemID) ?? { titles: [], date: "", extra: [] };
    const list = creators.get(itemID) ?? [];
    const year = yearOf(f.date);
    const title = f.titles.find((t) => t.trim() !== "") ?? "(untitled)";
    return {
      itemID,
      libraryID: num(row["libraryID"]) ?? 0,
      modified: str(row["dateModified"]),
      key: str(row["key"]),
      title,
      creators: creatorSummary(list),
      year,
      itemType: str(row["typeName"]),
      hasPdf: withPdf.has(itemID) || standalonePdf.has(itemID),
      haystack: [...f.titles, ...f.extra, year ?? ""].map(fold),
      creatorHay: fold(list.map((c) => `${c.last} ${c.first} ${c.last}${c.first}`).join(" ")),
    };
  });
}

interface CollectionNode {
  id: number;
  key: string;
  name: string;
  parent: number | null;
}

function collectionNodes(db: DatabaseSync): Map<number, CollectionNode> {
  const map = new Map<number, CollectionNode>();
  for (const row of all(
    db,
    "SELECT collectionID, key, collectionName, parentCollectionID FROM collections WHERE collectionID NOT IN (SELECT collectionID FROM deletedCollections)",
  )) {
    const id = num(row["collectionID"]) ?? -1;
    map.set(id, { id, key: str(row["key"]), name: str(row["collectionName"]), parent: num(row["parentCollectionID"]) });
  }
  return map;
}

function collectionPath(map: Map<number, CollectionNode>, id: number): string {
  const parts: string[] = [];
  const seen = new Set<number>();
  let at: number | null = id;
  while (at !== null && !seen.has(at)) {
    seen.add(at);
    const node = map.get(at);
    if (node === undefined) break;
    parts.unshift(node.name);
    at = node.parent;
  }
  return parts.join(" / ");
}

/** 分类参数：key 直接用；名字按「完整路径 / 名字」不分大小写全等优先，再退到唯一包含；歧义列候选 */
function resolveCollection(map: Map<number, CollectionNode>, input: string): CollectionNode & { path: string } {
  const nodes = [...map.values()].map((node) => ({ ...node, path: collectionPath(map, node.id) }));
  const byKey = nodes.find((node) => node.key === input.toUpperCase());
  if (byKey !== undefined) return byKey;
  const lower = fold(input);
  const exact = nodes.filter((node) => fold(node.path) === lower || fold(node.name) === lower);
  const pool = exact.length > 0 ? exact : nodes.filter((node) => fold(node.path).includes(lower));
  if (pool.length === 1) return pool[0] as CollectionNode & { path: string };
  if (pool.length === 0) throw new Error(`No Zotero collection matches "${input}"`);
  const shown = pool.slice(0, 10).map((c) => `${c.path} (${c.key})`).join("; ");
  throw new Error(`"${input}" matches ${pool.length} collections: ${shown}. Pass one of the keys.`);
}

export interface SearchOutcome {
  items: ZoteroItemSummary[];
  total: number;
  collection: ZoteroCollectionRef | null;
}

export function searchItems(db: DatabaseSync, request: ZoteroSearchRequest, limit: number, offset: number): SearchOutcome {
  let scope: number[] | null = null;
  let collection: ZoteroCollectionRef | null = null;
  if (request.collection !== undefined && request.collection.trim() !== "") {
    const node = resolveCollection(collectionNodes(db), request.collection.trim());
    collection = { key: node.key, path: node.path };
    scope = all(db, "SELECT itemID FROM collectionItems WHERE collectionID=?", node.id).map((row) => num(row["itemID"]) ?? -1);
  }
  if (request.tag !== undefined && request.tag.trim() !== "") {
    const tagged = all(db, "SELECT it.itemID FROM itemTags it JOIN tags t ON t.tagID = it.tagID WHERE t.name=?", request.tag.trim()).map(
      (row) => num(row["itemID"]) ?? -1,
    );
    scope = scope === null ? tagged : scope.filter((id) => tagged.includes(id));
  }
  const words = searchWords(request.query ?? "");
  const type = request.itemType?.trim() ?? "";
  const hits = candidates(db, scope)
    .filter((c) => type === "" || c.itemType === type)
    .filter((c) => words.every((word) => c.creatorHay.includes(word) || c.haystack.some((field) => field.includes(word))))
    .sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : a.itemID - b.itemID));
  const items = hits.slice(offset, offset + limit).map(({ itemID: _i, libraryID: _l, modified: _m, haystack: _h, creatorHay: _c, ...summary }) => summary);
  return { items, total: hits.length, collection };
}

/** 条目 key → itemID（同一个 key 在个人库与群组库里各有一条时优先个人库）；回收站里的当不存在 */
function findItem(db: DatabaseSync, key: string): { itemID: number; libraryID: number; type: string; parentItemID: number | null } | null {
  const rows = all(
    db,
    `SELECT i.itemID, i.libraryID, t.typeName, a.parentItemID FROM items i
       JOIN itemTypesCombined t ON t.itemTypeID = i.itemTypeID
       JOIN libraries l ON l.libraryID = i.libraryID
       LEFT JOIN itemAttachments a ON a.itemID = i.itemID
      WHERE i.key=? AND l.type IN ('user', 'group') AND i.${NOT_DELETED}
      ORDER BY (l.type = 'user') DESC, i.libraryID`,
    key,
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { itemID: num(row["itemID"]) ?? -1, libraryID: num(row["libraryID"]) ?? -1, type: str(row["typeName"]), parentItemID: num(row["parentItemID"]) };
}

/** 附件的本机路径（见文件头的规则）；链接网址 = null */
export function attachmentPath(location: LibraryLocation, key: string, linkMode: number, stored: string): string | null {
  if (stored === "") return null;
  if (linkMode === 0 || linkMode === 1 || linkMode === 4) {
    return stored.startsWith("storage:") ? join(location.dataDir, "storage", key, stored.slice("storage:".length)) : null;
  }
  if (linkMode === 2) {
    if (stored.startsWith("attachments:")) {
      if (location.baseAttachmentPath === null) return null;
      return join(location.baseAttachmentPath, ...stored.slice("attachments:".length).split("/"));
    }
    return stored;
  }
  return null;
}

export interface AttachmentRow extends ZoteroAttachment {
  itemID: number;
}

function attachmentsOf(db: DatabaseSync, location: LibraryLocation, where: string, id: number): AttachmentRow[] {
  const titleField = all(db, "SELECT fieldID FROM fieldsCombined WHERE fieldName='title'")[0]?.["fieldID"];
  return all(
    db,
    `SELECT a.itemID, i.key, a.linkMode, a.contentType, a.path,
            (SELECT v.value FROM itemData d JOIN itemDataValues v ON v.valueID = d.valueID WHERE d.itemID = a.itemID AND d.fieldID = ?) AS title
       FROM itemAttachments a JOIN items i ON i.itemID = a.itemID
      WHERE ${where} AND a.${NOT_DELETED}
      ORDER BY i.dateAdded, a.itemID`,
    num(titleField) ?? -1,
    id,
  ).map((row) => {
    const key = str(row["key"]);
    const linkMode = num(row["linkMode"]) ?? -1;
    const path = attachmentPath(location, key, linkMode, str(row["path"]));
    const stored = str(row["path"]);
    const filename = path !== null ? basename(path) : stored === "" ? "" : basename(stored.replace(/^(storage|attachments):/, ""));
    const contentType = str(row["contentType"]);
    return {
      itemID: num(row["itemID"]) ?? -1,
      key,
      title: str(row["title"]),
      filename: filename === "" ? null : filename,
      contentType: contentType === "" ? null : contentType,
      linkMode: LINK_MODES[linkMode] ?? String(linkMode),
      path,
      onDisk: false,
    };
  });
}

/** 条目的规范地址（uri.js getLibraryPath） */
function itemUri(db: DatabaseSync, libraryID: number, key: string): string {
  const library = all(db, "SELECT type FROM libraries WHERE libraryID=?", libraryID)[0];
  if (str(library?.["type"]) === "group") {
    const group = all(db, "SELECT groupID FROM groups WHERE libraryID=?", libraryID)[0];
    return `http://zotero.org/groups/${str(group?.["groupID"])}/items/${key}`;
  }
  const account = new Map(all(db, "SELECT key, value FROM settings WHERE setting='account'").map((row) => [str(row["key"]), str(row["value"])]));
  const userID = account.get("userID") ?? "";
  const user = userID !== "" && userID !== "0" ? userID : `local/${account.get("localUserKey") ?? ""}`;
  return `http://zotero.org/users/${user}/items/${key}`;
}

/** 读条目时不进「其余字段」的：已单列的 */
const SKIP_FIELDS = new Set(["title", "abstractNote"]);

export interface ItemRead {
  detail: Omit<ZoteroItemDetail, "annotations" | "annotationTotal" | "annotationOffset">;
  annotations: ZoteroAnnotation[];
  attachments: AttachmentRow[];
}

export function readItem(db: DatabaseSync, location: LibraryLocation, key: string): ItemRead | null {
  const found = findItem(db, key);
  if (found === null) return null;
  if (found.type === "note" || found.type === "annotation") {
    throw new Error(`${key} is a ${found.type}, not a library item; pass the key of the item it belongs to`);
  }
  const summary = candidates(db, [found.itemID])[0];
  const dateIds = fieldFamily(db, "date");
  const fields: { name: string; value: string }[] = [];
  let title = summary?.title ?? "(untitled)";
  let abstract = "";
  for (const row of all(
    db,
    `SELECT d.fieldID, f.fieldName, v.value FROM itemData d JOIN fieldsCombined f ON f.fieldID = d.fieldID
       JOIN itemDataValues v ON v.valueID = d.valueID WHERE d.itemID=? ORDER BY d.fieldID`,
    found.itemID,
  )) {
    const name = str(row["fieldName"]);
    const value = str(row["value"]).trim();
    if (value === "") continue;
    if (name === "title") title = value;
    if (name === "abstractNote") abstract = value;
    if (SKIP_FIELDS.has(name)) continue;
    fields.push({ name, value: dateIds.has(num(row["fieldID"]) ?? -1) ? displayDate(value) : value });
  }
  const creatorList = all(
    db,
    `SELECT c.firstName, c.lastName, c.fieldMode, ct.creatorType FROM itemCreators ic
       JOIN creators c ON c.creatorID = ic.creatorID JOIN creatorTypes ct ON ct.creatorTypeID = ic.creatorTypeID
      WHERE ic.itemID=? ORDER BY ic.orderIndex`,
    found.itemID,
  ).map((row) => {
    const c: CreatorRow = { first: str(row["firstName"]), last: str(row["lastName"]), single: num(row["fieldMode"]) === 1, role: str(row["creatorType"]) };
    return { name: creatorName(c), role: c.role };
  });
  const tags = all(db, "SELECT t.name FROM itemTags it JOIN tags t ON t.tagID = it.tagID WHERE it.itemID=? ORDER BY t.name", found.itemID).map((row) =>
    str(row["name"]),
  );
  const nodes = collectionNodes(db);
  const collections = all(db, "SELECT collectionID FROM collectionItems WHERE itemID=?", found.itemID)
    .map((row) => num(row["collectionID"]) ?? -1)
    .filter((id) => nodes.has(id))
    .map((id) => ({ key: nodes.get(id)?.key ?? "", path: collectionPath(nodes, id) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const attachments =
    found.type === "attachment" ? attachmentsOf(db, location, "a.itemID=?", found.itemID) : attachmentsOf(db, location, "a.parentItemID=?", found.itemID);
  const noteCount = num(
    all(db, `SELECT COUNT(*) AS n FROM itemNotes WHERE parentItemID=? AND ${NOT_DELETED}`, found.itemID)[0]?.["n"],
  ) ?? 0;
  const annotations: ZoteroAnnotation[] = [];
  for (const attachment of attachments) {
    for (const row of all(
      db,
      `SELECT i.key, an.type, an.text, an.comment, an.color, an.pageLabel, an.sortIndex FROM itemAnnotations an
         JOIN items i ON i.itemID = an.itemID WHERE an.parentItemID=? AND an.${NOT_DELETED} ORDER BY an.sortIndex, an.itemID`,
      attachment.itemID,
    )) {
      annotations.push({
        key: str(row["key"]),
        type: ANNOTATION_TYPES[num(row["type"]) ?? 0] ?? String(row["type"]),
        text: str(row["text"]),
        comment: str(row["comment"]),
        color: str(row["color"]),
        pageLabel: str(row["pageLabel"]),
        attachmentKey: attachment.key,
      });
    }
  }
  return {
    detail: {
      key,
      title,
      creators: summary?.creators ?? creatorSummary([]),
      year: summary?.year ?? null,
      itemType: found.type,
      hasPdf: attachments.some((a) => a.contentType === "application/pdf"),
      uri: itemUri(db, found.libraryID, key),
      fields,
      creatorList,
      abstract,
      tags,
      collections,
      attachments: attachments.map(({ itemID: _id, ...rest }) => rest),
      noteCount,
    },
    annotations,
    attachments,
  };
}

/** 读全文要的东西：标题、候选附件（PDF 优先，其次 EPUB / 网页快照）、各自的索引页数 */
export interface FulltextTargets {
  title: string;
  attachments: (AttachmentRow & { indexedPages: number | null; totalPages: number | null })[];
}

const READABLE_TYPES = new Set(["application/pdf", "application/epub+zip", "text/html"]);

export function fulltextTargets(db: DatabaseSync, location: LibraryLocation, key: string): FulltextTargets | null {
  const read = readItem(db, location, key);
  if (read === null) return null;
  const pdfFirst = [
    ...read.attachments.filter((a) => a.contentType === "application/pdf"),
    ...read.attachments.filter((a) => a.contentType !== "application/pdf" && a.contentType !== null && READABLE_TYPES.has(a.contentType)),
  ];
  return {
    title: read.detail.title,
    attachments: pdfFirst.map((attachment) => {
      const row = all(db, "SELECT indexedPages, totalPages FROM fulltextItems WHERE itemID=?", attachment.itemID)[0];
      return { ...attachment, indexedPages: num(row?.["indexedPages"]), totalPages: num(row?.["totalPages"]) };
    }),
  };
}
