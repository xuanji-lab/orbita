/**
 * 输入框附件的第二类：文件引用与粘贴文本块（图片在 composer-images.ts，管线不同）。
 *
 * 文件是**纯引用**——只拿路径、不读内容，模型用 read 工具自己读（契约与组装在
 * `shared/prompt-attachments.ts`）。这里只管输入框这一侧的事：分拣（哪些进得来）与
 * 每一条被拒的都点名报出来——一次拖进来一批、悄悄少了几条，用户不会发现，
 * 模型却会对着缺文件的问题瞎答。条数不设上限（2026-10 用户裁决），拒绝只剩
 * 两种：拿不到路径的、与草稿里重复的。
 */
import type { Messages } from "../messages-en.ts";

/** 输入框里的一个文件引用。id 只给 React key 与「移除」用，不上 IPC */
export interface ComposerFileRef {
  id: string;
  /** 显示名（路径末段）。文件面板引用与拖入的都有真名 */
  name: string;
  path: string;
  kind: "file" | "dir";
  /** workspace = 文件面板引用（原位置不动）；external = 拖入/选择（发送时主进程复制进会话） */
  origin: "workspace" | "external";
  /**
   * 超过复制上限（EXTERNAL_FILE_COPY_MAX_BYTES）的 external 文件：发送时主进程
   * 不复制、按原位置引用——原件挪走 / 删掉后引用会断，胶囊上要明说。只在 renderer
   * 里存在，不上 IPC（发送侧自己 lstat 判定，不信这个标记）。
   */
  uncopied?: boolean;
}

/**
 * 把主进程 stat 回来的盘上事实（类型 + 是否超限）按入列时记下的 id 贴回。拖入的
 * 条目先按 file 同步入列（拖放与回车发送抢的是同一拍，不能等 IPC 往返），stat
 * 回来再改真实类型——这期间被移除的（id 已不在）自然跳过，贴不上的（回执比
 * 入列短）维持原样。
 */
export function withStatKinds<T extends { id: string; kind: "file" | "dir"; uncopied?: boolean }>(
  current: readonly T[],
  statted: readonly { id: string; kind: "file" | "dir"; uncopied?: boolean }[],
): T[] {
  const facts = new Map(statted.map((item) => [item.id, item]));
  return current.map((item) => {
    const fact = facts.get(item.id);
    if (fact === undefined) return item;
    const wantUncopied = fact.uncopied === true;
    const hadUncopied = item.uncopied === true;
    if (fact.kind === item.kind && hadUncopied === wantUncopied) return item;
    return wantUncopied ? { ...item, kind: fact.kind, uncopied: true } : { ...item, kind: fact.kind };
  });
}

export type FileRefRejection = "no-path" | "duplicate";

/**
 * 分拣一批文件引用。已在同一条草稿里的路径记 duplicate——同一个文件引用两次
 * 只是噪音，说出来比静默跳过好（右键点第二下没反应会像按钮坏了）。条数不设
 * 上限（2026-10 用户裁决）：多拖就是多要。
 */
export function admitFileRefs(
  files: readonly { path: string; name: string }[],
  existing: readonly { path: string }[],
): { accepted: { path: string; name: string }[]; rejected: { name: string; reason: FileRefRejection }[] } {
  const seen = new Set(existing.map((ref) => ref.path));
  const accepted: { path: string; name: string }[] = [];
  const rejected: { name: string; reason: FileRefRejection }[] = [];
  for (const file of files) {
    // 剪贴板里没有磁盘来源的条目拿不到路径（preload 的 getPathForFile 回空串）——
    // 纯引用模型下没有路径就发不出去，当场点名比发送时失败早得多
    if (file.path === "") {
      rejected.push({ name: file.name, reason: "no-path" });
      continue;
    }
    if (seen.has(file.path)) {
      rejected.push({ name: file.name, reason: "duplicate" });
      continue;
    }
    seen.add(file.path);
    accepted.push({ path: file.path, name: file.name });
  }
  return { accepted, rejected };
}

/** 一批拒绝 → 一句提示，逐条列名字与原因 */
export function fileRefRejectionText(
  rejected: readonly { name: string; reason: FileRefRejection }[],
  t: Messages,
): string | null {
  if (rejected.length === 0) return null;
  return rejected
    .map((item) => (item.reason === "no-path" ? t.composer.fileNoPath(item.name) : t.composer.fileAlreadyAttached(item.name)))
    .join(" ");
}
