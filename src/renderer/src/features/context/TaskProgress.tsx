import { useEffect, useMemo, useState } from "react";
import { selectTranscript } from "@earendil-works/pi-coding-agent/client";
import type { Carryover } from "@shared/session";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { StatusPie } from "../../shell/StatusPie";
import { formatTokens } from "../../utils/format-tokens.ts";
import type { SessionEntry } from "../chat/session-states.ts";
import { formatRunClock, formatToolDuration, indexToolResults, type ToolResultIndex } from "../chat/tool-results.ts";
import { sessionRunState } from "../notify/completion-notice.ts";
import { latestPlan, REVEAL_ENTRY_EVENT, turnDigests, type TurnDigest } from "./task-progress.ts";


/**
 * 「这条任务 › 进度」（2026-10-30）：它在做什么、做过什么、还剩什么。
 *
 * - 头一行：状态饼 + 状态（在跑 / 等你 / 做完了 / 出错了）+ 轮数 + 这一轮的用时（在跑时每秒走）；
 * - 计划：update_plan 的最后一张清单（空圈 / 在做 / 勾）；「在做」那步带计时（从这张计划写下起）；
 * - 做过的：按轮列，旧轮收成一行（用户那句话 + 步数 · 文件 · 用时），最近一轮展开成章节——
 *   与对话里过程块展开后的章节同一份推导；点一章，对话滚到那一块；
 * - 留到以后：这条会话收割的遗留（open），勾掉即完成；
 * - 页底一行上下文用量，点进「上下文」页签。
 */
export function TaskProgress(props: {
  entry: SessionEntry;
  carryovers: readonly Carryover[];
  onSetCarryoverStatus: (id: string, status: Carryover["status"]) => void;
  onOpenContext: () => void;
}) {
  const t = useT();
  const { entry } = props;
  const records = useMemo(() => selectTranscript(entry.transcript), [entry.transcript]);
  const results = useMemo(() => indexToolResults(records), [records]);
  const turnActive = entry.phase === "turn";
  const turns = useMemo(() => turnDigests(records, turnActive, results), [records, turnActive, results]);
  const plan = useMemo(() => latestPlan(records), [records]);
  const state = sessionRunState({ slot: { phase: entry.phase, approvals: entry.approvals.length }, children: [], unread: null });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!turnActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [turnActive]);
  const last = turns.at(-1);
  // 头一行的状态：在跑 / 等你取槽；落定后按最后一轮有没有失败说「做完了 / 出错了」
  const headState = state ?? (last === undefined ? null : last.failed > 0 && last.steps === last.failed ? "failed" : "done");
  const clock = turnActive && last !== undefined ? formatRunClock(now - last.at) : last?.durationMs != null ? formatToolDuration(last.durationMs, t) : null;
  const usage = entry.stats?.contextUsage ?? null;

  return (
    <div className="tp-body">
      <div className="tp-now">
        <span className="tp-slot">{headState !== null && <StatusPie state={headState} />}</span>
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
                  ) : item.status === "in_progress" ? (
                    <StatusPie state="running" />
                  ) : (
                    <span className="tp-ring" />
                  )}
                </span>
                <span className="tp-text">{item.text}</span>
                {item.status === "in_progress" && turnActive && <span className="tp-clock">{formatRunClock(now - plan.at)}</span>}
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
        {turns.length === 0 ? (
          <p className="tp-hint">{t.taskPanel.nothingYet}</p>
        ) : (
          turns.map((turn, index) => (
            <TurnItem key={turn.key} turn={turn} results={results} openByDefault={index === turns.length - 1} />
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

/** 一轮：用户那句话 + 一行计数；展开是章节，点一章让对话滚到那一块 */
function TurnItem(props: { turn: TurnDigest; results: ToolResultIndex; openByDefault: boolean }) {
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
            const failed = chapter.calls.some((call) => props.results.get(call.toolCallId)?.status === "error");
            const isLive = turn.live && index === turn.chapters.length - 1;
            const work = chapter.calls.filter((call) => call.toolName !== "update_plan").length;
            return (
              <li key={chapter.key} data-live={isLive || undefined} data-failed={failed || undefined}>
                <button type="button" title={t.taskPanel.jump} onClick={() => reveal(turn.processKeys[0])}>
                  <span className={chapter.source === "say" ? "tp-ch" : "tp-ch think"}>
                    {chapter.title ?? chapter.calls.map((call) => t.chat.rollupTool(call.toolName)).filter((v, i, a) => a.indexOf(v) === i).join(" · ")}
                  </span>
                  {work > 0 && <span className="tp-meta">{t.chat.processSteps(work)}</span>}
                </button>
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
