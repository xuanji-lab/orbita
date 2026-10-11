import "./blackhole.css";
import { createContext, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileChip } from "./composer-material-stack.tsx";
import { ImageLightbox } from "./ImageLightbox";
import { ImageThumb } from "./ImageThumb";
import { imageSrc } from "./composer-images.ts";
import type { ComposerMaterial } from "./composer-materials.ts";
import {
  BLACKHOLE_STEP_PX,
  blackholeSpan,
  boxHeightCap,
  cellsToPx,
  columnsForWidth,
  EMPTY_LEDGER,
  enqueueByRank,
  fallStartAt,
  nextReleasable,
  packedExtent,
  reconcileLedger,
  releaseInto,
  releaseRank,
  supportersOf,
  type BlackholePlacement,
  type BlackholeSpan,
} from "./blackhole-layout.ts";
import { useT } from "../locale.ts";

/**
 * 输入框黑洞（设置 › Agent › 输入框黑洞，默认关；只在浅 / 黛 / 玄生效，判定见
 * blackhole-layout.ts 的 blackholeActive）。App 根部算好一次，输入框与转录里的
 * 用户消息都从这里读——开关关着时两处都走原样。
 */
export const BlackholeContext = createContext(false);

/** 进盒子的材料：截图 / 文件 / 目录。引用不进盒子——它算消息正文，待在盒子下面 */
export type BoxMaterial = Extract<ComposerMaterial, { kind: "image" | "file" | "dir" }>;

// ── 手感参数（用户 2026-10 在原型里认可的那一组） ──────────────────────────
/** 重力加速度（px/s²）：从会话顶端掉到输入框约 0.6s */
const GRAVITY = 2600;
/** 落地回弹的高度（px）。设计系统 motion 原则写的是 no bounce，这里按用户原话留一点 */
const BOUNCE_PX = 6;
/** 吸入（替身螺旋缩进中心）的时长 */
const SUCK_MS = 560;
/** 一批材料依次掉落的间隔 */
const FALL_STAGGER_MS = 110;
/** 悬停多久中心黑满 */
const HOVER_RAMP_MS = 1400;
/** 投放 / 粘贴记下的起点多久内算数：附件要读文件、复制，进状态有延迟 */
const ORIGIN_TTL_MS = 2500;
/** 发送时记下的飞行起点多久内算数：消息进转录的那一刻消费 */
const FLIGHT_TTL_MS = 2500;
/** 悬停变黑的椭圆尺寸随输入卡宽走：用户调手感那版原型的输入卡是 760px、半径爬满
 *  132px（rx = 264 = 卡宽的 35%）。真应用的卡更宽（默认 1000px），同一公式不缩放的话
 *  在宽卡上只是中心一小团（2026-10 验收：深色首页的洞小得几乎看不出、光子环弱）。
 *  按卡宽等比缩放，让洞在卡上的占比与原型一致。 */
const PROTO_COMPOSER_W = 760;
/** 「未复制」标记额外占的宽度：胶囊会因此长一截 */
const UNCOPIED_EXTRA_PX = 80;
/** 精确的 y = t² 曲线（三次贝塞尔的控制点 1/3、2/3） */
const GRAVITY_EASING = "cubic-bezier(.333,0,.667,.333)";

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

/** 材料 → 形状（截图正方形 / 小胶囊 / 半宽长条） */
export function boxSpan(item: { kind: "image" | "file" | "dir"; name: string; uncopied?: boolean }, columns: number): BlackholeSpan {
  return blackholeSpan(item.kind, item.name, columns, item.uncopied === true ? UNCOPIED_EXTRA_PX : 0);
}

// ── 起点与批次：这批材料是从哪进来的（窗口级捕获，不改任何既有的拖放 / 粘贴处理） ─────
/**
 * 一批：一次拖入 / 一次点按 / 一次粘贴。`expected` 是这次投放带了几个文件——一次拖入的
 * 材料会分几拨进状态（文件 / 目录同步入列，截图要读字节、解码，晚几十到几百毫秒），
 * 放出队列等这一批到齐（或超时）再放，批内才能「截图先落」。
 */
