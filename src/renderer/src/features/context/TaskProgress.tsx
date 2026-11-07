import { useCallback, useEffect, useMemo, useState } from "react";
import type { Carryover } from "@shared/session";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { InlineMarks } from "../../shell/InlineMarks";
import { inlinePlain } from "../../shell/inline-marks.ts";
import { RowHoverAction } from "../../shell/RowHoverAction";
import { StatusPie } from "../../shell/StatusPie";
import { formatTokens } from "../../utils/format-tokens.ts";
import type { SessionEntry } from "../chat/session-states.ts";
import { formatRunClock, formatToolDuration } from "../chat/tool-results.ts";
import { useTaskHistory, useTaskRecords, type TaskRecordsView } from "../chat/useTaskRecords.ts";
import { sessionRunState, type SessionRunState } from "../notify/completion-notice.ts";
import { isBookkeepingTool } from "../../../../shared/goal.ts";
import { headSnippet, snippetPair, type GoalLedger, type LedgerEntry } from "../../../../shared/goal-ledger.ts";
import { PLAN_TOOL_NAME } from "../../../../shared/plan.ts";
import type { TranscriptRecord } from "@shared/session";
import type { ProcessChapter } from "../chat/turn-process.ts";
import {
  liveTail,
  REVEAL_ENTRY_EVENT,
  settledEnd,
  stepClockFrom,
  stepDisplay,
  taskHeadState,
  toolIndexOf,
  turnDigests,
  type TurnDigest,
} from "./task-progress.ts";
import {
  BEFORE_PLAN,
  groupBySteps,
  OUTSIDE_PLAN,
  planAwaitingIn,
  planTimeline,
  planView,
  stepActiveSince,
  type PlanStep,
  type PlanTimeline,
  type StepActivity,
  type StepChapter,
} from "./plan-timeline.ts";
import { planChangeText } from "./plan-text.ts";
import { buildGoalSeed } from "./goal-seed.ts";
import { useGoalLedger } from "./useGoalLedger.ts";


/**
 * 「这条任务 › 进度」（2026-10-30）：它在做什么、做过什么、还剩什么。
 *
 * - 头一行：状态饼 + 状态（在跑 / 等你 / 做完了 / 出错了；计划没做完就停了是「停下了」，只说字不画饼）
 *   + 轮数 + 这一轮的用时（在跑时每秒走）；推导在 task-progress.ts 的 taskHeadState；
 * - 计划是主干（2026-10-30）：每一步（空圈 / 在做 / 勾）尾部写它「用了几步」，在做的那步带计时（从它这一次
 *   变成在做起）；每一步下面挂它那几章（按时间归属，plan-timeline.ts），在做那步默认展开；改过的计划在步下写
 *   「新加 / 改过 / 拆出」与理由，头上「改过 N 次」点开是改动记录；「在做」只在会话在跑 / 等你时画在跑饼，
 *   停下之后画空圈、字仍加粗标出停在哪一步；
 * - 做过的：有计划时收成页底一行（点开才是按轮列表）；没有计划时按轮列，旧轮收成一行（用户那句话 + 步数 · 文件 · 用时），最近一轮展开成章节——
 *   与对话里过程块展开后的章节同一份推导；点一章，对话滚到那一块（对话里还没加载到的轮不可点）。
 *   会话槽只装尾窗，更早的轮按需载入：上下文页签「整个任务」已经拉过就直接用，没拉过在列表顶上
 *   给一行「载入」——长会话的全量能有上百 MB，进度是这个面板的默认页签，不该一打开就全搬进来；
 * - 以后再做（2026-10-30：future work 与遗留事项合并）：这条任务里当场记下的（agent 在 update_plan 的
 *   later 里写的）与收尾时确认的；悬停出三个动作——转成任务（App 的 startCarryoverTask）、现在就做
 *   （发进本会话）、丢掉（收进「丢掉的」，可找回）；点一项，对话滚到记下它的那一章；
 * - 页底一行上下文用量，点进「上下文」页签。
 */
