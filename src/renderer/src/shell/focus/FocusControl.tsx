import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./focus.css";
import { Icon } from "../Icon";
import { placeMenu } from "../menu-position";
import { useT } from "../../locale";
import type { Workspace } from "@shared/workspace";
import {
  FOCUS_MINUTES,
  FOCUS_MINUTES_DEFAULT,
  FOCUS_WHEEL_ROW,
  focusProgress,
  formatFocusClock,
  formatStartClock,
  pickerRequestFresh,
  remainMs,
  resolvePickerWorkspace,
  wheelIndex,
} from "./focus-timer.ts";
import type { FocusStatus } from "./use-focus.ts";

/**
 * 专注键（平时）→ 闪电 + 倒计时（专注中）。
 *
 * 住工具栏左胶囊的第三格（#248 预留的槽位：侧栏开关 · 新任务 · 专注），样式
 * 沿用胶囊按钮——平时是圆格 cap-seg（选中态走 quiet-control 的蓝色选中配方），
 * 专注中变成 zap + 等宽倒计时的一格 cap-focus-run，不另起按钮外观。浮层两块：
 * - **开始专注**（点闪电）：滚轮选时长（10–120 分钟，默认 25）+ 选工作区 +
 *   唯一的强调色按钮。Enter 开始，Esc 关。
 * - **胶囊浮层**（点倒计时）：剩余、进度线、+5 / +15、提前结束。没有暂停——
 *   原型待定 9 的默认做法。时间到出口只剩「结束专注」。
 *
 * 浮层 portal 到 body + fixed（工具栏与侧栏都是 overflow 裁剪链上的容器，原地
 * 渲染会被裁，同 Menu 的理由）；定位复用 placeMenu（below + start，出屏自己夹回）。
 */
