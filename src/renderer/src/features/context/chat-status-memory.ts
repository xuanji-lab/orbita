/**
 * 状态卡的界面状态，**按会话记住**（用户 2026-11-23：「每个 session 能自己记住自己的」）。
 *
 * 卡按会话重挂（App 里 `key={mainSessionId}`），卡内的开合、滚动位置全是组件 state，切走就丢。
 * 这里给每条主会话记一份「在哪一层」：卡开着还是收起、展开了哪一步、各折叠区的开合、目标是否展开、
 * 各产物组横向滑到哪、卡内纵向滚到哪。**只记位置，不记内容**（步骤文字、子会话、产物都是活数据，现取）。
 *
 * 存法照 sub-sessions-fold.ts 的做法：一个 localStorage 账本（会话 id → 一份），上限 200 条、最近写的在最后、
 * 超出丢最早的；会话被删就清掉（forgetMissing）。没有走 right-panel-memory 的主进程落盘：它要一整套 IPC 四层，
 * 而这些是纯 renderer 的外观偏好、丢了只是回到默认，localStorage 同样跨重启，不值得多一条契约。
 * 开 / 关以前是全局一份（orbita.proto.chatStatus.open），现在按会话；宽度仍是全局一份（与右栏宽度同理）。
 *
 * 规范形：与默认值相同的字段一律不写（开着是默认，所以只记「收起」）；空视图就是没有这条。
 * 读回来的数据不可信（手改 / 旧版本）：每个字段在 parse 里校验，对不上的丢掉，字符串与列表都有长度上限。
 * 纯函数部分可被 node --test 直接加载（不在 import 时碰 localStorage）。
 */

export const STATUS_VIEW_KEY = "orbita.chatStatus.view";
export const STATUS_VIEW_LIMIT = 200;

/** 产物分组的键（与 chat-status.ts 的 OutputGroupKey 同一批；这里不 import，保持本模块零依赖） */
const GROUP_KEYS: ReadonlySet<string> = new Set(["slides", "doc", "web", "pdf", "image", "video", "audio", "board", "file"]);
const MAX_ID = 200;
const MAX_LIST = 40;
const MAX_PX = 1_000_000;

export interface StatusView {
  /** 卡收起了（开着是默认，不写） */
  closed?: true;
  /** 进度里展开的那一步（计划步骤 id，或「其他子会话」的占位键） */
  step?: string;
  /** 进度展开到全部步骤 */
  all?: true;
  /** 一步下面「还有 N 个」展开过的步骤键 */
  more?: string[];
  /** 一步下面「已交回」展开的步骤键 */
  handed?: string[];
  /** 卡头的目标展开了（看全文） */
  goal?: true;
  /** 各产物组横向滚到哪（px，0 不写） */
  strips?: Record<string, number>;
  /** 卡内纵向滚到哪（px，0 不写） */
  scroll?: number;
}

/** 改一份视图：给值 = 设置，给 null = 回到默认（删掉这个字段） */
export type StatusViewPatch = { [K in keyof StatusView]?: StatusView[K] | null };

export type StatusBook = ReadonlyMap<string, StatusView>;

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function id(raw: unknown): string | undefined {
  return typeof raw === "string" && raw !== "" && raw.length <= MAX_ID ? raw : undefined;
}

function keyList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = [...new Set(raw.map(id).filter((item): item is string => item !== undefined))].slice(0, MAX_LIST);
  return out.length === 0 ? undefined : out;
}

function px(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const value = Math.round(raw);
  return value > 0 && value <= MAX_PX ? value : undefined;
}

/** 规范化一份视图（落盘读回的、组件报上来的都走它）：校验、丢默认值、空就是 undefined */
export function parseView(raw: unknown): StatusView | undefined {
  if (!isRecord(raw)) return undefined;
  const out: StatusView = {};
  if (raw.closed === true) out.closed = true;
  const step = id(raw.step);
  if (step !== undefined) out.step = step;
  if (raw.all === true) out.all = true;
  const more = keyList(raw.more);
  if (more !== undefined) out.more = more;
  const handed = keyList(raw.handed);
  if (handed !== undefined) out.handed = handed;
  if (raw.goal === true) out.goal = true;
  if (isRecord(raw.strips)) {
    const strips: Record<string, number> = {};
    for (const [group, value] of Object.entries(raw.strips)) {
      const left = px(value);
      if (GROUP_KEYS.has(group) && left !== undefined) strips[group] = left;
    }
    if (Object.keys(strips).length > 0) out.strips = strips;
  }
  const scroll = px(raw.scroll);
  if (scroll !== undefined) out.scroll = scroll;
  return Object.keys(out).length === 0 ? undefined : out;
}

