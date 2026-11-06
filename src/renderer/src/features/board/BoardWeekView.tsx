/**
 * 全局周看板：占满主区域（像设置那样的全屏视图，Esc 或再点右栏图标退出）。
 *
 * 一周一屏，每天一列：默认 1 格宽，当天有 2 格宽的卡就 2 格。格宽 = 可视宽 / 所选天数（3 / 5 / 7，默认 5），
 * 所以有 2 格列时一屏看到的天数更少，超出的横向滚动——Shift + 滚轮或触控板横滑。打开时把今天滚进视野。
 * 看板只有自动化触发之后才出来：过去的天画运行留下的卡（按快照，见 useSnapshotCards），今天剩下的与未来的天
 * 画排好的自动化（虚线框灰字）。
 *
 * 布局、天数、滚动位置的算法在 week-layout.ts（纯函数，有测试）；这里只管把它们接到 DOM。
 * 每张卡一只沙箱 iframe，一周几十张全挂太重：只挂可视窗里的天及左右各一天，滑远了卸掉。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  localWeekStart,
  type BoardPlannedRun,
  type BoardWeekDay,
  type BoardWeekItem,
} from "../../../../shared/plugin-board.ts";
import { BOARD_DAYS_CHOICES, type BoardDays } from "../../../../shared/settings.ts";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import { PanelEmpty } from "../../shell/PanelEmpty";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { useAutomationUi } from "../automation/automation-context.ts";
import { BoardGrid } from "../plugins/BoardGrid.tsx";
import { useBoardWeek } from "./useBoardWeek.ts";
import { useSnapshotCards, type SnapshotCardInput } from "./useSnapshotCards.ts";
import {
  WEEK_CELL_GAP,
  WEEK_DAY_GAP,
  cardCaption,
  clampScroll,
  clockLabel,
  dayContent,
  dayLabel,
  dayPhase,
  layoutWeekColumns,
  maxScrollLeft,
  mountedDays,
  plannedLabel,
  todayScrollTarget,
  trailingSlack,
  shiftWeek,
  todayColumnIndex,
  weekCellWidth,
  weekIsBlank,
  weekRangeLabel,
  wheelScrollDelta,
  type DayContent,
  type DayPhase,
} from "./week-layout.ts";
import "./board.css";

/** 滚动区左右内边距（px）。可视宽 = 滚动区宽 − 两侧内边距，和 board.css 的 .wk-head 同一条左缘（--space-5） */
const WEEK_PAD_X = 20;

