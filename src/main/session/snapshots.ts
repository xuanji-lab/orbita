/**
 * 快照正文仓 —— `sessions/<id>.snapshots/<sha1>.txt`。
 *
 * 正文按内容寻址（sha1）：同一份内容跨轮只存一份（改回原样、分支后的重复轮），
 * 回退记录与轮尾账里的 `blob` 引用天然去重。住在 sessions/ 里 = 受
 * protectedPaths 保护（工具面只读）、随会话一起删（SessionStore.remove）。
 *
 * blob 名只认 `^[0-9a-f]{40}\.txt$`：它是从盘上读回来拼路径的，白名单比转义可靠
 * （SESSION_ID 同一条纪律）。
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { writeTextAtomic } from "../atomic-write.ts";
import { isSessionId } from "./store.ts";

const BLOB_NAME = /^[0-9a-f]{40}\.txt$/;

export class SnapshotStore {
  private readonly sessionsDir: string;

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
  }

  private dirOf(sessionId: string): string {
    if (!isSessionId(sessionId)) throw new Error(`invalid session id "${sessionId}"`);
    return join(this.sessionsDir, `${sessionId}.snapshots`);
  }

  /** 存一份正文，返回 blob 名（sha1）。内容寻址：已存在就跳过写（幂等）。 */
  async save(sessionId: string, content: string): Promise<string> {
    const name = `${createHash("sha1").update(content, "utf8").digest("hex")}.txt`;
    await writeTextAtomic(join(this.dirOf(sessionId), name), content);
    return name;
  }

  /** 读一份正文；引用不合格或文件不在（会话被删、手删）都是 null，调用方按快照不可用处理。 */
  async read(sessionId: string, blob: string): Promise<string | null> {
    if (!BLOB_NAME.test(blob)) return null;
    try {
      return await readFile(join(this.dirOf(sessionId), blob), "utf8");
    } catch {
      return null;
    }
  }
}