export function TaskProgress(props: {
  sessionId: string;
  entry: SessionEntry;
  /** 会话运行态（App 的 runStateOf，与侧栏状态饼同一个推导，含子会话）；null = 列表里还没有这条会话的 meta */
  runState: SessionRunState;
  /** 这条任务的「以后再做」（全部状态：open 列出，dismissed 收在「丢掉的」里） */
  carryovers: readonly Carryover[];
  onSetCarryoverStatus: (id: string, status: Carryover["status"]) => void;
  onStartCarryoverTask: (item: Carryover) => void;
  /** 现在就做：把这一项作为下一条消息发进本会话（在跑就排队，同 continueCarryoverInSource） */
  onDoCarryoverNow: (item: Carryover) => void;
  /** 带着目标开新会话：种子由这里按来源标题现拼（goal-seed.ts），App 负责开会话 */
  onStartGoalTask: (sourceSessionId: string, makeSeed: (sourceTitle: string | null) => string | null) => void;
  onOpenContext: () => void;
}) {
  const t = useT();
  const { entry } = props;
  const turnActive = entry.phase === "turn";
  // 更早的轮：谁先要过（上下文页签「整个任务」或这里的「载入」）就一直合进来；同一份缓存
  const history = useTaskHistory(props.sessionId);
  const [wantOlder, setWantOlder] = useState(false);
  const view = useTaskRecords(props.sessionId, entry, wantOlder || history.status !== "idle");
  const { turns, plan, timeline, statusOf, inChat } = useProgressDigest(view, turnActive);
  // 目标与计划的改动账（shared/goal-ledger.ts）：从转录推，目标行与「改过 N 次」的记录都读它
  const ledger = useGoalLedger(view.records);
  const [logOpen, setLogOpen] = useState(false);
  const activity = useMemo(() => groupBySteps(timeline, turns, statusOf), [timeline, turns, statusOf]);
  // update_plan / update_goal 调用 → 它所在的过程块（改动记录与以后再做点一下让对话滚过去）
  const callOf = useMemo(() => {
    const map = new Map<string, string | undefined>();
    for (const turn of turns) {
      for (const chapter of turn.chapters) {
        for (const call of chapter.calls) if (isBookkeepingTool(call.toolName)) map.set(call.toolCallId, turn.processKeys[0]);
      }
    }
    return map;
  }, [turns]);
  const [historyOpen, setHistoryOpen] = useState(false);
  // App 给的是侧栏同一个推导；meta 还没进列表（刚建的会话）时退回只看自己的槽
  const run =
    props.runState ?? sessionRunState({ slot: { phase: entry.phase, approvals: entry.approvals.length }, children: [], unread: null });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!turnActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [turnActive]);
  const last = turns.at(-1);
  const headState = taskHeadState({ run, turnError: entry.turnError !== null, turns: turns.length, plan });
  // 「在做」那步画在跑饼的前提：会话真的在跑 / 等你。停下之后还画蓝饼，说的是一件没在发生的事
  const working = headState === "running" || headState === "waiting";
  const clock = turnActive && last !== undefined ? formatRunClock(now - last.at) : last?.durationMs != null ? formatToolDuration(last.durationMs, t) : null;
  const usage = entry.stats?.contextUsage ?? null;

  return (
    <div className="tp-body">
      {ledger.goal !== null && (
        <GoalSection
          ledger={ledger}
          logOpen={logOpen}
          onToggleLog={() => setLogOpen((value) => !value)}
          callOf={callOf}
          inChat={inChat}
          onCarry={() =>
            props.onStartGoalTask(props.sessionId, (sourceTitle) =>
              buildGoalSeed(t, {
                sourceTitle,
                ledger,
                later: props.carryovers.filter((item) => item.status === "open").map((item) => ({ title: item.title, detail: item.detail })),
              }),
            )
          }
        />
      )}
      <div className="tp-now">
        <span className="tp-slot">{headState !== null && headState !== "stopped" && <StatusPie state={headState} />}</span>
        <b>{t.taskPanel.state(headState ?? "idle")}</b>
        {turns.length > 0 && <span className="tp-sub">· {t.taskPanel.turns(turns.length)}</span>}
        {clock !== null && <span className="tp-clock">{clock}</span>}
      </div>

      {timeline !== null && plan !== null ? (
        <PlanSection
          timeline={timeline}
          turns={turns}
          activity={activity}
          working={working}
          awaiting={timeline.current.awaiting && planAwaitingIn(view.current)}
          turnActive={turnActive}
          now={now}
          inChat={inChat}
          statusOf={statusOf}
          callOf={callOf}
          ledger={ledger}
          logOpen={logOpen}
          onToggleLog={() => setLogOpen((value) => !value)}
        />
      ) : (
        turnActive && <p className="tp-hint">{t.taskPanel.noPlan}</p>
      )}

      {plan !== null && turns.length > 0 && (
        <button
          type="button"
          className="tp-histline"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((value) => !value)}
        >
          <span className="tp-histline-label">{t.taskPanel.history}</span>
          <span className="tp-n">
            {t.planText.history(turns.length, turns.reduce((sum, turn) => sum + turn.steps, 0), turns.reduce((sum, turn) => sum + turn.files, 0))}
          </span>
          <Icon name={historyOpen ? "chevron-down" : "chevron-right"} size={12} strokeWidth={1.8} />
        </button>
      )}

      {(plan === null || historyOpen) && (
        <section className="tp-sec">
          <div className="tp-gh">
            {t.taskPanel.history}
            {turns.length > 0 && <span className="tp-n">{t.taskPanel.turns(turns.length)}</span>}
          </div>
          {view.hasOlder && view.older.length === 0 && !view.loading && view.error === null && (
            <p className="tp-hint">
              {t.taskPanel.olderNotLoaded}
              <button type="button" className="notice-exit" onClick={() => setWantOlder(true)}>
                {t.taskPanel.loadOlder}
              </button>
            </p>
          )}
          {view.loading && <p className="tp-hint">{t.contextPanel.loading(view.fetched)}</p>}
          {view.capped && <p className="tp-hint">{t.contextPanel.capped}</p>}
          {view.error !== null && (
            <p className="tp-hint" role="alert" data-tone="danger">
              {t.contextPanel.loadError(view.error)}
            </p>
          )}
          {turns.length === 0 ? (
            <p className="tp-hint">{t.taskPanel.nothingYet}</p>
          ) : (
            turns.map((turn, index) => (
              <TurnItem
                key={turn.key}
                turn={turn}
                statusOf={statusOf}
                inChat={inChat.has(turn.key)}
                openByDefault={index === turns.length - 1}
              />
            ))
          )}
        </section>
      )}

      <LaterSection
        items={props.carryovers}
        revealOf={(toolCallId) => callOf.get(toolCallId)}
        onSetStatus={props.onSetCarryoverStatus}
        onToTask={props.onStartCarryoverTask}
        onDoNow={props.onDoCarryoverNow}
      />

      {usage !== null && usage.contextWindow > 0 && (
        <button type="button" className="tp-ctx" onClick={props.onOpenContext}>
          <span className="tp-ctx-line">
            <span>{t.taskPanel.contextLine}</span>
            <span className="tp-n">
              {usage.tokens === null ? "—" : `${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)}`}
              {usage.percent !== null && ` · ${Math.round(usage.percent)}%`}
            </span>
          </span>
          <span className="tp-ctx-bar">
            <i style={{ width: `${Math.min(100, Math.max(0, usage.percent ?? 0))}%` }} />
          </span>
        </button>
      )}
    </div>
  );
}

