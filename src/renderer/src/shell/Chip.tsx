import { Icon, type IconName } from "./Icon";

/**
 * 安静的行内控件：输入卡底栏的作用域/权限/模型，设置面的分段选择，都是它。
 *
 * 字号 sm（12）：它是次级控件，常和卡名 / 正文（base）并排——同号就抢标题的视线
 * （2026-10-14 实验功能页：On / Off 与卡名一样大）。
 *
 * 选中态用 `--color-mode-active-*`（明主题蓝、暗主题黄），hover 是中性抬升——
 * 这两者是设计系统里 accent 仅有的两个去处之一，别处一律中性。
 */
export function Chip(props: {
  icon?: IconName;
  /**
   * 文字前面的一小块自定义内容（模型芯片的型号头像）。与 icon 同位、不进 chip-label：
   * 名字被省略号截断时头像不跟着被裁。
   */
  leading?: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  /** 尾部的下拉指示。**用 lucide 的 chevron-down**——设计系统自己那个 `▾` 是 Unicode 字符，违反它自己的硬规则 */
  chevron?: boolean;
  /**
   * 无文字芯片（用量环）的可读名。以前调用方直接传 `aria-label`，但 Chip 不转发
   * 未声明的 props，它被静默丢掉（2026-10-02 PR138 复审发现）；显式声明并转发。
   */
  ariaLabel?: string;
  /** 模型与思考档的标签是斜体次级灰——UI 里唯一的斜体（设计系统 *Type*） */
  italic?: boolean;
  /**
   * 固定宽度（px），内容居中。给文字长度随选择变化的芯片用——宽度跟着词
   * 长伸缩会显得轻浮（wafo 2026-09-22，思考档从 Off 到 Extra high 跨四个词宽）。
   * 值按常见最宽词定，给未来更长的档名留余量；超出仍可撑开（maxWidth 仍在）。
   */
  fixedWidth?: number;
  /**
   * 紧凑态：只画图标，文字收进 title。侧栏筛选行在窄宽度下用——四个带字的 chip
   * 在 288px 里本来就放不下（wafo 2026-09-22：「太窄的时候文字自动消失，只剩图标，往左 stack」）。
   */
  compact?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  /**
   * 调用方追加的 class（如 composer 底栏窄槽下用容器查询收起文字的芯片，
   * 见 styles.css 的 `.composer-bottom-bar`），与内建的安静控件配方叠加。
   */
  className?: string;
}) {
  const disabled = props.disabled === true;
  const active = props.active === true;
  return (
    <button
      type="button"
      className={`quiet-control chip${props.className === undefined ? "" : ` ${props.className}`}`}
      title={props.title}
      aria-label={props.ariaLabel}
      aria-pressed={props.onClick === undefined ? undefined : active}
      // 视觉上的「选中」与是否可点无关（不可点的 Chip 也可能是恒亮的当前态，如
      // SkillsPanel 的 List/Map 视图切换）；aria-pressed 只在可点时才挂，是 a11y
      // 语义（不可点的不该读成「按钮，已按下」），两者故意分开，样式只认 data-active
      data-active={active || undefined}
      disabled={disabled}
      onClick={props.onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: props.fixedWidth === undefined ? undefined : "center",
        minWidth: props.fixedWidth,
        gap: props.compact === true ? 0 : 5,
        maxWidth: 260,
        // 带头像的芯片（模型芯片，头像 20px）收窄上下与左边距：芯片总高仍与同排的文字芯片齐平，
        // 头像贴近左缘、不显得被框在一个更大的胶囊里
        padding: props.compact === true ? "3px 6px" : props.leading !== undefined ? "2px 8px 2px 2px" : "3px 8px",
        border: 0,
        borderRadius: "var(--radius-md)",
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-sm)",
        fontStyle: props.italic === true ? "italic" : "normal",
        letterSpacing: props.italic === true ? "var(--tracking-model)" : "normal",
        whiteSpace: "nowrap",
        cursor: disabled ? "not-allowed" : props.onClick === undefined ? "default" : "pointer",
      }}
    >
      {props.icon !== undefined && <Icon name={props.icon} size={12} />}
      {props.leading}
      {props.compact !== true && (
        // chip-label：composer 底栏窄槽下按容器查询隐藏（styles.css），文字退到上面
        // 的 title 里；这里的 minWidth:0 与省略号截断本身与宽窄无关，一直生效
        <span className="chip-label" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
          {props.children}
        </span>
      )}
      {props.chevron === true && <Icon name="chevron-down" size={11} strokeWidth={2} />}
    </button>
  );
}
