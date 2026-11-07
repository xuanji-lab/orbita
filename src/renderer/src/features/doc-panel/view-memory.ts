/**
 * 文档面板的「上次停在哪」：演示文稿停在第几页、文档滚到哪，以及每个工作区的文档 / 演示文稿面板上次打开的是哪份。
 * 关面板再开、重启后都要回到原处，所以落 localStorage（renderer 本地、轻量、同步读；不是用户数据，丢了只是回到顶部）。
 * 存储可注入，测试用内存实现。
 */
export interface MemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "orbita.docpanel.v1";
/** 最多记多少份文档的位置：超出的丢最早的 */
const MAX_VIEWS = 60;

interface ViewState {
  /** 演示文稿：当前页（0 起） */
  page?: number;
  /** 文档：滚动位置（px） */
  scroll?: number;
  /** 文档：上次停在哪个视图（阅读 / 编辑 / 源码） */
  view?: "read" | "edit" | "source";
}

interface Memory {
  views: Record<string, ViewState>;
  /** `<工作区>:<doc|slides>` → 上次打开的文件路径 */
  last: Record<string, string>;
}

function browserStorage(): MemoryStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function read(storage: MemoryStorage | null): Memory {
  const empty: Memory = { views: {}, last: {} };
  if (storage === null) return empty;
  try {
    const parsed = JSON.parse(storage.getItem(KEY) ?? "null") as Partial<Memory> | null;
    if (typeof parsed !== "object" || parsed === null) return empty;
    return {
      views: typeof parsed.views === "object" && parsed.views !== null ? parsed.views : {},
      last: typeof parsed.last === "object" && parsed.last !== null ? parsed.last : {},
    };
  } catch {
    return empty;
  }
}

function write(storage: MemoryStorage | null, memory: Memory): void {
  if (storage === null) return;
  try {
    storage.setItem(KEY, JSON.stringify(memory));
  } catch {
    // 满了 / 被禁：记不住就记不住
  }
}

export function getView(path: string, storage: MemoryStorage | null = browserStorage()): ViewState {
  return read(storage).views[path] ?? {};
}

export function setView(path: string, patch: ViewState, storage: MemoryStorage | null = browserStorage()): void {
  const memory = read(storage);
  const next = { ...(memory.views[path] ?? {}), ...patch };
  // 重新插入 = 记为最近用过
  delete memory.views[path];
  memory.views[path] = next;
  const keys = Object.keys(memory.views);
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_VIEWS))) delete memory.views[stale];
  write(storage, memory);
}

/**
 * 「这个面板上次开的是哪份」的记忆键：<工作区 id 或 home>:<doc | slides>。
 * DocsPanel 与新手引导的「试试」（预先新建并登记一份）共用这一个，两边不准各写一份——
 * 写成两份一旦形状不同，引导造的文档面板就认不出来。
 */
export function docScope(workspaceId: string | null | undefined, kind: "doc" | "slides"): string {
  return `${workspaceId ?? "home"}:${kind}`;
}

export function getLast(scope: string, storage: MemoryStorage | null = browserStorage()): string | null {
  return read(storage).last[scope] ?? null;
}

export function setLast(scope: string, path: string | null, storage: MemoryStorage | null = browserStorage()): void {
  const memory = read(storage);
  if (path === null) delete memory.last[scope];
  else memory.last[scope] = path;
  write(storage, memory);
}
