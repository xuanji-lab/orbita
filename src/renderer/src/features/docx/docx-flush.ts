/**
 * docx 的「切走前先落盘」登记表 —— 纯模块（无 React、无 IPC），`node --test` 直接可测。
 *
 * 为什么需要它：编辑器里的字先进引擎的文档模型，**不会**在敲键那一刻进磁盘；
 * 面板只是把组件卸载掉，卸载里能做的只有 clearTimeout。于是「点开另一个文件」
 * 「关标签」「切会话」「换右栏面板」「重读文件」都会把还没落盘的字丢掉，而屏幕上一句
 * 提示都没有（2026-10-24 评审复现，随后第二轮评审补出 5 个漏掉的入口）。
 *
 * 约定：`DocxView` 挂载时登记一个 flush；任何要离开这份文档的入口先问它。
 * - flush 返回 `{ ok: false }` 时调用方**保持原地不动**——提示由 docx 视图自己挂出来
 *   （保真闸门 / 冲突 / 写盘失败，各有各的文案），切换器不另造第二套。
 * - `cause` 让 docx 视图区别「用户主动保存失败」与「因为要切走才保存、结果失败」：
 *   后者要明说「切走会丢字」，否则用户会以为只是普通保存报错。
 * - `*ForLeave`：没有待存改动就**不 await**（右栏这种每次点击都经过的地方，
 *   不该为了一个空操作变成异步切换）。
 */
export type DocxFlushOutcome =
  | { ok: true }
  /** blocked = 需要用户确认（整份重排），conflict = 磁盘变了，failed = 写盘失败 */
  | { ok: false; reason: "blocked" | "conflict" | "failed" };

/** 为什么要 flush：手动保存 / 要离开这份文档（用户主动按保存 vs 被闸门逼着保存） */
export type DocxFlushCause = "manual" | "leave";

export interface DocxFlushEntry {
  /** 把待存改动落盘；没有待存改动就当成功 */
  flush: (cause: DocxFlushCause) => Promise<DocxFlushOutcome>;
  /** 此刻是否有没落盘的改动（同步；离场闸门与关窗口兜底用） */
  pending: () => boolean;
}

const entries = new Map<string, DocxFlushEntry>();

/** 登记一份打开着的 docx（键 = 文件绝对路径）。返回值是注销函数，挂载的 effect 直接 return 它 */
export function registerDocxFlush(path: string, entry: DocxFlushEntry): () => void {
  entries.set(path, entry);
  return () => {
    if (entries.get(path) === entry) entries.delete(path);
  };
}

/** 有没有没落盘的 docx（同步）。离场闸门拿它决定「要不要等」 */
export function hasPendingDocx(): boolean {
  for (const entry of entries.values()) if (entry.pending()) return true;
  return false;
}

/** 离开 `path` 之前调用；没有登记（不是 docx / 已经关掉）就是成功 */
export async function flushDocxAt(
  path: string | null | undefined,
  cause: DocxFlushCause = "leave",
): Promise<DocxFlushOutcome> {
  if (path === null || path === undefined) return { ok: true };
  const entry = entries.get(path);
  if (entry === undefined) return { ok: true };
  return entry.flush(cause);
}

/** 离开**所有**打开的 docx（切会话 / 换面板 / 关窗口）：任一份失败就整次不动 */
export async function flushAllDocx(cause: DocxFlushCause = "leave"): Promise<DocxFlushOutcome> {
  for (const entry of [...entries.values()]) {
    const outcome = await entry.flush(cause);
    if (!outcome.ok) return outcome;
  }
  return { ok: true };
}

/** 离场闸门的常用形态：没有待存改动就同步放行，不把一次点击变成异步 */
export async function flushDocxForLeave(path: string | null | undefined): Promise<DocxFlushOutcome> {
  if (path === null || path === undefined) return { ok: true };
  const entry = entries.get(path);
  if (entry === undefined || !entry.pending()) return { ok: true };
  return entry.flush("leave");
}

export async function flushAllDocxForLeave(): Promise<DocxFlushOutcome> {
  return hasPendingDocx() ? flushAllDocx("leave") : { ok: true };
}
