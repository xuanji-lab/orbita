/**
 * 输入框材料盒的纯逻辑：材料的形状（截图 / 文件 / 目录 → 列跨度、行跨度）、
 * 重力落位（天际线装箱）、删除后的重力补位、盒子的限高，以及「哪些主题生效」。
 *
 * 消费者是 BlackholeBox.tsx（输入框上方的隐形盒子）与 SentBlackholeBox.tsx
 * （已发送用户消息顶上的缩小快照）。这里不碰 DOM：名字宽度按字符估（全宽 13px、
 * 半宽 7.2px，sm 12px 字号的实测近似），差一两像素由省略号吸收。
 *
 * **落位是确定性的，不是物理模拟**：同一份清单永远算出同一个布局。所以发出去的
 * 消息只凭附件清单就能重算出盒子，**不改会话存储协议**；也不会出现物理引擎那种
 * 方块歪斜、互相推挤、可点击的胶囊位置不稳的情况。两种落位模式（2026-10-12
 * 用户裁决「pure random 好玩一些」）：
 * - `lowest`（黑洞）：每块选落点最低的列位（平手取最左），跟真的掉下去一样
 *   不填悬空的洞；视觉上块从左到右排。
 * - `random`（俄罗斯方块）：在放得下的列位里**纯随机**挑一个，停在那几列已有
 *   的最高处之上——大量悬空与空洞是有意的玩法。随机数也是确定性的：每块的
 *   抽签只由它自己的种子键决定（见 blackholeSeedKey），与别的块无关——后加一块
 *   不会重排已落定的块，快照重算才能与输入框逐块一致。
 *
 * 纯函数：不 import React，可被 `node --test` 直接加载。
 */
import type { ThemePreference } from "../../../shared/settings.ts";

/** 一格的边长与格间距（px）。1 行的块高 = 格边长，与 28px 的材料胶囊近邻 */
export const BLACKHOLE_CELL_PX = 30;
export const BLACKHOLE_GAP_PX = 4;
/** 一格占用的步进（格边长 + 间距）：估宽换列数、容器宽换列数、落位换像素都用它 */
export const BLACKHOLE_STEP_PX = BLACKHOLE_CELL_PX + BLACKHOLE_GAP_PX;
/** 已发送消息里的盒子是输入框盒子的等比快照：材料与盒子一起缩到这个比例 */
export const BLACKHOLE_SENT_SCALE = 0.6;
/**
 * 盒子限高的安全距离（px）：盒子最多长到「舷窗横条下沿 → 盒子底」的距离减去它。
 * 160 = 消息区至少还剩约 4 行正文（14px × 1.75 行高 ≈ 24.5px，4 行约 100px）
 * + 舷窗光晕的 40px + 20px 余量——横条不被盖住，消息区也不会被挤成一条缝。
 * 不设行数上限：材料一直往上堆，到这里才在盒子内部滚动。
 */
export const BLACKHOLE_SAFE_PX = 160;
/** 限高的地板：窗口再矮也至少留两行格子，盒子不塌成 0 */
const MIN_CAP_ROWS = 2;
/** 名字短到这个列数以内是小胶囊；再长就是半宽长条 */
const CAPSULE_MAX_COLS = 6;
/** 胶囊的最短列数：再短的名字也要有个能点的身位 */
const CAPSULE_MIN_COLS = 3;
/** 胶囊除名字外的固定宽度：左内边距 10 + 图标 13 + 间距 4 + 移除键 18 + 右内边距 4 + 余量 */
const CHIP_CHROME_PX = 56;

const CHAR_WIDE_PX = 13;
const CHAR_NARROW_PX = 7.2;

/** 材料在盒子里的形状：截图 = 正方形，名字短 = 小胶囊，名字长 = 半宽长条 */
export type BlackholeShape = "square" | "capsule" | "strip";
/** 盒子只装这三种；引用不进盒子（它算消息正文的一部分，待在盒子下面） */
export type BlackholeKind = "image" | "file" | "dir";

