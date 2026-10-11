import "./usage.css";
import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { useT } from "../locale.ts";
import { formatTokens } from "../utils/format-tokens.ts";
import { isWindowInactive } from "./window-activity.ts";
import { useHoverTooltip } from "./useHoverTooltip.ts";
import { petLeft, shortDate, usageWeekCells, type UsageCell, type UsageTier } from "./usage-week.ts";
import type { UsageDayTotal } from "@shared/usage";

/**
 * 侧栏左下角的 7 天 token 用量格 + 星云能量体。
 *
 * - 7 格从今天往回数，**右端是今天**；档位按「当天 / 7 天最大值」的比例。
 * - 星云默认坐在今天上方、显示今天的档位；悬停某格时移过去、换那天的档位
 *   （移动与大小收放都是 160ms 缓动）。
 * - 任意会话在跑（props.running）→ 碎片轨道 3 倍速；窗口失焦 / 减少动效 → 静帧。
 * - 数据：usage:week 拉一次 + usage:event 推送整份快照（每次模型调用落账即刷新）。
 */
export function UsageMeter(props: { running: boolean }) {
  const [days, setDays] = useState<UsageDayTotal[] | null>(null);
  /** 悬停的格序号；null = 回到今天 */
  const [hover, setHover] = useState<number | null>(null);
  /** 窗口是否前台：失焦时碎片停转（SMIL 不吃 CSS 的 animation-play-state，得在这里掐） */
  const [windowActive, setWindowActive] = useState(
    () =>
      !isWindowInactive({ hasFocus: document.hasFocus(), visibilityState: document.visibilityState }),
  );

  useEffect(() => {
    void api.usage.week().then(setDays).catch(() => undefined);
    return api.usage.onEvent((event) => setDays(event.days));
  }, []);

  useEffect(() => {
    const sync = (): void => {
      setWindowActive(
        !isWindowInactive({ hasFocus: document.hasFocus(), visibilityState: document.visibilityState }),
      );
    };
    window.addEventListener("blur", sync);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("blur", sync);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  const cells = useMemo(
    () => usageWeekCells(new Date(), new Map((days ?? []).map((day) => [day.date, day.tokens]))),
    [days],
  );
  const active = hover ?? cells.length - 1;
  const activeTier: UsageTier = cells[active]?.tier ?? 0;

  return (
    <div className="usage-meter">
      <div className="usage-pet" style={{ left: petLeft(active) }}>
        <NebulaPet tier={activeTier} orbit={windowActive} fast={props.running} />
      </div>
      <div className="usage-cells">
        {cells.map((cell, index) => (
          <UsageSquare key={cell.date} cell={cell} index={index} onHover={setHover} />
        ))}
      </div>
    </div>
  );
}

/** 一格 + 星期短标 + 悬停 tooltip（tooltip 落在能量体上方，不吃默认 6px 间距） */
function UsageSquare(props: { cell: UsageCell; index: number; onHover: (index: number | null) => void }) {
  const t = useT();
  const tooltip = useHoverTooltip<HTMLButtonElement>(200, true, { gap: 52 });
  const { cell } = props;
  const weekday = t.usage.weekdays[cell.weekday] ?? "";
  const text =
    cell.tokens > 0
      ? t.usage.day(shortDate(cell.date), weekday, formatTokens(cell.tokens))
      : t.usage.noUsage;
  return (
    <div
      className="usage-col"
      onMouseEnter={() => props.onHover(props.index)}
      onMouseLeave={() => props.onHover(null)}
    >
      <button
        ref={tooltip.anchorRef}
        type="button"
        className="usage-cell"
        data-tier={cell.tier}
        data-today={cell.isToday || undefined}
        aria-label={text}
        // 键盘聚焦同样把能量体叫过来（指针之外的第二条路）
        onFocus={() => props.onHover(props.index)}
        onBlur={() => props.onHover(null)}
        onMouseEnter={tooltip.handlers.onMouseEnter}
        onMouseLeave={tooltip.handlers.onMouseLeave}
      />
      <span className="usage-wd" data-now={cell.isToday || undefined}>
        {cell.isToday ? t.usage.today : weekday}
      </span>
      {tooltip.open &&
        createPortal(
          <div
            ref={tooltip.tooltipRef}
            role="tooltip"
            style={{
              position: "fixed",
              top: tooltip.placement?.top ?? 0,
              left: tooltip.placement?.left ?? 0,
              padding: "2px 8px",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: "var(--radius-sm)",
              background: "var(--color-bg-panel)",
              boxShadow: "var(--shadow-popover)",
              color: "var(--color-text-secondary)",
              fontFamily: "var(--font-family-base)",
              fontSize: "var(--font-size-caption)",
              lineHeight: "var(--line-height-caption)",
              whiteSpace: "nowrap",
              pointerEvents: "none",
              zIndex: 70,
              opacity: tooltip.placement === null ? 0 : 1,
              transition: "opacity var(--duration-fast) var(--ease-standard)",
            }}
          >
            {text}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** 档位 → 云半径与碎片数（原型 nebula.mjs 的参数，用户验收过的那份） */
const NEBULA_RADIUS = [11, 14, 18, 22] as const;
const NEBULA_CHUNKS = [0, 2, 4, 7] as const;

/** 云的五团渐变球心：[x 系数, y 系数, 半径系数]，都乘当档半径 */
const NEBULA_BLOBS: readonly (readonly [number, number, number])[] = [
  [-0.45, -0.1, 0.7],
  [0.4, -0.2, 0.65],
  [0, 0.3, 0.75],
  [-0.1, -0.45, 0.6],
  [0.5, 0.35, 0.5],
];

/** prefers-reduced-motion：SMIL 不吃 CSS 的 collapsed animation，得在渲染层掐掉 */
function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 星云能量体：几团径向渐变叠成软云（呼吸 1 ↔ 1.06），小方块碎片沿椭圆轨道绕行，
 * 两只眼睛。0 档（没用量）闭眼睡着、没有碎片。
 * `orbit=false`（窗口失焦 / 减少动效）时碎片停在轨道上的静态分位，云的呼吸
 * 由全局 reduced-motion / 失焦暂停规则接管（anim-continuous 标记类）。
 */
function NebulaPet(props: { tier: UsageTier; orbit: boolean; fast: boolean }) {
  // useId 带「:」等字符，不能直接当 SVG id 用（url(#…) 引用会失效），洗成字母数字
  const gradientId = `neb${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const radius = NEBULA_RADIUS[props.tier];
  const chunks = NEBULA_CHUNKS[props.tier];
  const orbiting = props.orbit && !prefersReducedMotion();
  const eyes =
    props.tier === 0 ? (
      // 睡着：两条下弧线
      <path d="M-5.5 0.5 q2.2 2 4.4 0 M1.1 0.5 q2.2 2 4.4 0" className="usage-eye-line" />
    ) : (
      <>
        <ellipse cx={-3.3} cy={-0.5} rx={1.6} ry={2.2} className="usage-eye" />
        <ellipse cx={3.3} cy={-0.5} rx={1.6} ry={2.2} className="usage-eye" />
      </>
    );
  return (
    <svg viewBox="-40 -24 80 48" width={80} height={48} className="usage-orb" aria-hidden="true">
      <defs>
        <radialGradient id={gradientId}>
          <stop offset={0} className="neb-in" />
          <stop offset={1} className="neb-out" />
        </radialGradient>
      </defs>
      <g className="usage-cloud anim-continuous">
        {NEBULA_BLOBS.map(([x, y, scale], index) => (
          <circle key={index} cx={x * radius} cy={y * radius * 0.7} r={radius * scale} fill={`url(#${gradientId})`} />
        ))}
      </g>
      {Array.from({ length: chunks }, (_, j) => {
        const orbitRadius = radius * (0.55 + (j % 3) * 0.15);
        const path = `M ${-orbitRadius} 0 A ${orbitRadius} ${orbitRadius * 0.55} 0 1 0 ${orbitRadius} 0 A ${orbitRadius} ${orbitRadius * 0.55} 0 1 0 ${-orbitRadius} 0`;
        const angle = (j / Math.max(chunks, 1)) * 2 * Math.PI;
        return (
          <rect
            key={j}
            x={-1.6}
            y={-1.6}
            width={3.2}
            height={3.2}
            rx={0.8}
            className={`usage-chunk-${j % 3}`}
            // 静帧（失焦 / 减少动效）：碎片均匀分布在轨道分位上
            transform={orbiting ? undefined : `translate(${orbitRadius * Math.cos(angle)}, ${orbitRadius * 0.55 * Math.sin(angle)})`}
          >
            {orbiting && (
              <animateMotion
                dur={`${(7 + j) / (props.fast ? 3 : 1)}s`}
                repeatCount="indefinite"
                begin={`-${j * 1.3}s`}
                rotate="auto"
                path={path}
              />
            )}
          </rect>
        );
      })}
      {eyes}
    </svg>
  );
}
