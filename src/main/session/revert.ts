/**
 * 会话回退 / 单轮撤销的主进程编排 —— 对话（readLog 折叠）、pi 本子（agent 进程
 * 裁枝）、文件（快照还原）三条线在这里汇成一个事务。
 *
 * 顺序是刻意的：**pi 本子先裁**（对账不过就地拒绝，一条文件都不动——宁可回退
 * 失败，不切错位置），文件后还原（单文件失败记 skipped，不砸整批），我们的
 * RevertRecord / UndoRecord 最后追加（它一落盘，界面读到的就是折叠后的新世界）。
 *
 * 回退不拦截用户手改过的文件（2026-11 用户裁决「直接撤回，不整七七八八的。
 * 但一定要提醒用户」）：确认框里的警示组由 planRevert / planUndo 提供。
 */
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readlink, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AgentCommand } from "../../shared/agent-ipc.ts";
import {
  isFileTurnRecord,
  latestAfters,
  planRestores,
  type FileTurnRecord,
  type RevertFileOutcome,
  type RevertPlan,
  type SnapshotRef,
  type UndoPlan,
} from "../../shared/revert.ts";
import { writeTextAtomic } from "../atomic-write.ts";
import { branchRoles, type SessionStore } from "./store.ts";

/** pi 本子编辑的最小面：host 的 editPiBook —— 测试注入假货，不拉起真 agent 进程。 */
export interface PiBookEditor {
  editPiBook(command: Extract<AgentCommand, { type: "revertPiBook" | "undoPiBook" }>): Promise<void>;
}

export interface RevertDeps {
  store: SessionStore;
  host: PiBookEditor;
}

/** 生效记录里的全部轮尾账（按发生顺序）。 */
export function fileTurnsIn(records: readonly unknown[]): FileTurnRecord[] {
  return records.filter(isFileTurnRecord);
}

/** 磁盘现状 → 可比较的形状：不在 = absent；读不了 / 非 utf8 / 带 NUL = null（无法比较）。 */
async function diskText(path: string): Promise<{ kind: "absent" } | { kind: "text"; content: string } | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    const bytes = await readFile(path);
    if (bytes.includes(0)) return null;
    // ignoreBOM：把开头的 U+FEFF 留在字符串里，与 file-tracker.toSnapshot 同一口径
    // （两边一边剥一边不剥的话，带 BOM 的文件会被误报「你改过」）。
    return { kind: "text", content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { kind: "absent" };
  }
}

/** 快照引用的正文（blob 读不出 = null；absent = ""——「agent 改完时文件不在」）。 */
async function snapshotText(store: SessionStore, id: string, ref: SnapshotRef): Promise<string | null> {
  if (ref.kind === "absent") return "";
  if (ref.kind !== "text") return null;
  return store.snapshots.read(id, ref.blob);
}

/**
 * 逐路径比对「磁盘现状 vs agent 改完时的样子」。
 * restores 决定还原目标（哪些路径、还原到什么）；afters 是比较基准（回退看被撤
 * 范围内最后一份，撤销还要算上之后的轮次）——两者分开传，撤销与回退的语义差异
 * 全在这一处。
 */
async function compareWithDisk(
  store: SessionStore,
  id: string,
  restores: Map<string, SnapshotRef>,
  afters: Map<string, SnapshotRef>,
): Promise<{ userModified: string[]; unrecoverable: string[]; alreadyThere: string[] }> {
  const userModified: string[] = [];
  const alreadyThere: string[] = [];
  const unrecoverable: string[] = [];
  for (const [path, before] of restores) {
    if (before.kind === "unrecoverable") {
      unrecoverable.push(path);
      continue;
    }
    const disk = await diskText(path);
    if (disk === null) continue; // 比不了（二进制 / 读不了）——不猜
    // 磁盘已经是还原目标（比如那一轮先被单独撤销过）：这次什么都不会丢，不算「你的修改」。
    // 不先判这一步的话，撤销过的新建文件在回退时被报成「你改过」（实机）
    const target = await snapshotText(store, id, before);
    if (target !== null && (disk.kind === "absent" ? before.kind === "absent" : disk.content === target && before.kind !== "absent")) {
      alreadyThere.push(path);
      continue;
    }
    const afterContent = await snapshotText(store, id, afters.get(path) ?? { kind: "absent" });
    if (afterContent === null) continue; // 快照缺——不猜
    const differs = disk.kind === "absent" ? afterContent !== "" : disk.content !== afterContent;
    if (differs) userModified.push(path);
  }
  return { userModified, unrecoverable, alreadyThere };
}

