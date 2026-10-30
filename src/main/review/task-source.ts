/**
 * 审查面板的 task 来源 —— 「本任务改动」：基线 = 本任务**首次**改该文件前的快照
 * （含已撤回轮次——回退不抹掉「动过」的事实），对比 = 磁盘现状。不依赖 git：
 * 没有仓库的目录一样能用；回退 / 撤销之后基线与现状一致，条目标「已还原」。
 *
 * 读盘边界：白名单是本任务的文件账（账上没有的路径不给 diff）；账上的路径事后被换成符号链接时
 * 不跟过去读（lstat），只报它指向哪——账管「哪个路径」，管不到「这个路径现在指向谁」。
 *
 * 正文上限（REVIEW_DIFF_MAX_*）：超过上限的文件**不读、不比、不生成 patch**——列表标
 * 「行数未知」（lineCountUnknown），展开回「改动太大」。判的是改动的增删行数与字节，
 * 不是文件大小；文件超限但基线是文本且与现状一致，仍能判「已还原」。
 */
import { lstat, readFile, readlink } from "node:fs/promises";
import { createTwoFilesPatch, diffLines } from "diff";
import type { SessionRecord } from "../../shared/session.ts";
import { isFileTurnRecord, type SnapshotRef } from "../../shared/revert.ts";
import {
  reviewDiffError,
  reviewDiffOverflow,
  reviewDiffTooLarge,
  REVIEW_DIFF_MAX_BYTES,
  REVIEW_DIFF_MAX_LINES,
  type ReviewDiff,
  type ReviewEntry,
  type ReviewList,
} from "../../shared/review.ts";
import type { SessionStore } from "../session/store.ts";
import { sniffBinary } from "./untracked-lines.ts";

/** 判二进制看开头这么多字节：git 的 FIRST_FEW_BYTES 口径（同 untracked-lines） */
const BINARY_SNIFF_BYTES = 8000;

/**
 * 列表数行的时限（diff 包的 timeout 选项）：数不出来就标「行数未知」，别让一次刷新等它。
 * 实测（Apple M 系列）：20000 行 / 273 KB 改 10% 的合法计数要 ~0.9 s——超过 300 ms 的
 * 会如实标未知，下次刷新还有机会；整份重写的无界计算则被拦在这里（见 PATCH_DIFF_TIMEOUT_MS）。
 */
const LIST_COUNT_TIMEOUT_MS = 300;

/**
 * 正文路径的时限：用户点开才跑、一次性，给足空间（实测同上 ~1.8 s）；真正超 5000 行
 * 编辑距离的会在 ~1 秒内先被 maxEditLength 拦下，这里只兜「慢但合法」之外的异常情况。
 */
const PATCH_DIFF_TIMEOUT_MS = 10_000;

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

/**
 * 普通文件的字节数：不是普通文件 / stat 不到 = null（链接与「不在」交给 diskContent 细判）。
 * 超过正文上限的文件靠它在读盘前就拦下——数增删行要整读整比，大文件不值。
 */
