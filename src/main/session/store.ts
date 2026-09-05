/**
 * 会话落盘 —— 每条会话两个文件（设计与被否决的方案见
 * `docs/plans/2026-08-25-会话存储与命名工作区.md`）：
 *
 *   sessions/<id>.meta.json   可变（标题 / updatedAt / 权限档），原子写
 *   sessions/<id>.jsonl       只追加，一行一个 SessionRecord
 *
 * 分两个文件的理由：meta 会变而 transcript 只增。把可变记录塞进只追加的日志里，
 * 要么改个标题就重写全文，要么读取时全文扫描找最后一条 meta。分开之后
 * **列会话只需读 N 个小 meta 文件，完全不碰日志**。
 */
import { appendFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { writeJsonAtomic, writeTextAtomic } from "../atomic-write.ts";
import { isNotFound } from "../fs-errors.ts";
import type { AgentStats } from "../../shared/agent-ipc.ts";
import type { PermissionMode } from "../../shared/permission.ts";
import {
  deriveSessionTitle,
  isCompactedRecord,
  parseSessionMeta,
  pushRecentQuery,
  recentQueriesFromRecords,
  sortSessions,
  type SessionDetail,
  type SessionMeta,
  type SessionRecord,
} from "../../shared/session.ts";

/**
 * 会话 id 必须长得像 `randomUUID()`。
 *
 * **这是安全检查，不是洁癖**：id 从 renderer 经 IPC 传进来，直接拼进路径的话，
 * 一个 `../../` 就能读写 sessions 目录之外的文件。白名单比转义可靠。
 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const META_SUFFIX = ".meta.json";

/**
 * 一次分支的全部预制件（C-2）。prepareBranch 只读不写；pi 那边把分支文件落了
 * （agent 进程的 createBranchedSession），才由 commitBranch 落盘——顺序保证中途
 * 失败最多留下一个孤儿 pi 文件，而不是一条「看得见历史但 pi 没有前文」的半残会话。
 */
export interface BranchPlan {
  /** 新会话 id（新 meta 与新 JSONL 都用它） */
  newId: string;
  /** 源会话的 pi 本子——agent 进程要打开它裁分支 */
  sourcePiSessionFile: string;
  /** 前缀记录（含锚点回答）：新会话的初始 transcript */
  records: SessionRecord[];
  /** 前缀的 user/assistant 角色序列，发去 agent 进程与 pi 文件逐位对账 */
  roles: ("user" | "assistant")[];
  /** 新会话 meta（piSessionFile 空着占位，commitBranch 补真值） */
  meta: SessionMeta;
}

/**
 * 前缀的 user/assistant 角色序列——与 pi 文件里的消息条目按位对账用（两本账没有
 * id 映射，顺序是唯一桥梁）。跳过「status=error 且内容为空」的 assistant 记录：
 * pi 不把这种失败尾巴落进它的本子（2026-09-01 对 72 条真实会话实测的唯一系统性
 * 落账差异），带上它对账必炸。其余罕见漂移由 agent 进程的对账守卫兜底——
 * 拒绝分支优于切错位置。
 */
export function branchRoles(records: readonly SessionRecord[]): ("user" | "assistant")[] {
  const roles: ("user" | "assistant")[] = [];
  for (const record of records) {
    if (record.role !== "user" && record.role !== "assistant") continue;
    if (record.role === "assistant" && record.status === "error" && record.content.length === 0) {
      continue;
    }
    roles.push(record.role);
  }
  return roles;
}

export class SessionStore {
  private readonly dir: string;

  /**
   * 每条会话的 meta 写入链（见 `queueMeta`）。会话删掉时清掉自己那条，
   * 不然长会话跑一天下来这里会攒下一堆已经没人要的 promise。
   */
  private readonly metaWrites = new Map<string, Promise<unknown>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  private metaPath(id: string): string {
    if (!SESSION_ID.test(id)) throw new Error(`invalid session id "${id}"`);
    return join(this.dir, `${id}${META_SUFFIX}`);
  }

  private logPath(id: string): string {
    if (!SESSION_ID.test(id)) throw new Error(`invalid session id "${id}"`);
    return join(this.dir, `${id}.jsonl`);
  }

  /** 建会话即落一条 meta：标题空着，等第一条用户消息填。 */
  async create(meta: SessionMeta): Promise<void> {
    await writeJsonAtomic(this.metaPath(meta.id), meta);
  }

  /**
   * 记一条 transcript 记录。**只在终态调用**——哪些帧算终态、abort 怎么算，
   * 全部由 `recorder.ts` 决定，这里只管写。
   */
  async record(id: string, item: SessionRecord): Promise<void> {
    const meta = await this.readMeta(id);
    if (meta === null) return; // 会话的 meta 没了就别再往日志里加，避免长出孤儿日志
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.logPath(id), `${JSON.stringify(item)}\n`, "utf8");

    // **基于链内刚读的 meta 算**，不用上面 appendFile 之前那份快照——
    // 写盘期间标题可能刚落、最近提问可能刚被别的消息推过
    await this.update(id, (current) => {
      const changes: Partial<SessionMeta> = { updatedAt: item.timestamp };
      // 标题只认第一条用户消息，之后不再改——否则会话会在侧栏里改名。
      // 手动改过名的会话 title 不为空，因此这条守卫自动让位给它。
      if (current.title === "" && item.role === "user") {
        const text = item.content.find((block) => block.type === "text");
        if (text !== undefined && text.type === "text") {
          changes.title = deriveSessionTitle(text.text);
        }
      }
      // 最近提问每条用户消息都记（首页会话卡的三槽吃它）；规则在 shared，两边一致
      if (item.role === "user") {
        const text = item.content.find((block) => block.type === "text");
        if (text !== undefined && text.type === "text") {
          changes.recentQueries = pushRecentQuery(current.recentQueries, text.text);
        }
      }
      return changes;
    });
  }

  /**
   * 改名。**改成空名字就退回推导**——侧栏里一行看不见的东西比一个坏名字更糟，
   * 用户会以为会话丢了（工作区改名走的是同一条规矩：空名退回路径末段）。
   * **任何显式改名（含改空）都记成 `user`**：auto-title 永不覆盖用户起的名字，
   * 连「用户清掉的名字」也不该在几条消息后自己长回来——那会被当成改名丢失。
   */
  async rename(id: string, title: string): Promise<void> {
    const wanted = deriveSessionTitle(title);
    const next = wanted !== "" ? wanted : derivedFrom(await this.readLog(id));
    await this.update(id, { title: next, titleSource: "user" });
  }

  /** 还需要自动生成标题吗（C-3 的发送门禁）。用户改过名 / 已生成过就不再试。 */
  async needsAutoTitle(id: string): Promise<boolean> {
    const meta = await this.readMeta(id);
    return meta !== null && meta.titleSource === "derived";
  }

  /**
   * 落一个模型生成的标题。**写入时再查一次 titleSource**——生成在途的几秒里
   * 用户可能刚改过名，读时是 derived 不算数，写前是 derived 才算。核验不过
   * （meta 没了 / 已 user / 已 auto）就整份丢弃：迟到的标题不该吵醒任何东西。
   */
  setAutoTitle(id: string, title: string): Promise<void> {
    const next = deriveSessionTitle(title);
    if (next === "") return Promise.resolve();
    // **这一次查必须和写在同一条写入链里**（见 `queueMeta`）：分开的话，读到的
    // derived 到写回之前可能已被别的写入改过，那句「写前再查」就是假的。
    return this.update(id, (meta) =>
      meta.titleSource === "derived" ? { title: next, titleSource: "auto" } : null,
    );
  }

  /**
   * 落一份用量快照（A1-Q1）。**只在 agent 带 `persist` 的那几帧调**——
   * 界面跟着每条消息走，磁盘只需要「上一次跑完时的样子」。
   */
  setStats(id: string, stats: AgentStats): Promise<void> {
    return this.update(id, { stats });
  }

  /**
   * 改 meta 上的字段。**六处「读 → 改一个字段 → 原子写回」收成这一个**——
   * meta 不在就悄悄不做：会话可能刚被别处删掉，为此抛错没有意义。
   */
  private update(
    id: string,
    changes: Partial<SessionMeta> | ((meta: SessionMeta) => Partial<SessionMeta> | null),
  ): Promise<void> {
    return this.queueMeta(id, async () => {
      const meta = await this.readMeta(id);
      if (meta === null) return;
      const patch = typeof changes === "function" ? changes(meta) : changes;
      if (patch === null) return;
      await writeJsonAtomic(this.metaPath(id), { ...meta, ...patch });
    });
  }

  /**
   * 每条会话一条 meta 写入链。
   *
   * **原子写只保证单次写不撕裂，不保证两次「读-改-写」不互相覆盖。**
   * 真事故（wafo 2026-09-03 实测）：标题生成是一次 LLM 调用，要跑几秒；这几秒里
   * `record`（每条消息都调）与 `setStats`（每轮落定）已经各自读过 meta。标题写回
   * `titleSource: "auto"` 之后，它们手里那份旧快照一落盘就把它冲回 `derived`——
   * 于是下一条消息又生成一次标题，用户看到的是「已经命名好的会话又被重命名」。
   *
   * 这个竞态本来就在（record / setModel / setPiSessionFile 之间），只是都是低频事件、
   * 撞不上；A-1 加的 `setStats` 是高频的，把潜伏的变成了必现的。
   *
   * 链上某一环失败不该卡死后续写入，所以存回去的是吃掉异常的那一支；
   * 调用方拿到的仍是真实结果。
   */
  private queueMeta<T>(id: string, run: () => Promise<T>): Promise<T> {
    const prev = this.metaWrites.get(id) ?? Promise.resolve();
    const next = prev.then(run, run);
    this.metaWrites.set(
      id,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** 记住 pi 这一次用的那份 session 文件——没有它，这条会话下次就只能读不能续 */
  setPiSessionFile(id: string, piSessionFile: string | null): Promise<void> {
    return this.update(id, { piSessionFile });
  }

  setMode(id: string, mode: PermissionMode): Promise<void> {
    return this.update(id, { mode });
  }

  /** 会话内切换模型（C-4）成功后落 meta——重开播种、分支继承、resume 对齐全读它 */
  setModel(id: string, providerId: string, modelId: string): Promise<void> {
    return this.update(id, { providerId, modelId });
  }

  setPinned(id: string, pinned: boolean): Promise<void> {
    return this.update(id, { pinned });
  }

  /** 归档：从主列表移走，收进侧栏底部的 Archived。**不是删除**，随时能拿回来 */
  setArchived(id: string, archived: boolean): Promise<void> {
    return this.update(id, { archived });
  }

  /** 换归属工作区；null = 移出所有工作区，回到 TASKS */
  move(id: string, workspaceId: string | null): Promise<void> {
    return this.update(id, { workspaceId });
  }

  /**
   * 准备一次分支（C-2）：定位锚点、截前缀、抽角色序列、起好新 meta。
   * 锚点必须是 assistant 记录（界面只在轮末 agent 回答下给入口，这里是信任边界
   * 的再校验）。**只读不写**，落盘在 commitBranch。
   */
  async prepareBranch(id: string, anchorItemId: string): Promise<BranchPlan> {
    const meta = await this.readMeta(id);
    if (meta === null) throw new Error(`session ${id} not found`);
    if (meta.piSessionFile === null) {
      throw new Error("This task predates resumable sessions and can be read but not continued or branched");
    }
    const records = await this.readLog(id);
    const anchorIndex = records.findIndex(
      (record) => record.role !== "compacted" && record.id === anchorItemId,
    );
    const anchor = records[anchorIndex];
    if (anchor === undefined) throw new Error(`Branch anchor message not found: ${anchorItemId}`);
    if (anchor.role !== "assistant") throw new Error("Branch anchor must be an agent reply");

    const prefix = records.slice(0, anchorIndex + 1);
    const newId = randomUUID();
    const now = Date.now();
    return {
      newId,
      sourcePiSessionFile: meta.piSessionFile,
      records: prefix,
      roles: branchRoles(prefix),
      // 标题沿用原标题加后缀（截断规则复用 deriveSessionTitle）；不置顶、
      // 不继承归档——分支的目的就是去那边继续说话
      meta: {
        id: newId,
        title: deriveSessionTitle(`${meta.title} (branch)`),
        titleSource: "derived",
        cwd: meta.cwd,
        workspaceId: meta.workspaceId,
        providerId: meta.providerId,
        modelId: meta.modelId,
        mode: meta.mode,
        piSessionFile: null,
        pinned: false,
        archived: false,
        // 分支的新会话带着前缀里的最近提问——它的历史是真的，卡片不该显示空槽
        recentQueries: recentQueriesFromRecords(prefix),
        // 分支的新会话不继承用量：pi 那本是裁过的，累计值对不上，等它自己跑一轮
        stats: null,
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  /** 分支落盘：新 meta（补上 pi 分支文件）+ 前缀整写为初始 JSONL（原子写）。 */
  async commitBranch(plan: BranchPlan, piSessionFile: string | null): Promise<void> {
    if (piSessionFile === null) throw new Error("pi produced no branch session file; branch was not persisted");
    await writeJsonAtomic(this.metaPath(plan.meta.id), { ...plan.meta, piSessionFile });
    if (plan.records.length > 0) {
      await writeTextAtomic(
        this.logPath(plan.meta.id),
        `${plan.records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      );
    }
  }

  /** 会话列表：置顶在前，其余最近的在前。**坏掉的 meta 直接跳过**，不让一条坏记录挡住整张列表。 */
  async list(): Promise<SessionMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (cause) {
      // 目录还不存在 = 一条会话都没有；**读不了 ≠ 没有**——权限、ENOTDIR 等照抛，
      // 吞成空列表会让用户以为会话全没了（D-3 的根因）
      if (isNotFound(cause)) return [];
      throw cause;
    }
    const metas: SessionMeta[] = [];
    for (const name of names) {
      if (!name.endsWith(META_SUFFIX)) continue;
      const meta = await this.readMeta(name.slice(0, -META_SUFFIX.length)).catch(() => null);
      if (meta !== null) metas.push(meta);
    }
    return sortSessions(metas);
  }

  async load(id: string): Promise<SessionDetail | null> {
    const meta = await this.readMeta(id);
    if (meta === null) return null;
    return { meta, transcript: await this.readLog(id) };
  }

  /**
   * 删一条会话。**先删 transcript，后删 meta**——顺序不是随意的：
   * 两次 rm 之间崩了的话，
   *   先删 meta：留下一个**列不出来也删不掉**的 .jsonl，永远占着盘；
   *   先删 transcript：留下一条打得开但空的会话，用户看得见、能自己再删一次。
   * 可见的残留优于隐形的残留。
   */
  async remove(id: string): Promise<void> {
    // 先等它自己那条写入链排完，再删——否则在途的 `update` 会在删完之后
    // 把 meta 文件又写回去（`update` 内部读不到才跳过，它已经读到了）。
    await this.queueMeta(id, async () => undefined);
    this.metaWrites.delete(id);
    await rm(this.logPath(id), { force: true });
    await rm(this.metaPath(id), { force: true });
  }

  private async readMeta(id: string): Promise<SessionMeta | null> {
    try {
      return parseSessionMeta(JSON.parse(await readFile(this.metaPath(id), "utf8")));
    } catch {
      return null;
    }
  }

  /**
   * 读日志。**逐行解析、坏行跳过**——只追加的文件最后一行可能因为断电写了一半，
   * 为此丢掉整条会话的记录是不划算的。
   */
  private async readLog(id: string): Promise<SessionRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.logPath(id), "utf8");
    } catch {
      return [];
    }
    const records: SessionRecord[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        // 界碑逐字段校验；**长着界碑的脸但字段不齐的行跳过**——
        // 半截摘要当消息渲染，比少渲染一行更糟
        if (isCompactedRecord(parsed)) {
          records.push(parsed);
          continue;
        }
        const suspect = parsed as { role?: unknown } | null;
        if (suspect !== null && typeof suspect === "object" && suspect.role === "compacted") continue;
        records.push(parsed as TranscriptItem);
      } catch {
        // 半截行：跳过它，前面读到的照常返回
      }
    }
    return records;
  }
}

/** 从记录里推导标题：第一条用户消息的第一行。改名清空时退回它。 */
function derivedFrom(transcript: readonly SessionRecord[]): string {
  for (const item of transcript) {
    if (item.role !== "user") continue;
    for (const block of item.content) {
      if (block.type !== "text") continue;
      const title = deriveSessionTitle(block.text);
      if (title !== "") return title;
    }
  }
  return "";
}
