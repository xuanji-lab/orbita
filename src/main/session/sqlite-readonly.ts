/**
 * 只读打开别家工具的 SQLite 会话库（OpenCode、ZCode）读一件事，读完就关。
 *
 * **源目录零写入**是硬要求，而 SQLite 的「只读」连接不能保证不碰 `<库>-shm`：库在 WAL 模式时，
 * `readOnly: true` 的连接要用 -shm 里的 wal-index。2026-11-14 把本机 opencode.db（连 -wal、-shm）
 * 克隆一份，在复制件上只读打开一次，复制件的 -shm 的 mtime 与内容都变了；同一天 origin/main 的
 * 导入扫描以同样方式打开本机真库，真库的 -shm 前后没有变化。原因没有查明（推断与 wal-index 是否
 * 需要恢复有关），-shm 不在时会怎样也没测。既然不能确定只读连接一定不碰 -shm，这里保守地分两路：
 *
 * - `<库>-wal` 不在或为空：库文件就是全部内容，以 `immutable=1` 打开——SQLite 不加锁、
 *   不碰 -wal / -shm，源目录一个字节都不动。
 * - `<库>-wal` 有内容：里面可能是还没并回库文件的新消息，`immutable=1` 会看不到（源应用
 *   正开着时最近一轮就在这里）。把库与 -wal 复制到 Orbita 自己的副本目录（APFS / Btrfs 上是
 *   写时复制的克隆，瞬时、不占空间；别的文件系统是整份复制），在副本上读，**读完即删**
 *   （含副本的 -wal / -shm，异常路径同样删）。副本里是别家工具的全部聊天记录，不能在
 *   Orbita 的目录里攒下来；进程异常退出留下的残留在下一次设置副本目录（启动）或下一次读取时清掉。
 *
 * 副本有体积上限 SNAPSHOT_MAX_BYTES：超了如实报「数据库太大」，不悄悄复制一个几 GB 的库。
 * 这个上限管的是磁盘上的临时副本；读进内存的量另由调用方按单条会话的字节预算卡。
 *
 * 复制不是原子快照：源应用恰好在复制的那一刻做检查点，副本可能比源旧一点或读出错，
 * 报错由调用方如实写出（不静默返回空）；再读一次即可。
 */
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { errorCode } from "../fs-errors.ts";

/** 临时副本（库 + -wal）的体积上限 */
export const SNAPSHOT_MAX_BYTES = 1024 * 1024 * 1024;

/** 副本目录里每次读取一个子目录，名字带这个前缀（清残留只删认得的） */
const SNAPSHOT_PREFIX = "read-";

let snapshotRoot = join(tmpdir(), "orbita-external-db-snapshots");

/** 一次读取里还在用的副本目录：清残留时跳过它们（并发的另一次读） */
const active = new Set<string>();

/** 清掉副本目录里不在用的残留（上次进程异常退出时没删掉的）。 */
async function sweep(): Promise<void> {
  let names: string[];
  try {
    names = await readdir(snapshotRoot);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name.startsWith(SNAPSHOT_PREFIX) && !active.has(join(snapshotRoot, name)))
      .map((name) => rm(join(snapshotRoot, name), { recursive: true, force: true }).catch(() => undefined)),
  );
}

/**
 * 主进程启动时设副本目录（Orbita 自己的数据目录下，不在源目录旁、不在任何工作区里），并清残留。
 * 不设（测试）时落在系统临时目录下。
 */
export async function setSnapshotRoot(dir: string): Promise<void> {
  snapshotRoot = dir;
  await sweep();
}

function immutableUri(file: string): string {
  return `${pathToFileURL(file).href}?immutable=1`;
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function readImmutable<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(immutableUri(file), { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** 读源库：按上面的两路选一个能读到最新内容、又不碰源目录的打开方式。 */
export async function withReadOnlyDb<T>(dbPath: string, read: (db: DatabaseSync) => T): Promise<T> {
  const mainSize = await sizeOf(dbPath);
  if (mainSize === null) throw new Error(`database not found: ${dbPath}`);
  const walSize = await sizeOf(`${dbPath}-wal`);
  if (walSize === null || walSize === 0) return readImmutable(dbPath, read);

  const total = mainSize + walSize;
  if (total > SNAPSHOT_MAX_BYTES) {
    throw new Error(
      `the database is too large to read for now (${megabytes(total)} with its write-ahead log; the limit is ${megabytes(SNAPSHOT_MAX_BYTES)}): ${dbPath}`,
    );
  }
  await mkdir(snapshotRoot, { recursive: true });
  await sweep();
  const dir = await mkdtemp(join(snapshotRoot, SNAPSHOT_PREFIX));
  active.add(dir);
  try {
    const file = join(dir, basename(dbPath));
    try {
      // FICLONE：能克隆就克隆（APFS / Btrfs），不能就退回普通复制
      await copyFile(dbPath, file, constants.COPYFILE_FICLONE);
      await copyFile(`${dbPath}-wal`, `${file}-wal`, constants.COPYFILE_FICLONE);
    } catch (cause) {
      if (errorCode(cause) === "ENOSPC") {
        throw new Error(
          `not enough free disk space for a temporary copy of the database (${megabytes(total)} needed in ${snapshotRoot}): ${dbPath}`,
        );
      }
      throw cause;
    }
    // 在副本上读写打开一次：SQLite 把 -wal 并进副本的库文件；之后与另一路一样按 immutable 读
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    return readImmutable(file, read);
  } finally {
    active.delete(dir);
    await rm(dir, { recursive: true, force: true });
  }
}
