import { useCallback, useEffect, useMemo, useState } from "react";
import type { Carryover } from "@shared/session";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { StatusPie } from "../../shell/StatusPie";
import { formatTokens } from "../../utils/format-tokens.ts";
import type { SessionEntry } from "../chat/session-states.ts";
import { formatRunClock, formatToolDuration } from "../chat/tool-results.ts";
import { useTaskHistory, useTaskRecords, type TaskRecordsView } from "../chat/useTaskRecords.ts";
import { sessionRunState, type SessionRunState } from "../notify/completion-notice.ts";
import {
  latestPlan,
  liveTail,
  REVEAL_ENTRY_EVENT,
  settledEnd,
  stepClockFrom,
  taskHeadState,
  toolIndexOf,
  turnDigests,
  type TurnDigest,
} from "./task-progress.ts";


/**
 * 「这条任务 › 进度」（2026-10-30）：它在做什么、做过什么、还剩什么。
 *
 * - 头一行：状态饼 + 状态（在跑 / 等你 / 做完了 / 出错了；计划没做完就停了是「停下了」，只说字不画饼）
 *   + 轮数 + 这一轮的用时（在跑时每秒走）；推导在 task-progress.ts 的 taskHeadState；
 * - 计划：update_plan 的最后一张清单（空圈 / 在做 / 勾）；「在做」那步只在会话在跑 / 等你时画在跑饼、
 *   带计时（从这张计划写下起；计划是前几轮写的就从这一轮起），停下之后画空圈、字仍加粗标出停在哪一步；
 * - 做过的：按轮列，旧轮收成一行（用户那句话 + 步数 · 文件 · 用时），最近一轮展开成章节——
 *   与对话里过程块展开后的章节同一份推导；点一章，对话滚到那一块（对话里还没加载到的轮不可点）。
 *   会话槽只装尾窗，更早的轮按需载入：上下文页签「整个任务」已经拉过就直接用，没拉过在列表顶上
 *   给一行「载入」——长会话的全量能有上百 MB，进度是这个面板的默认页签，不该一打开就全搬进来；
 * - 留到以后：这条会话收割的遗留（open），勾掉即完成；
 * - 页底一行上下文用量，点进「上下文」页签。
 */
