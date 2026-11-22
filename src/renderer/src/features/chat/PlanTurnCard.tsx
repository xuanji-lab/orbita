import { useState } from "react";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { requestOpenProgress } from "../../shell/open-panel.ts";
import type { PlanItemStatus } from "../../../../shared/plan.ts";
import type { PlanStep, PlanVersion } from "../context/plan-timeline.ts";
import { Stats } from "./FileTurnCard";
import { planDiffLines, planDiffRows, planDiffStats, type PlanDiffLine, type PlanTurnState } from "./plan-turn.ts";

/**
 * 这一轮的计划卡（2026-11-22 用户）。放在过程行**下面**：过程收着时只剩它；过程展开时它在步骤之后，像一张确认稿。
 * 默认展开、跟着执行实时打勾（「要是我能显示的看到这个在做的这个计划，根据你的执行再实时推进就好了」），
 * 不写「在做：…」那一行、不编号——每步前面是状态记号，同右栏进度。
 * - 定了计划 / 定了新计划：整张清单；
 * - 改了计划：上一版 → 这一版的左右对照（左红右绿，没动的步整行只列一次）；
 * - 推进了计划（只打勾）：整张清单，头上写从几步到几步。
 * 骨架同结尾那几张（白底、淡边、同圆角、同宽）。右边「进度」打开右栏「这条任务 › 进度」。
 */
export function PlanTurnCard(props: { state: PlanTurnState; cardKey: string }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const { state } = props;
  const items = state.version.items;
  const done = items.filter((item) => item.status === "done").length;
  const lines = state.kind === "changed" ? planDiffLines(state.base.items, items) : null;
  const stats = lines === null ? null : planDiffStats(lines);
  const title =
    state.kind === "changed"
      ? t.chat.planTurnChanged
      : state.kind === "progress"
        ? t.chat.planTurnProgressed
        : state.replaced === true
          ? t.chat.planTurnReplaced(items.length)
          : t.chat.planTurnNew(items.length);
  const progress =
    state.kind === "progress"
      ? t.chat.planTurnProgressFrom(state.base.items.filter((item) => item.status === "done").length, done, items.length)
      : t.chat.planTurnProgress(done, items.length);
  const why = state.kind === "changed" ? state.notice.why : null;
  return (
    <section className="plan-turn-card" aria-label={title} data-key={props.cardKey}>
      <div className="plan-turn-head">
        <button type="button" className="plan-turn-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <Icon name={FEATURE_ICON.task} size={14} strokeWidth={1.8} />
          <span className="plan-turn-title">{title}</span>
          {stats !== null && <Stats added={stats.added} removed={stats.removed} />}
          <span className="plan-turn-progress">{progress}</span>
          <span className="plan-turn-chevron" data-open={open || undefined}>
            <Icon name="chevron-right" size={13} strokeWidth={1.8} />
          </span>
        </button>
        <button type="button" className="plan-turn-open" onClick={requestOpenProgress}>
          {t.chat.planTurnOpen}
          <Icon name="panel-right" size={13} strokeWidth={1.8} />
        </button>
      </div>
      {open && why !== null && why !== "" && <div className="plan-turn-second">{why}</div>}
      {open && (lines === null ? <PlanStepList items={items} /> : <PlanSideBySide lines={lines} />)}
    </section>
  );
}

/** 整张清单：每步前面是状态记号（做完的退到三级色，不划线——划线读起来像被删掉了） */
export function PlanStepList(props: { items: readonly PlanStep[]; compact?: boolean }) {
  return (
    <ol className={props.compact === true ? "plan-turn-lines compact" : "plan-turn-lines"}>
      {props.items.map((item) => (
        <PlanLine key={item.id} status={item.status} text={item.text} waitingFor={item.waitingFor} />
      ))}
    </ol>
  );
}

/** 左右对照：没动的步整行；改动的地方左边原来（红）、右边现在（绿） */
export function PlanSideBySide(props: { lines: readonly PlanDiffLine[]; compact?: boolean }) {
  const t = useT();
  const rows = planDiffRows(props.lines);
  return (
    <div className={props.compact === true ? "plan-sbs compact" : "plan-sbs"}>
      <div className="plan-sbs-head" aria-hidden="true">
        <span>{t.chat.planDiffBefore}</span>
        <span>{t.chat.planDiffAfter}</span>
      </div>
      {rows.map((row, index) =>
        row.kind === "same" ? (
          <div key={index} className="plan-sbs-same">
            <PlanLine status={row.line.status} text={row.line.text} waitingFor={row.line.waitingFor} />
          </div>
        ) : (
          <div key={index} className="plan-sbs-change">
            <div className="plan-sbs-cell" data-kind={row.left === null ? "empty" : "del"}>
              {row.left !== null && <PlanLine status={row.left.status} text={row.left.text} waitingFor={row.left.waitingFor} sign="−" />}
            </div>
            <div className="plan-sbs-cell" data-kind={row.right === null ? "empty" : "add"}>
              {row.right !== null && <PlanLine status={row.right.status} text={row.right.text} waitingFor={row.right.waitingFor} sign="+" />}
            </div>
          </div>
        ),
      )}
    </div>
  );
}

function PlanLine(props: { status: PlanItemStatus; text: string; waitingFor?: string; sign?: string }) {
  const t = useT();
  return (
    <div className="plan-line" data-status={props.status}>
      {props.sign !== undefined && (
        <span className="plan-turn-sign" aria-hidden="true">
          {props.sign}
        </span>
      )}
      <span className="plan-turn-mark">
        <StatusMark status={props.status} />
      </span>
      <span className="plan-turn-text">
        {props.text}
        {props.status === "waiting" && <span className="plan-turn-wait">{props.waitingFor ?? t.planText.waitingDefault}</span>}
      </span>
    </div>
  );
}

/** 一步的状态记号：同右栏进度（勾 / 在做 / 沙漏 / 空圈）。「在做」用静止的实心点 */
function StatusMark(props: { status: PlanItemStatus }) {
  if (props.status === "done") return <Icon name="check" size={12} strokeWidth={2} />;
  if (props.status === "waiting") return <Icon name="hourglass" size={12} strokeWidth={1.8} />;
  if (props.status === "in_progress") return <span className="plan-turn-dot" />;
  return <span className="plan-turn-ring" />;
}

/** 过程里「改计划」那一步展开 / 原位显示用：第一次定 = 清单；改了结构 = 左右对照 */
export function PlanCallBlock(props: { version: PlanVersion; base?: PlanVersion }) {
  return props.base === undefined ? (
    <PlanStepList items={props.version.items} compact />
  ) : (
    <PlanSideBySide lines={planDiffLines(props.base.items, props.version.items)} compact />
  );
}
