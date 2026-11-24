import "./galaxy-scan.css";
import { useEffect, useRef, useSyncExternalStore, type MutableRefObject } from "react";
import { Icon } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import { useT } from "../../locale.ts";
import type { Camera, Viewport } from "./galaxy.ts";
import type { GalaxyClock } from "./HomeGalaxy.tsx";
import { bodyPhysics, massRatio, pitDepth, probePath, ratioText, scanPath, sci, shortNumber, type Well } from "./gravity.ts";

/**
 * 星系上的「引力扫描」与「质量卡」（HomeGalaxy 挂上的一层，规则与数值在 gravity.ts）：
 * - ScanGrid：轨道平面上的透视网格，每个天体压出一个坑（坑深只随质量）。只在打开时挂；动效在跑（窗口在前台、可见、
 *   没有减少动效、没离电省电）时按 SCAN_FRAME_MS 重画一次（行星在公转，坑跟着走），停了就只画当前这一帧；
 *   转台拖动 / 缩放时由 HomeGalaxy 的 replan 叫一次 redraw，跟手。整张网格是一条 path，一次 DOM 写入。
 * - ScanToggle：右下角的开关（lucide radar + 文字）。开关状态全应用一份（各块星系一起开关），不落盘。
 * - MassCard：单击主星 / 行星 / 伴星弹出，固定在左上角（不跟着天体走：天体在转，跟着走的卡会盖住别的天体、
 *   字也一直在动读不稳；选中的那颗由命中圈常亮一圈细环标出来）。卡上「设计」键去设计面板（原来单击直接做的事）。
 */

/** 网格重画的间隔（ms）：行星公转很慢（最内圈一圈一分多钟），坑每帧挪不到半个像素，15 帧 / 秒看不出顿 */
export const SCAN_FRAME_MS = 66;

// ── 开关：全应用一份 ───────────────────────────────────────────────────

let scanOn = false;
const listeners = new Set<() => void>();

export function setScanOn(on: boolean): void {
  if (scanOn === on) return;
  scanOn = on;
  for (const listener of listeners) listener();
}

export function useScanOn(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => scanOn,
  );
}

// ── 网格 ──────────────────────────────────────────────────────────────

export interface ScanFrame {
  camera: Camera;
  viewport: Viewport;
  wells: readonly Well[];
  /** 网格中心（世界坐标）：这座星系的主星此刻在哪（联星时它绕质心走） */
  origin: { x: number; y: number };
  /** 主星此刻在屏幕上的位置（网格四周淡出的中心） */
  star: { x: number; y: number };
  /** 网格至少铺多远（世界单位，联星时盖住伴星）；0 = 默认 */
  reach: number;
}

export function ScanGrid(props: {
  /** grid = 网格（画在一切之下）；probe = 测深线（画在天体之上，gravity.probePath） */
  layer: "grid" | "probe";
  width: number;
  height: number;
  running: boolean;
  clock: GalaxyClock;
  frameAt: (tSec: number) => ScanFrame | null;
  /** HomeGalaxy 在转台拖动 / 缩放中调它：网格跟着视角走 */
  redraw: MutableRefObject<(() => void) | null>;
}) {
  const pathRef = useRef<SVGPathElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const frameAt = useRef(props.frameAt);
  const box = useRef({ width: props.width, height: props.height });
  box.current = { width: props.width, height: props.height };
  frameAt.current = props.frameAt;
  const { clock, running, redraw, layer } = props;
  // 画布四周各多铺 pad：联星时这一层跟着本星平移，网格的淡出遮罩（mask）只作用在元素盒子里，盒子不够大会露出一道直边
  const pad = Math.round(Math.max(props.width, props.height) / 2);
  useEffect(() => {
    const draw = (): void => {
      const path = pathRef.current;
      const svg = svgRef.current;
      const frame = frameAt.current(clock.now() / 1000);
      if (path === null || svg === null || frame === null) return;
      path.setAttribute("d", layer === "grid" ? scanPath(frame.camera, frame.viewport, frame.wells, frame.origin, frame.reach) : probePath(frame.camera, frame.viewport, frame.wells));
      svg.style.setProperty("--scan-x", `${(frame.star.x + pad).toFixed(0)}px`);
      svg.style.setProperty("--scan-y", `${(frame.star.y + pad).toFixed(0)}px`);
      // 淡出圈的半径按画布（不按加了 pad 的盒子）：联星时放大一档，把伴星圈进来
      const wide = frame.reach > 0;
      svg.style.setProperty("--scan-rx", `${Math.round(box.current.width * (wide ? 0.85 : 0.56))}px`);
      svg.style.setProperty("--scan-ry", `${Math.round(box.current.height * (wide ? 0.9 : 0.62))}px`);
    };
    redraw.current = draw;
    draw();
    let timer: number | null = null;
    if (running) {
      const tick = (): void => {
        draw();
        timer = window.setTimeout(tick, SCAN_FRAME_MS);
      };
      timer = window.setTimeout(tick, SCAN_FRAME_MS);
    }
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      if (redraw.current === draw) redraw.current = null;
    };
    // frameAt 变了（布局 / 视角换了）也重画一次：它在依赖里
  }, [clock, running, redraw, props.frameAt, layer, pad]);
  return (
    <svg
      ref={svgRef}
      className={layer === "grid" ? "gx-plane galaxy-scan" : "gx-plane galaxy-scan-probes"}
      style={{ left: -pad, top: -pad }}
      width={props.width + pad * 2}
      height={props.height + pad * 2}
      viewBox={`${-pad} ${-pad} ${Math.max(props.width, 1) + pad * 2} ${Math.max(props.height, 1) + pad * 2}`}
      aria-hidden="true"
      data-scan={layer}
    >
      <path ref={pathRef} className={layer === "grid" ? "galaxy-scan-grid" : "galaxy-scan-probe"} />
    </svg>
  );
}

