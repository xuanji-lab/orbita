import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { childSessions, type SessionMeta, type TranscriptRecord } from "@shared/session";
import type { Automation } from "@shared/automation";
import type { ChannelMessage } from "@shared/channel";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";
import { Icon } from "../../shell/Icon";
import { StatusPie } from "../../shell/StatusPie";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { requestOpenPanel, requestOpenPluginBoard } from "../../shell/open-panel.ts";
import { Switch } from "../settings/SettingControls";
import type { SessionEntry } from "../chat/session-states.ts";
import type { ChatSession, SessionEngine } from "../chat/useChatSession";
import { useTaskRecords } from "../chat/useTaskRecords.ts";
import { useChannelSummaries } from "../chat/useChannelSummaries";
import { useParentChannels } from "../chat/useChannelMessages";
import type { ChatFileScope } from "../chat/chat-file-scope.ts";
import { useMemorySession } from "../memory/useMemory.ts";
import { useProgressDigest } from "./TaskProgress";
import { useGoalLedger } from "./useGoalLedger.ts";
import type { PlanStep } from "./plan-timeline.ts";
import { STATUS_FOCUS_EVENT, type StatusFocusDetail } from "./chat-status-flag.ts";
import { OutputThumb, SlideStyles } from "./StatusThumb";
import {
  childActivityOf,
  childStateOf,
  clampPanelWidth,
  delegationSteps,
  fitsPanel,
  elapsedParts,
  groupOutputs,
  isWorking,
  nextTickIn,
  PANEL_DEFAULT,
  PANEL_GAP,
  pillSignal,
  planWindow,
  sortChildren,
  statusOutputs,
  toolCallLine,
  type ChildActivity,
  type ChildState,
  type StatusOutput,
} from "./chat-status.ts";
import "./context-panel.css";
import "./chat-status.css";

/**
 * 对话区右上角的「状态」卡（原型，2026-11-22；开关 localStorage orbita.proto.chatStatus）。
 *
 * 用户：「我看进度为了知道进度到哪了。我看产物为了知道我产出了些什么。我看子会话只是想知道他们是否还在工作。」
 * 第二版（同日 20:15 / 20:23 的意见）：
 * - 仍浮在对话区右上角（「悬浮挺好的，这样我还可以一边看到计划，一边写文稿」），左缘可拖改宽（280 – min(560, 对话区 60%)，存 localStorage）；
 * - 进度里母子一眼分得开：步骤是母节点（状态圆点），子会话从步骤「垂下来」（缩进到步骤文字线、一条竖引导线、小机器人图标、轻一档的字），
 *   折叠行（「还有 N 步」）不带状态圆点、用 chevron + 次级色；展开到底时收起键在最后一步下面；
 * - 产物按类型分行，每行一排大缩略图，横向滑（Shift + 滚轮 / 触控板横扫），点一下在右栏打开，悬停不弹东西；
 * - 产物口径同每轮结尾的产物卡（sessionOutputs），多图片与看板；按文件类型分行（同日 20:58）；
 * - 记忆一行接在产物后面（第二版的「这次用到的」只留它）；目标最多两行；卡第一次打开时进度只露在做的步；
 * - 删掉底部的上下文 / 改动 / 摘抄与临时预览浮层。
 *
 * 数据全部是现有的：进度与目标同右栏「这条任务」，子会话同子会话面板，产物同结尾产物卡，记忆同记忆页签。
 * 不改主进程、不改 src/shared 契约。
 */
