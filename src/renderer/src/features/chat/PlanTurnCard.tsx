import { useState } from "react";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { requestOpenProgress } from "../../shell/open-panel.ts";
import { planChangeText } from "../context/plan-text.ts";
import type { PlanTurnState } from "./plan-turn.ts";

/**
 * 这一轮开头的计划卡（2026-11-22 用户：「计划改动做成卡片，然后它就是属于放在开头的那种卡片，而不是放在结尾的卡片」）。
 *
 * 一轮的卡分两头：开头说「这一轮打算怎么干」（计划定了 / 改了），结尾说「这一轮交出了什么」（改了的文件、做出来的东西）。
 * 只打勾不出卡——勾在过程里是一行「改计划 · 3/7」，全貌在右栏「进度」。卡的骨架同结尾那几张（同宽、同底、同边）。
 *
 * - 定了计划：「定了计划 · 5 步」，第二行写在做的那一步；点开是整张清单。
 * - 改了计划：「计划改了 2 处」，第二行写为什么；点开是每一处改了什么。
 * 用户平时只关心打了几个勾、做到哪（2026-11-16），所以默认收着，头上写进度。
 */
export function PlanTurnCard(props: { state: PlanTurnState; cardKey: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { state } = props;
  const items = state.version.items;
  const done = items.filter((item) => item.status === "done").length;
  const now = items.find((item) => item.status === "in_progress")?.text ?? null;
  const title = state.kind === "fresh" ? t.chat.planTurnNew(items.length) : t.chat.planTurnChanged(state.notice.changes.length);
  const second = state.kind === "fresh" ? (now === null ? null : t.chat.planTurnNow(now)) : (state.notice.why ?? planChangeText(t, state.notice.changes[0] ?? { kind: "added", text: "" }));
  return (
    <section className="plan-turn-card" aria-label={title} data-key={props.cardKey}>
      <div className="plan-turn-head">
        <button type="button" className="plan-turn-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <span className="plan-turn-chevron" data-open={open || undefined}>
            <Icon name="chevron-right" size={13} strokeWidth={1.8} />
          </span>
          <Icon name={FEATURE_ICON.task} size={14} strokeWidth={1.8} />
          <span className="plan-turn-title">{title}</span>
          <span className="plan-turn-progress">{t.chat.planTurnProgress(done, items.length)}</span>
        </button>
        <button type="button" className="plan-turn-open" onClick={requestOpenProgress}>
          {t.chat.planTurnOpen}
          <Icon name="panel-right" size={13} strokeWidth={1.8} />
        </button>
      </div>
      {second !== null && second !== "" && <div className="plan-turn-second">{second}</div>}
      {open &&
        (state.kind === "fresh" ? (
          <ol className="plan-turn-steps">
            {items.map((item) => (
              <li key={item.id} data-status={item.status}>
                {item.text}
              </li>
            ))}
          </ol>
        ) : (
          <ul className="plan-turn-changes">
            {state.notice.changes.map((change, index) => (
              <li key={index}>{planChangeText(t, change)}</li>
            ))}
          </ul>
        ))}
    </section>
  );
}