/** 还原 / 删除两张清单。已经是目标状态的路径（skip）不进清单——确认框不报「将删除」一个早就不在的文件。 */
function splitRestoreDeletes(
  restores: Map<string, SnapshotRef>,
  skip: readonly string[] = [],
): { restore: string[]; deletes: string[] } {
  const restore: string[] = [];
  const deletes: string[] = [];
  for (const [path, before] of restores) {
    if (skip.includes(path)) continue;
    if (before.kind === "absent") deletes.push(path);
    else restore.push(path);
  }
  return { restore, deletes };
}

/** 读生效列表；null = 会话不在。 */
async function loadTranscript(store: SessionStore, id: string) {
  const detail = await store.load(id);
  if (detail === null) throw new Error(`session ${id} not found`);
  return detail.transcript;
}

export async function planRevert(store: SessionStore, id: string, targetMessageId: string): Promise<RevertPlan> {
  const transcript = await loadTranscript(store, id);
  const index = transcript.findIndex(
    (record) => record.id === targetMessageId && record.role === "user",
  );
  if (index < 0) {
    throw new Error("The message to revert to is not in the conversation (it may already have been reverted)");
  }
  const turns = fileTurnsIn(transcript.slice(index));
  const restores = planRestores(turns);
  const { userModified, unrecoverable, alreadyThere } = await compareWithDisk(store, id, restores, latestAfters(turns));
  const { restore, deletes } = splitRestoreDeletes(restores, alreadyThere);
  return { restore, deletes, userModified, unrecoverable };
}

/**
 * 解析还原写入的真实目标 + 要补回的权限位。
 *
 * 两个坑都出在「临时文件 + rename」上，而 atomic-write 的通用语义不能动
 * （配置 / 会话元数据等大量消费），这层适配留在还原侧：
 * 1. 目标是符号链接时，rename 会把**链接本身**换成普通文件，链接指向的文件还原
 *    不了——pi 的 write / edit 跟随链接写目标文件，tracker 读盘也是跟随读，还原
 *    同样写到真实目标（悬空链接照此重建目标文件）；
 * 2. 临时文件是新建的，原文件的权限位（可执行位等）会丢——stat 先记下，写完补回。
 *    Windows 上 chmod 只作用于只读位，其余位被忽略、不抛错。
 */
async function resolveRestoreTarget(path: string): Promise<{ target: string; mode: number | null }> {
  let target = path;
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      // realpath 对悬空链接抛 ENOENT，改用 readlink + dirname 拼接
      const raw = await readlink(path);
      target = isAbsolute(raw) ? raw : resolve(dirname(path), raw);
    }
  } catch {
    // 链接读不出（路径不在等）：按原路径写，rename 不会碰到任何链接
  }
  let mode: number | null = null;
  try {
    const info = await stat(target);
    if (info.isFile()) mode = info.mode & 0o777;
  } catch {
    // 目标不在（新建路径）：没有权限位要补
  }
  return { target, mode };
}

/** 把一批 before 快照写回磁盘。单文件失败记 skipped，不砸整批。 */
async function restoreFiles(
  store: SessionStore,
  id: string,
  restores: Map<string, SnapshotRef>,
): Promise<RevertFileOutcome[]> {
  const outcomes: RevertFileOutcome[] = [];
  for (const [path, before] of restores) {
    try {
      if (before.kind === "unrecoverable") {
        outcomes.push({ path, outcome: "skipped" });
        continue;
      }
      if (before.kind === "absent") {
        await rm(path, { force: true });
        outcomes.push({ path, outcome: "deleted" });
        continue;
      }
      const content = await store.snapshots.read(id, before.blob);
      if (content === null) {
        outcomes.push({ path, outcome: "skipped" });
        continue;
      }
      const { target, mode } = await resolveRestoreTarget(path);
      await mkdir(dirname(target), { recursive: true });
      await writeTextAtomic(target, content);
      if (mode !== null) {
        // 权限位补回是尽力而为：内容已还原，mode 补不上不该把整条记成失败
        await chmod(target, mode).catch((cause: unknown) => {
          console.error("[revert] 补回文件权限位失败（内容已还原）", path, cause);
        });
      }
      outcomes.push({ path, outcome: "restored" });
    } catch (cause) {
      console.error("[revert] 还原一个文件失败，记 skipped", path, cause);
      outcomes.push({ path, outcome: "skipped" });
    }
  }
  return outcomes;
}