async function diskFileSize(path: string): Promise<number | null> {
  try {
    const info = await lstat(path);
    return info.isFile() ? info.size : null;
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

function patchOf(path: string, oldText: string, newText: string): string | null {
  // maxEditLength：编辑距离超上限时 diff 包返回 undefined——不把 Myers 跑完再造一份必超限
  // 的 patch（实测 20000 行整份重写：无界 69 s，加上限 ~1 s 就 bail）。timeout 兜「慢但合法」
  // 之外的异常（上限内的合法 diff 实测 ~1.8 s，给到 10 s）。只造 patch：增删计数归
  // countLineChanges，这边不再顺带算一遍（以前算了没人用）。
  const diff = createTwoFilesPatch(`a/${path}`, `b/${path}`, oldText, newText, "", "", {
    context: 3,
    maxEditLength: REVIEW_DIFF_MAX_LINES,
    timeout: PATCH_DIFF_TIMEOUT_MS,
  });
  return typeof diff === "string" ? diff : null;
}

/** 一段文本有几行（最后一行没有换行也是一行；与 git numstat / untracked-lines 同口径） */
function lineCount(text: string): number {
  if (text === "") return 0;
  let lines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return text.charCodeAt(text.length - 1) !== 10 ? lines + 1 : lines;
}

/**
 * 直接数两个文本的增删行数（diff 包的 diffLines，行级分块）——**不生成 patch 字符串**。
 * 以前列表为了两个数字给每个文件造一份完整 diff 再数 +/- 行：大文件多攒一整份 patch，
 * 还会把 `++` 开头的内容行误当 patch 文件头少数（与 B1 修过的计数问题是同一类）。
 *
 * Myers 在主进程同步算，代价 O((N+M)×编辑距离)：实测 3000 行整份重写 ~1 s、10000 行 ~11 s
 * （结构审查 307 KB 实测 69 s），1 MB 的字节门槛拦不住。三道闸（便宜在前）：空边直接数、
 * 行数差超上限直接放弃、maxEditLength + timeout 让 diff 包 bail 返回 undefined → null。
 */
function countLineChanges(oldText: string, newText: string): { added: number; removed: number } | null {
  // 新建 / 清空的两边不必比：全部行就是增/删，行数直接数（几十万行的新文件也 O(n)）
  if (oldText === "") return { added: lineCount(newText), removed: 0 };
  if (newText === "") return { added: 0, removed: lineCount(oldText) };
  // 行数差是编辑距离的下界：差超上限必超，不进 Myers
  if (Math.abs(lineCount(oldText) - lineCount(newText)) > REVIEW_DIFF_MAX_LINES) return null;
  const parts = diffLines(oldText, newText, {
    maxEditLength: REVIEW_DIFF_MAX_LINES,
    timeout: LIST_COUNT_TIMEOUT_MS,
  });
  if (parts === undefined) return null;
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    if (part.added === true) added += lineCount(part.value);
    else if (part.removed === true) removed += lineCount(part.value);
  }
  return { added, removed };
}

/**
 * 正文路径的前置判定：两边行数差必超编辑上限，patchOf 不必进 Myers。
 * 空↔非空不算——那边增删就是行数，上限由生成后的 reviewDiffOverflow 把住。
 */
function editDistanceCertainlyOver(oldText: string, newText: string): boolean {
  if (oldText === "" || newText === "") return false;
  return Math.abs(lineCount(oldText) - lineCount(newText)) > REVIEW_DIFF_MAX_LINES;
}

/** `review:list` 的 task 侧实现。cwd 从 meta 读（路径策略在主进程，不信 renderer）。 */
export async function taskReviewList(store: SessionStore, sessionId: string): Promise<ReviewList> {
  const meta = await store.readMeta(sessionId);
  if (meta === null) return { kind: "error", message: `task ${sessionId} not found`, cwd: "" };
  const records = await store.readRawLog(sessionId);
  const entries: ReviewEntry[] = [];
  for (const [path, before] of baselines(records)) {
    // 先判大小再读：超过正文上限的文件数增删行要整读整比，跳过——行数标「未知」
    // （不是「没改动」，也不是「太大」：展开时正文侧会再说一次）。二进制照旧如实标出。
    const size = await diskFileSize(path);
    if (size !== null && size > REVIEW_DIFF_MAX_BYTES) {
      const binary = await sniffBinary(path);
      entries.push(
        binary === null
          ? { path, added: 0, removed: 0, binary: false, lineCountUnknown: true }
          : binary
            ? { path, added: 0, removed: 0, binary: false, noBaseline: true }
            : { path, added: 0, removed: 0, binary: false, lineCountUnknown: true },
      );
      continue;
    }
    const base = await baselineText(store, sessionId, before);
    // 基线太大同样跳过（罕见：agent 编辑过超大文件）。文本字符数是字节数的下界，够判
    if (base !== undefined && base.length > REVIEW_DIFF_MAX_BYTES) {
      entries.push({ path, added: 0, removed: 0, binary: false, lineCountUnknown: true });
      continue;
    }
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
      // 文件被删：删了多少行直接数基线，不必造一份全删的 patch
      entries.push({ path, added: 0, removed: lineCount(base), binary: false });
      continue;
    }
    if (disk === base) {
      // 基线与现状一致：列出来标「已还原」——面板要能说「这个文件已经回去了」
      entries.push({ path, added: 0, removed: 0, binary: false, restored: true });
      continue;
    }
    const changes = countLineChanges(base, disk);
    if (changes === null) {
      // 编辑距离超上限 / 超时：数不出来就标「行数未知」，不把 Myers 跑完
      entries.push({ path, added: 0, removed: 0, binary: false, lineCountUnknown: true });
      continue;
    }
    entries.push({ path, added: changes.added, removed: changes.removed, binary: false });
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
  // 先判大小再读：超限文件不整读，开头 8000 字节是二进制就如实报 binary，否则「改动太大」
  const size = await diskFileSize(path);
  if (size !== null && size > REVIEW_DIFF_MAX_BYTES) {
    const binary = await sniffBinary(path);
    if (binary === true) return { diff: null, binary: true, restored: false };
    return reviewDiffTooLarge("bytes", `${path} is larger than the inline diff limit`);
  }
  const base = await baselineText(store, sessionId, before);
  const disk = await diskContent(path);
  if (isDiskLink(disk)) return { diff: null, binary: false, restored: false, symlink: disk.symlink };
  if (base === undefined || disk === undefined) {
    return { diff: null, binary: true, restored: false };
  }
  if (disk === base || (disk === null && before.kind === "absent")) return { diff: null, binary: false, restored: true };
  // 基线太大且与现状不一致：出不了限内的正文，也不为它造一份超限的 patch
  if (base.length > REVIEW_DIFF_MAX_BYTES) {
    return reviewDiffTooLarge("bytes", `the baseline of ${path} exceeds the inline diff limit`);
  }
  if (disk === null) {
    if (editDistanceCertainlyOver(base, "")) {
      return reviewDiffTooLarge("lines", `the diff for ${path} exceeds the inline limits`);
    }
    const patch = patchOf(path, base, "");
    if (patch === null) {
      return reviewDiffTooLarge("lines", `the diff for ${path} exceeds the inline limits`);
    }
    const overflow = reviewDiffOverflow(patch);
    if (overflow !== null) {
      return reviewDiffTooLarge(overflow, `the diff for ${path} exceeds the inline limits`);
    }
    return { diff: patch, binary: false, restored: false };
  }
  if (editDistanceCertainlyOver(base, disk)) {
    return reviewDiffTooLarge("lines", `the diff for ${path} exceeds the inline limits`);
  }
  const patch = patchOf(path, base, disk);
  if (patch === null) {
    return reviewDiffTooLarge("lines", `the diff for ${path} exceeds the inline limits`);
  }
  const overflow = reviewDiffOverflow(patch);
  if (overflow !== null) {
    return reviewDiffTooLarge(overflow, `the diff for ${path} exceeds the inline limits`);
  }
  return { diff: patch, binary: false, restored: false };
}
