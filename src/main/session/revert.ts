/**
 * 会话回退 / 单轮撤销的主进程编排 —— 对话（readLog 折叠）、pi 本子（agent 进程
 * 裁枝）、文件（快照还原）三条线在这里汇成一个事务。
 *
 * 回退的顺序是刻意的：**pi 本子先裁**（对账不过就地拒绝，一条文件都不动——宁可
 * 回退失败，不切错位置），文件后还原（单文件失败记 skipped 并把原因带回界面，不砸
 * 整批、不静默），我们的 RevertRecord / UndoRecord 最后追加（它一落盘，界面读到
 * 的就是折叠后的新世界）。
 *
 * 单轮撤销只有一处相反：pi 的告知**在还原之后**再写（见 executeUndo）。撤销通知是
 * 一句陈述，不是裁枝位置；它的文案必须带真实结果（哪几个文件没还原、为什么），
 * 而结果只有做完才知道。先写通知就只能写「已撤除」——模型以为盘上已经回去，
 * 实际被占用/快照丢失的文件原地不动（A5）。
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
    // unrecoverable 不进这两张清单：它是「还原不了」，不是「将恢复 / 将删除」——
    // 进了的话确认栏同一文件出两枚矛盾胶囊（恢复 + 无法还原），结论句还会把它数进
    // 「还原 N 个文件」（N 个里有一个根本还原不了）。它由 plan.unrecoverable 单独
    // 报告，compareWithDisk 保证三个清单不重叠。执行侧不走这里（restoreFiles 直接看
    // restores 全量、逐条记 skipped），所以这只影响计划展示，不影响行为。
    if (before.kind === "unrecoverable") continue;
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
/** 跟符号链接的跳数上限（与 Linux 的 MAXSYMLINKS 同量级），防链接成环 */
const MAX_LINK_HOPS = 40;