/** 把 patch 叠到一份视图上，返回规范形（可能是 undefined = 回到全默认） */
export function mergeView(view: StatusView | undefined, patch: StatusViewPatch): StatusView | undefined {
  const next: Record<string, unknown> = { ...(view ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  return parseView(next);
}

/** 读盘上那份账本（不可信）：逐条校验，坏条目丢掉，旧 → 新顺序保持，超上限留最新的 */
export function parseBook(raw: string | null): StatusBook {
  if (raw === null) return new Map();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (!isRecord(value)) return new Map();
  let book: StatusBook = new Map();
  for (const [sessionId, entry] of Object.entries(value)) {
    const key = id(sessionId);
    const view = parseView(entry);
    if (key !== undefined && view !== undefined) book = writeView(book, key, view);
  }
  return book;
}

export function stringifyBook(book: StatusBook): string {
  return JSON.stringify(Object.fromEntries(book));
}

/**
 * 记下一条会话的视图：放到末尾（最近写的），超上限丢最早的。view 为 undefined（回到全默认）就删掉这条——
 * 读回来本来就是默认，不值得占一行。内容没变就原样返回（引用不变：调用方据此跳过落盘）。
 */
export function writeView(book: StatusBook, sessionId: string, view: StatusView | undefined): StatusBook {
  const old = book.get(sessionId);
  if (view === undefined) {
    if (old === undefined) return book;
    const next = new Map(book);
    next.delete(sessionId);
    return next;
  }
  if (old !== undefined && JSON.stringify(old) === JSON.stringify(view) && [...book.keys()].at(-1) === sessionId) return book;
  const next = new Map(book);
  next.delete(sessionId);
  next.set(sessionId, view);
  while (next.size > STATUS_VIEW_LIMIT) {
    const oldest = next.keys().next();
    if (oldest.done === true) break;
    next.delete(oldest.value);
  }
  return next;
}

/** 会话被删了：清掉不在 alive 里的条目。没有要清的就原样返回 */
export function forgetMissing(book: StatusBook, alive: ReadonlySet<string>): StatusBook {
  let dead = false;
  for (const key of book.keys()) {
    if (!alive.has(key)) {
      dead = true;
      break;
    }
  }
  if (!dead) return book;
  const next = new Map<string, StatusView>();
  for (const [key, view] of book) if (alive.has(key)) next.set(key, view);
  return next;
}

// ── 模块级的账本（renderer 里唯一一份）：首次用到时从 localStorage 读，改了就写回 ──────────────

let book: StatusBook | null = null;

function loaded(): StatusBook {
  if (book !== null) return book;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STATUS_VIEW_KEY);
  } catch {
    // 读不了就从空账本起步
  }
  book = parseBook(raw);
  return book;
}

function persist(next: StatusBook): void {
  book = next;
  try {
    localStorage.setItem(STATUS_VIEW_KEY, stringifyBook(next));
  } catch {
    // 存不下就只在这次运行里生效
  }
}

/** 这条会话上次离开时卡停在哪（没记过 = undefined = 全默认） */
export function readView(sessionId: string): StatusView | undefined {
  return loaded().get(sessionId);
}

/** 改一条会话的视图并落盘；内容没变不写盘 */
export function patchView(sessionId: string, patch: StatusViewPatch): void {
  const current = loaded();
  const next = writeView(current, sessionId, mergeView(current.get(sessionId), patch));
  if (next !== current) persist(next);
}

/** 会话被删：顺手清掉它们的条目。列表为空（还没读回 / 读失败）时由调用方不调——否则一次失败会抹掉全部记忆 */
export function forgetViews(alive: ReadonlySet<string>): void {
  const current = loaded();
  const next = forgetMissing(current, alive);
  if (next !== current) persist(next);
}
