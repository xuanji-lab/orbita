/**
 * 常驻主智能体的档案存储：`<userData>/agents/main/<工作区 id>.json`，一个工作区一份，原子写。
 * 档案回答「这个工作区的主智能体是哪条会话」；会话本身是普通会话（meta 带 role: "main"）。
 *
 * 惰性：`ensure` 第一次被调（用户第一次点进这个工作区）才建档案，只预留一个会话 id；
 * 会话在第一句话发出时由开轮收尾（agent/ipc.ts settleFirstTurn）落盘并打上 role。
 * 不迁、不吞旧会话。
 */
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../atomic-write.ts";
import { MAIN_AGENT_RESUMES_KEPT, parseMainAgentProfile, type MainAgentProfile, type MainAgentResume } from "../../shared/main-agent.ts";
import type { SessionStore } from "../session/store.ts";

/** 工作区 id 进文件名：只放行 uuid 一类的字符，挡住 `../` 之类越出目录的 id（IPC 入参不可信） */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class MainAgentStore {
  readonly #dir: string;
  readonly #now: () => number;
  readonly #newId: () => string;
  /** 同一工作区的 ensure 串行：两次并发的「第一次点进来」不能各建一份、各预留一个 id */
  readonly #pending = new Map<string, Promise<MainAgentProfile>>();

  constructor(dir: string, options?: { now?: () => number; newId?: () => string }) {
    this.#dir = dir;
    this.#now = options?.now ?? Date.now;
    this.#newId = options?.newId ?? randomUUID;
  }

  #path(workspaceId: string): string {
    if (!SAFE_ID.test(workspaceId)) throw new Error(`工作区 id 不合法：${workspaceId}`);
    return join(this.#dir, `${workspaceId}.json`);
  }

  /** 读档案；没有 / 读坏了 = null（坏文件不抛：ensure 会重建一份，不让它把工作区堵死） */
  async read(workspaceId: string): Promise<MainAgentProfile | null> {
    const raw = await readFile(this.#path(workspaceId), "utf8").catch(() => null);
    if (raw === null) return null;
    try {
      const profile = parseMainAgentProfile(JSON.parse(raw));
      return profile !== null && profile.workspaceId === workspaceId ? profile : null;
    } catch {
      return null;
    }
  }

  /** 取档案，没有就建一份（预留会话 id）。同一工作区并发调用拿到同一份 */
  ensure(workspaceId: string): Promise<MainAgentProfile> {
    const inflight = this.#pending.get(workspaceId);
    if (inflight !== undefined) return inflight;
    const task = (async () => {
      const current = await this.read(workspaceId);
      if (current !== null) return current;
      const profile: MainAgentProfile = { workspaceId, sessionId: this.#newId(), createdAt: this.#now() };
      await writeJsonAtomic(this.#path(workspaceId), profile);
      return profile;
    })();
    this.#pending.set(workspaceId, task);
    return task.finally(() => this.#pending.delete(workspaceId));
  }

  /** 记一次「断过」（重开应用时由主进程调）；没有档案就不记（没进过的工作区不会有主智能体名下的活） */
  async addResume(workspaceId: string, resume: MainAgentResume): Promise<void> {
    const current = await this.read(workspaceId);
    if (current === null) return;
    const resumes = [...(current.resumes ?? []), resume].slice(-MAIN_AGENT_RESUMES_KEPT);
    await writeJsonAtomic(this.#path(workspaceId), { ...current, resumes });
  }

  /** 这条会话是不是这个工作区的主智能体（开轮装配身份提示词、首轮建 meta 打 role 用） */
  async isMain(sessionId: string, workspaceId: string | null): Promise<boolean> {
    if (workspaceId === null || !SAFE_ID.test(workspaceId)) return false;
    return (await this.read(workspaceId))?.sessionId === sessionId;
  }

  /**
   * 主智能体那条会话被用户删了：档案一起删，下次点进工作区重新预留一个新 id——
   * 不复用旧 id（旧 id 的库与工作台刚被清掉，复用会让残留的东西对不上号）。
   */
  async forget(workspaceId: string, sessionId: string): Promise<void> {
    if (!SAFE_ID.test(workspaceId)) return;
    if ((await this.read(workspaceId))?.sessionId !== sessionId) return;
    await rm(this.#path(workspaceId), { force: true });
  }
}

/**
 * 取（没有就建）某工作区的主智能体档案，并顺手校准 meta：档案是真源，会话已落盘却没带 role
 * （比如回滚到旧版本时说过话、旧版本重写过 meta）就补上。
 */
export async function mainAgentOf(store: MainAgentStore, sessions: Pick<SessionStore, "readMeta" | "setRole">, workspaceId: string): Promise<MainAgentProfile> {
  const profile = await store.ensure(workspaceId);
  const meta = await sessions.readMeta(profile.sessionId);
  if (meta !== null && meta.role !== "main") await sessions.setRole(profile.sessionId, "main");
  return profile;
}