async function resolveRestoreTarget(path: string): Promise<{ target: string; mode: number | null }> {
  let target = path;
  // 链式链接（a → b → c）要一路跟到底：只跟一层会把中间的 b 换成普通文件、c 还原不到。
  // 设上限防环（a → b → a）：跟满还没到普通文件就按当前这一跳写，不死循环
  for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
    try {
      if (!(await lstat(target)).isSymbolicLink()) break;
      // realpath 对悬空链接抛 ENOENT，改用 readlink + dirname 拼接
      const raw = await readlink(target);
      target = isAbsolute(raw) ? raw : resolve(dirname(target), raw);
    } catch {
      // 不在（悬空链接的终点 / 新建路径）：就写这里，rename 不会碰到任何链接
      break;
    }
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

/** 写盘 / 快照失败的原因，给人看的一句话（带系统错误码，便于用户去搜）。 */
const LOCK_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

function failureReason(fallback: string, cause?: unknown): string {
  if (!(cause instanceof Error)) return fallback;
  const code = (cause as { code?: unknown }).code;
  if (typeof code !== "string") return cause.message === "" ? fallback : cause.message;
  if (LOCK_CODES.has(code)) return `文件被占用或没有写权限（${code}）`;
  if (code === "ENOSPC") return `磁盘空间不足（${code}）`;
  if (code === "ENOENT") return `路径已不存在（${code}）`;
  return `写盘失败（${code}）`;
}

/** 把一批 before 快照写回磁盘。单文件失败记 skipped，不砸整批——但原因必须带回去。 */
async function restoreFiles(
  store: SessionStore,
  id: string,
  restores: Map<string, SnapshotRef>,
): Promise<RevertFileOutcome[]> {
  const outcomes: RevertFileOutcome[] = [];
  for (const [path, before] of restores) {
    try {
      if (before.kind === "unrecoverable") {
        outcomes.push({ path, outcome: "skipped", reason: "没有快照（文件过大或不是文本）" });
        continue;
      }
      if (before.kind === "absent") {
        await rm(path, { force: true });
        outcomes.push({ path, outcome: "deleted" });
        continue;
      }
      const content = await store.snapshots.read(id, before.blob);
      if (content === null) {
        outcomes.push({ path, outcome: "skipped", reason: "快照内容已丢失" });
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
      // 失败不能静默：原因随结果回传（轮尾卡 / 回退卡上显示），日志留一份
      const reason = failureReason("写盘失败", cause);
      console.error("[revert] 还原一个文件失败，记 skipped：", path, reason, cause);
      outcomes.push({ path, outcome: "skipped", reason });
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

/**
 * 撤销通知的正文（进 pi 上下文，模型由此知道那轮改动没了）。
 *
 * 必须按**真实执行结果**写：部分文件没还原时不能只说「已撤除」，否则模型的上下文
 * 与磁盘相反——它会以为文件已回退、于是谎报完成或按错误的前提继续改（A5）。
 * 全成功时的文案与引入 outcomes 之前逐字一致（模型侧既有措辞不动）。
 */
export function undoNotice(turn: FileTurnRecord, outcomes: readonly RevertFileOutcome[]): string {
  const failed = outcomes.filter((entry) => entry.outcome === "skipped");
  const done = outcomes.filter((entry) => entry.outcome !== "skipped");
  if (failed.length === 0) {
    const paths = turn.changes.map((change) => change.path).join(", ");
    return (
      "The user undid the agent's changes to the following files from an earlier round, " +
      `restoring them to their state before that round: ${paths}. ` +
      "Those changes are no longer on disk — do not assume they are still present."
    );
  }
  const first = failed[0];
  const reason = first?.reason ?? "未知原因";
  const firstPath = first?.path ?? "";
  const failedPaths = failed.map((entry) => entry.path).join(", ");
  const failedPart =
    `另有 ${failed.length} 个文件未还原：${firstPath} —— ${reason}。` +
    "这些文件仍是 agent 改动后的内容，不要以为它们已经回退" +
    (failed.length > 1 ? `；未还原清单：${failedPaths}。` : "。");
  if (done.length === 0) {
    return `用户撤销了 agent 在更早一轮对这些文件的改动，但没有一个文件还原成功。${failedPart}`;
  }
  return (
    "The user undid the agent's changes to the following files from an earlier round, " +
    `restoring them to their state before that round: ${done.map((entry) => entry.path).join(", ")}. ` +
    "Those changes are no longer on disk — do not assume they are still present. " +
    failedPart
  );
}

/**
 * 执行单轮撤销：文件还原到该轮之前 → 落 UndoRecord → pi 本子追加告知。
 *
 * 与回退相反，pi 的告知放在还原之后：通知文案要写真实结果（失败文件与原因），
 * 而结果只有还原做完才知道（A5）。界面的撤销按钮在轮次进行中是禁用的，agent 侧
 * 「会话正在跑」仍是兜底；真落到那条兜底上时文件已经还原、UndoRecord 也已落盘，
 * 所以错误文案必须说清「盘上已经改了，只是没通知到模型」，不能让它读成「撤销失败」。
 */
export async function executeUndo(deps: RevertDeps, id: string, turnId: string): Promise<RevertFileOutcome[]> {
  const meta = await deps.store.readMeta(id);
  if (meta === null) throw new Error(`session ${id} not found`);
  if (meta.piSessionFile === null) {
    throw new Error("This task predates resumable sessions and can be read but not undone");
  }
  const { turn } = await locateTurn(deps.store, id, turnId);
  const restores = planRestores([turn]);
  const outcomes = await restoreFiles(deps.store, id, restores);
  // 账先落：文件已经按结果变了，界面必须如实显示（含失败原因）；通知书写不成也不改这个事实
  await deps.store.record(id, {
    role: "undo",
    id: randomUUID(),
    turnId,
    restored: outcomes,
    timestamp: Date.now(),
  });
  try {
    await deps.host.editPiBook({
      type: "undoPiBook",
      sessionId: id,
      sourcePiSessionFile: meta.piSessionFile,
      cwd: meta.cwd,
      notice: undoNotice(turn, outcomes),
    });
  } catch (cause) {
    console.error("[revert] 撤销已改盘并落账，但没能把告知写进 pi 本子：", id, turnId, cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Files were restored, but the agent was not told about the undo: ${detail}`);
  }
  return outcomes;
}
