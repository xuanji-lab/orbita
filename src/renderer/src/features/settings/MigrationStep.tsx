import { Icon, type IconName } from "../../shell/Icon";
import { useSettingTip } from "./InfoTip";
import type { StepState } from "./migration-page.ts";

/**
 * Migration 页四段与底栏共用的件：编号步骤、带悬停说明的徽标与事实、列头。
 * MigrationView / MigrationSkills / MigrationMcp 三处都用，所以单放一个文件。
 *
 * 说明的机制与 General / Providers 同一套（useSettingTip）：常驻的只有图标、数字和短语，
 * 整句在悬停里，读屏走 aria-describedby。
 */

/** 左侧编号圆点：未轮到是描边数字，当前步实心，做完了换成绿色的勾。 */
export function StepDot(props: { n: number; state: StepState }) {
  return (
    <span
      className="mg-dot"
      data-state={props.state}
      role="img"
      aria-label={props.state === "done" ? `Step ${props.n}, done` : `Step ${props.n}`}
    >
      {props.state === "done" ? <Icon name="check" size={13} strokeWidth={2.2} /> : props.n}
    </span>
  );
}

/**
 * 一步：圆点 + 标题行（标题、`summary` 紧跟标题、`tools` 靠右）+ 正文。步与步之间的
 * 竖线是 CSS 画的（`.mg-step::before`），最后一步不画——底栏的 Import 是单独的一行。
 */
export function Step(props: {
  n: number;
  title: string;
  state: StepState;
  summary?: React.ReactNode;
  tools?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="mg-step" data-state={props.state} aria-label={props.title}>
      <StepDot n={props.n} state={props.state} />
      <div className="mg-step-head">
        <span className="mg-step-title">{props.title}</span>
        {props.summary}
        <span className="mg-spacer" />
        {props.tools}
      </div>
      {props.children !== undefined && <div className="mg-step-body">{props.children}</div>}
    </section>
  );
}

/**
 * 带悬停说明的小徽标（Read-only、+16、Deleted here、Off）。与 Providers 的协议徽标同一个长相。
 * `focusable`：段头的徽标可 Tab 到；行内的不加——行里的焦点目标是复选框，一行一个 Tab 停点。
 */
export function TipBadge(props: {
  icon?: IconName;
  tip: string;
  focusable?: boolean;
  mono?: boolean;
  label?: string;
  children?: React.ReactNode;
}) {
  const tip = useSettingTip<HTMLSpanElement>(props.tip);
  return (
    <>
      <span
        className="mg-badge"
        data-mono={props.mono || undefined}
        tabIndex={props.focusable ? 0 : undefined}
        aria-label={props.label}
        {...tip.anchor}
      >
        {props.icon !== undefined && <Icon name={props.icon} size={10} strokeWidth={1.8} />}
        {props.children}
      </span>
      {tip.layer}
    </>
  );
}

/** 事实条的一项：图标 + 数字 + 短语（可带一个行内链接），整句进悬停。可 Tab 到。 */
export function Fact(props: { icon: IconName; tip: string; children: React.ReactNode }) {
  const tip = useSettingTip<HTMLSpanElement>(props.tip);
  return (
    <>
      <span className="mg-fact" tabIndex={0} {...tip.anchor}>
        <Icon name={props.icon} size={12} strokeWidth={1.8} />
        {props.children}
      </span>
      {tip.layer}
    </>
  );
}

/** 底栏副行的一项：比事实条再轻一档（不描边），同样整句进悬停。 */
export function FootFact(props: { icon: IconName; tip: string; tone?: "danger"; children: React.ReactNode }) {
  const tip = useSettingTip<HTMLSpanElement>(props.tip);
  return (
    <>
      <span className="mg-foot-fact" data-tone={props.tone} tabIndex={0} {...tip.anchor}>
        <Icon name={props.icon} size={11} strokeWidth={1.8} />
        {props.children}
      </span>
      {tip.layer}
    </>
  );
}

/** 悬停说明锚在一段普通内容上（模型格、子会话数、固定去向），不改它的长相。 */
export function Tipped(props: { className: string; tip: string; focusable?: boolean; children: React.ReactNode }) {
  const tip = useSettingTip<HTMLSpanElement>(props.tip);
  return (
    <>
      <span className={props.className} tabIndex={props.focusable ? 0 : undefined} {...tip.anchor}>
        {props.children}
      </span>
      {tip.layer}
    </>
  );
}