export function ChatStatus(props: {
  session: ChatSession;
  engine: SessionEngine;
  sessionId: string;
  entry: SessionEntry;
  /** 主会话自己在跑 / 等你（侧栏状态饼同一个推导）：在做的那步画不画在跑饼 */
  working: boolean;
  onOpenSubSession: (childId: string) => void;
  onOpenTerminal: (terminalId: string) => void;
  onOpenAutomation: (automationId: string) => void;
  onOpenMemory: () => void;
  onOpenAbilities: () => void;
}) {
  const t = useT();
  const { entry, sessionId, session } = props;
  const turnActive = entry.phase === "turn";
  // 窄（放下最窄的卡后对话列不到 480，见 fitsPanel）时卡默认收成小钮；在窄的时候点开算这一次的，不改宽时记住的开 / 收
  const hostRef = useRef<HTMLDivElement | null>(null);
  const paneWidth = usePaneWidth(hostRef);
  const narrow = paneWidth > 0 && !fitsPanel(paneWidth);
  const [openWide, setOpenWide] = useState(() => readOpen());
  const [openNarrow, setOpenNarrow] = useState(false);
  const open = narrow ? openNarrow : openWide;
  // 从卡里点开右栏（产物、在跑的、这次用到的）：右栏一开对话区就窄了，但这是在卡里操作的——卡留着，不收成小钮
  const keepOpen = () => setOpenNarrow(true);
  const toggleOpen = (next: boolean) => {
    if (narrow) {
      setOpenNarrow(next);
      return;
    }
    setOpenWide(next);
    writeOpen(next);
  };
  // 宽度：存的是用户拖到的值；显示时再按对话区宽度夹一次（窗口变窄时卡跟着让）
  const [wantWidth, setWantWidth] = useState(() => readWidth());
  const width = clampPanelWidth(wantWidth, paneWidth > 0 ? paneWidth : 1440);
  // 挤对话列：卡开着时对话列右侧让出「卡宽 + 两侧间距」（chat-status.css 的 .pane-main .chat-pane 读这个变量）；收起 / 卸载就还回去。
  // 放不下（窄，但用户在卡里点开了右栏、或自己点开了小钮）时不挤——挤了对话列只剩两百来宽、一行三个字，改成像第一版那样浮在上面
  const squeeze = open && !narrow;
  useLayoutEffect(() => {
    const pane = hostRef.current?.parentElement ?? null;
    if (pane === null) return undefined;
    pane.style.setProperty("--cs-reserve", squeeze ? `${width + PANEL_GAP}px` : "0px");
    return () => {
      pane.style.removeProperty("--cs-reserve");
    };
  }, [squeeze, width]);

  const view = useTaskRecords(sessionId, entry, true);
  const { plan, timeline } = useProgressDigest(view, turnActive);
  const ledger = useGoalLedger(view.records);

  // ── 子会话 ──
  const kids = useMemo(() => childSessions(session.sessions, sessionId), [session.sessions, sessionId]);
  const summaries = useChannelSummaries(sessionId);
  const kidIds = useMemo(() => kids.map((meta) => meta.id), [kids]);
  const channels = useParentChannels(sessionId, kidIds);
  const tails = useChildTails(kids);
  const assign = useMemo(() => delegationSteps(view.records, timeline), [view.records, timeline]);
  const terminals = useLiveTerminals(view.records);
  const automations = useSessionAutomations(sessionId);

  // ── 走表：只有在跑项才走；窗口不在前台停；不到一分钟按秒、否则按分钟跳（chat-status.ts 的 nextTickIn）──
  const [now, setNow] = useState(() => Date.now());
  const activities = useMemo(() => {
    const map = new Map<string, ChildActivity | null>();
    for (const meta of kids) map.set(meta.id, childActivityOf(tails.get(meta.id) ?? []));
    return map;
  }, [kids, tails]);
  const children = useMemo(
    () =>
      kids.map((meta) => {
        const activity = activities.get(meta.id) ?? null;
        const state = childStateOf({
          channelStatus: summaries.get(meta.id)?.status,
          needsApproval: (props.engine.states.get(meta.id)?.approvals.length ?? 0) > 0,
          enginePhaseRunning: props.engine.phaseOf(meta.id) !== "idle",
          activity,
          now,
        });
        return { meta, activity, state, since: activity?.since ?? meta.createdAt, stepId: assign.get(meta.id) ?? null, messages: channels.get(meta.id) };
      }),
    [kids, activities, summaries, props.engine, assign, channels, now],
  );
  const sinces = useMemo(
    () => [
      ...children.filter((row) => (row.state === "running" || row.state === "stuck") && row.activity !== null).map((row) => row.activity?.since ?? 0),
      ...terminals.map((row) => row.since),
    ],
    [children, terminals],
  );
  useTicker(open ? sinces : [], setNow);

  // ── 产物 ──
  const outputs = useMemo(() => {
    const own = statusOutputs(view.records, null);
    const fromKids = kids.flatMap((meta) => statusOutputs(tails.get(meta.id) ?? [], meta.title));
    return [...own, ...fromKids];
  }, [view.records, kids, tails]);

  // ── 记忆（第二版「这次用到的」只留这一行：用户 20:58「技能、网页、上传的文件可以不要掉」）──
  const memory = useMemorySession(sessionId);
  const remembered = memory.data?.turns.flatMap((turn) => turn.remembered) ?? [];
  const usedMemory = dedupeBy(memory.data?.turns.flatMap((turn) => turn.used) ?? [], (hit) => hit.id);

  // ── 状态条（另一条线）点过来：打开卡、展开那个子会话所在的步骤 ──
  const [focusStep, setFocusStep] = useState<{ key: string; token: number } | null>(null);
  useEffect(() => {
    const onFocus = (event: Event) => {
      const detail = (event as CustomEvent<StatusFocusDetail>).detail;
      toggleOpen(true);
      if (detail?.childId === undefined) return;
      const step = assign.get(detail.childId) ?? null;
      setFocusStep({ key: step ?? UNASSIGNED, token: Date.now() });
    };
    window.addEventListener(STATUS_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(STATUS_FOCUS_EVENT, onFocus);
  }, [assign]);

  const states = children.map((row) => row.state);
  const signal = pillSignal(states, (turnActive ? 1 : 0) + terminals.length);
  const scope: ChatFileScope = { sessionId, workspaceId: session.workspaceId, cwd: session.cwd };

  if (!open) {
    const label = signal === null ? t.chatStatus.pill.quiet : t.chatStatus.pill[signal.kind](signal.count);
    return (
      <div className="cs-host" ref={hostRef}>
        <button
          type="button"
          className="cs-pill"
          data-signal={signal?.kind}
          aria-label={t.chatStatus.name}
          title={`${t.chatStatus.name} · ${label}`}
          onClick={() => toggleOpen(true)}
        >
          {signal === null ? (
            <Icon name={FEATURE_ICON.task} size={14} strokeWidth={1.8} />
          ) : (
            <StatusPie state={signal.kind === "waiting" || signal.kind === "stuck" ? "waiting" : signal.kind === "failed" ? "failed" : "running"} />
          )}
          {signal !== null && <span className="cs-pill-n">{label}</span>}
        </button>
      </div>
    );
  }

  const goalVersions = ledger.entries.filter((item) => item.kind === "goal");
  const working = props.working || turnActive;
  const hasPlan = timeline !== null && plan !== null;
  return (
    <div className="cs-host" ref={hostRef}>
      <div className="cs-card" role="complementary" aria-label={t.chatStatus.name} data-over={!squeeze || undefined} style={{ width }}>
        <Resizer
          width={width}
          onChange={(next) => setWantWidth(clampPanelWidth(next, paneWidth))}
          onCommit={(next) => writeWidth(clampPanelWidth(next, paneWidth))}
        />
        {/* 头：目标常驻（往下滚也看得见在为什么干活）+ 收起键；没有目标时只剩收起键 */}
        <div className="cs-top">
          {ledger.goal !== null ? <GoalRow text={ledger.goal.text} versions={goalVersions.map((item) => (item.kind === "goal" ? item.to : ""))} /> : <span className="cs-top-fill" />}
          <button type="button" className="cs-close" aria-label={t.chatStatus.collapse} title={t.chatStatus.collapse} onClick={() => toggleOpen(false)}>
            <Icon name="minimize-2" size={12} strokeWidth={1.8} />
          </button>
        </div>
        <div className="cs-scroll">
          {(hasPlan || children.length > 0) && (
            <ProgressSection
              items={hasPlan ? (timeline?.current.items ?? []) : []}
              children={children}
              working={working}
              now={now}
              focus={focusStep}
              onOpenChild={props.onOpenSubSession}
            />
          )}

          {(terminals.length > 0 || automations.length > 0) && (
            <section className="cs-sec">
              <div className="cs-head">
                <span className="cs-head-label">{t.chatStatus.running}</span>
              </div>
              {terminals.map((row) => (
                <button key={row.id} type="button" className="cs-row cs-btn" title={row.command} onClick={() => {
                    keepOpen();
                    props.onOpenTerminal(row.id);
                  }}>
                  <span className="cs-slot">
                    <Icon name={FEATURE_ICON.terminal} size={14} strokeWidth={1.8} />
                  </span>
                  <span className="cs-text mono">{row.command}</span>
                  <span className="cs-tail">{elapsedText(t, now - row.since)}</span>
                </button>
              ))}
              {automations.map((item) => (
                <button key={item.id} type="button" className="cs-row cs-btn" title={item.prompt} onClick={() => {
                    keepOpen();
                    props.onOpenAutomation(item.id);
                  }}>
                  <span className="cs-slot">
                    <Icon name={FEATURE_ICON.automation} size={14} strokeWidth={1.8} />
                  </span>
                  <span className="cs-text">{item.title}</span>
                  <span className="cs-tail">{item.nextRunAt === null ? "" : nextRunText(t, item.nextRunAt, now)}</span>
                </button>
              ))}
            </section>
          )}

          {outputs.length > 0 && <OutputsSection outputs={outputs} scope={scope} onOpened={keepOpen} />}

          {usedMemory.length + remembered.length > 0 && (
            <MemoryRow
              read={usedMemory.length}
              remembered={remembered.length}
              onOpen={() => {
                keepOpen();
                props.onOpenMemory();
              }}
            />
          )}        </div>
      </div>
    </div>
  );
}

const UNASSIGNED = "__unassigned";
const OPEN_KEY = "orbita.proto.chatStatus.open";
const WIDTH_KEY = "orbita.proto.chatStatus.width";

function usePaneWidth(hostRef: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const pane = hostRef.current?.parentElement ?? null;
    if (pane === null) return undefined;
    const measure = () => setWidth(pane.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);
  return width;
}

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "off";
  } catch {
    return true;
  }
}
function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? "on" : "off");
  } catch {
    // 存不下就只在这次生效
  }
}
function readWidth(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    return raw > 0 ? raw : PANEL_DEFAULT;
  } catch {
    return PANEL_DEFAULT;
  }
}
function writeWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    // 存不下就只在这次生效
  }
}