export interface BlackholeSpan {
  shape: BlackholeShape;
  /** 占几列 */
  col: number;
  /** 占几行 */
  row: number;
}

/** 一块的落位：x 从盒子左缘数（列），y 从盒底往上数（行），w / h 是实际占的列与行 */
export interface BlackholePlacement {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 文本估宽（px）。码位 > 0x2e80 起按全宽算（CJK 与注音、假名都在其上） */
export function textWidthPx(text: string): number {
  let px = 0;
  for (const ch of text) px += (ch.codePointAt(0) ?? 0) > 0x2e80 ? CHAR_WIDE_PX : CHAR_NARROW_PX;
  return px;
}

/** 容器宽 → 能容下的列数（至少 1 列） */
export function columnsForWidth(widthPx: number): number {
  return Math.max(1, Math.floor((widthPx + BLACKHOLE_GAP_PX) / BLACKHOLE_STEP_PX));
}

/**
 * 一种材料的形状。`extraPx` 是名字之外额外要的宽度（例如「未复制」标记）。
 * 半宽长条的宽度跟盒子走（盒宽的一半），所以要传当前列数。
 */
export function blackholeSpan(
  kind: BlackholeKind,
  name: string,
  columns: number,
  extraPx = 0,
): BlackholeSpan {
  if (kind === "image") return { shape: "square", col: 2, row: 2 };
  const want = Math.ceil((textWidthPx(name) + CHIP_CHROME_PX + extraPx) / BLACKHOLE_STEP_PX);
  if (want <= CAPSULE_MAX_COLS) return { shape: "capsule", col: Math.max(CAPSULE_MIN_COLS, want), row: 1 };
  const half = Math.floor(columns / 2);
  return { shape: "strip", col: Math.max(CAPSULE_MIN_COLS, Math.min(want, half)), row: 1 };
}

/** 落位模式：黑洞 = 落点最低的列位（平手取最左）；俄罗斯方块 = 纯随机列位 */
export type BlackholeDropMode = "lowest" | "random";

/** 盒子的形态：黑洞带全套特效（变黑 / 吸入 / 舷窗 / 飞入），俄罗斯方块只落块 */
export type MaterialBoxStyle = "blackhole" | "tetris";

/** 一块材料在随机落点下的种子键素材：截图用它在截图组里的序号，文件 / 目录用路径 */
export type BlackholeSeedInput = { kind: "image"; index: number } | { kind: "file" | "dir"; path: string };

/**
 * 随机落点的种子键：同一块材料在两处要算出**同一个键**——输入框里（放出的那一刻）
 * 与已发送消息的快照里（只凭消息附件重算）。稳定的标识两边都有的是：
 * - 文件 / 目录：路径（分拣时已去重，清单里唯一；消息里也带着）；
 * - 截图：它在截图组里的序号（图片总是追加进清单，已有截图的序号不会被后加的
 *   挪动；消息里的图没有 id，只有组内顺序可复现——转录存的是缩放后的图，
 *   拿图字节做哈希在两边对不上）。
 */
export function blackholeSeedKey(input: BlackholeSeedInput): string {
  return input.kind === "image" ? `image:${input.index}` : input.path;
}

/** 种子键 → 32 位种子（FNV-1a，稳定且跨平台一致） */
function seedFromKey(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32：小而够用的确定性伪随机，首拍即满周期（种子不同序列不同） */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 掉一块：`lowest` 在已落定的块上找落点最低的列位（平手取最左）；`random` 在
 * 放得下列位里纯随机挑一个（确定性：抽签只由这块自己的种子键决定）。两种都
 * 停在那几列已有的最高处之上。块比盒子还宽时压到盒宽。
 */
export function dropOne(
  placed: readonly BlackholePlacement[],
  span: { col: number; row: number },
  columns: number,
  mode: BlackholeDropMode = "lowest",
  seed = "",
): BlackholePlacement {
  const heights = new Array<number>(columns).fill(0);
  for (const p of placed) {
    for (let i = p.x; i < p.x + p.w && i < columns; i++) heights[i] = Math.max(heights[i] ?? 0, p.y + p.h);
  }
  const w = Math.max(1, Math.min(span.col, columns));
  let x = 0;
  if (mode === "random") {
    // 纯随机：每个放得下的列位机会均等，抽签只看这块自己的种子键
    const roll = mulberry32(seedFromKey(seed))();
    x = Math.min(columns - w, Math.floor(roll * (columns - w + 1)));
  } else {
    let bestY = Number.POSITIVE_INFINITY;
    for (let candidate = 0; candidate + w <= columns; candidate++) {
      let base = 0;
      for (let i = candidate; i < candidate + w; i++) base = Math.max(base, heights[i] ?? 0);
      if (base < bestY) {
        bestY = base;
        x = candidate;
      }
    }
  }
  // 两种模式都停在那几列已有的最高处之上（random 因此大量悬空与空洞——玩法如此）
  let y = 0;
  for (let i = x; i < x + w; i++) y = Math.max(y, heights[i] ?? 0);
  return { x, y, w, h: span.row };
}

/**
 * 按清单顺序逐块往下掉：同一份清单 + 同一个列数 + 同一个模式永远得到同一个布局。
 * `seed` 是每块自己的种子键（blackholeSeedKey），只在 random 模式下被读。
 */
export function packPlacements(
  spans: readonly { col: number; row: number; seed?: string }[],
  columns: number,
  mode: BlackholeDropMode = "lowest",
): BlackholePlacement[] {
  const placed: BlackholePlacement[] = [];
  for (const span of spans) placed.push(dropOne(placed, span, columns, mode, span.seed ?? ""));
  return placed;
}

/**
 * 抽掉一块之后的重力补位：**列位不动**，按原高度从低到高逐块重新往下落——正上方的
 * 块掉进空出来的位置，旁边的不挪（跟抽掉一块积木一样）。传入的是剩下的块（已去掉
 * 被删的那块），返回同顺序的新落位。
 */
export function settleAfterRemoval(placed: readonly BlackholePlacement[]): BlackholePlacement[] {
  const order = placed
    .map((_, index) => index)
    .sort((a, b) => (placed[a]?.y ?? 0) - (placed[b]?.y ?? 0) || a - b);
  const out = placed.slice();
  const done: BlackholePlacement[] = [];
  for (const index of order) {
    const p = placed[index];
    if (p === undefined) continue;
    let base = 0;
    for (const q of done) {
      if (q.x < p.x + p.w && p.x < q.x + q.w) base = Math.max(base, q.y + q.h);
    }
    const next = { ...p, y: base };
    out[index] = next;
    done.push(next);
  }
  return out;
}

// ── 放出流程：落点在「放出那一刻」只对已放出的块增量计算 ──────────────────────
//
// 2026-10 用户实测的 bug：一批材料到达时就按清单把落点全算好，动画却分批各自错开放出——
// 截图晚到几十毫秒、却先于大部分文件放出，落点算在「还没掉下来的文件」上面，悬在半空，
// 文件再塞进它下面。不变量因此改为：全盒一条放出队列，**放出顺序就是装箱顺序**，
// 每块的落点只踩已放出的块或盒底（dropOne 对已放出集合），正下方不会有留给后来者的空位。

/** 盒子的账本：已放出的块（按放出顺序）与它们的落位。没放出的块不在账上 */
export interface BlackholeLedger {
  columns: number;
  order: readonly string[];
  map: ReadonlyMap<string, BlackholePlacement>;
}

export const EMPTY_LEDGER: BlackholeLedger = { columns: 0, order: [], map: new Map() };

/**
 * 账本跟上现状：清单里没了的块拿掉、其余沿重力补位（**列位不动**，两种落位模式
 * 同一条规矩——删掉一块后旁边的块不拐弯，只往下掉，随机落点不重抽）；列数变了就
 * 按放出顺序整份重排（重排要用与当初相同的模式与种子，才不会一改窗口宽度整盒变样）。
 * `spanOf` 给出每个 id 当前的形状（半宽长条跟列数走），`seedOf` 给出随机模式的种子键。
 */
export function reconcileLedger(
  ledger: BlackholeLedger,
  present: ReadonlySet<string>,
  columns: number,
  spanOf: (id: string) => { col: number; row: number },
  mode: BlackholeDropMode = "lowest",
  seedOf: (id: string) => string = () => "",
): BlackholeLedger {
  const order = ledger.order.filter((id) => present.has(id));
  if (columns !== ledger.columns) {
    const packed = packPlacements(
      order.map((id) => ({ ...spanOf(id), seed: seedOf(id) })),
      columns,
      mode,
    );
    return { columns, order, map: new Map(order.map((id, i) => [id, packed[i] ?? { x: 0, y: 0, w: 1, h: 1 }])) };
  }
  if (order.length === ledger.order.length) return ledger;
  const kept = order.map((id) => ledger.map.get(id) ?? { x: 0, y: 0, w: 1, h: 1 });
  const settled = settleAfterRemoval(kept);
  return { columns, order, map: new Map(order.map((id, i) => [id, settled[i] ?? { x: 0, y: 0, w: 1, h: 1 }])) };
}

/** 放出一块：落点只看已放出的块（账上的），追加到放出顺序末尾 */
export function releaseInto(
  ledger: BlackholeLedger,
  id: string,
  span: { col: number; row: number },
  mode: BlackholeDropMode = "lowest",
  seed = "",
): BlackholeLedger {
  const placed = dropOne(Array.from(ledger.map.values()), span, ledger.columns, mode, seed);
  const map = new Map(ledger.map);
  map.set(id, placed);
  return { columns: ledger.columns, order: [...ledger.order, id], map };
}

/** 托住 p 的块：顶边正好贴着 p 的底、列有重叠的那些。p 在盒底时没有（盒底托着） */
export function supportersOf(
  p: BlackholePlacement,
  placed: Iterable<[string, BlackholePlacement]>,
): string[] {
  const out: string[] = [];
  if (p.y === 0) return out;
  for (const [id, q] of placed) {
    if (q !== p && q.y + q.h === p.y && q.x < p.x + p.w && p.x < q.x + q.w) out.push(id);
  }
  return out;
}

/** p 被托住了吗：在盒底，或至少有一块托着它 */
export function isSupported(p: BlackholePlacement, placed: Iterable<[string, BlackholePlacement]>): boolean {
  return p.y === 0 || supportersOf(p, placed).length > 0;
}

/**
 * 一块什么时候起跳：最早 `now`，但必须让它**落地晚于托它的每一块落地**（再隔一帧）——
 * 后放出的块落点更高、路程更短，不卡这一下就可能抢先落在还在半空的块上。
 */
export function fallStartAt(now: number, durationMs: number, supporterLandAts: readonly number[]): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const at of supporterLandAts) latest = Math.max(latest, at);
  return Math.max(now, latest + 16 - durationMs);
}

