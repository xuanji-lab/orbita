import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setSnapshotRoot, SNAPSHOT_MAX_BYTES, withReadOnlyDb } from "./sqlite-readonly.ts";

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
  let source: string;
  let snapshots: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orbita-sqlite-ro-"));
    source = join(root, "source");
    snapshots = join(root, "snapshots");
    await mkdir(source);
    await setSnapshotRoot(snapshots);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("没有 -wal：immutable 打开，不新建 -wal / -shm，写操作被拒，不建副本", async () => {
    const file = join(source, "db.sqlite");
    const db = new DatabaseSync(file);
    db.exec("create table t (x); insert into t values (1), (2);");
    db.close();
    const before = await fingerprint(source);
    assert.equal(await withReadOnlyDb(file, count), 2);
    await assert.rejects(withReadOnlyDb(file, (readonly) => readonly.exec("delete from t")), /readonly/i);
    assert.deepEqual(await fingerprint(source), before);
    await assert.rejects(stat(snapshots));
  });

  test("WAL 里有还没并回库文件的新行（源应用开着）：读得到，源目录（含 -wal / -shm）一个字节不动；源再写，再读看得到新内容；副本读完即删", async () => {
    const file = join(source, "opencode.db");
    const writer = new DatabaseSync(file);
    writer.exec("pragma journal_mode = wal; pragma wal_autocheckpoint = 0; create table t (x); insert into t values (1);");
    writer.exec("insert into t values (2), (3);");
    // writer 不关：-wal / -shm 都在、新行只在 -wal 里，模拟源应用正开着
    assert.ok((await stat(`${file}-wal`)).size > 0);
    const before = await fingerprint(source);
    assert.equal(await withReadOnlyDb(file, count), 3);
    assert.deepEqual(await fingerprint(source), before);
    assert.deepEqual(await readdir(snapshots), [], "副本（含 -wal / -shm）读完即删");

    writer.exec("insert into t values (4);");
    assert.equal(await withReadOnlyDb(file, count), 4, "不读陈旧内容");
    // 读的过程中抛错：副本照样删
    await assert.rejects(
      withReadOnlyDb(file, () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.deepEqual(await readdir(snapshots), []);
    writer.close();
  });

  test("上次进程异常退出留下的副本：设副本目录（启动）时清掉，不认得的文件不动", async () => {
    await mkdir(join(snapshots, "read-leftover"), { recursive: true });
    await writeFile(join(snapshots, "read-leftover", "opencode.db"), "old chats");
    await writeFile(join(snapshots, "keep.txt"), "not ours");
    await setSnapshotRoot(snapshots);
    assert.deepEqual(await readdir(snapshots), ["keep.txt"]);
  });

  test("库加 -wal 超过副本上限：如实报太大与实际大小，不复制", async () => {
    const file = join(source, "huge.db");
    await writeFile(file, "");
    await truncate(file, SNAPSHOT_MAX_BYTES); // 稀疏文件，不占盘
    await writeFile(`${file}-wal`, "x");
    await assert.rejects(withReadOnlyDb(file, count), /too large to read for now \(1024 MB .*limit is 1024 MB/);
    await assert.rejects(stat(snapshots));
  });

  test("库不在：如实抛错，不当成空库", async () => {
    await assert.rejects(withReadOnlyDb(join(source, "missing.db"), count), /database not found/);
  });
});