/** 卡左缘的拖柄：拖动改宽（往左拉变宽），键盘左右键每次 16px；拖的时候整页 col-resize 光标 */
function Resizer(props: { width: number; onChange: (width: number) => void; onCommit: (width: number) => void }) {
  const t = useT();
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);
  const [active, setActive] = useState(false);
  return (
    <div
      className="cs-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={t.chatStatus.resize}
      aria-valuenow={props.width}
      tabIndex={0}
      data-active={active || undefined}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width: props.width, last: props.width };
        setActive(true);
        document.documentElement.classList.add("cs-resizing");
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start === null) return;
        start.last = start.width + (start.x - event.clientX);
        props.onChange(start.last);
      }}
      onPointerUp={() => {
        const start = drag.current;
        drag.current = null;
        setActive(false);
        document.documentElement.classList.remove("cs-resizing");
        if (start !== null) props.onCommit(start.last);
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const next = props.width + (event.key === "ArrowLeft" ? 16 : -16);
        props.onChange(next);
        props.onCommit(next);
      }}
    />
  );
}

// ───────────────────────── 进度 ─────────────────────────

/** 一步下面先露几个子会话（多的收成「还有 N 个」；已交回的收成「N 个已交回」） */
const KIDS_SHOWN = 5;
/** 行尾最多画几个机器人 */
const ROBOTS_SHOWN = 3;

