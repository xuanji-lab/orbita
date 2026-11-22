import { useState } from "react";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { requestOpenProgress } from "../../shell/open-panel.ts";
import type { PlanItemStatus } from "../../../../shared/plan.ts";
import { Stats } from "./FileTurnCard";
import { planDiffLines, planDiffStats, type PlanTurnState } from "./plan-turn.ts";

/**
 * 这一轮开头的计划卡（2026-11-22 用户：「计划改动做成卡片，然后它就是属于放在开头的那种卡片」）。
 *
 * 一轮的卡分两头：开头说「这一轮打算怎么干」（计划定了 / 改了），结尾说「这一轮交出了什么」（改了的文件、做出来的东西）。
 * 骨架同结尾那几张（白底、淡边、同圆角、同宽）。默认收着（用户 11-16：平时只关心打了几个勾、做到哪）：
 * - 定了计划：「定了计划 · 5 步  1/5」，第二行写在做的那一步；点开是整张清单，每步带状态（同右栏进度的记号）。
 * - 改了计划：「改了计划  +2 −1  3/6」（同文件卡的增删统计），第二行写为什么；点开是上一版 → 这一版的红绿 diff。
 * 右边「进度」打开右栏「这条任务 › 进度」。
 */
export function PlanTurnCard(props: { state: PlanTurnState; cardKey: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { state } = props;
  const items = state.version.items;
  const done = items.filter((item) => item.status === "done").length;
  const now = items.find((item) => item.status === "in_progress")?.text ?? null;
  const lines =
    state.kind === "changed"
      ? planDiffLines(state.base.items, items)
      : items.map((item) => ({ kind: "same" as const, text: item.text, status: item.status, ...(item.waitingFor === undefined ? {} : { waitingFor: item.waitingFor }) }));
  const stats = state.kind === "changed" ? planDiffStats(lines) : null;
  const title =
    state.kind === "changed" ? t.chat.planTurnChanged : state.replaced === true ? t.chat.planTurnReplaced(items.length) : t.chat.planTurnNew(items.length);
  const second = state.kind === "fresh" ? (now === null ? null : t.chat.planTurnNow(now)) : state.notice.why;
  return (
    <section className="plan-turn-card" aria-label={title} data-key={props.cardKey}>
      <div className="plan-turn-head">
        <button type="button" className="plan-turn-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <span className="plan-turn-chevron" data-open={open || undefined}>
            <Icon name="chevron-right" size={13} strokeWidth={1.8} />
          </span>
          <Icon name={FEATURE_ICON.task} size={14} strokeWidth={1.8} />
          <span className="plan-turn-title">{title}</span>
          {stats !== null && <Stats added={stats.added} removed={stats.removed} />}
          <span className="plan-turn-progress">{t.chat.planTurnProgress(done, items.length)}</span>
        </button>
        <button type="button" className="plan-turn-open" onClick={requestOpenProgress}>
          {t.chat.planTurnOpen}
          <Icon name="panel-right" size={13} strokeWidth={1.8} />
        </button>
      </div>
      {second !== null && second !== "" && <div className="plan-turn-second">{second}</div>}
      {open && (
        <ol className="plan-turn-lines" data-diff={state.kind === "changed" || undefined}>
          {lines.map((line, index) => (
            <li key={index} data-kind={line.kind} data-status={line.status}>
              {state.kind === "changed" && (
                <span className="plan-turn-sign" aria-hidden="true">
                  {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
                </span>
              )}
              <span className="plan-turn-mark">
                <StatusMark status={line.status} />
              </span>
              <span className="plan-turn-text">
                {line.text}
                {line.status === "waiting" && <span className="plan-turn-wait">{line.waitingFor ?? t.planText.waitingDefault}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** 一步的状态记号：同右栏进度（勾 / 在做 / 沙漏 / 空圈）。这是一张过去的卡，「在做」用静止的实心点，不转 */
function StatusMark(props: { status: PlanItemStatus }) {
  if (props.status === "done") return <Icon name="check" size={12} strokeWidth={2} />;
  if (props.status === "waiting") return <Icon name="hourglass" size={12} strokeWidth={1.8} />;
  if (props.status === "in_progress") return <span className="plan-turn-dot" />;
  return <span className="plan-turn-ring" />;
}
