import "./usage.css";
import { useEffect, useId, useMemo, useState } from "react";
import { api } from "../api";
import { useT } from "../locale.ts";
import { formatTokens } from "../utils/format-tokens.ts";
import { isWindowInactive } from "./window-activity.ts";
import {
  effectivePin,
  petAnchor,
  petLeft,
  petPrefAfterCellClick,
  petPrefAfterHide,
  usageWeekCells,
  type UsageCell,
  type UsageTier,
} from "./usage-week.ts";
import type { UsagePetPref } from "@shared/settings";
import type { UsageDayTotal } from "@shared/usage";

/**
 * 侧栏左下角的 7 天 token 用量格 + 星云能量体。
 *
 * - 7 格从今天往回数，**右端是今天**；档位按「当天 / 7 天最大值」的比例。
 * - 星云默认坐在今天上方、显示今天的档位；悬停某格时移过去、换那天的档位
 *   （移动与大小收放都是 160ms 缓动），并**像在说话**一样从头顶冒一个小气泡报当天用量
 *   （2026-10-12 用户验收：不用浮层 tooltip，气泡跟着星云走；字号同格子下的星期）。
 * - 任意会话在跑（props.running）→ 碎片轨道 3 倍速；窗口失焦 / 减少动效 → 静帧。
 * - **直接在这里操作，不进设置页**（2026-10-12 用户裁决）：点一格把星云钉在那天（按日期，
 *   显示那天的样子：零用量睡着、少的小、多的大），再点那格或点今天回到今天；点星云把它
 *   收起、让出上方空间，收起后点任意一格它从那格出来。偏好落 settings.usagePet。
 * - 数据：usage:week 拉一次 + usage:event 推送整份快照（每次模型调用落账即刷新）。
 */
export function UsageMeter(props: {
  running: boolean;
  pet: UsagePetPref | undefined;
  onPetChange: (next: UsagePetPref) => void;
}) {
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
  const hidden = props.pet?.hidden === true;
  const pinned = effectivePin(cells, props.pet);
  const active = (hidden ? null : hover) ?? petAnchor(cells, props.pet);
  const activeTier: UsageTier = cells[active]?.tier ?? 0;
  const t = useT();
  const hovered = hover === null ? undefined : cells[hover];

  return (
    <div className="usage-meter" data-hidden={hidden || undefined}>
      <div className="usage-pet" style={{ left: petLeft(active) }}>
        {hovered !== undefined && (
          // 气泡尾巴指向云；两端的格子把气泡往里收，免得出侧栏（data-edge）
          <div
            className="usage-say"
            role="status"
            data-edge={active <= 1 ? "start" : active >= cells.length - 2 ? "end" : undefined}
          >
            {usageText(hovered, t)}
          </div>
        )}
        <button
          type="button"
          className="usage-pet-btn"
          aria-label={t.usage.hidePet}
          title={t.usage.hidePet}
          tabIndex={hidden ? -1 : 0}
          onClick={() => {
            setHover(null);
            props.onPetChange(petPrefAfterHide(props.pet));
          }}
        >
          <NebulaPet tier={activeTier} orbit={windowActive && !hidden} fast={props.running} />
        </button>
      </div>
      <div className="usage-cells">
        {cells.map((cell, index) => (
          <UsageSquare
            key={cell.date}
            cell={cell}
            index={index}
            pinned={pinned === cell.date}
            hint={hidden ? t.usage.showPetHere : pinned === cell.date || cell.isToday ? t.usage.backToToday : t.usage.pinPetHere}
            onHover={setHover}
            onPick={() => props.onPetChange(petPrefAfterCellClick(cells, props.pet, index))}
          />
        ))}
      </div>
    </div>
  );
}

/** 悬停时星云说的那句：当天总量，零用量说「没有用量」 */
function usageText(cell: UsageCell, t: ReturnType<typeof useT>): string {
  return cell.tokens > 0 ? t.usage.day(formatTokens(cell.tokens)) : t.usage.noUsage;
}