/**
 * 进度：母节点是计划步骤（状态圆点、正文字），子节点是挂在步骤上的子会话——从步骤「垂下来」：缩进到步骤文字线，
 * 左边一条竖引导线连回母步骤，图标是小机器人，字轻一档。折叠行（「N 个更早的步骤 / 还有 N 步」）不带状态圆点，
 * 用 chevron + 次级色。一次只展开一步；展开到底，「收起」就在最后一行下面（不用回顶上找）。
 */
function ProgressSection(props: {
  items: readonly PlanStep[];
  children: readonly ChildRow[];
  working: boolean;
  now: number;
  focus: { key: string; token: number } | null;
  onOpenChild: (childId: string) => void;
}) {
  const t = useT();
  const { items } = props;
  const byStep = useMemo(() => {
    const map = new Map<string, ChildRow[]>();
    for (const row of props.children) {
      const key = row.stepId !== null && items.some((item) => item.id === row.stepId) ? row.stepId : UNASSIGNED;
      map.set(key, [...(map.get(key) ?? []), row]);
    }
    return map;
  }, [props.children, items]);
  const live = useMemo(
    () => new Set([...byStep.entries()].filter(([, rows]) => rows.some((row) => isWorking(row.state))).map(([key]) => key)),
    [byStep],
  );
  const [all, setAll] = useState(false);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [reportOn, setReportOn] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (props.focus === null) return;
    setOpenStep(props.focus.key);
    if (props.focus.key !== UNASSIGNED) setAll(true);
    requestAnimationFrame(() => sectionRef.current?.querySelector(`[data-step="${props.focus?.key}"]`)?.scrollIntoView({ block: "nearest" }));
  }, [props.focus?.token]);
  const done = items.filter((item) => item.status === "done").length;
  const rows = all ? items.map((_, index) => ({ kind: "step" as const, index })) : planWindow(items, live);
  const unassigned = byStep.get(UNASSIGNED) ?? [];
  const keepHeadInView = () => requestAnimationFrame(() => sectionRef.current?.scrollIntoView({ block: "nearest" }));
  const toggleStep = (key: string) => setOpenStep((prev) => (prev === key ? null : key));
  const closeStep = (key: string) => {
    setOpenStep(null);
    requestAnimationFrame(() => sectionRef.current?.querySelector(`[data-step="${key}"]`)?.scrollIntoView({ block: "nearest" }));
  };

  const stepRow = (item: PlanStep) => {
    const kids = byStep.get(item.id) ?? [];
    const workingKids = kids.filter((row) => isWorking(row.state));
    const byKids = workingKids.length > 0 && item.status !== "done";
    const status = byKids ? "in_progress" : item.status;
    const activeMark = (item.status === "in_progress" && props.working) || byKids;
    const shown = openStep === item.id;
    const head = (
      <>
        <span className="cs-slot cs-mark">
          {item.status === "done" ? (
            <Icon name="check" size={12} strokeWidth={2} />
          ) : activeMark ? (
            <StatusPie state="running" />
          ) : item.status === "waiting" ? (
            <Icon name="hourglass" size={12} strokeWidth={1.8} />
          ) : (
            <span className="tp-ring" />
          )}
        </span>
        {/* 步骤名最多两行，其余省略；悬停看全文（状态卡里唯一允许悬停出提示的地方） */}
        <span className="cs-step-text" title={item.text}>
          {item.text}
        </span>
        {kids.length > 0 && (
          <span className="cs-tail cs-step-tail">
            <Robots rows={kids} />
            <Icon name={shown ? "chevron-up" : "chevron-down"} size={12} strokeWidth={1.8} className="cs-step-chev" />
          </span>
        )}
      </>
    );
    return (
      <li key={item.id} data-step={item.id} data-status={status} data-open={shown || undefined}>
        {kids.length > 0 ? (
          <button type="button" className="cs-row cs-btn cs-step" aria-expanded={shown} onClick={() => toggleStep(item.id)}>
            {head}
          </button>
        ) : (
          <div className="cs-row cs-step">{head}</div>
        )}
        {shown && <KidList rows={kids} now={props.now} onOpen={props.onOpenChild} onClose={() => closeStep(item.id)} />}
      </li>
    );
  };

  return (
    <section className="cs-sec" ref={sectionRef}>
      <div className="cs-head">
        <span className="cs-head-label">{t.chatStatus.progress}</span>
        {items.length > 0 && <span className="cs-n">{t.chatStatus.planCount(done, items.length)}</span>}
      </div>
      <ol className="cs-plan">
        {rows.map((row, index) => {
          if (row.kind === "fold") {
            const label = row.where === "before" ? t.chatStatus.foldBefore(row.count) : row.where === "after" ? t.chatStatus.foldAfter(row.count) : t.chatStatus.foldBetween(row.count);
            return (
              <li key={`fold-${index}`} data-status="fold">
                <button type="button" className="cs-row cs-btn cs-fold" onClick={() => setAll(true)}>
                  <span className="cs-slot">
                    <Icon name="chevron-down" size={12} strokeWidth={1.8} />
                  </span>
                  <span className="cs-text">{label}</span>
                </button>
              </li>
            );
          }
          const item = items[row.index];
          return item === undefined ? null : stepRow(item);
        })}
        {all && (
          <li data-status="fold">
            <button
              type="button"
              className="cs-row cs-btn cs-fold"
              onClick={() => {
                setAll(false);
                keepHeadInView();
              }}
            >
              <span className="cs-slot">
                <Icon name="chevron-up" size={12} strokeWidth={1.8} />
              </span>
              <span className="cs-text">{t.chatStatus.foldLess}</span>
            </button>
          </li>
        )}
        {unassigned.length > 0 && (
          <li data-step={UNASSIGNED} data-status="pseudo" data-open={openStep === UNASSIGNED || undefined}>
            <button type="button" className="cs-row cs-btn cs-step" aria-expanded={openStep === UNASSIGNED} title={t.chatStatus.unassignedTip} onClick={() => toggleStep(UNASSIGNED)}>
              <span className="cs-slot cs-mark">
                <Icon name="git-fork" size={12} strokeWidth={1.8} />
              </span>
              <span className="cs-step-text">
                {t.chatStatus.unassigned}
                <span className="cs-n"> {unassigned.length}</span>
              </span>
              <span className="cs-tail cs-step-tail">
                <Robots rows={unassigned} />
                <Icon name={openStep === UNASSIGNED ? "chevron-up" : "chevron-down"} size={12} strokeWidth={1.8} className="cs-step-chev" />
              </span>
            </button>
            {openStep === UNASSIGNED && <KidList rows={unassigned} now={props.now} onOpen={props.onOpenChild} onClose={() => closeStep(UNASSIGNED)} />}
          </li>
        )}
      </ol>
      {/* 收齐就汇报（原「直接打岔」，用户嫌不好听）：只在有子会话时出现，原型未接上 */}
      {props.children.length > 0 && (
        <div className="cs-report">
          <span className="cs-report-text">
            <span>{t.chatStatus.reportWhenAll}</span>
            <span className="cs-report-sub">{reportOn ? t.chatStatus.notWired : t.chatStatus.reportWhenAllSub}</span>
          </span>
          <Switch label={t.chatStatus.reportWhenAll} checked={false} onChange={() => setReportOn(true)} />
        </div>
      )}
    </section>
  );
}