/**
 * 待放出队列按清单顺序插队：同一次拖进来的材料分几批到（文件先进状态、截图要先解码），
 * 吸入结束时谁排在清单前面谁先放出——于是同一批的落点与发出去后按清单重算的完全一致。
 */
export function enqueueByRank(queue: readonly string[], ids: readonly string[], rank: (id: string) => number): string[] {
  const out = [...queue];
  for (const id of ids) {
    if (out.includes(id)) continue;
    const r = rank(id);
    const at = out.findIndex((other) => rank(other) > r);
    if (at < 0) out.push(id);
    else out.splice(at, 0, id);
  }
  return out;
}

/**
 * 队头现在能不能放：还有排在它前面的块正在吸入（同一次拖入里晚到几十毫秒的截图），
 * 就等它——否则截图会落在先放出的文件上面，与「同一批截图先落」相反（CDP 时间序列
 * 抓到过：落地序列 ffIIII…）。返回能放的队头，或 null（再等一会儿）。
 */
export function nextReleasable(
  queue: readonly string[],
  sucking: Iterable<string>,
  rank: (id: string) => number,
): string | null {
  const head = queue[0];
  if (head === undefined) return null;
  const headRank = rank(head);
  for (const id of sucking) if (rank(id) < headRank) return null;
  return head;
}