/** 一格 + 星期短标（悬停时由星云头顶的气泡报用量） */
function UsageSquare(props: {
  cell: UsageCell;
  index: number;
  /** 星云钉在这天（描一圈星云色 + 顶上一个小点） */
  pinned: boolean;
  /** 点这格会发生什么（悬停 title） */
  hint: string;
  onHover: (index: number | null) => void;
  onPick: () => void;
}) {
  const t = useT();
  const { cell } = props;
  return (
    <div
      className="usage-col"
      onMouseEnter={() => props.onHover(props.index)}
      onMouseLeave={() => props.onHover(null)}
    >
      <button
        type="button"
        className="usage-cell"
        data-tier={cell.tier}
        data-today={cell.isToday || undefined}
        data-pinned={props.pinned || undefined}
        aria-label={`${usageText(cell, t)} · ${props.hint}`}
        title={props.hint}
        onClick={props.onPick}
        // 键盘聚焦同样把能量体叫过来（指针之外的第二条路）
        onFocus={() => props.onHover(props.index)}
        onBlur={() => props.onHover(null)}
      />
      <span className="usage-wd" data-now={cell.isToday || undefined}>
        {cell.isToday ? t.usage.today : (t.usage.weekdays[cell.weekday] ?? "")}
      </span>
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

/**
 * 星云能量体：几团径向渐变叠成软云（呼吸 1 ↔ 1.06），小方块碎片沿椭圆轨道绕行，
 * 两只眼睛。0 档（没用量）闭眼睡着、没有碎片。
 *
 * **动画全走合成层**（2026-10-12 实测）：首版用 SVG 的 `<animateMotion>` 让碎片绕轨、
 * CSS 让 SVG 里的 `<g>` 呼吸——SVG 内的动画 Chromium 不放上合成器，每帧都要在主线程
 * 重新算样式、排版、重绘这块带径向渐变的 SVG：空闲时主线程常驻 ~70ms/秒（120Hz 屏每秒
 * 120 次排版），用户感到整个应用变卡。改成：云与眼睛是一张**静态** SVG，呼吸做在包着它的
 * HTML 层上；每颗碎片是一个 HTML 小方块，外层压扁成椭圆（scaleY 0.55）、内层做 transform
 * 旋转——两者都只动 transform，合成器自己跑，主线程降到 ~7ms/秒。转速不影响开销（每帧都
 * 在算），所以没有靠「转慢点」省。
 *
 * `orbit=false`（窗口失焦）时碎片暂停在当前位置；减少动效与失焦暂停由 CSS 接管
 * （usage.css 的 prefers-reduced-motion、styles.css 的 anim-continuous）。
 */
function NebulaPet(props: { tier: UsageTier; orbit: boolean; fast: boolean }) {
  // useId 带「:」等字符，不能直接当 SVG id 用（url(#…) 引用会失效），洗成字母数字
  const gradientId = `neb${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const radius = NEBULA_RADIUS[props.tier];
  const chunks = NEBULA_CHUNKS[props.tier];
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
    <div className="usage-orb anim-continuous" data-orbit={props.orbit || undefined} aria-hidden="true">
      <svg viewBox="-40 -24 80 48" width={80} height={48} className="usage-cloud">
        <defs>
          <radialGradient id={gradientId}>
            <stop offset={0} className="neb-in" />
            <stop offset={1} className="neb-out" />
          </radialGradient>
        </defs>
        {NEBULA_BLOBS.map(([x, y, scale], index) => (
          <circle key={index} cx={x * radius} cy={y * radius * 0.7} r={radius * scale} fill={`url(#${gradientId})`} />
        ))}
        {eyes}
      </svg>
      {Array.from({ length: chunks }, (_, j) => {
        const orbitRadius = radius * (0.55 + (j % 3) * 0.15);
        const seconds = (7 + j) / (props.fast ? 3 : 1);
        return (
          // 外层压扁成椭圆轨道；内层转圈。负 delay = 起始相位按 j / chunks 均匀散开一圈
          <span key={j} className="usage-orbit">
            <span
              className="usage-spin anim-continuous"
              style={{ animationDuration: `${seconds}s`, animationDelay: `-${((j / chunks) * seconds).toFixed(2)}s` }}
            >
              <span className={`usage-chunk usage-chunk-${j % 3}`} style={{ left: orbitRadius }} />
            </span>
          </span>
        );
      })}
    </div>
  );
}