/**
 * 「做过的」要的推导：更早拉来的那段在最后一条用户消息前切开，前面的轮（落定段）只在拉到新的
 * 一页时算一次，每条流式事件只重算尾巴（更早那段的最后一轮 + 尾窗）——全量每次重算在长会话上
 * 一次要几毫秒（task-progress.ts 的 settledEnd）。没拉更早的时候落定段为空，等于只算尾窗。
 */
function useProgressDigest(view: TaskRecordsView, turnActive: boolean) {
  const end = useMemo(() => settledEnd(view.older), [view.older]);
  const settled = useMemo(() => view.older.slice(0, end), [view.older, end]);
  const olderIds = useMemo(() => new Set(view.older.map((record) => record.id)), [view.older]);
  const settledResults = useMemo(() => toolIndexOf(settled), [settled]);
  const settledTurns = useMemo(() => turnDigests(settled, false, settledResults), [settled, settledResults]);
  const settledPlanRecords = useMemo(() => settled.filter(isPlanRecord), [settled]);
  const tail = useMemo(() => liveTail(view.older, end, view.current, olderIds), [view.older, end, view.current, olderIds]);
  const tailResults = useMemo(() => toolIndexOf(tail), [tail]);
  const tailTurns = useMemo(() => turnDigests(tail, turnActive, tailResults), [tail, turnActive, tailResults]);
  const turns = useMemo(() => [...settledTurns, ...tailTurns], [settledTurns, tailTurns]);
  // 计划的版本线要对整段转录算（步骤 id 沿版本传下去），但只看 update_plan 那几条：落定段的挑一次，尾巴每条事件挑
  const timeline = useMemo(
    () => planTimeline([...settledPlanRecords, ...tail.filter(isPlanRecord)]),
    [settledPlanRecords, tail],
  );
  const plan = useMemo(() => planView(timeline), [timeline]);
  const statusOf = useCallback(
    (toolCallId: string) => (tailResults.get(toolCallId) ?? settledResults.get(toolCallId))?.status,
    [tailResults, settledResults],
  );
  // 对话里加载着的轮（用户那句话在尾窗里）：只有它们的章节点了能滚过去
  const inChat = useMemo(() => new Set(view.current.map((record) => record.id)), [view.current]);
  return { turns, plan, timeline, statusOf, inChat };
}

