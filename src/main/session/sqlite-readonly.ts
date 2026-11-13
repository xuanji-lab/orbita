/**
 * 只读打开别家工具的 SQLite 会话库（OpenCode、ZCode）读一件事，读完就关。
 *
 * **源目录零写入**是硬要求，而 SQLite 的「只读」连接并不只读：库在 WAL 模式时，
 * `readOnly: true` 的连接照样会映射并改写 `<库>-shm`（wal-index 共享内存，2026-11-14 本机
 * 拿 opencode.db 的副本实测：只读打开一次，-shm 的 mtime 就变了），`-shm` 不在时还要新建它。
 * 所以分两路：
 *
 * - `<库>-wal` 不在或为空：库文件就是全部内容，以 `immutable=1` 打开——SQLite 不加锁、
 *   不碰 -wal / -shm，源目录一个字节都不动。
 * - `<库>-wal` 有内容：里面可能是还没并回库文件的新消息，`immutable=1` 会看不到（源应用
 *   正开着时最近一轮就在这里）。把库与 -wal 复制到 orbita 自己的临时目录（APFS / Btrfs 上
 *   是写时复制的克隆，瞬时、不占空间；别的文件系统是整份复制），在副本上打开。副本按
 *   「库与 -wal 的大小 + mtime」缓存：源没变就复用，变了就换一份——再读一定是新内容。
 *
 * 复制不是原子快照：源应用恰好在复制的那一刻做检查点，副本可能比源旧一点或读出错，
 * 报错由调用方如实写出（不静默返回空）；再读一次即可。
 */
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

interface Snapshot {
  signature: string;
  file: string;
  dir: string;
}

/**
 * 库路径 → 当前副本（存 Promise：两次读同时到达时共用同一次复制，不各复制一份、互删对方的）。
 * 进程内缓存，进程退出后临时目录由系统回收。
 */
const snapshots = new Map<string, { signature: string; ready: Promise<Snapshot> }>();
let snapshotRoot: Promise<string> | null = null;

function immutableUri(file: string): string {
  return `${pathToFileURL(file).href}?immutable=1`;
}

async function sizeAndTime(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(path);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

async function freshSnapshot(dbPath: string, signature: string): Promise<Snapshot> {
  snapshotRoot ??= mkdir(tmpdir(), { recursive: true }).then(() => mkdtemp(join(tmpdir(), "orbita-external-db-")));
  const dir = await mkdtemp(join(await snapshotRoot, "s-"));
  const file = join(dir, basename(dbPath));
  // FICLONE：能克隆就克隆，不能就退回普通复制
  await copyFile(dbPath, file, constants.COPYFILE_FICLONE);
  await copyFile(`${dbPath}-wal`, `${file}-wal`, constants.COPYFILE_FICLONE);
  // 在副本上读写打开一次：SQLite 把 -wal 并进副本的库文件，之后按 immutable 读
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  await rm(`${file}-wal`, { force: true });
  await rm(`${file}-shm`, { force: true });
  return { signature, file, dir };
}

/** 读源库：按上面的两路选一个能读到最新内容、又不碰源目录的打开方式。 */
export async function withReadOnlyDb<T>(dbPath: string, read: (db: DatabaseSync) => T): Promise<T> {
  const main = await sizeAndTime(dbPath);
  if (main === null) throw new Error(`database not found: ${dbPath}`);
  const wal = await sizeAndTime(`${dbPath}-wal`);
  let file = dbPath;
  if (wal !== null && wal.size > 0) {
    const signature = `${main.size}:${main.mtimeMs}:${wal.size}:${wal.mtimeMs}`;
    let current = snapshots.get(dbPath);
    if (current === undefined || current.signature !== signature) {
      const previous = current;
      const ready = freshSnapshot(dbPath, signature);
      current = { signature, ready };
      snapshots.set(dbPath, current);
      // 失败的复制不留在缓存里：下一次读重新复制
      ready.catch(() => {
        if (snapshots.get(dbPath)?.ready === ready) snapshots.delete(dbPath);
      });
      // 旧副本可能正被另一次读打开着：留到它自然过期（临时目录），这里只删能删的
      if (previous !== undefined) void previous.ready.then((old) => rm(old.dir, { recursive: true, force: true })).catch(() => undefined);
    }
    file = (await current.ready).file;
  }
  const db = new DatabaseSync(immutableUri(file), { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}