export function FocusControl(props: {
  status: FocusStatus;
  workspaces: readonly Workspace[];
  /** 默认选中的工作区（当前会话所在的那个）；null = 落第一个 */
  defaultWorkspaceId: string | null;
  /** 上一次开始用的档位（「再专注一轮」沿用） */
  preset: { workspaceId: string; minutes: number } | null;
  /** 外部发起的开浮层请求（浏览态「以此开始专注」/卡片「再专注一轮」）：token 递增，同源连点也重开；minutes 给了就一并预选 */
  pickerRequest: { workspaceId: string; minutes?: number; token: number } | null;
  /** 每个工作区此刻的会话数（清单行尾的 meta） */
  sessionCountOf: (workspaceId: string) => number;
  onStart: (workspaceId: string, minutes: number) => void;
  onExtend: (minutes: number) => void;
  /** 提前结束：停表、星云气泡问要不要总结（run 相位胶囊浮层的那一行） */
  onEarlyEnd: () => void;
  /** 结束专注：直接回会话列表（done 相位胶囊浮层的那一行） */
  onEnd: () => void;
}) {
  const t = useT();
  const [pop, setPop] = useState<null | "picker" | "menu">(null);
  const [minutes, setMinutes] = useState(props.preset?.minutes ?? FOCUS_MINUTES_DEFAULT);
  const [workspaceId, setWorkspaceId] = useState<string | null>(
    props.preset?.workspaceId ?? props.defaultWorkspaceId ?? props.workspaces[0]?.id ?? null,
  );
  /**
   * 选中的工作区跟着事实回填：工作区列表异步加载，挂载时空表初始化出的 null
   * 不会自愈（验收：只有一个工作区时开始锿禁用）；选中项被移除也在这里落回
   * 有效项。链条在 resolvePickerWorkspace（纯函数，带测试）：显式选择 >
   * 上次档位 > 默认（当前会话所在）> 第一个。
   */
  useEffect(() => {
    setWorkspaceId((current) =>
      resolvePickerWorkspace(
        current,
        props.preset?.workspaceId ?? null,
        props.defaultWorkspaceId,
        props.workspaces.map((item) => item.id),
      ),
    );
  }, [props.workspaces, props.defaultWorkspaceId, props.preset]);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const wheelRef = useRef<HTMLDivElement | null>(null);
  const [spot, setSpot] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  /**
   * 秒针住在组件本地 state，只在 run 相位的 effect 里跳：倒计时 / 进度线每秒
   * 只重画这一小块。原来 now 由 App 的 useFocus 每秒 setNow 透传下来，整棵
   * App 每秒 commit 一次（`perf(focus)` 的根因）。status 换了（开始 / 延长）
   * 重排一拍；离开 run（ending / done / off）时 interval 停掉、tickNow 冻住
   * ——ending 的剩余量停在停表那一拍，与原来一致。
   */
  const [tickNow, setTickNow] = useState(() => Date.now());
  useEffect(() => {
    if (props.status.kind !== "run") return;
    setTickNow(Date.now());
    const timer = window.setInterval(() => setTickNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [props.status]);

  const run = props.status.kind === "off" ? null : props.status.run;
  const wsName = (id: string | null): string =>
    (id !== null ? props.workspaces.find((w) => w.id === id)?.name : undefined) ?? t.focus.deletedWorkspace;

  // 外部请求开浮层（token 变了才动，避免渲染期 setState 环）；**消费高水位**：
  // 同一遭请求只开一次——之后每一次回到 off（结束一轮、Esc 关掉再开一轮）
  // 都不重弹（pickerRequestFresh，纯函数带测试）
  const pickerConsumedRef = useRef(0);
  useEffect(() => {
    if (props.pickerRequest === null) return;
    if (props.status.kind !== "off") return;
    if (!pickerRequestFresh(props.pickerRequest.token, pickerConsumedRef.current)) return;
    pickerConsumedRef.current = props.pickerRequest.token;
    setWorkspaceId(props.pickerRequest.workspaceId);
    if (props.pickerRequest.minutes !== undefined) setMinutes(props.pickerRequest.minutes);
    setPop("picker");
  }, [props.pickerRequest, props.status.kind]);

  // 到点时若胶囊浮层还开着，收掉（胶囊停「时间到」，点不开）
  useEffect(() => {
    if (props.status.kind === "done") setPop(null);
  }, [props.status.kind]);

  // 开着浮层：Esc 关；点外面关（portal 的面板不在锚点的 DOM 子树里，判 popRef）
  useEffect(() => {
    if (pop === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // 滚轮里的 Enter 开始在面板自己的 onKeyDown；Esc 统一在这里收口
      event.stopPropagation();
      setPop(null);
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (popRef.current?.contains(target) === true) return;
      if (anchorRef.current?.contains(target) === true) return;
      setPop(null);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [pop]);

  // 定位：锚点下面开，出屏夹回（placeMenu）；开与滚动/缩放时重算
  useLayoutEffect(() => {
    if (pop === null) {
      setSpot(null);
      return;
    }
    const place = (): void => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const panel = popRef.current;
      if (anchor === undefined || panel === null) return;
      const placed = placeMenu(
        { top: anchor.top, bottom: anchor.bottom, left: anchor.left, right: anchor.right, width: anchor.width, height: anchor.height },
        { width: panel.offsetWidth, height: panel.offsetHeight },
        "start",
        { width: window.innerWidth, height: window.innerHeight },
        "below",
      );
      if (placed.visible) {
        setSpot((current) =>
          current !== null && current.top === placed.top && current.left === placed.left && current.maxHeight === placed.maxHeight
            ? current
            : { top: placed.top, left: placed.left, maxHeight: placed.maxHeight },
        );
      }
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [pop, minutes, workspaceId, props.workspaces]);

  // 滚轮初始滚到选中档（打开那一刻）
  useEffect(() => {
    if (pop !== "picker") return;
    const list = wheelRef.current;
    if (list === null) return;
    const index = Math.max(0, FOCUS_MINUTES.indexOf(minutes));
    list.scrollTop = index * FOCUS_WHEEL_ROW;
    // 只在打开时定位一次；后续滚动来自用户
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pop]);

  const start = (): void => {
    if (workspaceId === null) return;
    props.onStart(workspaceId, minutes);
    setPop(null);
  };

  const remain = run === null ? 0 : remainMs(run, tickNow);
  const done = props.status.kind === "done";
  // ending = 提前结束后的等待相位（B 半）：表停住等小结决定。延长在此相位本就是
  // no-op（use-focus 只认 run），浮层里也就不再摆延长键；出口只剩「结束专注」。「要」
  // 与「不要」的星云气泡（FocusSummaryCard 一侧）才是这个相位的正题。
  const ending = props.status.kind === "ending";

  const panel =
    pop === "picker" ? (
      <div
        ref={popRef}
        className="focus-pop focus-picker"
        role="dialog"
        aria-label={t.focus.pickerTitle}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            start();
          }
        }}
        style={spot === null ? { visibility: "hidden" } : { position: "fixed", top: spot.top, left: spot.left, maxHeight: spot.maxHeight, overflow: "auto" }}
      >
        <h4>{t.focus.pickerTitle}</h4>
        <p className="focus-picker-sub">{t.focus.pickerSub}</p>
        <div className="focus-pickgrid">
          <div>
            <div className="focus-pk-label">{t.focus.durationLabel}</div>
            <div className="focus-wheel">
              <div className="focus-wheel-band" aria-hidden="true" />
              <div
                ref={wheelRef}
                className="focus-wheel-list"
                role="listbox"
                aria-label={t.focus.durationLabel}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                  event.preventDefault();
                  const list = wheelRef.current;
                  if (list === null) return;
                  list.scrollTop += event.key === "ArrowUp" ? -FOCUS_WHEEL_ROW : FOCUS_WHEEL_ROW;
                }}
                onScroll={(event) => {
                  const index = wheelIndex(event.currentTarget.scrollTop, FOCUS_MINUTES.length);
                  const next = FOCUS_MINUTES[index];
                  if (next !== undefined && next !== minutes) setMinutes(next);
                }}
              >
                {FOCUS_MINUTES.map((value) => (
                  <div
                    key={value}
                    className="focus-wheel-opt"
                    role="option"
                    aria-selected={value === minutes}
                    data-on={value === minutes || undefined}
                    onClick={() => {
                      wheelRef.current?.scrollTo({ top: FOCUS_MINUTES.indexOf(value) * FOCUS_WHEEL_ROW, behavior: "smooth" });
                    }}
                  >
                    <b>{value}</b>
                    <span>{t.focus.minutesUnit}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div>
            <div className="focus-pk-label">{t.focus.workspaceLabel}</div>
            <div className="focus-wslist">
              {props.workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  className="focus-wsopt"
                  data-active={workspace.id === workspaceId || undefined}
                  aria-selected={workspace.id === workspaceId}
                  title={workspace.path}
                  onClick={() => setWorkspaceId(workspace.id)}
                >
                  <Icon name="folder" size={14} strokeWidth={1.8} className="lead" />
                  <span className="focus-wsopt-name">{workspace.name}</span>
                  {workspace.id === workspaceId ? (
                    <span className="focus-wsopt-ok row-trailing">
                      <Icon name="check" size={13} strokeWidth={2} />
                    </span>
                  ) : (
                    <span className="focus-wsopt-meta row-trailing">
                      {t.focus.sessionsCount(props.sessionCountOf(workspace.id))}
                    </span>
                  )}
                </button>
              ))}
              {props.workspaces.length === 0 && <span className="focus-pk-label">{t.focus.noWorkspaces}</span>}
            </div>
          </div>
        </div>
        <div className="focus-pickfoot">
          <span className="focus-picknote">{t.focus.pickerNote}</span>
          <button type="button" className="focus-start" disabled={workspaceId === null} onClick={start}>
            <Icon name="zap" size={14} strokeWidth={2} />
            {t.focus.start}
          </button>
        </div>
      </div>
    ) : pop === "menu" && run !== null ? (
      <div
        ref={popRef}
        className="focus-pop focus-cmenu"
        role="dialog"
        aria-label={t.focus.menuLabel}
        style={spot === null ? { visibility: "hidden" } : { position: "fixed", top: spot.top, left: spot.left }}
      >
        <div className="focus-cm-top">
          <span className="focus-cm-big">{formatFocusClock(remain)}</span>
          <span className="focus-cm-of">
            {t.focus.remainLabel(Math.round(run.totalMs / 60_000))}
          </span>
        </div>
        <div className="focus-cm-ws">
          <Icon name="folder" size={12} strokeWidth={1.8} />
          <span>{wsName(run.workspaceId)}</span>
          <span>{t.focus.startedAt(formatStartClock(run.startedAt))}</span>
        </div>
        <div className="focus-cm-track">
          <i style={{ width: `${(focusProgress(run, tickNow) * 100).toFixed(1)}%` }} />
        </div>
        {/* 时间到 / 已提前结束就没有延长一说，两个键收起；出口只剩「结束专注」 */}
        {done || ending ? null : (
          <div className="focus-cm-ext">
            <button
              type="button"
              onClick={() => {
                props.onExtend(5);
              }}
            >
              {t.focus.extend(5)}
            </button>
            <button
              type="button"
              onClick={() => {
                props.onExtend(15);
              }}
            >
              {t.focus.extend(15)}
            </button>
          </div>
        )}
        {done || ending ? null : <div className="focus-cm-sep" />}
        <button
          type="button"
          className="focus-cm-row"
          onClick={() => {
            setPop(null);
            // 时间到 / 已提前结束（ending）都是「结束专注」——走 onEnd 回会话列表。
            // ending 相位再调 onEarlyEnd 是空转（use-focus 只认 run），用户会卡在专注里
            if (done || ending) props.onEnd();
            else props.onEarlyEnd();
          }}
        >
          <Icon name="square" size={13} strokeWidth={2} />
          {done || ending ? t.focus.endFocus : t.focus.endEarly}
        </button>
      </div>
    ) : null;

  return (
    <span ref={anchorRef} style={{ position: "relative", display: "inline-flex", flex: "0 0 auto" }}>
      {run === null ? (
        <button
          type="button"
          className="quiet-control cap-seg"
          title={t.focus.keyTitle}
          aria-label={t.focus.keyTitle}
          aria-pressed={pop === "picker" || undefined}
          onClick={() => setPop((current) => (current === "picker" ? null : "picker"))}
        >
          <Icon name="zap" size={16} strokeWidth={1.9} />
        </button>
      ) : (
        <button
          type="button"
          className="quiet-control cap-focus-run"
          data-done={done || undefined}
          aria-expanded={pop === "menu"}
          title={done
            ? t.focus.timeUp
            : ending
              ? t.focus.endingTitle(wsName(run.workspaceId))
              : t.focus.capsuleTitle(wsName(run.workspaceId))}
          onClick={() => {
            // 时间到也点得开：出口只剩「结束专注」（星云卡片是下一个 PR 的事）
            setPop((current) => (current === "menu" ? null : "menu"));
          }}
        >
          <Icon name="zap" size={16} strokeWidth={1.9} />
          <span className="cap-focus-time">{done ? t.focus.timeUp : formatFocusClock(remain)}</span>
        </button>
      )}
      {panel !== null ? createPortal(panel, document.body) : null}
    </span>
  );
}
