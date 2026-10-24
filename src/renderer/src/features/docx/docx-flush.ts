/**
 * docx 的「切走前先落盘」登记表 —— 纯模块（无 React、无 IPC），`node --test` 直接可测。
 *
 * 为什么需要它：编辑器里的字先进引擎的文档模型，**不会**在敲键那一刻进磁盘；
 * 面板只是把组件卸载掉，卸载里能做的只有 clearTimeout。于是「点开另一个文件」
 * 「关标签」「切会话」都会把还没落盘的字丢掉，而屏幕上一句提示都没有
 * （2026-10-24 评审复现：insertText 后 200 ms 切标签，字消失、磁盘 hash 没变）。
 *
 * 约定：`DocxView` 挂载时登记一个 flush；任何要离开这份文档的入口（FilesPanel
 * 的标签切换 / 关闭、session 的 openSession、窗口卸载）先问它。flush 返回
 * `{ ok: false }` 时调用方**保持原地不动**——提示由 docx 视图自己挂出来
 * （保真闸门 / 冲突 / 保存失败各有各的文案），切换器不另造第二套。
 */
export type DocxFlushOutcome =
  | { ok: true }
  /** blocked = 需要用户确认（整份重排），conflict = 磁盘变了，failed = 写盘失败 */
  | { ok: false; reason: "blocked" | "conflict" | "failed" };

export interface DocxFlushEntry {
  /** 把待存改动落盘；没有待存改动就当成功 */
  flush: () => Promise<DocxFlushOutcome>;
  /** 此刻是否有没落盘的改动（beforeunload 与状态查询用） */
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

/** 离开 `path` 之前调用；没有登记（不是 docx / 已经关掉）就是成功 */
export async function flushDocxAt(path: string | null | undefined): Promise<DocxFlushOutcome> {
  if (path === null || path === undefined) return { ok: true };
  const entry = entries.get(path);
  if (entry === undefined) return { ok: true };
  return entry.flush();
}

/** 离开**所有**打开的 docx（切会话 / 关窗口）：任一份失败就整次不动 */
export async function flushAllDocx(): Promise<DocxFlushOutcome> {
  for (const entry of [...entries.values()]) {
    const outcome = await entry.flush();
    if (!outcome.ok) return outcome;
  }
  return { ok: true };
}

/** 有没有没落盘的 docx（同步；beforeunload 只能同步问） */
export function hasPendingDocx(): boolean {
  for (const entry of entries.values()) if (entry.pending()) return true;
  return false;
}