function isPlanRecord(record: TranscriptRecord): boolean {
  return record.role === "tool" && record.toolName === PLAN_TOOL_NAME;
}

/** 一轮：用户那句话 + 一行计数；展开是章节，点一章让对话滚到那一块 */
function TurnItem(props: {
  turn: TurnDigest;
  statusOf: (toolCallId: string) => string | undefined;
  /** 这一轮在对话里加载着：章节可以点过去；没加载的（更早、对话里没往上翻到）只列不点 */
  inChat: boolean;
  openByDefault: boolean;
}) {
  const t = useT();
  const { turn } = props;
  const [open, setOpen] = useState<boolean | null>(null);
  const shown = open ?? (props.openByDefault || turn.live);
  const meta = [
    t.chat.processSteps(turn.steps),
    ...(turn.files > 0 ? [t.chat.processWrote(turn.files)] : []),
    ...(turn.failed > 0 ? [t.chat.processFailed(turn.failed)] : []),
    ...(turn.durationMs !== null ? [formatToolDuration(turn.durationMs, t)] : []),
  ];
  return (
    <div className="tp-turn" data-open={shown || undefined}>
      <button type="button" className="tp-turn-head" aria-expanded={shown} onClick={() => setOpen(!shown)}>
        <span className="tp-time">{clockOf(turn.at)}</span>
        <span className="tp-ask">{turn.ask}</span>
      </button>
      {turn.steps > 0 && <div className="tp-meta">{meta.join(" · ")}</div>}
      {shown && turn.chapters.length > 0 && (
        <ChapterList
          rows={turn.chapters.map((chapter, index) => ({
            chapter,
            processKey: turn.processKeys[0],
            inChat: props.inChat,
            live: turn.live && index === turn.chapters.length - 1,
          }))}
          statusOf={props.statusOf}
        />
      )}
    </div>
  );
}

