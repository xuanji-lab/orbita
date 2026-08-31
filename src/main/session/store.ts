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
import { join } from "node:path";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { writeJsonAtomic } from "../atomic-write.ts";
import type { PermissionMode } from "../../shared/permission.ts";
import {
  deriveSessionTitle,
  isCompactedRecord,
  parseSessionMeta,
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

export class SessionStore {
  private readonly dir: string;

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

    const changes: Partial<SessionMeta> = { updatedAt: item.timestamp };
    // 标题只认第一条用户消息，之后不再改——否则会话会在侧栏里改名。
    // 手动改过名的会话 title 不为空，因此这条守卫自动让位给它。
    if (meta.title === "" && item.role === "user") {
      const text = item.content.find((block) => block.type === "text");
      if (text !== undefined && text.type === "text") changes.title = deriveSessionTitle(text.text);
    }
    await this.update(id, changes);
  }

  /**
   * 改名。**改成空名字就退回推导**——侧栏里一行看不见的东西比一个坏名字更糟，
   * 用户会以为会话丢了（工作区改名走的是同一条规矩：空名退回路径末段）。
   */
  async rename(id: string, title: string): Promise<void> {
    const wanted = deriveSessionTitle(title);
    const next = wanted !== "" ? wanted : derivedFrom(await this.readLog(id));
    await this.update(id, { title: next });
  }

  /**
   * 改 meta 上的字段。**六处「读 → 改一个字段 → 原子写回」收成这一个**——
   * meta 不在就悄悄不做：会话可能刚被别处删掉，为此抛错没有意义。
   */
  private async update(id: string, changes: Partial<SessionMeta>): Promise<void> {
    const meta = await this.readMeta(id);
    if (meta === null) return;
    await writeJsonAtomic(this.metaPath(id), { ...meta, ...changes });
  }

  /** 记住 pi 这一次用的那份 session 文件——没有它，这条会话下次就只能读不能续 */
  setPiSessionFile(id: string, piSessionFile: string | null): Promise<void> {
    return this.update(id, { piSessionFile });
  }

  setMode(id: string, mode: PermissionMode): Promise<void> {
    return this.update(id, { mode });
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

  /** 会话列表：置顶在前，其余最近的在前。**坏掉的 meta 直接跳过**，不让一条坏记录挡住整张列表。 */
  async list(): Promise<SessionMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return []; // 目录还不存在 = 一条会话都没有
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