export function TaskProgress(props: {
  sessionId: string;
  entry: SessionEntry;
  /** 会话运行态（App 的 runStateOf，与侧栏状态饼同一个推导，含子会话）；null = 列表里还没有这条会话的 meta */
  runState: SessionRunState;
  carryovers: readonly Carryover[];
  onSetCarryoverStatus: (id: string, status: Carryover["status"]) => void;
  onOpenContext: () => void;
}) {
  const t = useT();
  const { entry } = props;
  const turnActive = entry.phase === "turn";
  // 更早的轮：谁先要过（上下文页签「整个任务」或这里的「载入」）就一直合进来；同一份缓存
  const history = useTaskHistory(props.sessionId);
  const [wantOlder, setWantOlder] = useState(false);
  const view = useTaskRecords(props.sessionId, entry, wantOlder || history.status !== "idle");
  const { turns, plan, statusOf, inChat } = useProgressDigest(view, turnActive);
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
      <div className="tp-now">
        <span className="tp-slot">{headState !== null && headState !== "stopped" && <StatusPie state={headState} />}</span>
        <b>{t.taskPanel.state(headState ?? "idle")}</b>
        {turns.length > 0 && <span className="tp-sub">· {t.taskPanel.turns(turns.length)}</span>}
        {clock !== null && <span className="tp-clock">{clock}</span>}
      </div>

      {plan !== null ? (
        <section className="tp-sec">
          <div className="tp-gh">
            {t.taskPanel.plan}
            <span className="tp-n">{t.taskPanel.planCount(plan.done, plan.items.length)}</span>
          </div>
          <ol className="tp-plan">
            {plan.items.map((item, index) => (
              <li key={index} data-status={item.status}>
                <span className="tp-slot">
                  {item.status === "done" ? (
                    <Icon name="check" size={12} strokeWidth={2} />
                  ) : item.status === "in_progress" && working ? (
                    <StatusPie state="running" />
                  ) : (
                    <span className="tp-ring" />
                  )}
                </span>
                <span className="tp-text">{item.text}</span>
                {item.status === "in_progress" && working && turnActive && (
                  <span className="tp-clock">{formatRunClock(now - stepClockFrom(plan, turns))}</span>
                )}
              </li>
            ))}
          </ol>
        </section>
      ) : (
        turnActive && <p className="tp-hint">{t.taskPanel.noPlan}</p>
      )}

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

      {props.carryovers.length > 0 && (
        <section className="tp-sec">
          <div className="tp-gh">
            {t.taskPanel.later}
            <span className="tp-n">{props.carryovers.length}</span>
          </div>
          {props.carryovers.map((item) => (
            <label key={item.id} className="tp-later" title={item.detail}>
              <input
                type="checkbox"
                checked={item.status === "done"}
                aria-label={item.status === "done" ? t.taskPanel.reopen : t.taskPanel.markDone}
                onChange={(event) => props.onSetCarryoverStatus(item.id, event.target.checked ? "done" : "open")}
              />
              <span className="tp-text">{item.title}</span>
            </label>
          ))}
        </section>
      )}

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
  const settledPlan = useMemo(() => latestPlan(settled), [settled]);
  const tail = useMemo(() => liveTail(view.older, end, view.current, olderIds), [view.older, end, view.current, olderIds]);
  const tailResults = useMemo(() => toolIndexOf(tail), [tail]);
  const tailTurns = useMemo(() => turnDigests(tail, turnActive, tailResults), [tail, turnActive, tailResults]);
  const turns = useMemo(() => [...settledTurns, ...tailTurns], [settledTurns, tailTurns]);
  const plan = useMemo(() => latestPlan(tail) ?? settledPlan, [tail, settledPlan]);
  const statusOf = useCallback(
    (toolCallId: string) => (tailResults.get(toolCallId) ?? settledResults.get(toolCallId))?.status,
    [tailResults, settledResults],
  );
  // 对话里加载着的轮（用户那句话在尾窗里）：只有它们的章节点了能滚过去
  const inChat = useMemo(() => new Set(view.current.map((record) => record.id)), [view.current]);
  return { turns, plan, statusOf, inChat };
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
  const reveal = (key: string | undefined) => {
    if (key !== undefined) window.dispatchEvent(new CustomEvent(REVEAL_ENTRY_EVENT, { detail: key }));
  };
  return (
    <div className="tp-turn" data-open={shown || undefined}>
      <button type="button" className="tp-turn-head" aria-expanded={shown} onClick={() => setOpen(!shown)}>
        <span className="tp-time">{clockOf(turn.at)}</span>
        <span className="tp-ask">{turn.ask}</span>
      </button>
      {turn.steps > 0 && <div className="tp-meta">{meta.join(" · ")}</div>}
      {shown && turn.chapters.length > 0 && (
        <ol className="tp-chapters">
          {turn.chapters.map((chapter, index) => {
            const failed = chapter.calls.some((call) => props.statusOf(call.toolCallId) === "error");
            const isLive = turn.live && index === turn.chapters.length - 1;
            const work = chapter.calls.filter((call) => call.toolName !== "update_plan").length;
            const label =
              chapter.title ?? chapter.calls.map((call) => t.chat.rollupTool(call.toolName)).filter((v, i, a) => a.indexOf(v) === i).join(" · ");
            return (
              <li key={chapter.key} data-live={isLive || undefined} data-failed={failed || undefined}>
                {props.inChat ? (
                  <button type="button" title={t.taskPanel.jump} onClick={() => reveal(turn.processKeys[0])}>
                    {/* 章节名最多两行（真模型的旁白常有三四行、一段英文思考能到七行），全文在悬停里 */}
                    <span className={chapter.source === "say" ? "tp-ch" : "tp-ch think"} title={label}>
                      {label}
                    </span>
                    {work > 0 && <span className="tp-meta">{t.chat.processSteps(work)}</span>}
                  </button>
                ) : (
                  <div className="tp-ch-row" title={t.taskPanel.notInChat}>
                    <span className={chapter.source === "say" ? "tp-ch" : "tp-ch think"}>{label}</span>
                    {work > 0 && <span className="tp-meta">{t.chat.processSteps(work)}</span>}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function clockOf(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
