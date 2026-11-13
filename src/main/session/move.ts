/**
 * 会话迁移的主进程编排：把一批会话连同它们的子会话搬到另一个工作区，
 * **归属与 cwd 一起换**（只换归属的话，会话显示在新工作区下，agent 却还在旧目录干活）。
 *
 * 为什么 cwd 换得动：每轮开机都重开 pi 本子并显式传 cwd（runtime.ts openOrCreate →
 * `SessionManager.open(file, dir, cwd)`），本子头里记的旧 cwd 被覆盖；文件追踪与回退快照
 * 存的是绝对路径，搬走后回退旧轮仍还原到旧目录里那些文件——行为正确。
 *
 * 每一家（根 + 全部后代）：
 *   1. 有一个在跑 → 整家跳过（这一轮开机时已拿到旧 cwd，半搬会让母子目录不一致）
 *   2. 逐个：cwd 真的变了且有 pi 本子 → 先往本子追加「目录换了」的通知（进上下文，
 *      历史里的相对路径是对旧目录说的）；失败 → 这一家剩下的不动，记 failed
 *   3. 再写 meta（workspaceId + cwd）
 * 通知先于 meta：通知失败时 meta 还是旧的，两边一致；反过来模型会在新目录里按旧相对路径找文件。
 */
import type { AgentCommand } from "../../shared/agent-ipc.ts";
import type { SessionMeta, SessionMoveResult } from "../../shared/session.ts";
import type { Workspace } from "../../shared/workspace.ts";

export interface MoveDeps {
  sessions: {
    list(): Promise<SessionMeta[]>;
    relocate(id: string, workspaceId: string | null, cwd: string): Promise<void>;
  };
  workspaces: { list(): Promise<Workspace[]>; defaultPath(): string };
  host: { editPiBook(command: Extract<AgentCommand, { type: "movePiBook" }>): Promise<void> };
  /** 此刻在跑（phase 不是 idle）——主进程按 phase 事件维护的那张表 */
  isRunning(id: string): boolean;
}

/** 告诉模型目录换了的那句通知（进 pi 上下文）。 */
export function moveNotice(from: string, to: string): string {
  return (
    `The user moved this task to another folder: the working directory changed from ${from} to ${to}. ` +
    `Relative paths mentioned earlier in this conversation were relative to ${from}; files created or ` +
    `edited before the move are still at their old absolute paths. Work in ${to} from now on unless the ` +
    "user says otherwise."
  );
}

/** 一条根会话及其全部后代（parentId 链，多层也收），根在最前。 */
export function familyOf(rootId: string, all: readonly SessionMeta[]): SessionMeta[] {
  const byId = new Map(all.map((meta) => [meta.id, meta]));
  const root = byId.get(rootId);
  if (root === undefined) return [];
  const family = [root];
  const seen = new Set([rootId]);
  for (let index = 0; index < family.length; index += 1) {
    const parent = family[index]!;
    for (const meta of all) {
      if (meta.parentId === parent.id && !seen.has(meta.id)) {
        seen.add(meta.id);
        family.push(meta);
      }
    }
  }
  return family;
}

export async function moveSessions(
  deps: MoveDeps,
  ids: readonly string[],
  workspaceId: string | null,
): Promise<SessionMoveResult> {
  // 目标目录由主进程查：renderer 只给工作区 id，不给路径
  let cwd: string;
  if (workspaceId === null) {
    cwd = deps.workspaces.defaultPath();
  } else {
    const target = (await deps.workspaces.list()).find((w) => w.id === workspaceId);
    if (target === undefined) throw new Error(`工作区不存在：${workspaceId}`);
    cwd = target.path;
  }

  const all = await deps.sessions.list();
  const result: SessionMoveResult = { moved: [], skipped: [] };
  const handled = new Set<string>();
  for (const id of ids) {
    // 同一批里既选了母会话又选了它的子会话：子会话已随家搬过，不重复
    if (handled.has(id)) continue;
    const family = familyOf(id, all);
    if (family.length === 0) {
      result.skipped.push({ id, reason: "missing" });
      continue;
    }
    for (const meta of family) handled.add(meta.id);
    if (family.some((meta) => deps.isRunning(meta.id))) {
      result.skipped.push({ id, reason: "running" });
      continue;
    }
    try {
      for (const meta of family) {
        if (meta.cwd !== cwd && meta.piSessionFile !== null) {
          await deps.host.editPiBook({
            type: "movePiBook",
            sessionId: meta.id,
            sourcePiSessionFile: meta.piSessionFile,
            cwd,
            notice: moveNotice(meta.cwd, cwd),
          });
        }
        await deps.sessions.relocate(meta.id, workspaceId, cwd);
        result.moved.push(meta.id);
      }
    } catch (cause) {
      console.error(`[session] 迁移 ${id} 失败`, cause);
      result.skipped.push({ id, reason: "failed" });
    }
  }
  return result;
}