/**
 * 排序键：先按批（一次拖入 / 一次点按 = 一批，跨批次按到达先后），批内按清单顺序
 * （截图在前、文件 / 目录在后——用户 2026-10 原话：一起拖进来先让图片落）。
 */
export function releaseRank(batchSeq: number, listIndex: number): number {
  return batchSeq * 100_000 + listIndex;
}

/** 落位占满后的外接尺寸（列、行）：盒子高度与快照宽度都从它来 */
export function packedExtent(placed: readonly BlackholePlacement[]): { cols: number; rows: number } {
  let cols = 0;
  let rows = 0;
  for (const p of placed) {
    cols = Math.max(cols, p.x + p.w);
    rows = Math.max(rows, p.y + p.h);
  }
  return { cols, rows };
}

/** 行 / 列数 → 像素（末尾不带间距）。0 行就是 0 高 */
export function cellsToPx(cells: number): number {
  return cells > 0 ? cells * BLACKHOLE_STEP_PX - BLACKHOLE_GAP_PX : 0;
}

/**
 * 盒子的限高：`spacePx` 是舷窗横条下沿到盒子底的距离。减掉安全距离后**向下取整到整行**，
 * 地板是两行格子。取整到整行是为了滚动态：可视窗口的高度永远是整数行，窗口底边
 * 落在行与行的间隙上，最底一行不会被拦腰切断（2026-10 验收：不取整时底行半截沉在
 * 盒子底边之下，看着像落进了输入卡）。内容超过它时盒子内部滚动。
 */