/** 执行回退：pi 本子裁枝 → 文件还原 → 落 RevertRecord。返回按路径的执行结果。 */
export async function executeRevert(
  deps: RevertDeps,
  id: string,
  targetMessageId: string,
): Promise<RevertFileOutcome[]> {
  const meta = await deps.store.readMeta(id);
  if (meta === null) throw new Error(`session ${id} not found`);
  if (meta.piSessionFile === null) {
    throw new Error("This task predates resumable sessions and can be read but not reverted");
  }
  const transcript = await loadTranscript(deps.store, id);
  const index = transcript.findIndex(
    (record) => record.id === targetMessageId && record.role === "user",
  );
  if (index < 0) {
    throw new Error("The message to revert to is not in the conversation (it may already have been reverted)");
  }
  const turns = fileTurnsIn(transcript.slice(index));
  // pi 先裁：对账不过就地抛，文件一条不动（宁可回退失败，不切错位置）
  await deps.host.editPiBook({
    type: "revertPiBook",
    sessionId: id,
    sourcePiSessionFile: meta.piSessionFile,
    cwd: meta.cwd,
    roles: branchRoles(transcript.slice(0, index)),
    targetMessageId,
  });
  const restores = planRestores(turns);
  const outcomes = await restoreFiles(deps.store, id, restores);
  await deps.store.record(id, {
    role: "revert",
    id: randomUUID(),
    targetMessageId,
    restored: outcomes,
    timestamp: Date.now(),
  });
  return outcomes;
}

/** 找单轮撤销的目标轮（生效列表里的 FileTurnRecord）；顺带给出它之后的轮次。 */
async function locateTurn(
  store: SessionStore,
  id: string,
  turnId: string,
): Promise<{ turn: FileTurnRecord; later: FileTurnRecord[] }> {
  const transcript = await loadTranscript(store, id);
  const turns = fileTurnsIn(transcript);
  const at = turns.findIndex((turn) => turn.id === turnId);
  if (at < 0) throw new Error("That round's file record is not in the conversation (it may have been reverted)");
  const turn = turns[at];
  if (turn === undefined) throw new Error("unreachable");
  return { turn, later: turns.slice(at + 1) };
}

export async function planUndo(store: SessionStore, id: string, turnId: string): Promise<UndoPlan> {
  const { turn, later } = await locateTurn(store, id, turnId);
  // 还原目标只看这一轮的 before；比较基准要算上之后的轮次（磁盘最后一次被 agent
  // 改成什么样，是这一轮 + 之后轮次的最后一份 after）
  const restores = planRestores([turn]);
  const { userModified, unrecoverable, alreadyThere } = await compareWithDisk(
    store,
    id,
    restores,
    latestAfters([...later, turn]),
  );
  const { restore, deletes } = splitRestoreDeletes(restores, alreadyThere);
  const laterPaths = new Set(later.flatMap((entry) => entry.changes.map((change) => change.path)));
  return {
    turnId,
    restore,
    deletes,
    userModified,
    laterTouched: turn.changes.map((change) => change.path).filter((path) => laterPaths.has(path)),
    unrecoverable,
  };
}

/** 撤销通知的正文（进 pi 上下文，模型由此知道那轮改动没了）。 */
export function undoNotice(turn: FileTurnRecord): string {
  const paths = turn.changes.map((change) => change.path).join(", ");
  return (
    "The user undid the agent's changes to the following files from an earlier round, " +
    `restoring them to their state before that round: ${paths}. ` +
    "Those changes are no longer on disk — do not assume they are still present."
  );
}

/** 执行单轮撤销：pi 本子追加告知 → 文件还原到该轮之前 → 落 UndoRecord。 */
export async function executeUndo(deps: RevertDeps, id: string, turnId: string): Promise<RevertFileOutcome[]> {
  const meta = await deps.store.readMeta(id);
  if (meta === null) throw new Error(`session ${id} not found`);
  if (meta.piSessionFile === null) {
    throw new Error("This task predates resumable sessions and can be read but not undone");
  }
  const { turn } = await locateTurn(deps.store, id, turnId);
  // pi 先落通知：失败就地抛，文件一条不动
  await deps.host.editPiBook({
    type: "undoPiBook",
    sessionId: id,
    sourcePiSessionFile: meta.piSessionFile,
    cwd: meta.cwd,
    notice: undoNotice(turn),
  });
  const restores = planRestores([turn]);
  const outcomes = await restoreFiles(deps.store, id, restores);
  await deps.store.record(id, {
    role: "undo",
    id: randomUUID(),
    turnId,
    restored: outcomes,
    timestamp: Date.now(),
  });
  return outcomes;
}