type Batch = { seq: number; at: number; expected: number; seen: number; x: number; y: number; hovered: boolean };
/** 一批最多等多久到齐：被拒的文件（超数、重复）永远不会到，不能一直等 */
const GATHER_MS = 1500;
let batchSeq = 0;
let drops: Batch[] = [];
let lastDrag: { x: number; y: number } | null = null;
let lastPaste = 0;
let listening = false;
function listenForOrigins(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("dragover", (event) => (lastDrag = { x: event.clientX, y: event.clientY }), true);
  window.addEventListener(
    "drop",
    (event) => {
      const now = performance.now();
      drops = drops.filter((d) => now - d.at < ORIGIN_TTL_MS);
      drops.push({
        seq: ++batchSeq,
        at: now,
        expected: event.dataTransfer?.files.length ?? 0,
        seen: 0,
        x: event.clientX,
        y: event.clientY,
        hovered: true,
      });
    },
    true,
  );
  window.addEventListener("paste", () => (lastPaste = performance.now()), true);
}
/**
 * 这一拨属于哪一批、从哪被吸进来：还没到齐的最早一次投放（投放按先后进状态）→ 投放点；
 * 刚粘贴 → 输入区左上（光标附近）；否则 → 回形针按钮的位置（新的一批）。
 */
function takeBatch(card: DOMRect, count: number): Batch {
  const now = performance.now();
  drops = drops.filter((d) => now - d.at < ORIGIN_TTL_MS);
  const open = drops.find((d) => d.seen < d.expected) ?? drops[drops.length - 1];
  if (open !== undefined) {
    open.seen += count;
    return open;
  }
  const pasted = now - lastPaste < ORIGIN_TTL_MS;
  if (pasted) lastPaste = 0;
  return {
    seq: ++batchSeq,
    at: now,
    expected: count,
    seen: count,
    x: pasted ? card.left + 48 : card.left + 24,
    y: pasted ? card.top + 24 : card.bottom - 20,
    hovered: false,
  };
}

/** 这一批还在等后面几拨吗（没到齐、也没超时） */
function gathering(batch: Batch | undefined): boolean {
  return batch !== undefined && batch.seen < batch.expected && performance.now() - batch.at < GATHER_MS;
}

/** 舷窗所在的那条线（屏幕 y）：会话滚动区的顶边；首页是舞台顶边；都没有就盒子上方 240px */
function portholeLine(box: HTMLElement): number {
  const anchor = box.closest("[data-chat-pane]")?.querySelector("[data-porthole-anchor]");
  if (anchor !== null && anchor !== undefined) return anchor.getBoundingClientRect().top;
  const stage = box.closest(".home-stage");
  if (stage !== null) return stage.getBoundingClientRect().top;
  return Math.max(0, box.getBoundingClientRect().top - 240);
}

// ── 动画件：都是一次性的，reduced motion 时调用方直接跳过 ─────────────────────
function bounce(el: HTMLElement): Promise<unknown> {
  return el.animate(
    [
      { transform: "translateY(0) scale(1.04, .9)", easing: "cubic-bezier(.33,.66,.66,1)" },
      { transform: `translateY(${-BOUNCE_PX}px) scale(.98, 1.03)`, offset: 0.42, easing: GRAVITY_EASING },
      { transform: "translateY(0) scale(1, 1)" },
    ],
    { duration: 120 + BOUNCE_PX * 14 },
  ).finished;
}

/** 从 `fromPx` 高处自由落体要多久（ms）：y = ½gt² */
function fallDuration(fromPx: number): number {
  return Math.max(160, Math.sqrt((2 * Math.max(0, fromPx)) / GRAVITY) * 1000);
}

/**
 * 从 `fromPx` 高处沿重力落下，落地压扁再回弹。`delayMs` 期间停在起点（backwards 填充：
 * 藏在舷窗线以上），等托它的块先落地。
 */
