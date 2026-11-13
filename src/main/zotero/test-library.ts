/**
 * 测试夹具：在临时目录里造一份「Zotero 数据目录」——zotero.sqlite + storage/<key>/ 里的 PDF 与 .zotero-ft-cache，
 * 外加一个 profile 目录（profiles.ini + prefs.js）。由 service.test.ts / data-dir.test.ts / zotero-tools.test.ts 用，
 * 不在应用调用路径上。
 *
 * 表与列照本机 Zotero 10.0.9 的 `resource/schema/userdata.sql`（userdata 131）里我们读到的那些；建表语句是按列名
 * 自己写的最小版（不是拷贝 Zotero 的脚本——它是 AGPL），只建 library.ts 用到的表与列。
 * 取值约定照 Zotero：linkMode 0/2、`storage:` 与 `attachments:` 两种路径、批注类型 1/2、日期 multipart。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DDL = `
CREATE TABLE version (schema TEXT PRIMARY KEY, version INT NOT NULL);
CREATE TABLE settings (setting TEXT, key TEXT, value, PRIMARY KEY (setting, key));
CREATE TABLE libraries (libraryID INTEGER PRIMARY KEY, type TEXT NOT NULL, editable INT NOT NULL DEFAULT 1, filesEditable INT NOT NULL DEFAULT 1);
CREATE TABLE groups (groupID INTEGER PRIMARY KEY, libraryID INT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', version INT NOT NULL DEFAULT 0);
CREATE TABLE itemTypesCombined (itemTypeID INT NOT NULL PRIMARY KEY, typeName TEXT NOT NULL, display INT DEFAULT 1 NOT NULL, custom INT NOT NULL DEFAULT 0);
CREATE TABLE fieldsCombined (fieldID INT NOT NULL PRIMARY KEY, fieldName TEXT NOT NULL, label TEXT, fieldFormatID INT, custom INT NOT NULL DEFAULT 0);
CREATE TABLE baseFieldMappingsCombined (itemTypeID INT, baseFieldID INT, fieldID INT, PRIMARY KEY (itemTypeID, baseFieldID, fieldID));
CREATE TABLE creatorTypes (creatorTypeID INTEGER PRIMARY KEY, creatorType TEXT);
CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INT NOT NULL, dateAdded TIMESTAMP NOT NULL, dateModified TIMESTAMP NOT NULL,
  clientDateModified TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, libraryID INT NOT NULL, key TEXT NOT NULL, version INT NOT NULL DEFAULT 0,
  clientVersion INT NOT NULL DEFAULT 0, synced INT NOT NULL DEFAULT 0, UNIQUE (libraryID, key));
CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value UNIQUE);
CREATE TABLE itemData (itemID INT, fieldID INT, valueID, PRIMARY KEY (itemID, fieldID));
CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT, fieldMode INT);
CREATE TABLE itemCreators (itemID INT NOT NULL, creatorID INT NOT NULL, creatorTypeID INT NOT NULL DEFAULT 1, orderIndex INT NOT NULL DEFAULT 0,
  PRIMARY KEY (itemID, creatorID, creatorTypeID, orderIndex));
CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, parentItemID INT, linkMode INT, contentType TEXT, charsetID INT, path TEXT);
CREATE TABLE itemNotes (itemID INTEGER PRIMARY KEY, parentItemID INT, note TEXT, title TEXT);
CREATE TABLE itemAnnotations (itemID INTEGER PRIMARY KEY, parentItemID INT NOT NULL, type INTEGER NOT NULL, authorName TEXT, text TEXT,
  comment TEXT, color TEXT, pageLabel TEXT, sortIndex TEXT NOT NULL, position TEXT NOT NULL, isExternal INT NOT NULL);
CREATE TABLE tags (tagID INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE itemTags (itemID INT NOT NULL, tagID INT NOT NULL, type INT NOT NULL, PRIMARY KEY (itemID, tagID));
CREATE TABLE collections (collectionID INTEGER PRIMARY KEY, collectionName TEXT NOT NULL, parentCollectionID INT DEFAULT NULL,
  libraryID INT NOT NULL, key TEXT NOT NULL);
CREATE TABLE collectionItems (collectionID INT NOT NULL, itemID INT NOT NULL, orderIndex INT NOT NULL DEFAULT 0, PRIMARY KEY (collectionID, itemID));
CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY, dateDeleted DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE deletedCollections (collectionID INTEGER PRIMARY KEY, dateDeleted DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE fulltextItems (itemID INTEGER PRIMARY KEY, indexedPages INT, totalPages INT, indexedChars INT, totalChars INT, version INT NOT NULL DEFAULT 0);
`;

const TYPES: Record<string, number> = { note: 1, attachment: 2, annotation: 3, book: 4, journalArticle: 5, conferencePaper: 6, case: 7, bookSection: 8 };
const FIELDS: Record<string, number> = {
  title: 1, abstractNote: 2, date: 3, publicationTitle: 4, DOI: 5, shortTitle: 6, url: 7, caseName: 8, dateDecided: 9, court: 10, accessDate: 11, bookTitle: 12,
};

export interface TestLibrary {
  /** 数据目录 */
  dataDir: string;
  database: string;
  /** 链接文件的基准目录（prefs.js 里的 baseAttachmentPath） */
  baseDir: string;
  /** 存储附件 PDFA2222 的 PDF 与链接附件 LNKB2222 的 PDF */
  pdfA: string;
  pdfB: string;
  fulltextA: string;
}

