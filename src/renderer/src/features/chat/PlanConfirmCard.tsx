import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import type { PermissionMode } from "../../../../shared/permission.ts";
import type { PlanVersion } from "../context/plan-timeline.ts";

/**
 * 计划卡：这一轮停在「等你确认」上时画在过程行下面（2026-10-30，计划是 agent 与用户对齐的工具）。
 *
 * 停下来的原因有三（plan-tools.ts 的 decidePlanStop）：plan 档写完计划、agent 带了具体问题（confirm）、
 * 用户开了「先给我看计划」。卡上写：计划的每一步；有问题时列出 1–3 个要你回答的；一个主操作
 * 「按这个做」——在 plan 档里它要顺带离开 plan 档（plan 档只读，只确认不换档 agent 什么也做不了），
 * 按钮上写明会切到哪一档。想改就直接在输入框里说，不另给「改一下」按钮。
 * 只在「最后一次 update_plan 要求确认、之后用户还没回应」时出现（planAwaitingIn）。
 */
export function PlanConfirmCard(props: {
  version: PlanVersion;
  /** 点「按这个做」会切到哪一档；null = 不换档 */
  approveMode: PermissionMode | null;
  onApprove: () => void;
}) {
  const t = useT();
  const { version } = props;
  const asking = version.confirm.length > 0;
  return (
    <section className="plan-card" aria-label={t.chat.planCardTitle}>
      <div className="plan-card-head">
        <Icon name="list-todo" size={12} strokeWidth={1.8} />
        <span className="plan-card-kicker">{asking ? t.chat.planCardAsking : t.chat.planCardTitle}</span>
        <span className="plan-card-count">{t.chat.planCardSteps(version.items.length)}</span>
      </div>
      <ol className="plan-card-steps">
        {version.items.map((item) => (
          <li key={item.id} data-status={item.status}>
            {item.text}
          </li>
        ))}
      </ol>
      {asking && (
        <div className="plan-card-asks">
          <span className="plan-card-asks-title">{t.chat.planCardQuestions}</span>
          <ol>
            {version.confirm.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ol>
        </div>
      )}
      <div className="plan-card-foot">
        <span className="plan-card-hint">{asking ? t.chat.planCardHintAsking : t.chat.planCardHint}</span>
        <button type="button" className="wrapup-btn wrapup-primary row-trailing" onClick={props.onApprove}>
          {props.approveMode === null
            ? t.chat.planCardApprove
            : t.chat.planCardApproveSwitch(t.permissionModes[props.approveMode].label)}
        </button>
      </div>
    </section>
  );
}