export function BoardWeekView(props: {
  /** 一屏显示几天（AppSettings.boardDays，缺席 5） */
  days: BoardDays;
  onDaysChange: (days: BoardDays) => void;
  /** 点卡标题行 / 灰字行：打开那次运行的会话（调用方负责退出看板） */
  onOpenSession: (sessionId: string) => void;
}) {
  const t = useT().board;
  const { automations, openPanel } = useAutomationUi();
  const [weekStart, setWeekStart] = useState(() => localWeekStart(Date.now()));
  const { state, reload } = useBoardWeek(weekStart);
  const currentWeek = localWeekStart(Date.now());

  // 滚动区的可视宽与滚动位置
  // 滚动区只在有数据时才挂（载入中 / 出错 / 空态没有它），所以拿节点用 state：挂上 / 卸掉都会重跑下面几个 effect
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  useLayoutEffect(() => {
    if (scroller === null) {
      setViewport(0);
      return;
    }
    const measure = (): void => setViewport(Math.max(0, scroller.clientWidth - 2 * WEEK_PAD_X));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller]);

  const week = state.kind === "ready" ? state.week : null;
  const cellWidth = weekCellWidth(viewport, props.days);
  const contents = useMemo(() => (week === null ? [] : week.days.map((day) => dayContent(day, dayPhase(day, week.now)))), [week]);
  const layout = useMemo(() => layoutWeekColumns(contents.map((content) => content.cells), cellWidth), [contents, cellWidth]);
  const todayIndex = week === null ? null : todayColumnIndex(week.days, week.now);
  // 打开时要滚到的位置；内容只比可视窗多一点点时在尾部多留一点空白，让它够得着（见 trailingSlack）
  const target = todayScrollTarget(layout, viewport, todayIndex, WEEK_PAD_X - WEEK_DAY_GAP);
  const slack = trailingSlack(layout, viewport, target);
  const contentWidth = layout.totalWidth + slack;
  const mounted = useMemo(() => mountedDays(layout, scrollLeft, viewport, 1), [layout, scrollLeft, viewport]);

  // 打开 / 翻周 / 换天数后把今天滚进视野（每个「周 + 天数」只滚一次：数据每分钟刷新，不能把用户拖走的位置拽回来）
  const scrolledFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    const node = scroller;
    if (week === null || node === null || viewport <= 0) return;
    // 用数据自己的周起点：翻周后新数据回来之前，手里还是上一周的数据，按上一周的「今天」滚会滚错
    const key = `${week.weekStart}|${props.days}`;
    if (scrolledFor.current === key) return;
    scrolledFor.current = key;
    const left = clampScroll(target, contentWidth, viewport);
    node.scrollLeft = left;
    setScrollLeft(left);
  }, [scroller, week, viewport, props.days, target, contentWidth]);

  // 窗口缩放 / 天数变了，内容宽变，位置可能越界：夹回去
  useEffect(() => {
    const node = scroller;
    if (node === null || week === null) return;
    const clamped = clampScroll(node.scrollLeft, contentWidth + 2 * WEEK_PAD_X, node.clientWidth);
    if (Math.abs(clamped - node.scrollLeft) > 0.5) node.scrollLeft = clamped;
  }, [scroller, contentWidth, week]);

  // Shift + 滚轮 → 横向滑。要用原生监听（React 的 onWheel 是 passive，拦不住默认的竖向滚动）
  const [shift, setShift] = useState(false);
  useEffect(() => {
    const node = scroller;
    if (node === null) return;
    const onWheel = (event: WheelEvent): void => {
      const delta = wheelScrollDelta(event);
      if (delta === null) return;
      event.preventDefault();
      node.scrollLeft += delta;
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [scroller]);
  // 按住 Shift 时让 iframe 不吃滚轮（它会把滚轮吞进自己的文档，宿主就收不到了）
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Shift") setShift(event.type === "keydown");
    };
    const off = (): void => setShift(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", off);
    };
  }, []);

  const overflow = contentWidth > viewport && viewport > 0;
  const noAutomations = automations.length === 0;

  return (
    <div className="wk" data-shift={shift ? "true" : undefined}>
      <header className="wk-head">
        <div className="wk-nav" role="group" aria-label={t.title}>
          <IconButton label={t.prevWeek} size={28} onClick={() => setWeekStart((current) => shiftWeek(current, -1))}>
            <Icon name="chevron-left" size={16} />
          </IconButton>
          <span className="wk-range" aria-live="polite">
            {weekRangeLabel(weekStart)}
          </span>
          <IconButton label={t.nextWeek} size={28} onClick={() => setWeekStart((current) => shiftWeek(current, 1))}>
            <Icon name="chevron-right" size={16} />
          </IconButton>
          {weekStart !== currentWeek && (
            <button type="button" className="wk-this" onClick={() => setWeekStart(currentWeek)}>
              {t.thisWeek}
            </button>
          )}
        </div>
        <div className="wk-tools">
          {overflow && <span className="wk-hint">{t.scrollHint}</span>}
          <div className="wk-seg" role="group" aria-label={t.daysChoice}>
            {BOARD_DAYS_CHOICES.map((choice) => (
              <button key={choice} type="button" aria-pressed={props.days === choice} onClick={() => props.onDaysChange(choice)}>
                {t.days(choice)}
              </button>
            ))}
          </div>
        </div>
      </header>

      {state.kind === "failed" ? (
        <div className="wk-empty">
          <PanelEmpty tone="danger" exit={{ label: t.retry, onClick: reload }}>
            {t.loadFailed(state.message)}
          </PanelEmpty>
        </div>
      ) : state.kind === "loading" ? (
        <div className="wk-empty">
          <PanelEmpty busy>{t.loading}</PanelEmpty>
        </div>
      ) : noAutomations && week !== null && weekIsBlank(week.days) ? (
        <div className="wk-empty">
          {/* 没有任何自动化、这一周也没有历史记录才算空态（翻到有记录的周照常画） */}
          <PanelEmpty icon={FEATURE_ICON.board} hint={t.emptyHint} exit={{ label: t.openAutomation, onClick: () => openPanel() }}>
            {t.emptyTitle}
          </PanelEmpty>
        </div>
      ) : (
        <div
          className="wk-scroll scroll"
          ref={setScroller}
          // 两侧还有内容时边缘淡出：滚到某一天贴左缘后，前一天只会在内边距里露一条细边，淡出比硬切好看
          data-more-left={scrollLeft > 1 ? "true" : undefined}
          data-more-right={scrollLeft < maxScrollLeft(contentWidth, viewport) - 1 ? "true" : undefined}
          onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}>
          <div
            className="wk-days"
            style={{
              gridTemplateColumns: layout.columns.map((column) => `${column.width}px`).join(" "),
              columnGap: WEEK_DAY_GAP,
              paddingInline: WEEK_PAD_X,
              paddingBlock: "var(--space-3)",
              width: contentWidth + 2 * WEEK_PAD_X,
            }}
          >
            {week !== null &&
              week.days.map((day, index) => (
                <WeekDayColumn
                  key={day.start}
                  index={index}
                  day={day}
                  phase={dayPhase(day, week.now)}
                  content={contents[index] ?? dayContent(day, "past")}
                  cellWidth={cellWidth}
                  today={index === todayIndex}
                  mounted={mounted.has(index)}
                  onOpenSession={props.onOpenSession}
                />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function WeekDayColumn(props: {
  index: number;
  day: BoardWeekDay;
  phase: DayPhase;
  content: DayContent;
  cellWidth: number;
  today: boolean;
  mounted: boolean;
  onOpenSession: (sessionId: string) => void;
}) {
  const t = useT().board;
  const { day, content } = props;
  const items = day.items.filter((item) => item.cards.length > 0);
  return (
    <section className="wk-day" data-today={props.today ? "true" : undefined} data-phase={props.phase} aria-label={`${t.weekdays[props.index] ?? ""} ${dayLabel(day.start)}`}>
      <div className="wk-day-head">
        <b>{t.weekdays[props.index]}</b>
        <span className="wk-day-date">{dayLabel(day.start)}</span>
        {props.today && <span className="wk-today">{t.today}</span>}
      </div>
      {content.empty !== null && <p className="wk-note">{content.empty === "none-ran" ? t.noneRan : t.nonePlanned}</p>}
      {items.length > 0 &&
        (props.mounted ? (
          <div className="wk-runs">
            {items.map((item) => (
              <RunBoard key={item.runId} item={item} cellWidth={props.cellWidth} cells={content.cells} onOpenSession={props.onOpenSession} />
            ))}
          </div>
        ) : (
          <div className="wk-skel" aria-hidden="true" />
        ))}
      {content.bare.map((item) => (
        <BareRun key={item.runId} item={item} onOpenSession={props.onOpenSession} />
      ))}
      {content.planned.map((run) => (
        <PlannedRun key={`${run.automationId}:${run.at}`} run={run} />
      ))}
    </section>
  );
}

/** 一次运行留下的那块看板：BoardGrid 列模式，卡上方一行「时间 · 插件名」（点它打开那次运行的会话）。 */
function RunBoard(props: { item: BoardWeekItem; cellWidth: number; cells: 1 | 2; onOpenSession: (sessionId: string) => void }) {
  const t = useT().board;
  const { item } = props;
  const inputs = useMemo<SnapshotCardInput[]>(
    () => item.cards.map((snapshot) => ({ key: `${item.runId}:${snapshot.id}:${snapshot.index}`, snapshot, at: item.at })),
    [item],
  );
  const cards = useSnapshotCards(inputs);
  const text = cardCaption(item);
  const sessionId = item.sessionId;
  return (
    <BoardGrid
      cards={cards}
      layout={{ mode: "column", cellWidth: props.cellWidth, columns: props.cells, gap: WEEK_CELL_GAP }}
      actionName={item.plugin}
      caption={() =>
        sessionId === null ? (
          <span>{text}</span>
        ) : (
          <button type="button" className="wk-cap" data-failed={item.status === "error" ? "true" : undefined} title={t.openSession(text)} aria-label={t.openSession(text)} onClick={() => props.onOpenSession(sessionId)}>
            <span>{text}</span>
            {item.status === "error" ? <Icon name="triangle-alert" size={12} strokeWidth={1.8} /> : <Icon name="arrow-up-right" size={12} strokeWidth={1.8} />}
          </button>
        )
      }
    />
  );
}

/** 跑过但没有卡的运行（没选插件 / 没调 show_plugin_board / 还在跑 / 失败）：一行灰字，有会话就能点开。 */
function BareRun(props: { item: BoardWeekItem; onOpenSession: (sessionId: string) => void }) {
  const t = useT().board;
  const { item } = props;
  const time = clockLabel(item.at);
  const text = item.status === "running" ? t.bareRunning(time, item.automationTitle) : item.status === "error" ? t.bareFailed(time, item.automationTitle) : t.bareRun(time, item.automationTitle);
  const sessionId = item.sessionId;
  return sessionId === null ? (
    <p className="wk-note">{text}</p>
  ) : (
    <button type="button" className="wk-note" title={t.openSession(text)} onClick={() => props.onOpenSession(sessionId)}>
      {text}
    </button>
  );
}

/** 排好还没到的运行：虚线框 + 灰字「08:30 文献追踪」。 */
function PlannedRun(props: { run: BoardPlannedRun }) {
  const t = useT().board;
  return (
    <div className="wk-planned" title={t.plannedTip}>
      <Icon name={FEATURE_ICON.automation} size={14} strokeWidth={1.8} />
      <span>{plannedLabel(props.run)}</span>
    </div>
  );
}
