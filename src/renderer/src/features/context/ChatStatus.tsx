import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { childSessions, type SessionMeta, type TranscriptRecord } from "@shared/session";
import type { Automation } from "@shared/automation";
import type { ChannelMessage } from "@shared/channel";
import type { FilePreview } from "@shared/files";
import type { Excerpt } from "@shared/excerpt";
import type { ContextGroupKey } from "./context-panel-view.ts";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";
import { Icon } from "../../shell/Icon";
import { StatusPie } from "../../shell/StatusPie";
import { FileTypeIcon } from "../../shell/FileTypeIcon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { requestOpenPanel } from "../../shell/open-panel.ts";
import { Switch } from "../settings/SettingControls";
import { MarkdownBlock } from "../chat/MarkdownBlock";
import type { SessionEntry } from "../chat/session-states.ts";
import type { ChatSession, SessionEngine } from "../chat/useChatSession";
import { useTaskRecords } from "../chat/useTaskRecords.ts";
import { useChannelSummaries } from "../chat/useChannelSummaries";
import { useParentChannels } from "../chat/useChannelMessages";
import { openChatFile, readChatFile, type ChatFileScope } from "../chat/chat-file-scope.ts";
import { useMemorySession } from "../memory/useMemory.ts";
import type { ExcerptJump } from "../review/ExcerptsTab";
import { SlideStatic } from "../slides-editor/ElementView";
import { parseDeckSafe } from "../slides-editor/use-deck-editor.ts";
import { DEFAULT_COLLAPSED } from "../../shell/right-panel-memory.ts";
import { useProgressDigest } from "./TaskProgress";
import { ContextBody } from "./ContextPanel";
import { useGoalLedger } from "./useGoalLedger.ts";
import type { PlanStep } from "./plan-timeline.ts";
import { STATUS_FOCUS_EVENT, type StatusFocusDetail } from "./chat-status-flag.ts";
import {
  childActivityOf,
  childStateOf,
  delegationSteps,
  elapsedParts,
  isWorking,
  nextTickIn,
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
 * 它跨轮常驻，所以浮在对话区右上角，不进对话流、不挤对话列；可收起成一枚小钮（小钮上看得出有东西在跑）。
 *
 * 第一屏（每一节有内容才出现）：目标（一行 + 第几版，点开看以前各版）· 进度（计划；子会话挂在派出它时在做的那一步上，
 * 行尾一排机器人，点开逐个看它在跑什么、跑了多久）· 在跑的（常驻终端、自动化）· 产物（一份一行，行尾写类型）·
 * 记忆（一行）。底部一行：上下文 / 改动 / 摘抄，点了才在卡里展开。记忆与产物点了不跳右栏：就地弹临时预览，点外面关。
 *
 * 数据全部是现有的：进度与目标同右栏「这条任务」（useProgressDigest、useGoalLedger），子会话同子会话面板
 * （childSessions、通道账本），产物同结尾产物卡（sessionOutputs），记忆同记忆页签（useMemorySession），上下文直接是
 * 右栏上下文页签的 ContextBody。不改主进程、不改 src/shared 契约。
 */
export function ChatStatus(props: {
  session: ChatSession;
  engine: SessionEngine;
  sessionId: string;
  entry: SessionEntry;
  /** 主会话自己在跑 / 等你（侧栏状态饼同一个推导）：在做的那步画不画在跑饼 */
  working: boolean;
  onOpenSubSession: (childId: string) => void;
  onOpenReviewAt: (path: string) => void;
  onOpenExcerpt: (jump: ExcerptJump) => void;
}) {
  const t = useT();
  const { entry, sessionId, session } = props;
  const turnActive = entry.phase === "turn";
  // 窄（对话区不到 NARROW_PANE 宽：小窗、或右栏开着）时卡默认收成小钮，免得一打开会话就盖住正文；
  // 在窄的时候点开算这一次的，不改宽时记住的开 / 收
  const hostRef = useRef<HTMLDivElement | null>(null);
  const narrow = useNarrowPane(hostRef);
  const [openWide, setOpenWide] = useState(() => readOpen());
  const [openNarrow, setOpenNarrow] = useState(false);
  const open = narrow ? openNarrow : openWide;
  const toggleOpen = (next: boolean) => {
    if (narrow) {
      setOpenNarrow(next);
      return;
    }
    setOpenWide(next);
    writeOpen(next);
  };
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

  // ── 记忆 ──
  const memory = useMemorySession(sessionId);
  const remembered = memory.data?.turns.flatMap((turn) => turn.remembered) ?? [];
  const used = dedupeBy(memory.data?.turns.flatMap((turn) => turn.used) ?? [], (hit) => hit.id);

  // ── 临时预览（点外面关）──
  const [preview, setPreview] = useState<{ kind: "output"; output: StatusOutput; at: Anchor } | { kind: "memory"; at: Anchor } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (preview === null) return undefined;
    const down = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target !== null && (popRef.current?.contains(target) || (event.target as HTMLElement).closest?.("[data-preview-anchor]"))) return;
      setPreview(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreview(null);
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, [preview]);
  const anchorOf = (element: HTMLElement): Anchor => {
    const card = cardRef.current;
    if (card === null) return { top: 0, bottom: 0, cardHeight: 0, room: 0 };
    const box = card.getBoundingClientRect();
    const row = element.getBoundingClientRect();
    return { top: row.top - box.top, bottom: row.bottom - box.top, cardHeight: box.height, room: window.innerHeight - box.top };
  };

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

  const [secondary, setSecondary] = useState<"context" | "changes" | "excerpts" | null>(null);
  const [notWired, setNotWired] = useState(false);

  const states = children.map((row) => row.state);
  const signal = pillSignal(states, (turnActive ? 1 : 0) + terminals.length);

  if (!open) {
    const label = signal === null ? t.chatStatus.pill.quiet : t.chatStatus.pill[signal.kind](signal.count);
    return (
      <div className="cs-host" ref={hostRef}>
        <button
          type="button"
          className="cs-pill"
          data-signal={signal?.kind}
          aria-label={`${t.chatStatus.name} · ${label}`}
          title={`${t.chatStatus.name} · ${label}`}
          onClick={() => toggleOpen(true)}
        >
          {signal === null ? (
            <Icon name={FEATURE_ICON.task} size={14} strokeWidth={1.8} />
          ) : (
            <StatusPie state={signal.kind === "waiting" ? "waiting" : signal.kind === "failed" ? "failed" : "running"} />
          )}
          {signal !== null && <span className="cs-pill-n">{signal.count}</span>}
        </button>
      </div>
    );
  }

  const goalVersions = ledger.entries.filter((item) => item.kind === "goal");
  const working = props.working || turnActive;
  return (
    <div className="cs-host" ref={hostRef}>
      <div className="cs-card" ref={cardRef} role="complementary" aria-label={t.chatStatus.name}>
        {/* 头：目标常驻（往下滚也看得见在为什么干活）+ 收起键；没有目标时只剩收起键 */}
        <div className="cs-top">
          {ledger.goal !== null ? <GoalRow text={ledger.goal.text} versions={goalVersions.map((item) => (item.kind === "goal" ? item.to : ""))} /> : <span className="cs-top-fill" />}
          <button type="button" className="cs-close" aria-label={t.chatStatus.collapse} title={t.chatStatus.collapse} onClick={() => toggleOpen(false)}>
            <Icon name="minimize-2" size={12} strokeWidth={1.8} />
          </button>
        </div>
        <div className="cs-scroll">

          {timeline !== null && plan !== null && (
            <ProgressSection
              items={timeline.current.items}
              children={children}
              working={working}
              now={now}
              focus={focusStep}
              onOpenChild={props.onOpenSubSession}
            />
          )}
          {(timeline === null || plan === null) && children.length > 0 && (
            <ProgressSection items={[]} children={children} working={working} now={now} focus={focusStep} onOpenChild={props.onOpenSubSession} />
          )}

          {(terminals.length > 0 || automations.length > 0) && (
            <section className="cs-sec">
              <div className="cs-head">
                <span className="cs-head-label">{t.chatStatus.running}</span>
              </div>
              {terminals.map((row) => (
                <div key={row.id} className="cs-row" title={row.command}>
                  <span className="cs-slot">
                    <Icon name={FEATURE_ICON.terminal} size={14} strokeWidth={1.8} />
                  </span>
                  <span className="cs-text mono">{row.command}</span>
                  <span className="cs-tail">{elapsedText(t, now - row.since)}</span>
                </div>
              ))}
              {automations.map((item) => (
                <div key={item.id} className="cs-row" title={item.prompt}>
                  <span className="cs-slot">
                    <Icon name={FEATURE_ICON.automation} size={14} strokeWidth={1.8} />
                  </span>
                  <span className="cs-text">{item.title}</span>
                  <span className="cs-tail">{item.nextRunAt === null ? "" : nextRunText(t, item.nextRunAt, now)}</span>
                </div>
              ))}
            </section>
          )}

          {outputs.length > 0 && (
            <OutputsSection
              outputs={outputs}
              active={preview?.kind === "output" ? preview.output.path : null}
              onPick={(output, element) =>
                setPreview((prev) => (prev?.kind === "output" && prev.output.path === output.path ? null : { kind: "output", output, at: anchorOf(element) }))
              }
            />
          )}

          {(remembered.length > 0 || used.length > 0) && (
            <section className="cs-sec">
              <button
                type="button"
                className="cs-row cs-btn"
                data-preview-anchor
                aria-expanded={preview?.kind === "memory"}
                onClick={(event) => {
                  const element = event.currentTarget;
                  setPreview((prev) => (prev?.kind === "memory" ? null : { kind: "memory", at: anchorOf(element) }));
                }}
              >
                <span className="cs-slot">
                  <Icon name={FEATURE_ICON.memory} size={14} strokeWidth={1.8} />
                </span>
                <span className="cs-text">{t.chatStatus.memory(remembered.length, used.length)}</span>
                <span className="cs-tail">
                  <Icon name="chevron-left" size={12} strokeWidth={1.8} />
                </span>
              </button>
            </section>
          )}

          {secondary !== null && (
            <section className="cs-sec cs-second">
              <div className="cs-head">
                <span className="cs-head-label">{t.chatStatus[secondary]}</span>
              </div>
              {secondary === "context" ? (
                <ContextBody
                  sessionId={sessionId}
                  entry={entry}
                  cwd={session.cwd ?? ""}
                  scope="task"
                  collapsed={CONTEXT_COLLAPSED}
                  onToggleGroup={() => undefined}
                />
              ) : secondary === "changes" ? (
                <ChangesList records={view.records} onOpen={props.onOpenReviewAt} />
              ) : (
                <ExcerptsList sessionId={sessionId} onOpen={props.onOpenExcerpt} />
              )}
            </section>
          )}
        </div>
        <div className="cs-foot" role="tablist">
          {(["context", "changes", "excerpts"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              className="cs-foot-tab"
              aria-selected={secondary === key}
              onClick={() => setSecondary((prev) => (prev === key ? null : key))}
            >
              <Icon name={key === "context" ? "layers" : key === "changes" ? FEATURE_ICON.review : "quote"} size={12} strokeWidth={1.8} />
              {t.chatStatus[key]}
            </button>
          ))}
          {/* 允许直接打岔（与输入框上方状态条那条线配套；原型未接上）：放在底部一行，不占进度节的高度 */}
          {children.length > 0 && (
          <span className="cs-foot-switch" title={t.chatStatus.interrupt}>
            <span>{notWired ? t.chatStatus.notWired : t.chatStatus.interruptShort}</span>
            <Switch label={t.chatStatus.interrupt} checked={false} onChange={() => setNotWired(true)} />
          </span>
          )}
        </div>
        {preview !== null && (
          <div className="cs-pop" ref={popRef} style={popStyle(preview.at)}>
            {preview.kind === "output" ? (
              <OutputPreview output={preview.output} scope={{ sessionId, workspaceId: session.workspaceId, cwd: session.cwd }} />
            ) : (
              <MemoryPreview remembered={remembered.map((view_) => view_.entry.text)} used={used.map((hit) => hit.text)} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const UNASSIGNED = "__unassigned";

/** 临时预览挂在哪一行旁边：行在卡的上半截就从行顶往下长，在下半截就让预览的底对齐行底往上长（不出窗口） */
interface Anchor {
  top: number;
  bottom: number;
  cardHeight: number;
  /** 卡顶到窗口底还有多高 */
  room: number;
}
function popStyle(at: Anchor): React.CSSProperties {
  const gap = 8;
  if (at.top > at.cardHeight * 0.45) return { bottom: Math.max(0, at.cardHeight - at.bottom - gap), maxHeight: at.bottom + gap };
  return { top: Math.max(0, at.top - gap), maxHeight: Math.max(160, at.room - at.top - 24) };
}
/** 卡里的上下文：规则组照右栏默认收着，其余展开 */
const CONTEXT_COLLAPSED: ReadonlySet<ContextGroupKey> = new Set(DEFAULT_COLLAPSED);
const OPEN_KEY = "orbita.proto.chatStatus.open";
/** 对话区比这窄就默认收起：900 的正文列两侧各剩不到 50px，304 宽的卡会盖住正文的右三分之一 */
const NARROW_PANE = 1000;

function useNarrowPane(hostRef: React.RefObject<HTMLDivElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const pane = hostRef.current?.parentElement ?? null;
    if (pane === null) return undefined;
    const measure = () => setNarrow(pane.clientWidth < NARROW_PANE);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);
  return narrow;
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

// ───────────────────────── 进度 ─────────────────────────

interface ChildRow {
  meta: SessionMeta;
  activity: ChildActivity | null;
  state: ChildState;
  since: number;
  stepId: string | null;
  messages: readonly ChannelMessage[] | undefined;
}

/** 一步下面露几个子会话（多的收成「还有 N 个」；已交回的收成「N 个已交回」） */
const KIDS_SHOWN = 5;
/** 行尾最多画几个机器人 */
const ROBOTS_SHOWN = 3;

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
  const [openStep, setOpenStep] = useState<Record<string, boolean>>({});
  const listRef = useRef<HTMLOListElement | null>(null);
  useLayoutEffect(() => {
    if (props.focus === null) return;
    setOpenStep((prev) => ({ ...prev, [props.focus?.key ?? ""]: true }));
    setAll(true);
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-step="${props.focus?.key}"]`)?.scrollIntoView({ block: "nearest" }));
  }, [props.focus?.token]);
  const done = items.filter((item) => item.status === "done").length;
  const rows = all ? items.map((_, index) => ({ kind: "step" as const, index })) : planWindow(items, live);
  const unassigned = byStep.get(UNASSIGNED) ?? [];

  const stepRow = (item: PlanStep) => {
    const kids = byStep.get(item.id) ?? [];
    const workingKids = kids.filter((row) => isWorking(row.state));
    const byKids = workingKids.length > 0 && item.status !== "done";
    const status = byKids ? "in_progress" : item.status;
    const activeMark = (item.status === "in_progress" && props.working) || byKids;
    const shown = openStep[item.id] ?? false;
    const head = (
      <>
        <span className="cs-slot">
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
        <span className="cs-text" title={item.text}>
          {item.text}
        </span>
        <span className="cs-tail">{kids.length > 0 ? <Robots rows={kids} /> : null}</span>
      </>
    );
    return (
      <li key={item.id} data-step={item.id} data-status={status}>
        {kids.length > 0 ? (
          <button type="button" className="cs-row cs-btn" aria-expanded={shown} title={t.chatStatus.robots(workingKids.length)} onClick={() => setOpenStep((prev) => ({ ...prev, [item.id]: !shown }))}>
            {head}
          </button>
        ) : (
          <div className="cs-row">{head}</div>
        )}
        {shown && <KidList rows={kids} now={props.now} onOpen={props.onOpenChild} />}
      </li>
    );
  };

  return (
    <section className="cs-sec">
      {items.length > 0 && (
        <div className="cs-head">
          <span className="cs-head-label">{t.chatStatus.progress}</span>
          <span className="cs-n">{t.chatStatus.planCount(done, items.length)}</span>
          {all && (
            <button type="button" className="cs-head-act" onClick={() => setAll(false)}>
              {t.chatStatus.foldLess}
            </button>
          )}
        </div>
      )}
      <ol className="cs-plan" ref={listRef}>
        {rows.map((row, index) => {
          if (row.kind === "fold") {
            const label = row.where === "before" ? t.chatStatus.foldBefore(row.count) : row.where === "after" ? t.chatStatus.foldAfter(row.count) : t.chatStatus.foldBetween(row.count);
            return (
              <li key={`fold-${index}`} data-status="fold">
                <button type="button" className="cs-row cs-btn cs-fold" onClick={() => setAll(true)}>
                  <span className="cs-slot">
                    <Icon name="chevron-right" size={12} strokeWidth={1.8} />
                  </span>
                  <span className="cs-text">{label}</span>
                </button>
              </li>
            );
          }
          const item = items[row.index];
          return item === undefined ? null : stepRow(item);
        })}
        {unassigned.length > 0 && (
          <li data-step={UNASSIGNED} data-status="pseudo">
            <button
              type="button"
              className="cs-row cs-btn"
              aria-expanded={openStep[UNASSIGNED] ?? false}
              title={t.chatStatus.unassignedTip}
              onClick={() => setOpenStep((prev) => ({ ...prev, [UNASSIGNED]: !(prev[UNASSIGNED] ?? false) }))}
            >
              <span className="cs-slot">
                <Icon name="bot" size={12} strokeWidth={1.8} />
              </span>
              <span className="cs-text">
                {t.chatStatus.unassigned}
                <span className="cs-n"> {unassigned.length}</span>
              </span>
              <span className="cs-tail">
                <Robots rows={unassigned} />
              </span>
            </button>
            {(openStep[UNASSIGNED] ?? false) && <KidList rows={unassigned} now={props.now} onOpen={props.onOpenChild} />}
          </li>
        )}
      </ol>
    </section>
  );
}

/** 行尾一排机器人：在干活的几个画几个（多了 +N）；要你的（在问 / 卡住）黄、失败红；没有在干活的只写「N 个已交回」 */
function Robots(props: { rows: readonly ChildRow[] }) {
  const t = useT();
  const working = sortChildren(props.rows.filter((row) => isWorking(row.state) || row.state === "failed"));
  if (working.length === 0) {
    const done = props.rows.filter((row) => row.state === "done").length;
    return done > 0 ? <span className="cs-meta">{t.chatStatus.handedBack(done)}</span> : null;
  }
  return (
    <span className="cs-robots" aria-label={t.chatStatus.robots(working.length)}>
      {working.slice(0, ROBOTS_SHOWN).map((row) => (
        <span key={row.meta.id} className="cs-robot" data-state={row.state}>
          <Icon name="bot" size={12} strokeWidth={1.8} />
        </span>
      ))}
      {working.length > ROBOTS_SHOWN && <span className="cs-robot-more">+{working.length - ROBOTS_SHOWN}</span>}
    </span>
  );
}

/** 一步下面的子会话：要你的在前；已交回的收成一行；超过五个收成「还有 N 个」 */
function KidList(props: { rows: readonly ChildRow[]; now: number; onOpen: (childId: string) => void }) {
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
            {t.chatStatus.showAll(active.length - shown.length)}
          </button>
        </li>
      )}
      {done.length > 0 && (
        <li>
          <button type="button" className="cs-kid-more" aria-expanded={doneOpen} onClick={() => setDoneOpen((value) => !value)}>
            <Icon name={doneOpen ? "chevron-down" : "chevron-right"} size={12} strokeWidth={1.8} />
            {t.chatStatus.handedBack(done.length)}
          </button>
        </li>
      )}
      {doneOpen && done.map((row) => <KidRow key={row.meta.id} row={row} now={props.now} onOpen={props.onOpen} />)}
    </ul>
  );
}

function KidRow(props: { row: ChildRow; now: number; onOpen: (childId: string) => void }) {
  const t = useT();
  const { row } = props;
  const running = row.state === "running" || row.state === "stuck";
  const question = row.state === "waiting" ? [...(row.messages ?? [])].reverse().find((message) => message.kind === "question")?.text : undefined;
  const failed = row.state === "failed" ? [...(row.messages ?? [])].reverse().find((message) => message.kind === "failed")?.text : undefined;
  // 交回的：它交回的那句话（第一行），不再写一遍「已交回」
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
        <span className="cs-kid-title">
          <span className="cs-kid-name" title={row.meta.title}>
            {row.meta.title}
          </span>
          <span className="cs-kid-state">
            {row.state === "stuck" && <Icon name="triangle-alert" size={12} strokeWidth={1.8} />}
            {t.chatStatus.state[row.state]}
          </span>
        </span>
        <span className="cs-kid-line">
          <span className={running && row.activity !== null ? "cs-kid-call mono" : "cs-kid-call"} title={line}>
            {line}
          </span>
          {elapsed !== null && (
            <span className="cs-kid-time" title={stuckMin !== null ? t.chatStatus.stuckTip(stuckMin) : undefined}>
              {elapsedText(t, elapsed)}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

// ───────────────────────── 产物 ─────────────────────────

const OUTPUTS_SHOWN = 4;

function OutputsSection(props: { outputs: readonly StatusOutput[]; active: string | null; onPick: (output: StatusOutput, element: HTMLElement) => void }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const shown = all ? props.outputs : props.outputs.slice(0, OUTPUTS_SHOWN);
  return (
    <section className="cs-sec">
      <div className="cs-head">
        <span className="cs-head-label">{t.chatStatus.outputs}</span>
        <span className="cs-n">{props.outputs.length}</span>
      </div>
      {shown.map((output) => (
        <button
          key={output.path}
          type="button"
          className="cs-row cs-btn"
          data-preview-anchor
          aria-pressed={props.active === output.path}
          title={output.by === null ? output.path : `${output.path}\n${t.chatStatus.byChild(output.by)}`}
          onClick={(event) => props.onPick(output, event.currentTarget)}
        >
          <span className="cs-slot cs-file">
            {output.kind === "board" ? <Icon name={FEATURE_ICON.board} size={14} strokeWidth={1.8} /> : <FileTypeIcon name={output.path.split(/[\\/]/).pop() ?? ""} size={16} />}
          </span>
          <span className="cs-text">
            {output.title}
            {output.by !== null && <Icon name="bot" size={12} strokeWidth={1.8} className="cs-by" />}
          </span>
          <span className="cs-tail">{t.chatStatus.kinds[output.kind]}</span>
        </button>
      ))}
      {props.outputs.length > shown.length && (
        <button type="button" className="cs-row cs-btn cs-fold" onClick={() => setAll(true)}>
          <span className="cs-slot">
            <Icon name="chevron-right" size={12} strokeWidth={1.8} />
          </span>
          <span className="cs-text">{t.chatStatus.outputsMore(props.outputs.length - shown.length)}</span>
        </button>
      )}
    </section>
  );
}

/** 产物的临时预览：文档渲染正文、图片原图、演示文稿第一页；看不了的写一句，给「在右栏打开」与「用默认应用打开」 */
function OutputPreview(props: { output: StatusOutput; scope: ChatFileScope }) {
  const t = useT();
  const { output } = props;
  const [data, setData] = useState<FilePreview | null | undefined>(undefined);
  useEffect(() => {
    if (output.kind === "board") {
      setData(null);
      return undefined;
    }
    let alive = true;
    setData(undefined);
    void readChatFile(props.scope, output.path).then((value) => {
      if (alive) setData(value);
    });
    return () => {
      alive = false;
    };
  }, [output.path]);
  const openPanel = () => {
    if (output.kind === "board") return;
    requestOpenPanel({ kind: output.kind === "slides" ? "slides" : "files", path: output.path, force: true });
  };
  let body: React.ReactNode;
  if (data === undefined) body = <p className="cs-pop-hint">{t.chatStatus.previewLoading}</p>;
  else if (data !== null && data.kind === "image") body = <img className="cs-pop-img" alt={output.title} src={`data:${data.mime};base64,${data.base64}`} />;
  else if (data !== null && data.kind === "text" && output.kind === "slides") body = <DeckThumb text={data.text} />;
  else if (data !== null && data.kind === "text" && output.kind === "doc") body = <div className="cs-pop-doc"><MarkdownBlock text={data.text} /></div>;
  else if (data !== null && data.kind === "text") body = <pre className="cs-pop-pre">{data.text.slice(0, 1200)}</pre>;
  else body = <p className="cs-pop-hint">{t.chatStatus.noPreview}</p>;
  return (
    <>
      <div className="cs-pop-head">
        <span className="cs-slot cs-file">
          {output.kind === "board" ? <Icon name={FEATURE_ICON.board} size={14} strokeWidth={1.8} /> : <FileTypeIcon name={output.path.split(/[\\/]/).pop() ?? ""} size={16} />}
        </span>
        <span className="cs-pop-title" title={output.path}>
          {output.title}
        </span>
        <span className="cs-tail">{t.chatStatus.kinds[output.kind]}</span>
      </div>
      {output.by !== null && <div className="cs-pop-by">{t.chatStatus.byChild(output.by)}</div>}
      <div className="cs-pop-body">{body}</div>
      {output.kind !== "board" && (
        <div className="cs-pop-acts">
          <button type="button" className="cs-pop-btn" onClick={openPanel}>
            <Icon name="panel-right" size={12} strokeWidth={1.8} />
            {t.chatStatus.openInPanel}
          </button>
          <button type="button" className="cs-pop-btn" onClick={() => void openChatFile(props.scope, output.path)}>
            <Icon name="external-link" size={12} strokeWidth={1.8} />
            {t.chatStatus.openDefault}
          </button>
        </div>
      )}
    </>
  );
}

function DeckThumb(props: { text: string }) {
  const t = useT();
  const deck = useMemo(() => parseDeckSafe(props.text).deck, [props.text]);
  const first = deck.slides[0];
  if (first === undefined) return <p className="cs-pop-hint">{t.chatStatus.noPreview}</p>;
  return (
    <div className="cs-pop-deck">
      <SlideStatic slide={first} aspect={deck.aspect} ctx={{ deck, imageUrl: () => null }} width={268} index={0} />
      <span className="cs-meta">{t.chatStatus.pages(deck.slides.length)}</span>
    </div>
  );
}

function MemoryPreview(props: { remembered: readonly string[]; used: readonly string[] }) {
  const t = useT();
  return (
    <div className="cs-mem">
      {props.remembered.length > 0 && (
        <>
          <div className="cs-pop-label">{t.chatStatus.memRemembered}</div>
          <ul>
            {props.remembered.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </>
      )}
      {props.used.length > 0 && (
        <>
          <div className="cs-pop-label">{t.chatStatus.memUsed}</div>
          <ul>
            {props.used.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ───────────────────────── 二级：改动 / 摘抄 ─────────────────────────

function ChangesList(props: { records: readonly TranscriptRecord[]; onOpen: (path: string) => void }) {
  const t = useT();
  const files = useMemo(() => {
    const map = new Map<string, { path: string; added: number; removed: number }>();
    for (const record of props.records) {
      if (record.role !== "file-turn") continue;
      for (const change of record.changes) {
        const prev = map.get(change.path);
        map.set(change.path, { path: change.path, added: (prev?.added ?? 0) + change.added, removed: (prev?.removed ?? 0) + change.removed });
      }
    }
    return [...map.values()].reverse();
  }, [props.records]);
  if (files.length === 0) return <p className="cs-pop-hint">{t.chatStatus.noChanges}</p>;
  return (
    <>
      {files.map((file) => (
        <button key={file.path} type="button" className="cs-row cs-btn" title={file.path} onClick={() => props.onOpen(file.path)}>
          <span className="cs-slot cs-file">
            <FileTypeIcon name={file.path.split(/[\\/]/).pop() ?? ""} size={16} />
          </span>
          <span className="cs-text">{file.path.split(/[\\/]/).pop()}</span>
          <span className="cs-tail mono">
            {file.added + file.removed > 0 ? `+${file.added} −${file.removed}` : ""}
          </span>
        </button>
      ))}
    </>
  );
}

function ExcerptsList(props: { sessionId: string; onOpen: (jump: ExcerptJump) => void }) {
  const t = useT();
  const [items, setItems] = useState<Excerpt[] | null>(null);
  useEffect(() => {
    let alive = true;
    void api.excerpt.list().then((response) => {
      if (alive) setItems(response.items.map((item) => item.excerpt).filter((excerpt) => excerpt.sessionId === props.sessionId));
    });
    return () => {
      alive = false;
    };
  }, [props.sessionId]);
  const open = useCallback(
    (excerpt: Excerpt) =>
      props.onOpen({ sessionId: excerpt.sessionId, role: excerpt.role, text: excerpt.text, ...(excerpt.turn === undefined ? {} : { turn: excerpt.turn }) }),
    [props.onOpen],
  );
  if (items === null) return <p className="cs-pop-hint">{t.chatStatus.previewLoading}</p>;
  if (items.length === 0) return <p className="cs-pop-hint">{t.chatStatus.noExcerpts}</p>;
  return (
    <>
      {items.map((excerpt) => (
        <button key={excerpt.id} type="button" className="cs-row cs-btn cs-excerpt" onClick={() => open(excerpt)}>
          <span className="cs-slot">
            <Icon name="quote" size={12} strokeWidth={1.8} />
          </span>
          <span className="cs-text">{excerpt.text}</span>
        </button>
      ))}
    </>
  );
}

