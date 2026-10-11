import { Icon, type IconName } from "./Icon";

/**
 * 行 / 卡尾部的悬停动作键。形态收编自文件面板树行的那颗 paperclip（2026-10
 * 用户点名「复用一下文件系统里面的这个添加附件的那个 button」）：无边框方形
 * icon 按钮，平时不出现也不占位，悬停 / 键盘聚焦到宿主行才浮现。
 *
 * 三个消费者共用同一形态（AGENTS.md 消费者纪律，凑齐才抽）：
 * - 文件树行 / 附件行：Reveal 与「添加文件引用」（paperclip）；
 * - Skills 行：「选用此技能」——把 /skill:<slug> 插进输入框；
 * - MCP 卡动作组：「选用此 MCP」——把 /mcp:<server> 插进输入框。
 * 图标与文案由调用方给：skill / MCP 处是「选用、落进输入框」
 * （corner-down-left），不是「附件」（paperclip）——图形与动作成对，语义
 * 不同图形就分家（2026-09-26 教训：只换图形不换动作，按钮就说谎了）。
 *
 * 显隐与配色不内建：调用方用 className 挂宿主已成立的机制（文件面板
 * `.file-hover-act .file-row-act`、skill 行 `.reveal` + `.skill-row-act`）；
 * 不给 className 时落公共的 `.row-hover-act`（MCP 卡动作组——组本身随卡
 * reveal，按钮只要配色）。
 *
 * 排布两种：给 `right` 就绝对定位钉在宿主右缘（宿主行 position:relative），
 * 盖在行尾之上——行尾血线规则的悬停组合例外：静止态尾部元素钉血线，悬停时
 * 由宿主 CSS 让位（.set-dots / .attachment-row-tail 的先例）；不给 `right`
 * 就留在宿主的 flex 流里（MCP 卡的 .mcp-actions 组）。键盘可达：真按钮 +
 * title / aria-label，Tab 进宿主行即随组浮现。
 */
export function RowHoverAction(props: {
  /** lucide 图标名 */
  icon: IconName;
  /** tooltip 与 aria-label */
  title: string;
  onClick: () => void;
  /** 绝对定位：钉在宿主右缘的偏移（px）。缺省 = 静态，随宿主行流排布 */
  right?: number;
  /** 绝对定位的顶缘偏移（px），默认 5（30px 行内居中） */
  top?: number;
  /** 按钮边长（px），默认 20（与 PanelIconButton 同排时给 26） */
  size?: number;
  /** 图标边长（px），默认 12 */
  iconSize?: number;
  /** 宿主配对 class（显隐与配色挂它）；缺省用公共 .row-hover-act */
  className?: string;
}) {
  const size = props.size ?? 20;
  return (
    <button
      type="button"
      className={props.className ?? "row-hover-act"}
      title={props.title}
      aria-label={props.title}
      onClick={props.onClick}
      style={{
        // display 不内建：文件面板的显隐由 .file-hover-act 的 display:none/
        // inline-flex 管，inline style 会压过它（2026-09-23 同款坑）
        ...(props.right === undefined
          ? {}
          : { position: "absolute", right: props.right, top: props.top ?? 5 }),
        width: size,
        height: size,
        flex: "0 0 auto",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        border: 0,
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
      }}
    >
      <Icon name={props.icon} size={props.iconSize ?? 12} />
    </button>
  );
}