function fall(el: HTMLElement, fromPx: number, delayMs: number): Promise<unknown> {
  return el
    .animate([{ transform: `translateY(${-fromPx}px)` }, { transform: "translateY(0)" }], {
      duration: fallDuration(fromPx),
      delay: Math.max(0, delayMs),
      fill: "backwards",
      easing: GRAVITY_EASING,
    })
    .finished.then(() => bounce(el));
}

/** 替身沿一圈收紧的螺线缩进中心：旋转、越近越快、最后一段淡掉 */
function spiral(ghost: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }): Promise<unknown> {
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  const r0 = Math.hypot(dx, dy);
  const a0 = Math.atan2(dy, dx);
  const dir = dx >= 0 ? 1 : -1;
  const frames: Keyframe[] = [];
  const steps = 18;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const r = r0 * (1 - t) ** 1.35;
    const a = a0 + dir * Math.PI * 0.75 * t ** 1.4;
    const s = Math.max(0.04, 1 - 0.96 * t ** 1.25);
    frames.push({
      transform: `translate(${Math.cos(a) * r}px, ${Math.sin(a) * r}px) rotate(${dir * 300 * t ** 1.6}deg) scale(${s})`,
      opacity: t < 0.72 ? 1 : 1 - (t - 0.72) / 0.28,
    });
  }
  return ghost.animate(frames, { duration: SUCK_MS, easing: "cubic-bezier(.4,0,.75,.6)" }).finished;
}

/** 把一个格子的 DOM 拷成 fixed 层的替身，摆在 rect 处（不进 React 树，播完即删） */
function ghostOf(cell: HTMLElement, rect: { left: number; top: number; width: number; height: number }): HTMLElement {
  const ghost = cell.cloneNode(true) as HTMLElement;
  ghost.classList.add("bh-ghost");
  ghost.removeAttribute("data-bh-id");
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    bottom: "auto",
    visibility: "visible",
    transform: "none",
  });
  document.body.append(ghost);
  return ghost;
}

// ── 发送：输入框盒子的样子交给转录里那条新消息，它飞过去 ──────────────────────
type FlightPart = { rect: DOMRect; node: HTMLElement };
let pendingFlight: { at: number; parts: FlightPart[] } | null = null;

/** 发送前调用：记下盒子里每块的位置与样子（DOM 顺序 = 清单顺序 = 消息里的顺序） */
export function captureBlackholeFlight(box: HTMLElement | null): void {
  if (box === null || reducedMotion()) {
    pendingFlight = null;
    return;
  }
  // 还没放出的块（藏在盒底等着的）不算：块数对不上就不飞
  const cells = Array.from(box.querySelectorAll<HTMLElement>(".bh-cell:not([data-staged])"));
  pendingFlight =
    cells.length === 0
      ? null
      : {
          at: performance.now(),
          parts: cells.map((cell) => ({ rect: cell.getBoundingClientRect(), node: cell.cloneNode(true) as HTMLElement })),
        };
}

/**
 * 新消息的缩小盒子挂上时调用：块数对得上、且是刚发的，就让每块从输入框上方的
 * 旧位置飞到消息里的新位置（替身走 fixed 层，不被滚动区裁掉），落定后换回真块。
 */
export function flyBlackholeInto(targets: readonly HTMLElement[]): void {
  const flight = pendingFlight;
  if (flight === null || performance.now() - flight.at > FLIGHT_TTL_MS || flight.parts.length !== targets.length) return;
  pendingFlight = null;
  flight.parts.forEach((part, index) => {
    const target = targets[index];
    if (target === undefined) return;
    const to = target.getBoundingClientRect();
    const ghost = part.node;
    ghost.classList.add("bh-ghost");
    ghost.setAttribute("aria-hidden", "true");
    Object.assign(ghost.style, {
      left: `${part.rect.left}px`,
      top: `${part.rect.top}px`,
      width: `${part.rect.width}px`,
      height: `${part.rect.height}px`,
      bottom: "auto",
      visibility: "visible",
      transform: "none",
      transformOrigin: "0 0",
    });
    document.body.append(ghost);
    target.style.visibility = "hidden";
    const sx = to.width / part.rect.width;
    const sy = to.height / part.rect.height;
    ghost
      .animate(
        [{ transform: "none" }, { transform: `translate(${to.left - part.rect.left}px, ${to.top - part.rect.top}px) scale(${sx}, ${sy})` }],
        { duration: 420, easing: "cubic-bezier(.4,0,.6,1)" },
      )
      .finished.catch(() => undefined)
      .finally(() => {
        ghost.remove();
        target.style.visibility = "";
      });
  });
}

