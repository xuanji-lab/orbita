/**
 * 通道账本落盘（子会话 2026-09-23 裁决）——每对父子一份独立文件：
 *
 *   <userData>/channels/<parentId>/<childId>.jsonl   只追加，一行一个 ChannelMessage
 *
 * **通道是真源，两边是投影**（`shared/channel.ts` 头部注释）：父与子各自的
 * transcript 里只落一条 `ChannelMarkRecord` 指向这里的某一行，正文只有一份，
 * 在这本账里。**纯模块**：不 import electron，可被 `node --test` 直接加载
 * （`session/store.ts` 的同款先例）。
 */
import { appendFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isNotFound } from "../fs-errors.ts";
import { writeJsonAtomic } from "../atomic-write.ts";
import { isSessionId } from "../session/store.ts";
import {
  parseChannelMessage,
  sortChannelMessages,
  summarizeChannel,
  type ChannelKey,
  type ChannelMessage,
  type ChannelSummary,
} from "../../shared/channel.ts";

const LOG_SUFFIX = ".jsonl";
/** 待投账（每个父会话一份）：还没投给父模型的子→父消息。文件名不以 .jsonl 结尾，listForParent 不会把它当通道 */
const PENDING_FILE = "pending.json";

/** 待投账里的一条：哪个子会话的哪条消息（正文在账本里，只记指针） */
export interface PendingRef {
  childId: string;
  messageId: string;
}

function parsePendingRefs(raw: unknown): PendingRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const value = item as Record<string, unknown>;
    const childId = value["childId"];
    const messageId = value["messageId"];
    return typeof childId === "string" && isSessionId(childId) && typeof messageId === "string" && messageId !== "" ? [{ childId, messageId }] : [];
  });
}

/**
 * **parentId / childId 必须过会话 id 白名单**——`channel:load` 的 key 来自
 * renderer，直接拼进路径的话一个 `../../` 就能读写 channels 目录之外的文件。
 * 白名单比转义可靠，同 SessionStore 的 metaPath/logPath 一条纪律。
 */
function assertSessionId(id: string): void {
  if (!isSessionId(id)) throw new Error(`invalid session id "${id}"`);
}

export class ChannelStore {
  private readonly dir: string;
  /** 待投账按父会话串行写（读-改-原子写），同一父会话的两次改动不互相覆盖 */
  private readonly pendingChains = new Map<string, Promise<void>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  private parentDir(parentId: string): string {
    assertSessionId(parentId);
    return join(this.dir, parentId);
  }

  private logPath(key: ChannelKey): string {
    assertSessionId(key.parentId);
    assertSessionId(key.childId);
    return join(this.dir, key.parentId, `${key.childId}${LOG_SUFFIX}`);
  }

  /** 追加一条消息（只追加，一行一个 JSON）。目录不存在就先建。 */
  async append(key: ChannelKey, message: ChannelMessage): Promise<void> {
    const path = this.logPath(key);
    await mkdir(join(this.dir, key.parentId), { recursive: true });
    await appendFile(path, `${JSON.stringify(message)}\n`, "utf8");
  }