export function boxHeightCap(spacePx: number): number {
  const rows = Math.floor((spacePx - BLACKHOLE_SAFE_PX) / BLACKHOLE_STEP_PX);
  return Math.max(cellsToPx(MIN_CAP_ROWS), cellsToPx(Math.max(0, rows)));
}

/** 材料盒只在基础三套主题生效（浅 / 黛 / 玄）。纸面主题的裁决（2026-10 首版黑洞
 *  定下）是「稿纸自带一套语言，不叠这层动效」——俄罗斯方块虽然不演黑洞特效，但
 *  落块 + 回弹仍是叠在稿纸上的动效，首版沿用同一条限制（放开是一行改动，等用户在
 *  纸面主题上验收过再说）。 */
export const BLACKHOLE_THEMES = ["light", "graphite", "black"] as const;

/**
 * 输入框材料盒此刻的形态：null = 不启用（走原材料叠放）。开关开着，且当前
 * （已解析的）主题是基础三套之一。其他主题即使开关开着也走原材料区——开关的值
 * 不动，切回基础主题自动恢复。
 *
 * 黑洞与俄罗斯方块互斥（settings.ts 的 parseSettings 兑底过「两个都开」，这里
 * 再防一手）：两个都开时**黑洞优先**——先落盘的既有功能不让后来的实验玩法顶掉。
 */
export function materialBoxStyle(
  blackhole: boolean | undefined,
  tetris: boolean | undefined,
  theme: Exclude<ThemePreference, "system">,
): MaterialBoxStyle | null {
  const basic = (BLACKHOLE_THEMES as readonly string[]).includes(theme);
  if (blackhole === true && basic) return "blackhole";
  if (tetris === true && basic) return "tetris";
  return null;
}