/**
 * 输入框上方的隐形盒子：没盖子、没边框、没底色。材料被吸进输入卡中心，从会话顶端的
 * 舷窗掉下来，落进这里堆起来。不设行数上限，堆高到「舷窗下沿 → 盒底减安全距离」
 * （boxHeightCap）之后盒子内部滚动。
 *
 * 交互与 B 叠放一致：截图点开看大图、带移除键；文件 / 目录是同一颗胶囊（路径快速
 * tooltip、未复制标记、移除键）。移除键是按钮，Tab 可达。
 */
export function BlackholeBox(props: {
  materials: readonly BoxMaterial[];
  /** 输入卡：中心变黑那一层画在卡里 */
  cardRef: React.RefObject<HTMLDivElement | null>;
  /** 盒子本体：发送时 Composer 用它记下飞行起点 */
  boxRef: React.RefObject<HTMLDivElement | null>;
  /** 有文件正拖在聊天面板上方（ChatView 的 dropActive） */
  dragActive: boolean;
}) {
  const t = useT();
  const boxRef = props.boxRef;
  const [columns, setColumns] = useState(0);
  const [cap, setCap] = useState(Number.POSITIVE_INFINITY);
  const [viewing, setViewing] = useState<number | null>(null);
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  const cells = useRef(new Map<string, HTMLDivElement>());
  const holeRef = useRef<HTMLDivElement | null>(null);
  const portholeRef = useRef<HTMLDivElement | null>(null);
  const portholeRaf = useRef(0);

  // 输入卡排在盒子后面：盒子的 layout effect 跑的时候卡的 ref 可能还没挂上，等提交完再取
  useEffect(() => {
    listenForOrigins();
    setCard(props.cardRef.current);
  }, [props.cardRef]);

  // 盒宽 → 列数；连同限高一起跟着窗口缩放重算
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    const measure = (): void => {
      setColumns(columnsForWidth(box.clientWidth));
      setCap(boxHeightCap(box.getBoundingClientRect().bottom - portholeLine(box)));
      // 舷窗开着时，盒子尺寸 / 窗口的变化都要把裁切边重新钉回舷窗线（ResizeObserver
      // 在高度过渡的每一帧都会触发）
      if (portholeRef.current?.dataset["open"] === "true") applyPorthole();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [boxRef]);

  const items = props.materials;
  const ids = items.map((item) => item.id);
  const spanById = new Map(
    items.map((item) => [
      item.id,
      boxSpan({ kind: item.kind, name: item.name, uncopied: item.kind !== "image" && item.ref.uncopied === true }, columns),
    ]),
  );
  // 放出队列是异步跑的：它读的清单与形状必须是最新一次渲染的，不能是起跑那次闭包里的
  const latest = useRef({ ids, spanById });
  latest.current = { ids, spanById };
  const spanOf = (id: string): BlackholeSpan =>
    latest.current.spanById.get(id) ?? { shape: "capsule", col: 3, row: 1 };
  // 放出排序：先按批（到达先后），批内按清单顺序（截图在前）
  const rankOf = (id: string): number =>
    releaseRank(flow.current.batchOf.get(id)?.seq ?? 0, latest.current.ids.indexOf(id));

  // ── 账本（blackhole-layout.ts）：已放出的块与落位。没放出的块不上账、藏在盒底等着 ──────
  // 渲染时只做幂等的对账（删掉的拿掉并补位、列数变了重排）；放出由下面的队列逐块做。
  const flow = useRef({
    ledger: EMPTY_LEDGER,
    /** 见过的 id：第一次见到的才算新到（要吸入、排队） */
    known: new Set<string>(),
    /** 新到、还没开始吸入的（layout effect 取走） */
    arrived: [] as string[],
    /** 吸入完、等着放出的（按清单顺序插队） */
    queue: [] as string[],
    /** 刚放出、还没起跳的（layout effect 取走） */
    released: [] as string[],
    /** 每块预计落地的时刻：后放出的块要等托它的块落地 */
    landAt: new Map<string, number>(),
    /** 正在吸入的（替身还在螺旋里） */
    sucking: new Set<string>(),
    pumping: false,
    /** 每块属于哪一批 */
    batchOf: new Map<string, Batch>(),
    /** 吸入中 + 排队 + 半空中的块数：舷窗开关跟它走 */
    airborne: 0,
    mounted: false,
  });
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const f = flow.current;
  const present = new Set(ids);
  if (columns > 0) f.ledger = reconcileLedger(f.ledger, present, columns, spanOf);
  f.queue = f.queue.filter((id) => present.has(id));
  for (const id of Array.from(f.known)) if (!present.has(id)) f.known.delete(id);
  for (const id of ids) {
    if (f.known.has(id)) continue;
    f.known.add(id);
    // 首次挂上（切会话 / 开开关时已有草稿）、还没量出列数、减弱动态：直接落位，不演
    if (!f.mounted || columns === 0 || reducedMotion()) {
      if (columns > 0) f.ledger = releaseInto(f.ledger, id, spanOf(id));
    } else {
      f.arrived.push(id);
    }
  }
  // 列数终于量出来时，把首挂时没能落位的补上
  if (columns > 0) {
    for (const id of ids) {
      if (!f.ledger.map.has(id) && !f.arrived.includes(id) && !f.queue.includes(id) && !f.sucking.has(id)) {
        f.ledger = releaseInto(f.ledger, id, spanOf(id));
      }
    }
  }
  const placed = f.ledger.map;
  const { rows } = packedExtent(Array.from(placed.values()));
  const contentHeight = cellsToPx(rows);
  const scroll = contentHeight > cap;
  const images = items.filter((item): item is Extract<BoxMaterial, { kind: "image" }> => item.kind === "image");

  // ── 中心变黑：浓度 k 随悬停时长爬升、随离中心的距离打折；按需起停的 rAF，静止时不跑 ──
  const hole = useRef({ k: 0, r: 40, target: 0, targetR: 40, enter: 0, dragging: false, raf: 0, last: 0 });
  const kickHole = (): void => {
    const h = hole.current;
    if (h.raf !== 0) return;
    h.last = performance.now();
    const step = (now: number): void => {
      const el = holeRef.current;
      const cardEl = props.cardRef.current;
      // rAF 的时间戳可能早于 kick 时取的 performance.now()：负的 dt 会让插值发散
      const dt = Math.max(0, now - h.last);
      h.last = Math.max(h.last, now);
      if (h.dragging && cardEl !== null) {
        const rect = cardEl.getBoundingClientRect();
        const point = lastDrag ?? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        const distance = Math.hypot(point.x - (rect.left + rect.width / 2), point.y - (rect.top + rect.height / 2));
        const near = 1 - Math.min(1, distance / Math.max(1, rect.width / 2));
        const time = Math.min(1, (now - h.enter) / HOVER_RAMP_MS);
        h.target = time * (0.45 + 0.55 * near);
        h.targetR = ((36 + 96 * h.target) * rect.width) / PROTO_COMPOSER_W;
      }
      const lerp = Math.min(1, 1 - Math.exp(-dt / 90));
      h.k += (h.target - h.k) * lerp;
      h.r += (h.targetR - h.r) * lerp;
      if (el !== null && cardEl !== null) {
        el.style.opacity = String(h.k);
        el.style.setProperty("--bh-rx", `${h.r * 2}px`);
        el.style.setProperty("--bh-ry", `${Math.min(h.r * 0.8, cardEl.clientHeight * 0.7)}px`);
      }
      if (!h.dragging && h.target === 0 && h.k < 0.004) {
        h.k = 0;
        if (el !== null) el.style.opacity = "0";
        h.raf = 0;
        return;
      }
      h.raf = window.requestAnimationFrame(step);
    };
    h.raf = window.requestAnimationFrame(step);
  };
  const setHole = (target: number, targetR: number): void => {
    hole.current.target = target;
    hole.current.targetR = targetR;
    if (!reducedMotion()) kickHole();
  };
  useEffect(() => {
    const h = hole.current;
    if (reducedMotion()) return;
    if (props.dragActive) {
      h.dragging = true;
      h.enter = performance.now();
      kickHole();
      return;
    }
    if (!h.dragging) return;
    h.dragging = false;
    // 松手后保持一会儿等附件进状态（吸入时接管）；等不到就褪回
    const timer = window.setTimeout(() => setHole(0, 40), ORIGIN_TTL_MS);
    return () => window.clearTimeout(timer);
    // kickHole / setHole 只读 ref，不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.dragActive]);
  useEffect(() => () => window.cancelAnimationFrame(hole.current.raf), []);
  useEffect(() => () => window.cancelAnimationFrame(portholeRaf.current), []);

  // ── 舷窗：吸入完到最后一块落地之间开着；舷窗线以上裁掉（材料从缝里「冒出来」） ───────
  /** 按盒子当前几何重贴舷窗与裁切。inset 是一次性像素值，而盒子长高 / 窗口缩放都会
   *  挪动盒子上缘——不重算的话裁切边跟着上移，下落中的材料会画到舷窗线之上、盖住
   *  会话头部（2026-10 验收：连拍里材料压住了标题栏）。开着的期间每逢几何变化都重贴。 */
  const applyPorthole = (): void => {
    const box = boxRef.current;
    const el = portholeRef.current;
    if (box === null || el === null) return;
    const rect = box.getBoundingClientRect();
    const line = portholeLine(box);
    Object.assign(el.style, { left: `${rect.left - 12}px`, width: `${rect.width + 24}px`, top: `${line}px` });
    box.style.clipPath = `inset(${-(rect.top - line)}px -48px -16px -48px)`;
  };
  const openPorthole = (): void => {
    const el = portholeRef.current;
    if (el !== null) el.dataset["open"] = "true";
    applyPorthole();
    // 盒子长高有 220ms 高度过渡：inset 是一次性像素值，过渡的每一帧都得把裁切边
    // 重钉回舷窗线。ResizeObserver 在过渡期间有一帧滞后（实测裁切边高出线 9–11px），
    // 这里在 rAF 里强制同步布局——读到的是本帧动画插值后的值，零滞后。
    const tick = (): void => {
      if (portholeRef.current?.dataset["open"] !== "true") {
        portholeRaf.current = 0;
        return;
      }
      applyPorthole();
      portholeRaf.current = window.requestAnimationFrame(tick);
    };
    if (portholeRaf.current === 0) portholeRaf.current = window.requestAnimationFrame(tick);
  };
  const closePorthole = (): void => {
    const el = portholeRef.current;
    if (el !== null) el.dataset["open"] = "false";
    window.cancelAnimationFrame(portholeRaf.current);
    portholeRaf.current = 0;
    const box = boxRef.current;
    if (box !== null) box.style.clipPath = "";
  };
  const lift = (): void => {
    if (f.airborne++ === 0) openPorthole();
  };
  const land = (): void => {
    f.airborne = Math.max(0, f.airborne - 1);
    if (f.airborne === 0) void wait(220).then(() => f.airborne === 0 && closePorthole());
  };

  /** 放出队列：全盒只有一条。每 FALL_STAGGER_MS 放一块，落点在放出这一刻只对已放出的块算 */
  const pump = async (): Promise<void> => {
    if (f.pumping) return;
    f.pumping = true;
    while (f.queue.length > 0) {
      f.queue = f.queue.filter((qid) => f.known.has(qid));
      const head = f.queue[0];
      const id = gathering(head === undefined ? undefined : f.batchOf.get(head))
        ? null
        : nextReleasable(f.queue, f.sucking, rankOf);
      if (id === null) {
        // 同一批还没到齐，或排在前面的还在吸入：等一会儿
        await wait(30);
        continue;
      }
      f.queue.shift();
      f.ledger = releaseInto(f.ledger, id, spanOf(id));
      f.released.push(id);
      bump();
      await wait(FALL_STAGGER_MS);
    }
    f.pumping = false;
  };

  /** 新到的一批：替身螺旋缩进输入卡中心 → 中心褪黑 → 按清单顺序排进放出队列 */
  const suckIn = async (arrived: readonly string[]): Promise<void> => {
    const cardEl = props.cardRef.current;
    const rect = cardEl?.getBoundingClientRect();
    if (rect === undefined) {
      for (let i = 0; i < arrived.length; i++) lift();
      f.queue = enqueueByRank(f.queue, arrived, rankOf);
      void pump();
      return;
    }
    for (const id of arrived) {
      f.sucking.add(id);
      lift();
    }
    const origin = takeBatch(rect, arrived.length);
    for (const id of arrived) f.batchOf.set(id, origin);
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    // 没有悬停的入口（按钮 / 粘贴）：中心快速聚出一团黑接住替身（半径同样按卡宽等比）
    if (origin.hovered) setHole(Math.max(hole.current.k, 0.9), Math.max(hole.current.r, (120 * rect.width) / PROTO_COMPOSER_W));
    else setHole(0.8, (110 * rect.width) / PROTO_COMPOSER_W);
    await Promise.all(
      arrived.map(async (id, index) => {
        const staged = cells.current.get(id);
        if (staged === undefined) return;
        const size = staged.getBoundingClientRect();
        const ghost = ghostOf(staged, {
          left: center.x - size.width / 2,
          top: center.y - size.height / 2,
          width: size.width,
          height: size.height,
        });
        ghost.style.visibility = "hidden";
        await wait(index * 70);
        ghost.style.visibility = "visible";
        await spiral(ghost, { x: origin.x + index * 18, y: origin.y - index * 10 }, center).catch(() => undefined);
        ghost.remove();
      }),
    );
    setHole(0, 40);
    await wait(120);
    // 吸入期间被删掉的不再排队；其余按清单顺序插进队列（同一次拖入分几批到也是同一个顺序）
    for (const id of arrived) f.sucking.delete(id);
    const alive = arrived.filter((id) => f.known.has(id));
    for (let i = alive.length; i < arrived.length; i++) land();
    f.queue = enqueueByRank(f.queue, alive, rankOf);
    void pump();
  };

  /** 刚放出的一块起跳：从舷窗线沿重力落到账上的落点；托它的块没落地之前不让它先到 */
  const launch = (id: string): void => {
    const el = cells.current.get(id);
    const box = boxRef.current;
    const p = f.ledger.map.get(id);
    if (el === undefined || box === null || p === undefined) {
      land();
      return;
    }
    const r = el.getBoundingClientRect();
    const fromPx = r.top - portholeLine(box) + r.height + 4;
    const duration = fallDuration(fromPx);
    const now = performance.now();
    const supporters = supportersOf(p, f.ledger.map).map((sid) => f.landAt.get(sid) ?? 0);
    const start = fallStartAt(now, duration, supporters);
    f.landAt.set(id, start + duration);
    el.style.visibility = "";
    void fall(el, fromPx, start - now)
      .catch(() => undefined)
      .finally(land);
  };

  // ── 每次提交后：新到的开始吸入；刚放出的起跳；删除后被补位的块沿重力落下 ─────────────
  const committed = useRef(new Map<string, BlackholePlacement>());
  useLayoutEffect(() => {
    const before = committed.current;
    const wasMounted = f.mounted;
    f.mounted = true;
    committed.current = new Map(placed);
    // 舷窗开着时每次提交后重贴裁切：盒子的每次长高（含高度过渡中的每一帧）
    // 都把裁切边钉回舷窗线，落体永远只画在缝以下
    if (portholeRef.current?.dataset["open"] === "true") applyPorthole();
    if (!wasMounted) {
      // 首挂：账上没有的（列数还没量出）下一次渲染再落位
      bump();
      return;
    }
    const arrived = f.arrived;
    f.arrived = [];
    const released = f.released;
    f.released = [];
    if (reducedMotion()) {
      if (arrived.length > 0) {
        f.queue = enqueueByRank(f.queue, arrived, rankOf);
        for (const id of f.queue) f.ledger = releaseInto(f.ledger, id, spanOf(id));
        f.queue = [];
        bump();
      }
      return;
    }
    if (arrived.length > 0) void suckIn(arrived);
    for (const id of released) launch(id);
    for (const [id, p] of placed) {
      const old = before.get(id);
      if (old === undefined || released.includes(id)) continue;
      const drop = (old.y - p.y) * BLACKHOLE_STEP_PX;
      const el = cells.current.get(id);
      if (drop > 0 && el !== undefined) void fall(el, drop, 0).catch(() => undefined);
    }
    // 读写的都是 ref 与 DOM；依赖只认这一次提交
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  return (
    <>
      <div
        ref={boxRef}
        className="bh-box"
        data-scroll={scroll}
        style={{ height: scroll ? cap : contentHeight }}
        aria-label={t.composer.materialBox}
        role="group"
      >
        {viewing !== null && (
          <ImageLightbox
            images={images.map((item) => item.image.image)}
            startIndex={viewing}
            onClose={() => setViewing(null)}
          />
        )}
        <div className="bh-inner" style={{ height: contentHeight }}>
          {items.map((item) => {
            const placedAt = placed.get(item.id);
            const span = spanOf(item.id);
            // 没放出的块：按形状的尺寸藏在盒底（不可见、不可聚焦），吸入时拿它的样子做替身
            const p = placedAt ?? { x: 0, y: 0, w: Math.min(span.col, Math.max(1, columns)), h: span.row };
            // 刚放出、还没起跳的块先藏着（起跳动画的 backwards 填充接手）
            const hidden = placedAt === undefined || f.released.includes(item.id);
            return (
              <div
                key={item.id}
                ref={(el) => {
                  if (el === null) cells.current.delete(item.id);
                  else cells.current.set(item.id, el);
                }}
                className="bh-cell"
                data-bh-id={item.id}
                data-staged={placedAt === undefined ? "" : undefined}
                aria-hidden={placedAt === undefined ? true : undefined}
                style={{
                  left: p.x * BLACKHOLE_STEP_PX,
                  bottom: p.y * BLACKHOLE_STEP_PX,
                  width: cellsToPx(p.w),
                  height: cellsToPx(p.h),
                  visibility: hidden ? "hidden" : undefined,
                }}
              >
                {item.kind === "image" ? (
                  <ImageThumb
                    src={imageSrc(item.image.image)}
                    name={item.name}
                    size={cellsToPx(p.w)}
                    openLabel={t.lightbox.open}
                    onOpen={() => setViewing(images.indexOf(item))}
                    paperclip
                    onRemove={item.remove}
                    removeLabel={t.composer.removeImage}
                  />
                ) : (
                  <FileChip
                    name={item.name}
                    path={item.ref.path}
                    kind={item.kind}
                    uncopied={item.ref.uncopied === true}
                    onRemove={item.remove}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {card !== null && createPortal(<div ref={holeRef} className="bh-hole" aria-hidden="true" />, card)}
      {createPortal(
        <div ref={portholeRef} className="bh-porthole" aria-hidden="true">
          <div className="bh-porthole-glow" />
          <div className="bh-porthole-slit" />
        </div>,
        document.body,
      )}
    </>
  );
}