export interface BuildOptions {
  userdata?: number;
  /** 个人库没登录过同步：只有 localUserKey */
  localOnly?: boolean;
}

/** 造数据目录（root/zotero）与链接文件基准目录（root/papers）；返回各路径 */
export function buildTestLibrary(root: string, options: BuildOptions = {}): TestLibrary {
  const dataDir = join(root, "zotero");
  const baseDir = join(root, "papers");
  mkdirSync(join(dataDir, "storage", "PDFA2222"), { recursive: true });
  mkdirSync(join(baseDir, "论文"), { recursive: true });
  const pdfA = join(dataDir, "storage", "PDFA2222", "Vaswani - 2017 - Attention Is All You Need.pdf");
  const pdfB = join(baseDir, "论文", "城市智能体.pdf");
  writeFileSync(pdfA, "%PDF-1.4 fake\n");
  writeFileSync(pdfB, "%PDF-1.4 fake\n");
  const fulltextA = "Attention Is All You Need\nAbstract\nThe dominant sequence transduction models are based on complex recurrent or convolutional neural networks. ".repeat(200);
  writeFileSync(join(dataDir, "storage", "PDFA2222", ".zotero-ft-cache"), fulltextA);

  const database = join(dataDir, "zotero.sqlite");
  const db = new DatabaseSync(database);
  try {
    db.exec(DDL);
    const run = (sql: string, ...params: (string | number | null)[]): void => {
      db.prepare(sql).run(...params);
    };
    run("INSERT INTO version VALUES ('userdata', ?)", options.userdata ?? 131);
    run("INSERT INTO settings VALUES ('account', 'localUserKey', 'loc4lKey')");
    if (options.localOnly !== true) run("INSERT INTO settings VALUES ('account', 'userID', 1234567)");
    run("INSERT INTO libraries (libraryID, type) VALUES (1, 'user'), (2, 'group'), (3, 'feed')");
    run("INSERT INTO groups (groupID, libraryID, name) VALUES (7654321, 2, 'Example Group')");
    for (const [name, id] of Object.entries(TYPES)) run("INSERT INTO itemTypesCombined (itemTypeID, typeName) VALUES (?, ?)", id, name);
    for (const [name, id] of Object.entries(FIELDS)) run("INSERT INTO fieldsCombined (fieldID, fieldName) VALUES (?, ?)", id, name);
    // case 的 caseName → title、dateDecided → date；bookSection 的 bookTitle → publicationTitle（Zotero 的 base field mapping）
    run("INSERT INTO baseFieldMappingsCombined VALUES (7, 1, 8), (7, 3, 9), (8, 4, 12)");
    run("INSERT INTO creatorTypes VALUES (1, 'author'), (2, 'editor')");

    let valueId = 0;
    const values = new Map<string, number>();
    const field = (itemID: number, name: string, value: string): void => {
      let v = values.get(value);
      if (v === undefined) {
        valueId += 1;
        v = valueId;
        values.set(value, v);
        run("INSERT INTO itemDataValues VALUES (?, ?)", v, value);
      }
      run("INSERT INTO itemData VALUES (?, ?, ?)", itemID, FIELDS[name] ?? -1, v);
    };
    const item = (itemID: number, type: string, key: string, modified: string, library = 1): void => {
      run("INSERT INTO items (itemID, itemTypeID, dateAdded, dateModified, libraryID, key) VALUES (?, ?, ?, ?, ?, ?)", itemID, TYPES[type] ?? -1, modified, modified, library, key);
    };
    let creatorId = 0;
    const creator = (itemID: number, order: number, last: string, first: string, type = 1, single = 0): void => {
      creatorId += 1;
      run("INSERT INTO creators VALUES (?, ?, ?, ?)", creatorId, first, last, single);
      run("INSERT INTO itemCreators VALUES (?, ?, ?, ?)", itemID, creatorId, type, order);
    };

    run("INSERT INTO collections VALUES (1, '博士论文', NULL, 1, 'CLLA2222'), (2, '第二章', 1, 1, 'CLLB3333'), (3, 'Transformers', NULL, 1, 'CLLC4444'), (4, '已删分类', NULL, 1, 'CLLD5555')");
    run("INSERT INTO deletedCollections (collectionID) VALUES (4)");
    run("INSERT INTO tags VALUES (1, 'transformer'), (2, 'urbanism')");

    // 1：英文会议论文，存储 PDF + 全文缓存 + 35 条批注 + 子笔记
    item(1, "conferencePaper", "ATTN2345", "2024-05-01 00:00:00");
    field(1, "title", "Attention Is All You Need");
    field(1, "abstractNote", "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.");
    field(1, "date", "2017-06-12 2017-06-12");
    field(1, "publicationTitle", "Advances in Neural Information Processing Systems");
    field(1, "DOI", "10.48550/arXiv.1706.03762");
    field(1, "accessDate", "2024-01-02 03:04:05");
    creator(1, 0, "Vaswani", "Ashish");
    creator(1, 1, "Shazeer", "Noam");
    creator(1, 2, "Parmar", "Niki");
    run("INSERT INTO collectionItems VALUES (2, 1, 0), (3, 1, 0), (4, 1, 0)");
    run("INSERT INTO itemTags VALUES (1, 1, 0)");
    item(10, "attachment", "PDFA2222", "2024-05-01 00:00:00");
    field(10, "title", "Full Text PDF");
    run("INSERT INTO itemAttachments VALUES (10, 1, 0, 'application/pdf', NULL, 'storage:Vaswani - 2017 - Attention Is All You Need.pdf')");
    run("INSERT INTO fulltextItems (itemID, indexedPages, totalPages) VALUES (10, 15, 15)");
    item(11, "note", "NTEE2222", "2024-05-01 00:00:00");
    run("INSERT INTO itemNotes VALUES (11, 1, '<p>读书笔记</p>', '读书笔记')");
    // 倒着插：读出来的顺序必须来自 sortIndex，而不是插入顺序
    for (let i = 34; i >= 0; i -= 1) {
      const id = 100 + i;
      item(id, "annotation", `AN${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}ABCD`, "2024-05-01 00:00:00");
      const note = i % 5 === 4;
      run(
        "INSERT INTO itemAnnotations VALUES (?, 10, ?, '', ?, ?, ?, ?, ?, '{}', 0)",
        id,
        note ? 2 : 1,
        note ? null : `Highlighted passage number ${i + 1} about scaled dot-product attention.`,
        i % 3 === 0 ? `想法 ${i + 1}：和第二章的论证对得上` : "",
        i % 2 === 0 ? "#ffd400" : "#5fb236",
        String(Math.floor(i / 10) + 1),
        `${String(Math.floor(i / 10)).padStart(5, "0")}|${String(i * 100).padStart(6, "0")}|00100`,
      );
    }

    // 2：中文期刊论文，链接文件（attachments: 相对路径），没有全文缓存
    item(2, "journalArticle", "CHN22222", "2024-04-01 00:00:00");
    field(2, "title", "城市智能体的空间认知研究");
    field(2, "date", "2023-00-00 2023");
    field(2, "publicationTitle", "地理学报");
    creator(2, 0, "张", "三");
    run("INSERT INTO collectionItems VALUES (1, 2, 0)");
    item(20, "attachment", "LNKB2222", "2024-04-01 00:00:00");
    field(20, "title", "城市智能体.pdf");
    run("INSERT INTO itemAttachments VALUES (20, 2, 2, 'application/pdf', NULL, 'attachments:论文/城市智能体.pdf')");

    // 3：书，没有附件
    item(3, "book", "BKJJ2222", "2024-03-01 00:00:00");
    field(3, "title", "The Death and Life of Great American Cities");
    field(3, "date", "1961-00-00 1961");
    creator(3, 0, "Jacobs", "Jane");
    run("INSERT INTO itemTags VALUES (3, 2, 0)");

    // 4：在回收站里（不该出现）
    item(4, "journalArticle", "DELD2222", "2024-06-01 00:00:00");
    field(4, "title", "Attention deleted draft");
    run("INSERT INTO deletedItems (itemID) VALUES (4)");

    // 5：独立笔记（不该出现在查文献里）
    item(5, "note", "NTST2222", "2024-06-02 00:00:00");
    run("INSERT INTO itemNotes VALUES (5, NULL, '<p>Attention 随想</p>', 'Attention 随想')");

    // 6：群组库里的论文（规范地址是 groups/…）
    item(6, "journalArticle", "GRPA2222", "2024-02-01 00:00:00", 2);
    field(6, "title", "Generative Agents: Interactive Simulacra of Human Behavior");
    field(6, "date", "2023-04-07 2023-04-07");
    creator(6, 0, "Park", "Joon Sung");
    creator(6, 1, "O'Brien", "Joseph");

    // 7：判例（标题在 caseName，日期在 dateDecided——经 base field mapping 读到）
    item(7, "case", "CASE2222", "2024-01-01 00:00:00");
    field(7, "caseName", "Penn Central v. New York City");
    field(7, "dateDecided", "1978-06-26 June 26, 1978");
    field(7, "court", "Supreme Court");

    // 9：书的一章（书名在 bookTitle，映射到 publicationTitle——按书名也要查得到）
    item(9, "bookSection", "BKSC2222", "2023-12-01 00:00:00");
    field(9, "title", "Streets as systems");
    field(9, "bookTitle", "Urban Systems Design");
    field(9, "date", "2020-00-00 2020");

    // 8：订阅源里的条目（不该出现）
    item(8, "journalArticle", "FEED2222", "2024-07-01 00:00:00", 3);
    field(8, "title", "Attention feed entry");
  } finally {
    db.close();
  }
  return { dataDir, database, baseDir, pdfA, pdfB, fulltextA };
}

/** 造 Zotero 的 profile 目录：profiles.ini（默认 profile）+ prefs.js（数据目录、基准目录） */
export function writeTestProfile(profileRoot: string, prefs: Record<string, string | boolean>): string {
  const profile = join(profileRoot, "Profiles", "abcd1234.default");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profileRoot, "profiles.ini"), "[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/abcd1234.default\nDefault=1\n\n[General]\nStartWithLastProfile=1\nVersion=2\n");
  const lines = Object.entries(prefs).map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${typeof value === "boolean" ? String(value) : JSON.stringify(value)});`);
  writeFileSync(join(profile, "prefs.js"), `// Mozilla User Preferences\n${lines.join("\n")}\n`);
  return profile;
}