  /**
   * 读一份账本，时间正序。**逐行解析、坏行跳过**（半截行 / 编出来的消息）
   * 同 SessionStore.readLog 的纪律；文件不存在 = 还没有任何往来（ENOENT → []），
   * 其它读错照抛（读不了 ≠ 没有）。
   */
  async load(key: ChannelKey): Promise<ChannelMessage[]> {
    let raw: string;
    try {
      raw = await readFile(this.logPath(key), "utf8");
    } catch (cause) {
      if (isNotFound(cause)) return [];
      throw cause;
    }
    const messages: ChannelMessage[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = parseChannelMessage(JSON.parse(line));
        if (parsed !== null) messages.push(parsed);
      } catch {
        // 半截行：跳过它，前面读到的照常返回
      }
    }
    return sortChannelMessages(messages);
  }

  /**
   * 父会话名下的全部通道，按最后一条消息倒序。**不做 hasExchange 过滤**——
   * task-only 通道 status 恒 running，过滤是通道列渲染的事，这里只如实列出。
   * 目录不存在 = 这条父会话还没派出过任何子（ENOENT → []）。
   */
  async listForParent(
    parentId: string,
    titleOf: (childId: string) => Promise<string>,
  ): Promise<ChannelSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.parentDir(parentId));
    } catch (cause) {
      if (isNotFound(cause)) return [];
      throw cause;
    }
    const summaries: ChannelSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(LOG_SUFFIX)) continue;
      const childId = name.slice(0, -LOG_SUFFIX.length);
      // 手放 / 残留的非会话 id 文件（如 notes.jsonl）：跳过，不让它拖垮整个列表——
      // 同「坏行跳过」纪律。这条父会话每轮开轮都调 listForParent（turn-directories.ts
      // 的 related），一条坏文件让它抛错就等于这条父会话再也开不了轮。
      if (!isSessionId(childId)) continue;
      const key: ChannelKey = { parentId, childId };
      const messages = await this.load(key);
      const childTitle = await titleOf(childId);
      summaries.push(summarizeChannel(key, childTitle, messages));
    }
    return summaries.sort((a, b) => b.lastAt - a.lastAt);
  }

  // ── 待投账（子→父的完成 / 提问 / 失败，投给父模型之前）──
  //
  // 为什么要落盘：排队归 renderer（会话槽的 queued），应用退出 / 崩溃 / 窗口重载时内存里的队列就没了——账本里
  // 还有这条消息，但再没人会把它投给父模型。落一份「还没投」的指针，父会话的转录落下这条消息的通道标记
  // （recorder，内核已收下）时出账；renderer 启动时拉一遍重新入队。宁可重投（出账前崩了）不可丢。

  private pendingPath(parentId: string): string {
    return join(this.parentDir(parentId), PENDING_FILE);
  }

  private async readPending(parentId: string): Promise<PendingRef[]> {
    try {
      return parsePendingRefs(JSON.parse(await readFile(this.pendingPath(parentId), "utf8")));
    } catch (cause) {
      // 不存在 = 没有待投；坏文件同样当空（它只是派生的指针，坏了最多少投一次，不该拦住投递与开轮）
      if (isNotFound(cause) || cause instanceof SyntaxError) return [];
      throw cause;
    }
  }

  private editPending(parentId: string, edit: (refs: PendingRef[]) => PendingRef[] | null): Promise<void> {
    const previous = this.pendingChains.get(parentId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const refs = await this.readPending(parentId);
        const changed = edit(refs);
        if (changed === null) return;
        if (changed.length === 0) await rm(this.pendingPath(parentId), { force: true });
        else {
          await mkdir(this.parentDir(parentId), { recursive: true });
          await writeJsonAtomic(this.pendingPath(parentId), changed);
        }
      });
    this.pendingChains.set(parentId, next);
    return next;
  }

  /** 记一条待投（同一条只记一次） */
  addPending(parentId: string, ref: PendingRef): Promise<void> {
    assertSessionId(ref.childId);
    return this.editPending(parentId, (refs) => (refs.some((each) => each.messageId === ref.messageId) ? null : [...refs, ref]));
  }

  /** 出账：这条消息已经交给父会话的内核（父的转录落了它的通道标记）。没有这条 = 什么都不做 */
  clearPending(parentId: string, messageId: string): Promise<void> {
    return this.editPending(parentId, (refs) => (refs.some((each) => each.messageId === messageId) ? refs.filter((each) => each.messageId !== messageId) : null));
  }

  /**
   * 全部父会话的待投，带上账本里的原文（按父会话、到达顺序）。账本里已经找不到的指针（通道被删）跳过。
   * 用户已终止的子会话（stopped）也照投——终止之前它说的话父模型还没看到。
   */
  async listPending(): Promise<{ parentId: string; childId: string; message: ChannelMessage }[]> {
    let parents: string[];
    try {
      parents = await readdir(this.dir);
    } catch (cause) {
      if (isNotFound(cause)) return [];
      throw cause;
    }
    const out: { parentId: string; childId: string; message: ChannelMessage }[] = [];
    for (const parentId of parents) {
      if (!isSessionId(parentId)) continue;
      const refs = await this.readPending(parentId);
      for (const ref of refs) {
        const message = (await this.load({ parentId, childId: ref.childId })).find((each) => each.id === ref.messageId);
        if (message !== undefined) out.push({ parentId, childId: ref.childId, message });
      }
    }
    return out;
  }

  /** 级联删：父会话被删时，它名下的全部通道一起没了。force——不存在也不报错。 */
  async removeForParent(parentId: string): Promise<void> {
    await rm(this.parentDir(parentId), { recursive: true, force: true });
  }

  /** 删单条通道（子会话自己被删、但父还在时）。force——不存在也不报错。 */
  async removeChannel(key: ChannelKey): Promise<void> {
    await rm(this.logPath(key), { force: true });
  }
}