/** 一步下面的子会话（从步骤垂下来的那一层）：要你的在前；已交回的收成一行；超过五个收成「还有 N 个」；底部「收起」 */
function KidList(props: { rows: readonly ChildRow[]; now: number; onOpen: (childId: string) => void; onClose: () => void }) {
  const t = useT();
  const [more, setMore] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const sorted = sortChildren(props.rows);
  const active = sorted.filter((row) => row.state !== "done");
  const done = sorted.filter((row) => row.state === "done");
  const shown = more ? active : active.slice(0, KIDS_SHOWN);
  return (
    <ul className="cs-kids">
      {shown.map((row) => (
        <KidRow key={row.meta.id} row={row} now={props.now} onOpen={props.onOpen} />
      ))}
      {active.length > shown.length && (
        <li>
          <button type="button" className="cs-kid-more" onClick={() => setMore(true)}>
            <Icon name="chevron-down" size={12} strokeWidth={1.8} />
            {t.chatStatus.showAll(active.length - shown.length)}
          </button>
        </li>
      )}
      {done.length > 0 && (
        <li>
          <button type="button" className="cs-kid-more" aria-expanded={doneOpen} onClick={() => setDoneOpen((value) => !value)}>
            <Icon name={doneOpen ? "chevron-up" : "chevron-down"} size={12} strokeWidth={1.8} />
            {t.chatStatus.handedBack(done.length)}
          </button>
        </li>
      )}
      {doneOpen && done.map((row) => <KidRow key={row.meta.id} row={row} now={props.now} onOpen={props.onOpen} />)}
      <li>
        <button type="button" className="cs-kid-more cs-kid-close" onClick={props.onClose}>
          <Icon name="chevron-up" size={12} strokeWidth={1.8} />
          {t.chatStatus.foldKids}
        </button>
      </li>
    </ul>
  );
}

