/**
 * 审查面板的 task 来源 —— 「本任务改动」：基线 = 本任务**首次**改该文件前的快照
 * （含已撤回轮次——回退不抹掉「动过」的事实），对比 = 磁盘现状。不依赖 git：
 * 没有仓库的目录一样能用；回退 / 撤销之后基线与现状一致，条目标「已还原」。
 *
 * 读盘边界：白名单是本任务的文件账（账上没有的路径不给 diff）；账上的路径事后被换成符号链接时
 * 不跟过去读（lstat），只报它指向哪——账管「哪个路径」，管不到「这个路径现在指向谁」。
 */
import { lstat, readFile, readlink } from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import type { SessionRecord } from "../../shared/session.ts";
import { isFileTurnRecord, type SnapshotRef } from "../../shared/revert.ts";
import { reviewDiffError, type ReviewDiff, type ReviewEntry, type ReviewList } from "../../shared/review.ts";
import type { SessionStore } from "../session/store.ts";

/** 账上的路径现在是个符号链接：只带链接里写的目标（readlink 原文），不读目标 */
interface DiskLink {
  symlink: string;
}

function isDiskLink(value: string | null | undefined | DiskLink): value is DiskLink {
  return typeof value === "object" && value !== null;
}

/**
 * 磁盘现状：不在 = null；读不了 / 非 utf8 / 带 NUL = undefined（比不了、也出不了 diff）；
 * 符号链接 = DiskLink。
 */
async function diskContent(path: string): Promise<string | null | undefined | DiskLink> {
  try {
    // lstat 不跟链接：跟过去的话，账上一个路径被换成指向根外的链接，「本任务改动」就成了
    // 读任意文件的后门（Windows 的 junction 在 Node 里同样是 isSymbolicLink）
    const info = await lstat(path);
    if (info.isSymbolicLink()) return { symlink: await readlink(path) };
    if (!info.isFile()) return undefined;
    const bytes = await readFile(path);
    if (bytes.includes(0)) return undefined;
    // ignoreBOM 与 file-tracker.toSnapshot / revert.diskText 同一口径（三处必须一起改）：
    // 默认会剥掉开头的 U+FEFF，而快照侧留着——BOM 文件会算出「首行改了」的幽灵 diff，
    // 字节级还原之后也永远判不成「已还原」（Windows 验收实机：VS 系 .cs / .ps1 大量带 BOM）
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** 全部轮尾账里每个路径最早的 before（含被回退折掉的轮次——那也是「动过」）。 */
function baselines(records: readonly SessionRecord[]): Map<string, SnapshotRef> {
  const byPath = new Map<string, SnapshotRef>();
  for (const record of records) {
    if (!isFileTurnRecord(record)) continue;
    for (const change of record.changes) {
      if (!byPath.has(change.path)) byPath.set(change.path, change.before);
    }
  }
  return byPath;
}

async function baselineText(
  store: SessionStore,
  sessionId: string,
  ref: SnapshotRef,
): Promise<string | undefined> {
  if (ref.kind === "absent") return "";
  if (ref.kind !== "text") return undefined;
  // blob 丢了 = 基线不可用（undefined）：列出来标「无基线」，不猜内容
  return (await store.snapshots.read(sessionId, ref.blob)) ?? undefined;
}

function patchOf(path: string, oldText: string, newText: string): { diff: string; added: number; removed: number } {
  const diff = createTwoFilesPatch(`a/${path}`, `b/${path}`, oldText, newText, "", "", { context: 3 });
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { diff, added, removed };
}

/** `review:list` 的 task 侧实现。cwd 从 meta 读（路径策略在主进程，不信 renderer）。 */
export async function taskReviewList(store: SessionStore, sessionId: string): Promise<ReviewList> {
  const meta = await store.readMeta(sessionId);
  if (meta === null) return { kind: "error", message: `task ${sessionId} not found`, cwd: "" };
  const records = await store.readRawLog(sessionId);
  const entries: ReviewEntry[] = [];
  for (const [path, before] of baselines(records)) {
    const base = await baselineText(store, sessionId, before);
    const disk = await diskContent(path);
    if (isDiskLink(disk)) {
      // 链接：不跟到目标读，行数不算目标的，只标出它指向哪
      entries.push({ path, added: 0, removed: 0, binary: false, symlink: disk.symlink });
      continue;
    }
    if (base === undefined || disk === undefined) {
      // 基线或现状是二进制 / 读不了：列出来（路径是真的动过），标无基线
      entries.push({ path, added: 0, removed: 0, binary: base === undefined && disk === undefined, noBaseline: true });
      continue;
    }
    if (disk === null) {
      // 任务里新建、后来又被回退 / 撤销删掉：净差为零，但要列出来标「已还原」——
      // 面板要能回答「那个文件呢？」（实机：撤销后面板一片空白，看不出发生过什么）
      if (before.kind === "absent") {
        entries.push({ path, added: 0, removed: 0, binary: false, restored: true });
        continue;
      }
      const patch = patchOf(path, base, "");
      entries.push({ path, added: 0, removed: patch.removed, binary: false });
      continue;
    }
    if (disk === base) {
      // 基线与现状一致：列出来标「已还原」——面板要能说「这个文件已经回去了」
      entries.push({ path, added: 0, removed: 0, binary: false, restored: true });
      continue;
    }
    const patch = patchOf(path, base, disk);
    entries.push({ path, added: patch.added, removed: patch.removed, binary: false });
  }
  if (entries.length === 0) return { kind: "empty", reason: "no-changes", cwd: meta.cwd };
  return { kind: "ok", cwd: meta.cwd, entries };
}

/** `review:diff` 的 task 侧实现。 */
export async function taskReviewDiff(
  store: SessionStore,
  sessionId: string,
  path: string,
): Promise<ReviewDiff> {
  const records = await store.readRawLog(sessionId);
  const before = baselines(records).get(path);
  if (before === undefined) {
    // 不在账上的路径不给 diff——review:diff 不能变成读任意文件的后门。拒绝要说清楚，
    // 以前回 { diff: null, binary: false }，面板显示成「二进制」
    return reviewDiffError("not-in-record", `${path} is not in this task's change record`);
  }
  const base = await baselineText(store, sessionId, before);
  const disk = await diskContent(path);
  if (isDiskLink(disk)) return { diff: null, binary: false, restored: false, symlink: disk.symlink };
  if (base === undefined || disk === undefined) {
    return { diff: null, binary: true, restored: false };
  }
  if (disk === base || (disk === null && before.kind === "absent")) return { diff: null, binary: false, restored: true };
  if (disk === null) {
    const patch = patchOf(path, base, "");
    return { diff: patch.diff, binary: false, restored: false };
  }
  const patch = patchOf(path, base, disk);
  return { diff: patch.diff, binary: false, restored: false };
}
