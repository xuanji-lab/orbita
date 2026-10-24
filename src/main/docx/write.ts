/**
 * `docx:save` 的实做（契约在 `shared/docx.ts`）。**纯模块**：不 import electron，
 * `node --test` 直接加载。三条纪律，都是文件域已有的：
 *
 * 1. **hash 冲突检测**：打开（或上次保存）时记下的 sha256 与磁盘现状不一致就拒绝写入，
 *    回 `conflict` —— 文档在外部被改过（另一台设备同步、Word 里改了没关、agent 自己
 *    写了它），覆盖会让那些改动无声消失。一个字节都不写。
 * 2. **原子写**：临时文件 + rename（`atomic-write.ts`）。半截 docx 比没有 docx 难查得多。
 * 3. **同路径串行**：自动保存与 Ctrl+S 可能同时在途，两条 rename 交叉会让后写的输掉。
 *    按 realpath 排一条队列，后来的等前一个写完再判 hash。
 *
 * 备份：每次覆盖前把**磁盘上的上一版**原样复制进应用数据目录（`docx-backups/`），
 * 每个文件一个子目录、保留最近 keepBackups 份。它不进工作区——工作区是用户的，
 * 多出来的备份文件会出现在文件面板与 git 状态里。
 */
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DOCX_MAX_BYTES, type DocxSaveResult } from "../../shared/docx.ts";
import { writeBytesAtomic } from "../atomic-write.ts";
import { sha256Hex } from "./read.ts";

export interface DocxSaveOptions {
  path: string;
  expectedHash: string;
  data: Uint8Array;
  /** 应用数据目录下的备份根（`<userData>/docx-backups`）；不给就不备份 */
  backupDir?: string;
  /** 每个文件保留几份上一版；默认 5 */
  keepBackups?: number;
  /** 测试注入 */
  now?: () => number;
}

const DEFAULT_KEEP_BACKUPS = 5;

/** 同路径串行：路径 → 队尾 Promise。结算后清掉，Map 不会随保存次数长大 */
const pathQueues = new Map<string, Promise<unknown>>();

function withPathLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = pathQueues.get(path) ?? Promise.resolve();
  // 前一条失败不能拦住后一条：两个分支都接 task
  const next = previous.then(task, task);
  const tail = next.catch(() => undefined);
  pathQueues.set(path, tail);
  void tail.then(() => {
    if (pathQueues.get(path) === tail) pathQueues.delete(path);
  });
  return next;
}

/** 备份目录按路径分（同一目录下两个同名 docx 不会互相覆盖），名字带时间戳排序即新旧 */
function backupDirFor(root: string, path: string): string {
  return join(root, sha256Hex(new TextEncoder().encode(path.toLowerCase())).slice(0, 12));
}

async function writeBackup(
  path: string,
  bytes: Uint8Array,
  root: string,
  keep: number,
  now: () => number,
): Promise<string> {
  const dir = backupDirFor(root, path);
  await mkdir(dir, { recursive: true });
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
  const target = join(dir, `${stamp}-${basename(path)}`);
  await writeFile(target, bytes);
  const files = (await readdir(dir)).sort();
  const excess = files.length - keep;
  for (const old of excess > 0 ? files.slice(0, excess) : []) {
    await unlink(join(dir, old)).catch(() => undefined);
  }
  return target;
}

/**
 * 把 `data` 写回 `path`，前提是磁盘现状仍是 `expectedHash`。
 * 冲突是值不是异常（changing hands 的正常情形）；真正的 IO 故障才抛。
 */
export async function saveDocxFile(options: DocxSaveOptions): Promise<DocxSaveResult> {
  const { path, expectedHash, data } = options;
  const keep = options.keepBackups ?? DEFAULT_KEEP_BACKUPS;
  const now = options.now ?? Date.now;
  if (data.byteLength > DOCX_MAX_BYTES) {
    throw new Error(`Refusing to write a ${data.byteLength}-byte docx (limit ${DOCX_MAX_BYTES})`);
  }

  return withPathLock(path, async (): Promise<DocxSaveResult> => {
    let current: Buffer | null = null;
    let currentStat = null;
    try {
      current = await readFile(path);
      currentStat = await stat(path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      // 文件在外部被删：不悄悄重建——用户以为自己在编辑一份「还在」的文档
      return { kind: "conflict", reason: "missing", modifiedAt: null };
    }
    if (sha256Hex(current) !== expectedHash) {
      return { kind: "conflict", reason: "changed", modifiedAt: currentStat.mtimeMs };
    }

    let backupPath: string | null = null;
    if (options.backupDir !== undefined) {
      backupPath = await writeBackup(path, current, options.backupDir, keep, now);
    }

    await writeBytesAtomic(path, data);
    const written = await stat(path);
    return {
      kind: "saved",
      size: written.size,
      modifiedAt: written.mtimeMs,
      hash: sha256Hex(data),
      backupPath,
    };
  });
}