function KidRow(props: { row: ChildRow; now: number; onOpen: (childId: string) => void }) {
  const t = useT();
  const { row } = props;
  const running = row.state === "running" || row.state === "stuck";
  const question = row.state === "waiting" ? [...(row.messages ?? [])].reverse().find((message) => message.kind === "question")?.text : undefined;
  const failed = row.state === "failed" ? [...(row.messages ?? [])].reverse().find((message) => message.kind === "failed")?.text : undefined;
  const handed = row.state === "done" ? [...(row.messages ?? [])].reverse().find((message) => message.kind === "done")?.text.split("\n")[0] : undefined;
  const line =
    running && row.activity !== null
      ? toolCallLine(row.activity.toolName, row.activity.input)
      : running
        ? t.chatStatus.thinking
        : (question ?? failed ?? handed ?? t.chatStatus.state[row.state]);
  const elapsed = running && row.activity !== null ? props.now - row.activity.since : null;
  const stuckMin = row.state === "stuck" && elapsed !== null ? Math.floor(elapsed / 60_000) : null;
  return (
    <li>
      <button type="button" className="cs-kid" data-state={row.state} onClick={() => props.onOpen(row.meta.id)}>
        <span className="cs-kid-bot">
          <Icon name="bot" size={12} strokeWidth={1.8} />
        </span>
        <span className="cs-kid-body">
          <span className="cs-kid-title">
            <span className="cs-kid-name">{row.meta.title}</span>
            <span className="cs-kid-state">
              {row.state === "stuck" && <Icon name="triangle-alert" size={12} strokeWidth={1.8} />}
              {t.chatStatus.state[row.state]}
            </span>
          </span>
          <span className="cs-kid-line">
            <span className={running && row.activity !== null ? "cs-kid-call mono" : "cs-kid-call"}>{line}</span>
            {elapsed !== null && (
              <span className="cs-kid-time" aria-label={stuckMin !== null ? t.chatStatus.stuckTip(stuckMin) : undefined}>
                {elapsedText(t, elapsed)}
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

// ───────────────────────── 产物 ─────────────────────────

/**
 * 产物：按文件类型分行（口径同每轮结尾的产物卡，多图片与看板），每行一排大缩略图（宽约卡内宽的 80%，露出下一张的一角暗示能滑）；行内横向滚动——
 * 触控板横扫原生就行，Shift + 滚轮在 mac 上鼠标会由系统转成横向，CDP / 部分鼠标不会，所以这里自己把
 * 「按着 Shift 的纵向滚动」换成横向。点一张 = 在右栏打开（演示文稿面板 / 文件面板 / 插件看板）；悬停不弹东西。
 */
function OutputsSection(props: { outputs: readonly StatusOutput[]; scope: ChatFileScope; onOpened: () => void }) {
  const t = useT();
  const groups = useMemo(() => groupOutputs(props.outputs), [props.outputs]);
  return (
    <section className="cs-sec">
      <div className="cs-head">
        <span className="cs-head-label">{t.chatStatus.outputs}</span>
        <span className="cs-n">{props.outputs.length}</span>
      </div>
      {groups.some((group) => group.key === "slides") && <SlideStyles />}
      {groups.map((group) => (
        <div key={group.key} className="cs-og">
          <div className="cs-og-head">
            <span>{t.chatStatus.groups[group.key]}</span>
            <span className="cs-n">{group.items.length}</span>
          </div>
          <ShiftScroll className="cs-strip" single={group.items.length === 1}>
            {group.items.map((output) => (
              <button
                key={output.path}
                type="button"
                className="cs-thumb"
                aria-label={`${output.title} · ${t.chatStatus.kinds[output.kind]}`}
                onClick={() => {
                  props.onOpened();
                  openOutput(output);
                }}
              >
                <OutputThumb output={output} scope={props.scope} />
                <span className="cs-thumb-name">
                  <span className="cs-thumb-title">{output.title}</span>
                  {output.by !== null && <Icon name="bot" size={12} strokeWidth={1.8} className="cs-by" />}
                </span>
                <span className="cs-thumb-kind">{kindLine(t, output)}</span>
              </button>
            ))}
          </ShiftScroll>
        </div>
      ))}
    </section>
  );
}

/** 缩略图下的类型行：同一行里并进来的格式写具体（PPTX / Word）；演示文稿带页数；子会话做的补一句是谁做的 */
function kindLine(t: Messages, output: StatusOutput): string {
  const kind = output.pages === null ? t.chatStatus.kinds[output.kind] : `${t.chatStatus.kinds[output.kind]} · ${t.chatStatus.pages(output.pages)}`;
  return output.by === null ? kind : `${kind} · ${t.chatStatus.byChild(output.by)}`;
}

function openOutput(output: StatusOutput): void {
  if (output.kind === "board") {
    if (output.plugin !== null) requestOpenPluginBoard({ plugin: output.plugin, draftPath: null });
    return;
  }
  requestOpenPanel({ kind: output.kind === "slides" ? "slides" : "files", path: output.path, force: true });
}

/** 横向滚动的一行：Shift + 纵向滚轮换成横向（passive: false 才能拦住纵向滚动） */
function ShiftScroll(props: { className: string; single: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (node === null) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (!event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      if (node.scrollWidth <= node.clientWidth) return;
      event.preventDefault();
      node.scrollLeft += event.deltaY;
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);
  return (
    <div ref={ref} className={props.className} data-single={props.single || undefined}>
      {props.children}
    </div>
  );
}

// ───────────────────────── 记忆 ─────────────────────────

/**
 * 记忆一行（第二版的「这次用到的」只剩它，节标题去掉，直接接在产物后面）：图标 · 记忆 · 行尾「读了 N 条 · 记住 N 条」· chevron。
 * 点了开右栏 审查 › 记忆。技能 / 网页 / 上传删掉的理由（用户 20:58）：点技能开的是全部技能，看不出这个会话用了哪些；
 * 网页与上传在右栏工具条、文件目录里本来就点得到。
 */
function MemoryRow(props: { read: number; remembered: number; onOpen: () => void }) {
  const t = useT();
  return (
    <section className="cs-sec cs-mem-sec">
      <button type="button" className="cs-row cs-btn cs-used" onClick={props.onOpen}>
        <span className="cs-slot">
          <Icon name={FEATURE_ICON.memory} size={14} strokeWidth={1.8} />
        </span>
        <span className="cs-used-label">{t.chatStatus.usedMemory}</span>
        <span className="cs-used-tail">{t.chatStatus.usedMemoryTail(props.read, props.remembered)}</span>
        <Icon name="chevron-right" size={12} strokeWidth={1.8} className="cs-step-chev" />
      </button>
    </section>
  );
}

// ───────────────────────── 杂项 ─────────────────────────

function dedupeBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function elapsedText(t: Messages, ms: number): string {
  const { h, m, s } = elapsedParts(ms);
  if (h > 0) return t.chatStatus.elapsedHM(h, m);
  if (m > 0) return t.chatStatus.elapsedM(m);
  return t.chatStatus.elapsedS(s);
}

function nextRunText(t: Messages, at: number, now: number): string {
  const date = new Date(at);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return new Date(now).toDateString() === date.toDateString() ? t.chatStatus.nextRun(time) : t.chatStatus.nextRunTomorrow(time);
}

/** 走表：since 列表空就不走；窗口失焦 / 隐藏就停，回到前台立刻补一次 */
function useTicker(sinces: readonly number[], setNow: (now: number) => void): void {
  const key = sinces.join(",");
  useEffect(() => {
    if (sinces.length === 0) return undefined;
    let timer: number | undefined;
    const active = () => document.visibilityState === "visible" && document.hasFocus();
    const schedule = () => {
      window.clearTimeout(timer);
      if (!active()) return;
      const wait = nextTickIn(sinces, Date.now());
      if (wait === null) return;
      timer = window.setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, wait);
    };
    const wake = () => {
      setNow(Date.now());
      schedule();
    };
    schedule();
    window.addEventListener("focus", wake);
    window.addEventListener("blur", schedule);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", wake);
      window.removeEventListener("blur", schedule);
      document.removeEventListener("visibilitychange", wake);
    };
    // sinces 的内容由 key 代表
  }, [key]);
}

/** 子会话的转录尾窗（原型：每个子会话读一次尾窗，meta 的 updatedAt 变了重读；真功能里应由主进程推一行「在跑什么」） */
function useChildTails(kids: readonly SessionMeta[]): ReadonlyMap<string, readonly TranscriptRecord[]> {
  const [tails, setTails] = useState<ReadonlyMap<string, readonly TranscriptRecord[]>>(new Map());
  const key = kids.map((meta) => `${meta.id}:${meta.updatedAt}`).join(",");
  useEffect(() => {
    let alive = true;
    void (async () => {
      const next = new Map<string, readonly TranscriptRecord[]>();
      const queue = [...kids];
      const worker = async () => {
        for (let meta = queue.shift(); meta !== undefined; meta = queue.shift()) {
          const detail = await api.session.load(meta.id).catch(() => null);
          next.set(meta.id, (detail?.transcript ?? []) as readonly TranscriptRecord[]);
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (alive) setTails(next);
    })();
    return () => {
      alive = false;
    };
  }, [key]);
  return tails;
}

/** 这条会话的 agent 开的、还开着的终端：terminal_execute 的结果里有 terminalId 和命令，开着与否问终端列表 */
function useLiveTerminals(records: readonly TranscriptRecord[]): { id: string; command: string; since: number }[] {
  const launched = useMemo(() => {
    const map = new Map<string, { id: string; command: string; since: number }>();
    for (const record of records) {
      if (record.role !== "tool" || record.toolName !== "terminal_execute" || record.status !== "complete") continue;
      const text = record.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
      const id = /visible terminal (\S+) \(/.exec(text)?.[1];
      const command = (record.input as Record<string, unknown> | null)?.["command"];
      if (id !== undefined && typeof command === "string") map.set(id, { id, command, since: record.timestamp });
    }
    return [...map.values()];
  }, [records]);
  const [alive, setAlive] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let live = true;
    const refresh = () =>
      void api.terminal.list().then((list) => {
        if (live) setAlive(new Set(list.filter((item) => item.exited === null).map((item) => item.terminalId)));
      });
    refresh();
    const off = api.terminal.onEvent((event) => {
      if (event.type !== "output") refresh();
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return launched.filter((row) => alive.has(row.id));
}

/** 这条会话的自动化（agent 在这里建的、或投回这条会话的），只列还排着的 */
function useSessionAutomations(sessionId: string): Automation[] {
  const [list, setList] = useState<Automation[]>([]);
  useEffect(() => {
    let live = true;
    const refresh = () =>
      void api.automation.list().then((all) => {
        if (!live) return;
        setList(
          all.filter(
            (item) =>
              item.status === "active" &&
              ((item.createdBy.kind === "agent" && item.createdBy.sessionId === sessionId) ||
                (item.target.kind === "this_session" && item.target.sessionId === sessionId)),
          ),
        );
      });
    refresh();
    const off = api.automation.onEvent(() => refresh());
    return () => {
      live = false;
      off();
    };
  }, [sessionId]);
  return list;
}

// ───────────────────────── 目标 ─────────────────────────

function GoalRow(props: { text: string; versions: readonly string[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const n = Math.max(1, props.versions.length);
  return (
    <section className="cs-goal">
      <div className="cs-goal-line">
        <span className="cs-goal-text" title={props.text}>
          {props.text}
        </span>
        {n > 1 && (
          <button type="button" className="cs-ver" aria-expanded={open} title={t.chatStatus.versionTip} onClick={() => setOpen((value) => !value)}>
            {t.chatStatus.version(n)}
          </button>
        )}
      </div>
      {open && (
        <ol className="cs-vers">
          {[...props.versions].reverse().map((text, index) => (
            <li key={`${index}:${text}`} data-now={index === 0 || undefined}>
              <span className="cs-ver-n">{index === 0 ? t.chatStatus.versionNow : t.chatStatus.versionN(n - index)}</span>
              <span className="cs-ver-text">{text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

interface ChildRow {
  meta: SessionMeta;
  activity: ChildActivity | null;
  state: ChildState;
  since: number;
  stepId: string | null;
  messages: readonly ChannelMessage[] | undefined;
}


/**
 * 行尾一排机器人：在干活的几个画几个（多了 +N）；要你的（在问 / 卡住）黄、失败红；没有在干活的只写「N 个已交回」。
 * 卡窄（< 340，见 chat-status.css 的容器查询）时收成一个机器人 + 个数（「N 个已交回」收成 ✓ N），把宽度让给两行的步骤名——
 * 啰嗦进度在 280 宽时先坏的就是这里：三个头像 + chevron 吃掉近一半行宽，步骤名一行只剩七个字。
 */
function Robots(props: { rows: readonly ChildRow[] }) {
  const t = useT();
  const working = sortChildren(props.rows.filter((row) => isWorking(row.state) || row.state === "failed"));
  if (working.length === 0) {
    const done = props.rows.filter((row) => row.state === "done").length;
    if (done === 0) return null;
    return (
      <>
        <span className="cs-meta cs-wide">{t.chatStatus.handedBack(done)}</span>
        <span className="cs-meta cs-compact" aria-label={t.chatStatus.handedBack(done)}>
          <Icon name="check" size={12} strokeWidth={2} />
          {done}
        </span>
      </>
    );
  }
  const first = working[0];
  return (
    <>
      <span className="cs-robots cs-wide" aria-label={t.chatStatus.robots(working.length)}>
        {working.slice(0, ROBOTS_SHOWN).map((row) => (
          <span key={row.meta.id} className="cs-robot" data-state={row.state}>
            <Icon name="bot" size={12} strokeWidth={1.8} />
          </span>
        ))}
        {working.length > ROBOTS_SHOWN && <span className="cs-robot-more">+{working.length - ROBOTS_SHOWN}</span>}
      </span>
      <span className="cs-robots cs-compact" aria-label={t.chatStatus.robots(working.length)}>
        <span className="cs-robot" data-state={first?.state}>
          <Icon name="bot" size={12} strokeWidth={1.8} />
        </span>
        <span className="cs-robot-more">{working.length}</span>
      </span>
    </>
  );
}