export function ScanToggle() {
  const t = useT();
  const tg = t.gravity;
  const on = useScanOn();
  return (
    <button
      type="button"
      className="quiet-control galaxy-scan-toggle"
      aria-pressed={on}
      title={on ? tg.scanOffTip : tg.scanOnTip}
      onClick={() => setScanOn(!on)}
      // 不让按下变成转台拖动的起点
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Icon name="radar" size={14} strokeWidth={1.8} />
      <span>{tg.scan}</span>
    </button>
  );
}

// ── 质量卡 ────────────────────────────────────────────────────────────

export interface CardBody {
  id: string;
  kind: "star" | "planet" | "companion";
  name: string;
  /** 界面质量（M⊕ × 10） */
  massUi: number;
  /** 密度（g/cm³） */
  density: number;
  /** 这颗画出来比主星还大（小主星 + 大行星）：卡上补一句「看起来大，但更轻」 */
  looksBigger: boolean;
}

export function MassCard(props: { body: CardBody; starMassUi: number; onDesign: (() => void) | null; onClose: () => void }) {
  const t = useT();
  const tg = t.gravity;
  const { body } = props;
  const phys = bodyPhysics(body.massUi, body.density);
  const ratio = massRatio(body.massUi, props.starMassUi);
  const pit = pitDepth(body.massUi) / Math.max(pitDepth(props.starMassUi), 1e-9);
  const kind = body.kind === "star" ? tg.kindStar : body.kind === "planet" ? tg.kindPlanet : tg.kindCompanion;
  const ratioLine =
    body.kind === "star" ? tg.ratioSelf : `${ratioText(ratio)} · ${shortNumber(ratio * 100)}%`;
  return (
    <section
      className="galaxy-mass-card"
      aria-label={tg.cardLabel(body.name)}
      data-kind={body.kind}
      data-body={body.id}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          props.onClose();
        }
      }}
    >
      <header className="galaxy-mass-head">
        <span className="galaxy-mass-kind">{kind}</span>
        <strong className="galaxy-mass-name">{body.name}</strong>
        <IconButton label={tg.close} title={tg.close} size={20} onClick={props.onClose}>
          <Icon name="x" size={12} strokeWidth={1.8} />
        </IconButton>
      </header>
      <dl className="galaxy-mass-rows">
        <dt>{tg.mass}</dt>
        <dd data-field="mass">
          <span>{phys === null ? "—" : `${shortNumber(phys.massEarth)} M⊕`}</span>
          <span className="galaxy-mass-sub">{phys === null ? "" : `${sci(phys.massKg)} kg`}</span>
        </dd>
        <dt>{tg.radius}</dt>
        <dd data-field="radius">
          <span>{phys === null ? "—" : `${shortNumber(phys.radiusEarth)} R⊕`}</span>
          <span className="galaxy-mass-sub">{phys === null ? "" : `${shortNumber(phys.radiusKm)} km`}</span>
        </dd>
        <dt>{tg.density}</dt>
        <dd data-field="density">
          <span>{phys === null ? "—" : `${shortNumber(phys.density)} g/cm³`}</span>
        </dd>
        <dt>{tg.ratio}</dt>
        <dd data-field="ratio">
          <span>{ratioLine}</span>
        </dd>
        <dt>{tg.pit}</dt>
        <dd data-field="pit">
          <span>{body.kind === "star" ? "100%" : tg.pitOf(`${shortNumber(pit * 100)}%`)}</span>
        </dd>
      </dl>
      {body.looksBigger && body.kind === "planet" && <p className="galaxy-mass-note">{tg.lookNote}</p>}
      {props.onDesign !== null && (
        <button type="button" className="quiet-control galaxy-mass-design" onClick={props.onDesign}>
          <Icon name="paintbrush" size={12} strokeWidth={1.8} />
          <span>{tg.design}</span>
        </button>
      )}
    </section>
  );
}
