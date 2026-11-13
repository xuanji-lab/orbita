/**
 * Zotero 只读服务的账：对着夹具库（test-library.ts，表结构照 userdata 131）验查文献 / 读条目 / 读全文、
 * 数据目录的三种读不了、只读（源目录逐字节不变，含 Zotero 开着时 -wal 有内容的那一路）、不预热。
 * 真库上的数字与 5 个查询的核对在 PR 描述里（这里是夹具，不是用户的库）。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import type { ZoteroOutcome, ZoteroResult } from "../../shared/zotero.ts";
import { setSnapshotRoot } from "../session/sqlite-readonly.ts";
import { findZoteroDataDir } from "./data-dir.ts";
import { ZOTERO_SCHEMA_MAX, ZOTERO_SCHEMA_MIN } from "./library.ts";
import { ZoteroService } from "./service.ts";
import { buildTestLibrary, type TestLibrary } from "./test-library.ts";

let root: string;
let lib: TestLibrary;
let service: ZoteroService;

const located = (l: TestLibrary) => async () => ({
  found: { dir: l.dataDir, database: l.database, baseAttachmentPath: l.baseDir, source: "override" as const },
  tried: [l.dataDir],
});

function ok<T extends ZoteroResult["op"]>(outcome: ZoteroOutcome, op: T): Extract<ZoteroResult, { op: T }> {
  if (!outcome.ok) throw new Error(`expected ok, got: ${outcome.error}`);
  assert.equal(outcome.result.op, op);
  return outcome.result as Extract<ZoteroResult, { op: T }>;
}

/** 目录里每个文件的 大小 + mtime + 内容哈希（零写入的判据） */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const info = statSync(path);
      if (info.isDirectory()) walk(path);
      else out[path.slice(dir.length)] = `${info.size}|${info.mtimeMs}|${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    }
  };
  walk(dir);
  return out;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "orbita-zotero-"));
  await setSnapshotRoot(join(root, "snapshots"));
  lib = buildTestLibrary(join(root, "main"));
  service = new ZoteroService({ locate: located(lib) });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("查文献", () => {
  test("标题词：标题 / 作者摘要 / 年份 / 类型 / 有无 PDF / key；总数", async () => {
    const result = ok(await service.handle({ op: "search", query: "attention" }), "search");
    assert.equal(result.total, 1, "回收站里的、独立笔记、订阅源里的都不算");
    assert.deepEqual(result.items[0], {
      key: "ATTN2345",
      title: "Attention Is All You Need",
      creators: "Vaswani et al.",
      year: "2017",
      itemType: "conferencePaper",
      hasPdf: true,
    });
  });

  test("作者姓、年份、中文标题、中文作者（姓 / 全名）、出版物都查得到；不分大小写与变音符", async () => {
    const keys = async (query: string): Promise<string[]> => ok(await service.handle({ op: "search", query }), "search").items.map((i) => i.key);
    assert.deepEqual(await keys("Jacobs"), ["BKJJ2222"]);
    assert.deepEqual(await keys("1961"), ["BKJJ2222"]);
    assert.deepEqual(await keys("城市智能体"), ["CHN22222"]);
    assert.deepEqual(await keys("张"), ["CHN22222"]);
    assert.deepEqual(await keys("张三"), ["CHN22222"]);
    assert.deepEqual(await keys("地理学报"), ["CHN22222"]);
    assert.deepEqual(await keys("VASWANI"), ["ATTN2345"]);
    assert.deepEqual(await keys("o'brien"), ["GRPA2222"], "群组库里的也查");
  });

  test("多词是「且」；引号括起的是一个词；判例的 caseName 经 base field mapping 当标题", async () => {
    assert.equal(ok(await service.handle({ op: "search", query: "attention 2017" }), "search").total, 1);
    assert.equal(ok(await service.handle({ op: "search", query: "attention 1961" }), "search").total, 0);
    assert.equal(ok(await service.handle({ op: "search", query: '"all you need"' }), "search").total, 1);
    const penn = ok(await service.handle({ op: "search", query: "penn 1978" }), "search").items[0];
    assert.equal(penn?.title, "Penn Central v. New York City");
    assert.equal(penn?.year, "1978");
    // 基础字段连同映射字段一起搜：bookSection 的 bookTitle 映射到 publicationTitle（真库 13 条书章靠它才查得到）
    assert.deepEqual(ok(await service.handle({ op: "search", query: "urban systems" }), "search").items.map((i) => i.key), ["BKSC2222"]);
  });

  test("默认最多 20 条、limit / offset 翻页；按修改时间新的在前", async () => {
    const all = ok(await service.handle({ op: "search" }), "search");
    assert.deepEqual(all.items.map((i) => i.key), ["ATTN2345", "CHN22222", "BKJJ2222", "GRPA2222", "CASE2222", "BKSC2222"]);
    const page = ok(await service.handle({ op: "search", limit: 2, offset: 2 }), "search");
    assert.deepEqual(page.items.map((i) => i.key), ["BKJJ2222", "GRPA2222"]);
    assert.equal(page.total, 6);
  });

  test("按分类（名字 / 路径 / key）与标签、条目类型；分类不存在或在回收站给人话", async () => {
    const byName = ok(await service.handle({ op: "search", collection: "第二章" }), "search");
    assert.deepEqual(byName.collection, { key: "CLLB3333", path: "博士论文 / 第二章" });
    assert.deepEqual(byName.items.map((i) => i.key), ["ATTN2345"]);
    // 只看直接放在里面的（Zotero 的「显示子分类中的条目」默认关）
    assert.deepEqual(ok(await service.handle({ op: "search", collection: "博士论文" }), "search").items.map((i) => i.key), ["CHN22222"]);
    assert.equal(ok(await service.handle({ op: "search", collection: "cllc4444" }), "search").collection?.path, "Transformers");
    const deleted = await service.handle({ op: "search", collection: "已删分类" });
    assert.ok(!deleted.ok && /No Zotero collection matches/.test(deleted.error));
    assert.deepEqual(ok(await service.handle({ op: "search", tag: "urbanism" }), "search").items.map((i) => i.key), ["BKJJ2222"]);
    assert.deepEqual(ok(await service.handle({ op: "search", itemType: "case" }), "search").items.map((i) => i.key), ["CASE2222"]);
  });
});

describe("读条目", () => {
  test("元数据（日期显示原文、accessDate 不被当成 multipart）、摘要、分类路径（回收站里的分类不列）、标签、子笔记数、规范地址", async () => {
    const { item } = ok(await service.handle({ op: "item", key: "attn2345" }), "item");
    assert.equal(item.title, "Attention Is All You Need");
    assert.match(item.abstract, /sequence transduction/);
    assert.deepEqual(item.creatorList.map((c) => c.name), ["Vaswani, Ashish", "Shazeer, Noam", "Parmar, Niki"]);
    assert.ok(item.fields.some((f) => f.name === "date" && f.value === "2017-06-12"));
    assert.ok(item.fields.some((f) => f.name === "accessDate" && f.value === "2024-01-02 03:04:05"));
    assert.ok(item.fields.some((f) => f.name === "DOI"));
    assert.ok(!item.fields.some((f) => f.name === "title" || f.name === "abstractNote"));
    assert.deepEqual(item.collections.map((c) => c.path), ["Transformers", "博士论文 / 第二章"]);
    assert.deepEqual(item.tags, ["transformer"]);
    assert.equal(item.noteCount, 1);
    assert.equal(item.uri, "http://zotero.org/users/1234567/items/ATTN2345");
  });

  test("附件：存储附件 storage:… 与链接文件 attachments:… 都解析成本机原路径；在不在本机按 stat", async () => {
    const a = ok(await service.handle({ op: "item", key: "ATTN2345" }), "item").item.attachments;
    assert.deepEqual(a, [
      {
        key: "PDFA2222",
        title: "Full Text PDF",
        filename: "Vaswani - 2017 - Attention Is All You Need.pdf",
        contentType: "application/pdf",
        linkMode: "imported_file",
        path: lib.pdfA,
        onDisk: true,
      },
    ]);
    const b = ok(await service.handle({ op: "item", key: "CHN22222" }), "item").item;
    assert.equal(b.attachments[0]?.linkMode, "linked_file");
    assert.equal(b.attachments[0]?.path, lib.pdfB);
    assert.equal(b.attachments[0]?.onDisk, true);
    assert.equal(b.creatorList[0]?.name, "张三");
    rmSync(lib.pdfB);
    try {
      assert.equal(ok(await service.handle({ op: "item", key: "CHN22222" }), "item").item.attachments[0]?.onDisk, false);
    } finally {
      writeFileSync(lib.pdfB, "%PDF-1.4 fake\n");
    }
  });

  test("批注：类型 / 原文 / 批注文字 / 页码 / 颜色，按 sortIndex 排；一页 30 条，offset 续读", async () => {
    const first = ok(await service.handle({ op: "item", key: "ATTN2345" }), "item").item;
    assert.equal(first.annotationTotal, 35);
    assert.equal(first.annotations.length, 30);
    assert.deepEqual(first.annotations[0], {
      key: "ANAAABCD",
      type: "highlight",
      text: "Highlighted passage number 1 about scaled dot-product attention.",
      comment: "想法 1：和第二章的论证对得上",
      color: "#ffd400",
      pageLabel: "1",
      attachmentKey: "PDFA2222",
    });
    assert.equal(first.annotations[4]?.type, "note");
    const rest = ok(await service.handle({ op: "item", key: "ATTN2345", annotationOffset: 30 }), "item").item;
    assert.equal(rest.annotations.length, 5);
    assert.equal(rest.annotations.at(-1)?.text, "", "note 类批注没有原文");
  });

  test("群组库条目的规范地址是 groups/…；附件 key 也能读；回收站里的、批注 / 笔记的 key、不像 key 的输入都给人话", async () => {
    assert.equal(ok(await service.handle({ op: "item", key: "GRPA2222" }), "item").item.uri, "http://zotero.org/groups/7654321/items/GRPA2222");
    assert.equal(ok(await service.handle({ op: "item", key: "PDFA2222" }), "item").item.attachments[0]?.key, "PDFA2222");
    const deleted = await service.handle({ op: "item", key: "DELD2222" });
    assert.ok(!deleted.ok && /No Zotero item with key DELD2222/.test(deleted.error));
    const note = await service.handle({ op: "item", key: "NTEE2222" });
    assert.ok(!note.ok && /is a note/.test(note.error));
    const bad = await service.handle({ op: "item", key: "../../x" });
    assert.ok(!bad.ok && /not a Zotero item key/.test(bad.error));
  });
});

describe("读全文", () => {
  test("父条目 key → PDF 附件的 .zotero-ft-cache；字符区间续读；带 PDF 原路径与索引页数", async () => {
    const first = ok(await service.handle({ op: "fulltext", key: "ATTN2345", length: 100 }), "fulltext");
    assert.ok(first.fulltext !== null);
    assert.equal(first.fulltext.attachmentKey, "PDFA2222");
    assert.deepEqual([first.fulltext.start, first.fulltext.end, first.fulltext.total], [0, 100, lib.fulltextA.length]);
    assert.equal(first.fulltext.text, lib.fulltextA.slice(0, 100));
    assert.equal(first.fulltext.path, lib.pdfA);
    assert.deepEqual([first.fulltext.indexedPages, first.fulltext.totalPages], [15, 15]);
    const next = ok(await service.handle({ op: "fulltext", key: "ATTN2345", start: 100, length: 50 }), "fulltext");
    assert.equal(next.fulltext?.text, lib.fulltextA.slice(100, 150));
  });

  test("没有全文缓存：如实说没有，并给 PDF 路径；没有附件的条目 pdfPath 为 null", async () => {
    const none = ok(await service.handle({ op: "fulltext", key: "CHN22222" }), "fulltext");
    assert.equal(none.fulltext, null);
    assert.equal(none.pdfPath, lib.pdfB);
    const book = ok(await service.handle({ op: "fulltext", key: "BKJJ2222" }), "fulltext");
    assert.deepEqual([book.fulltext, book.pdfPath], [null, null]);
  });
});

describe("读不了的三种情况：一句人话，不抛栈", () => {
  test("没有数据目录：说清找过哪里、Orbita 从 Zotero 自己的设置找", async () => {
    const empty = mkdtempSync(join(root, "home-"));
    const svc = new ZoteroService({ locate: () => findZoteroDataDir({ home: empty, platform: "darwin", packaged: false }) });
    const outcome = await svc.handle({ op: "search", query: "x" });
    assert.equal(outcome.ok ? null : outcome.unavailable, "no-data-dir");
    if (!outcome.ok) {
      assert.match(outcome.error, /^Zotero was not found on this computer/);
      assert.match(outcome.error, /数据目录位置/);
      assert.ok(outcome.error.includes(join(empty, "Zotero")), "说出找过的默认位置");
    }
  });

  test(`数据库版本不在 ${ZOTERO_SCHEMA_MIN}–${ZOTERO_SCHEMA_MAX}：新了说「还不认识」，旧了说太旧；都不往下读`, async () => {
    for (const [userdata, kind] of [
      [ZOTERO_SCHEMA_MAX + 1, "schema-too-new"],
      [ZOTERO_SCHEMA_MIN - 1, "schema-too-old"],
    ] as const) {
      const other = buildTestLibrary(join(root, `v${userdata}`), { userdata });
      const outcome = await new ZoteroService({ locate: located(other) }).handle({ op: "search", query: "attention" });
      assert.equal(outcome.ok ? null : outcome.unavailable, kind);
      if (!outcome.ok) assert.ok(outcome.error.includes(`userdata schema ${userdata}`));
    }
    const edge = buildTestLibrary(join(root, "vmin"), { userdata: ZOTERO_SCHEMA_MIN });
    assert.equal(ok(await new ZoteroService({ locate: located(edge) }).handle({ op: "search", query: "attention" }), "search").total, 1);
  });

  test("没登录过同步的个人库：规范地址是 users/local/<localUserKey>/…", async () => {
    const local = buildTestLibrary(join(root, "local"), { localOnly: true });
    const item = ok(await new ZoteroService({ locate: located(local) }).handle({ op: "item", key: "ATTN2345" }), "item").item;
    assert.equal(item.uri, "http://zotero.org/users/local/loc4lKey/items/ATTN2345");
  });
});

describe("只读与空闲", () => {
  test("Zotero 关着（没有 -wal）：immutable 直读，数据目录逐字节不变、不新建 -wal / -shm", async () => {
    const before = fingerprint(lib.dataDir);
    ok(await service.handle({ op: "search", query: "attention" }), "search");
    ok(await service.handle({ op: "item", key: "ATTN2345" }), "item");
    ok(await service.handle({ op: "fulltext", key: "ATTN2345" }), "fulltext");
    assert.deepEqual(fingerprint(lib.dataDir), before);
  });

  test("Zotero 开着（库被占着、新写的还在 -wal 里）：读到最新内容，源目录逐字节不变，临时副本读完即删", async () => {
    const live = buildTestLibrary(join(root, "live"));
    const writer = new DatabaseSync(live.database);
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
      writer.exec("INSERT INTO itemDataValues VALUES (9999, 'Attention arrives in the WAL')");
      writer.exec("UPDATE itemData SET valueID=9999 WHERE itemID=3 AND fieldID=1");
      assert.ok(statSync(`${live.database}-wal`).size > 0, "前提：-wal 里有没并回的内容");
      const before = fingerprint(live.dataDir);
      const svc = new ZoteroService({ locate: located(live) });
      const keys = ok(await svc.handle({ op: "search", query: "arrives" }), "search").items.map((i) => i.key);
      assert.deepEqual(keys, ["BKJJ2222"], "-wal 里的改动读得到");
      assert.deepEqual(fingerprint(live.dataDir), before, "源目录（含 -wal / -shm）逐字节不变");
      assert.deepEqual(readdirSync(join(root, "snapshots")), [], "副本读完即删");
    } finally {
      writer.close();
    }
  });

  test("构造服务不碰磁盘：locate 只在工具被调用时才跑", async () => {
    let calls = 0;
    const svc = new ZoteroService({
      locate: async () => {
        calls += 1;
        return located(lib)();
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls, 0);
    ok(await svc.handle({ op: "search" }), "search");
    assert.equal(calls, 1);
  });
});
