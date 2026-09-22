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
      const key: ChannelKey = { parentId, childId };
      const messages = await this.load(key);
      const childTitle = await titleOf(childId);
      summaries.push(summarizeChannel(key, childTitle, messages));
    }
    return summaries.sort((a, b) => b.lastAt - a.lastAt);
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
