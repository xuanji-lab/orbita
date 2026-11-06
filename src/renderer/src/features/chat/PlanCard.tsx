import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import type { PlanVersion } from "../context/plan-timeline.ts";

/**
 * 计划卡：这一轮先停下、等你在聊天框里回答时，画在过程行下面——**只读，没有任何按钮**
 * （2026-10-30 用户：「我不希望这方面老是找用户确认，打扰用户……要确认可以在聊天框里面确认，你不要在交互页面上
 * 让用户点什么确认或者修改啥的」）。问题由 agent 在正文里用自然语言问，用户在输入框里答，
 * 下一轮 agent 按回答去改计划；plan 档里想让它开工，用户自己用现有的权限选择切出 plan 档。
 *
 * 只在「最后一次 update_plan 要求停、之后用户还没回应」时出现（planAwaitingIn）。
 */
export function PlanCard(props: { version: PlanVersion }) {
  const t = useT();
  const { version } = props;
  return (
    <section className="plan-card" aria-label={t.chat.planCardTitle}>
      <div className="plan-card-head">
        <Icon name={FEATURE_ICON.task} size={12} strokeWidth={1.8} />
        <span className="plan-card-kicker">{t.chat.planCardTitle}</span>
        <span className="plan-card-count">{t.chat.planCardSteps(version.items.length)}</span>
      </div>
      <ol className="plan-card-steps">
        {version.items.map((item) => (
          <li key={item.id} data-status={item.status}>
            {item.text}
          </li>
        ))}
      </ol>
    </section>
  );
}
