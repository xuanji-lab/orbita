import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withReadOnlyDb } from "./sqlite-readonly.ts";

/** 源目录的文件清单 + 大小 + mtime：读前读后逐字相等才算零写入。 */
async function fingerprint(dir: string): Promise<string[]> {
  const names = (await readdir(dir)).sort();
  return Promise.all(
    names.map(async (name) => {
      const info = await stat(join(dir, name));
      return `${name}:${info.size}:${info.mtimeMs}`;
    }),
  );
}

const count = (db: DatabaseSync): number => Number(db.prepare("select count(*) as n from t").get()?.["n"]);

describe("withReadOnlyDb：别家的 SQLite 库只读，源目录零写入", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orbita-sqlite-ro-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("没有 -wal：immutable 打开，不新建 -wal / -shm，写操作被拒", async () => {
    const file = join(root, "db.sqlite");
    const db = new DatabaseSync(file);
    db.exec("create table t (x); insert into t values (1), (2);");
    db.close();
    const before = await fingerprint(root);
    assert.equal(await withReadOnlyDb(file, count), 2);
    await assert.rejects(withReadOnlyDb(file, (readonly) => readonly.exec("delete from t")), /readonly/i);
    assert.deepEqual(await fingerprint(root), before);
  });

  test("WAL 里有还没并回库文件的新行（源应用开着）：读得到，源目录（含 -wal / -shm）一个字节不动；源再写，再读看得到新内容", async () => {
    const file = join(root, "opencode.db");
    const writer = new DatabaseSync(file);
    writer.exec("pragma journal_mode = wal; pragma wal_autocheckpoint = 0; create table t (x); insert into t values (1);");
    writer.exec("insert into t values (2), (3);");
    // writer 不关：-wal / -shm 都在、新行只在 -wal 里，模拟源应用正开着
    assert.ok((await stat(`${file}-wal`)).size > 0);
    const before = await fingerprint(root);
    assert.equal(await withReadOnlyDb(file, count), 3);
    assert.equal(await withReadOnlyDb(file, count), 3, "缓存的副本复用");
    assert.deepEqual(await fingerprint(root), before);

    writer.exec("insert into t values (4);");
    assert.equal(await withReadOnlyDb(file, count), 4, "源变了换一份副本，不读陈旧内容");
    writer.close();
  });

  test("库不在：如实抛错，不当成空库", async () => {
    await assert.rejects(withReadOnlyDb(join(root, "missing.db"), count), /database not found/);
  });
});