function clockOf(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function reveal(key: string | undefined): void {
  if (key !== undefined) window.dispatchEvent(new CustomEvent(REVEAL_ENTRY_EVENT, { detail: key }));
}

interface ChapterRow {
  chapter: ProcessChapter;
  /** 点一章让对话滚到哪一块 */
  processKey: string | undefined;
  /** 这一章所在的轮在对话里加载着：能点过去；没加载的只列不点 */
  inChat: boolean;
  live: boolean;
}

/** 章节时间线（「做过的」里一轮的章节与计划里一步的章节共用） */
function ChapterList(props: { rows: readonly ChapterRow[]; statusOf: (toolCallId: string) => string | undefined }) {
  const t = useT();
  return (
    <ol className="tp-chapters">
      {props.rows.map(({ chapter, processKey, inChat, live }) => {
        const failed = chapter.calls.some((call) => props.statusOf(call.toolCallId) === "error");
        const work = chapter.calls.filter((call) => !isBookkeepingTool(call.toolName)).length;
        const label =
          chapter.title ?? chapter.calls.map((call) => t.chat.rollupTool(call.toolName)).filter((v, i, a) => a.indexOf(v) === i).join(" · ");
        const text = (
          <>
            {/* 章节名最多两行（真模型的旁白常有三四行、一段英文思考能到七行），全文在悬停里 */}
            <span className={chapter.source === "say" ? "tp-ch" : "tp-ch think"} title={inlinePlain(label)}>
              <InlineMarks text={label} />
            </span>
            {work > 0 && <span className="tp-meta">{t.chat.processSteps(work)}</span>}
          </>
        );
        return (
          <li key={chapter.key} data-live={live || undefined} data-failed={failed || undefined}>
            {inChat ? (
              <button type="button" title={t.taskPanel.jump} onClick={() => reveal(processKey)}>
                {text}
              </button>
            ) : (
              <div className="tp-ch-row" title={t.taskPanel.notInChat}>
                {text}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * 计划（面板的主干）：每一步一行——状态槽、文字、尾部（在做的写计时，其余写用了几步）；
 * 改过的步下面写出处与理由；在做的那步默认展开它的章节，点任何一步展开 / 收起；
 * 本轮去掉的步在原位置画划线灰行；写计划之前的探索与计划外的活各收成一个灰行。
 */
function PlanSection(props: {
  timeline: PlanTimeline;
  turns: readonly TurnDigest[];
  activity: ReadonlyMap<string, StepActivity>;
  working: boolean;
  /** 计划停下等你确认（最后一次 update_plan 要求确认、之后还没有用户消息）：计划里不出现在做的步 */
  awaiting: boolean;
  turnActive: boolean;
  now: number;
  inChat: ReadonlySet<string>;
  statusOf: (toolCallId: string) => string | undefined;
  callOf: ReadonlyMap<string, string | undefined>;
  /** 目标与计划的改动账；有目标时「改过 N 次」挂在目标行（同一本账），没有目标才挂在计划头上 */
  ledger: GoalLedger;
  logOpen: boolean;
  onToggleLog: () => void;
}) {
  const t = useT();
  const { timeline, activity } = props;
  const { current } = timeline;
  const done = current.items.filter((item) => item.status === "done").length;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const turnStart = props.turns.at(-1)?.at ?? 0;
  // 去掉的步只在它被去掉的那一轮里露面，之后只留在改动记录里
  const recentRemoved = current.at >= turnStart ? current.removed : [];
  const rowsFor = (act: StepActivity | undefined): ChapterRow[] =>
    (act?.chapters ?? []).map((entry: StepChapter) => ({
      chapter: entry.chapter,
      processKey: entry.processKey,
      inChat: props.inChat.has(entry.turnKey),
      live: entry.live,
    }));
  const stepRow = (item: PlanStep) => {
    const act = activity.get(item.id);
    const { status, active } = stepDisplay(item.status, { working: props.working, awaiting: props.awaiting });
    const rows = rowsFor(act);
    const shown = open[item.id] ?? active;
    const since = status === "in_progress" ? stepActiveSince(timeline, item.id) : null;
    const note = item.note;
    return (
      <li key={item.id} data-status={status}>
        <span className="tp-slot">
          {status === "done" ? (
            <Icon name="check" size={12} strokeWidth={2} />
          ) : active ? (
            <StatusPie state="running" />
          ) : (
            <span className="tp-ring" />
          )}
        </span>
        <div className="tp-step">
          {rows.length > 0 ? (
            <button
              type="button"
              className="tp-step-head"
              aria-expanded={shown}
              title={t.planText.stepTitle(rows.length, act?.files.length ?? 0)}
              onClick={() => setOpen((prev) => ({ ...prev, [item.id]: !shown }))}
            >
              <span className="tp-text">{item.text}</span>
              <StepTail act={act} clock={active && props.turnActive && since !== null ? formatRunClock(props.now - stepClockFrom(since, props.turns)) : null} />
            </button>
          ) : (
            <div className="tp-step-head">
              <span className="tp-text">{item.text}</span>
              <StepTail act={act} clock={active && props.turnActive && since !== null ? formatRunClock(props.now - stepClockFrom(since, props.turns)) : null} />
            </div>
          )}
          {note !== null && (
            <div className="tp-note">
              <b>{note.kind === "added" ? t.planText.noteAdded : note.kind === "reworded" ? t.planText.noteReworded : t.planText.noteSplit}</b>
              {note.kind === "reworded" && note.from !== null && <span>{t.planText.was(note.from)}</span>}
              {note.kind === "split" && note.from !== null && <span>{t.planText.splitFrom(note.from)}</span>}
              {note.why !== null && <span>{note.why}</span>}
            </div>
          )}
          {shown && rows.length > 0 && <ChapterList rows={rows} statusOf={props.statusOf} />}
        </div>
      </li>
    );
  };
  const removedRow = (entry: { id: string; text: string }, key: string) => (
    <li key={key} data-status="removed">
      <span className="tp-slot">
        <Icon name="x" size={12} strokeWidth={2} />
      </span>
      <div className="tp-step">
        <div className="tp-step-head">
          <span className="tp-text">{entry.text}</span>
          <span className="tp-tail">{t.planText.dropped}</span>
        </div>
        {current.why !== null && <div className="tp-note"><span>{current.why}</span></div>}
      </div>
    </li>
  );
  const pseudo = (bucket: string, label: string) => {
    const act = activity.get(bucket);
    const rows = rowsFor(act);
    if (act === undefined || (act.calls === 0 && rows.length === 0)) return null;
    const shown = open[bucket] ?? false;
    return (
      <li key={bucket} data-status="pseudo">
        <span className="tp-slot" />
        <div className="tp-step">
          <button type="button" className="tp-step-head" aria-expanded={shown} onClick={() => setOpen((prev) => ({ ...prev, [bucket]: !shown }))}>
            <span className="tp-text">{label}</span>
            <StepTail act={act} clock={null} />
          </button>
          {shown && rows.length > 0 && <ChapterList rows={rows} statusOf={props.statusOf} />}
        </div>
      </li>
    );
  };
  return (
    <section className="tp-sec">
      <div className="tp-gh">
        {t.taskPanel.plan}
        <span className="tp-n">{t.taskPanel.planCount(done, current.items.length)}</span>
        {props.ledger.goal === null && props.ledger.entries.length > 0 && (
          <EditsButton entries={props.ledger.entries} open={props.logOpen} onClick={props.onToggleLog} />
        )}
      </div>
      {props.ledger.goal === null && props.logOpen && (
        <EditLog entries={props.ledger.entries} callOf={props.callOf} inChat={props.inChat} />
      )}
      <ol className="tp-plan">
        {pseudo(BEFORE_PLAN, t.planText.beforePlan)}
        {recentRemoved.filter((entry) => entry.afterNext === -1).map((entry, i) => removedRow(entry, `rm-first-${i}`))}
        {current.items.flatMap((item, index) => [
          stepRow(item),
          ...recentRemoved.filter((entry) => entry.afterNext === index).map((entry, i) => removedRow(entry, `rm-${index}-${i}`)),
        ])}
        {pseudo(OUTSIDE_PLAN, t.planText.outsidePlan)}
      </ol>
    </section>
  );
}

/** 改动记录里一条目标文字最长多少字符（再长只留不同处附近的一小段，全文在悬停里） */
const EDIT_TEXT_MAX = 80;

/**
 * 「改过 N 次」：点开是改动记录（目标和计划同一本账）。N 只数真的改过的：第一次定下目标不是「改过」，
 * 只有这一条时按钮写「记录」（点开仍能看到目标是从你哪句话来的）。
 */
function EditsButton(props: { entries: readonly LedgerEntry[]; open: boolean; onClick: () => void }) {
  const t = useT();
  const changes = props.entries.filter((entry) => !(entry.kind === "goal" && entry.from === null)).length;
  return (
    <button type="button" className="tp-edits" aria-expanded={props.open} title={t.goalText.editsTitle} onClick={props.onClick}>
      {changes > 0 ? t.planText.editsCount(changes) : t.goalText.logOnly}
    </button>
  );
}

/**
 * 进度面板最上面一块：会话级目标（2026-10-30）。目标由智能体从你的话里提炼、替你写（update_goal），
 * 面板上只读——要改直接在聊天里说，智能体改完会在回复里告诉你；没有输入框、没有确认按钮。
 * 计划（todo）挂在目标下面。「改过 N 次」点开是目标与计划共用的改动记录。
 */
function GoalSection(props: {
  ledger: GoalLedger;
  logOpen: boolean;
  onToggleLog: () => void;
  callOf: ReadonlyMap<string, string | undefined>;
  inChat: ReadonlySet<string>;
  /** 带着目标开新会话 */
  onCarry: () => void;
}) {
  const t = useT();
  const goal = props.ledger.goal;
  if (goal === null) return null;
  return (
    <section className="tp-goal" aria-label={t.goalText.title}>
      <div className="tp-gh">
        {t.goalText.title}
        {props.ledger.entries.length > 0 && (
          <EditsButton entries={props.ledger.entries} open={props.logOpen} onClick={props.onToggleLog} />
        )}
      </div>
      <p className="tp-goal-text">{goal.text}</p>
      {/* 这是一个去处，不是确认：目标没做完、一个会话装不下时，带着它换个会话接着做 */}
      <button type="button" className="tp-goal-carry" title={t.goalText.carryTitle} onClick={props.onCarry}>
        <Icon name="corner-up-right" size={12} strokeWidth={1.8} />
        {t.goalText.carry}
      </button>
      {props.logOpen && <EditLog entries={props.ledger.entries} callOf={props.callOf} inChat={props.inChat} />}
    </section>
  );
}

/**
 * 改动记录：目标和计划的每一次改动，新 → 旧。每条写「从什么变成什么、为什么、是谁提的」——
 * 来源是触发改动的那条用户消息（时间 + 头一行，点一下对话滚到那句话），或者智能体自己发现的。
 * 点改动本身，对话滚到记下它的那一块。
 */
function EditLog(props: {
  entries: readonly LedgerEntry[];
  callOf: ReadonlyMap<string, string | undefined>;
  inChat: ReadonlySet<string>;
}) {
  const t = useT();
  return (
    <ol className="tp-editlog">
      {[...props.entries].reverse().map((entry) => {
        const kind =
          entry.kind === "plan" ? t.goalText.kindPlan : entry.from === null ? t.goalText.kindGoalSet : t.goalText.kindGoalChanged;
        // 目标很长时，「从什么变成什么」两边各缩成不同处附近的一小段（全文在悬停里；当前目标在最上面全文给出）
        const [goalFrom, goalTo] =
          entry.kind === "goal"
            ? entry.from === null
              ? [null, headSnippet(entry.to, EDIT_TEXT_MAX)]
              : snippetPair(entry.from, entry.to, EDIT_TEXT_MAX)
            : [null, null];
        const what =
          entry.kind === "goal"
            ? (goalTo ?? entry.to)
            : entry.replaced !== null
              ? t.goalText.planReplaced(entry.replaced.length)
              : entry.changes.map((change) => planChangeText(t, change)).join("；");
        const source = entry.source;
        const sourceText = source.kind === "user" ? t.goalText.sourceUser(clockOf(source.at), source.head) : t.goalText.sourceSelf;
        return (
          <li key={entry.id}>
            <button type="button" className="tp-editlog-main" title={t.taskPanel.jump} onClick={() => reveal(props.callOf.get(entry.id))}>
              <span className="tp-time">
                {clockOf(entry.at)} · {kind}
              </span>
              <span className="tp-editlog-what" title={entry.kind === "goal" ? entry.to : undefined}>
                {what}
              </span>
              {entry.kind === "goal" && goalFrom !== null && entry.from !== null && (
                <span className="tp-meta" title={entry.from}>
                  {t.planText.was(goalFrom)}
                </span>
              )}
              {entry.why !== null && <span className="tp-meta">{entry.why}</span>}
            </button>
            {source.kind === "user" && props.inChat.has(source.id) ? (
              <button type="button" className="tp-editlog-src" title={t.taskPanel.jump} onClick={() => reveal(source.id)}>
                {sourceText}
              </button>
            ) : (
              <div className="tp-editlog-src" title={source.kind === "user" ? t.taskPanel.notInChat : undefined}>
                {sourceText}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** 一步尾部：在做的写计时，其余写「用了几步」（0 步不写） */
function StepTail(props: { act: StepActivity | undefined; clock: string | null }) {
  const t = useT();
  if (props.clock !== null) return <span className="tp-clock">{props.clock}</span>;
  if (props.act === undefined || props.act.calls === 0) return null;
  return (
    <span className="tp-tail">
      {t.planText.stepCalls(props.act.calls)}
      {/* 失败的写成字（颜色只是第二信号） */}
      {props.act.failed > 0 && <span className="tp-tail-bad"> · {t.chat.processFailed(props.act.failed)}</span>}
    </span>
  );
}

/**
 * 以后再做：这条任务里记下的、这次不做的事。open 的列在上面，悬停出三个动作；丢掉的收成一行
 * 「丢掉的 N」，点开能找回。没有任何一项时整段不出现（不占版面）。
 */
function LaterSection(props: {
  items: readonly Carryover[];
  /** 记下它的那次 update_plan（anchor）所在的过程块；找不到 = 不可点 */
  revealOf: (toolCallId: string) => string | undefined;
  onSetStatus: (id: string, status: Carryover["status"]) => void;
  onToTask: (item: Carryover) => void;
  onDoNow: (item: Carryover) => void;
}) {
  const t = useT();
  const [dismissedOpen, setDismissedOpen] = useState(false);
  const open = props.items.filter((item) => item.status === "open");
  const dismissed = props.items.filter((item) => item.status === "dismissed");
  if (open.length === 0 && dismissed.length === 0) return null;
  const origin = (item: Carryover): string =>
    item.origin === "noticed" ? t.taskPanel.laterNoticed(clockOf(item.createdAt)) : t.taskPanel.laterWrapup(clockOf(item.createdAt));
  return (
    <section className="tp-sec">
      <div className="tp-gh">
        {t.taskPanel.later}
        <span className="tp-n">{open.length}</span>
      </div>
      {open.map((item) => {
        const processKey = item.anchor === null ? undefined : props.revealOf(item.anchor);
        const title = (
          <>
            <span className="tp-text" title={item.detail === "" ? undefined : item.detail}>
              {item.title}
            </span>
            <span className="tp-meta">{origin(item)}</span>
          </>
        );
        return (
          <div key={item.id} className="tp-later">
            <span className="tp-slot">
              <Icon name="bookmark" size={12} strokeWidth={1.8} />
            </span>
            {processKey === undefined ? (
              <div className="tp-later-body">{title}</div>
            ) : (
              <button type="button" className="tp-later-body" title={t.taskPanel.jump} onClick={() => reveal(processKey)}>
                {title}
              </button>
            )}
            {/* 行尾悬停动作（RowHoverAction 配方）：平时不占位，悬停 / 键盘聚焦到这一行才浮出 */}
            <span className="tp-later-acts reveal">
              <RowHoverAction icon="corner-up-right" title={t.taskPanel.toTask} onClick={() => props.onToTask(item)} className="row-hover-act" />
              <RowHoverAction icon="play" title={t.taskPanel.doNow} onClick={() => props.onDoNow(item)} className="row-hover-act" />
              <RowHoverAction icon="x" title={t.taskPanel.dismiss} onClick={() => props.onSetStatus(item.id, "dismissed")} className="row-hover-act" />
            </span>
          </div>
        );
      })}
      {dismissed.length > 0 && (
        <>
          <button type="button" className="tp-dismissed" aria-expanded={dismissedOpen} onClick={() => setDismissedOpen((value) => !value)}>
            {t.taskPanel.dismissedCount(dismissed.length)}
            <Icon name={dismissedOpen ? "chevron-down" : "chevron-right"} size={12} strokeWidth={1.8} />
          </button>
          {dismissedOpen &&
            dismissed.map((item) => (
              <div key={item.id} className="tp-later" data-dismissed>
                <span className="tp-slot">
                  <Icon name="bookmark" size={12} strokeWidth={1.8} />
                </span>
                <div className="tp-later-body">
                  <span className="tp-text">{item.title}</span>
                </div>
                <span className="tp-later-acts reveal">
                  <RowHoverAction icon="undo-2" title={t.taskPanel.restore} onClick={() => props.onSetStatus(item.id, "open")} className="row-hover-act" />
                </span>
              </div>
            ))}
        </>
      )}
    </section>
  );
}
