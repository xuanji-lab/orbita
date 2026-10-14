import { Icon, type IconName } from "../../shell/Icon";

/**
 * 「离开卡」：聊天流里指向**聊天区之外**的那一类卡——点了会把用户带走（2026-09-27 wafo 裁决：
 * 这类卡统一一个样式）。目前两种：
 *   - 派出卡（delegate）：点了去子会话；
 *   - 交接卡（request_user_action）：点了去受管浏览器完成一步。
 * 骨架同一套：第一行 kicker + 标题 + 右侧状态，第二行预览，第三行等宽的元信息；可选一行动作。
 *
 * 整张卡可点（`onClick`）时渲染成 button；带动作按钮（`actions`）时根是 div——按钮里不能再套
 * 按钮。`lit` 加 accent 描边：它指向的地方此刻正开着。
 */

export const EXIT_CARD_STYLE = {
  display: "grid",
  gap: "var(--space-1)",
  padding: "var(--space-2) var(--space-3)",
  borderRadius: "var(--radius-lg)",
  border: "1px solid var(--color-border-subtle)",
  background: "var(--color-bg-panel)",
  minWidth: 0,
} satisfies React.CSSProperties;

export const EXIT_CARD_KICKER = {
  flex: "0 0 auto",
  fontFamily: "var(--font-family-base)",
  fontSize: "var(--font-size-sm)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--color-text-tertiary)",
} satisfies React.CSSProperties;

/** `.card.lit`（设计稿）：accent 描边 + 3px `--color-bg-active` 外环 */
const LIT_STYLE = {
  borderColor: "var(--color-accent)",
  boxShadow: "0 0 0 3px var(--color-bg-active)",
} satisfies React.CSSProperties;

export function ExitCard(props: {
  kicker: string;
  /** kicker 前的小图标（交接卡用 user：「这一步要你来」） */
  icon?: IconName;
  title: string;
  /** 右侧状态：文字说话，颜色是第二信号；active 时呼吸 */
  status?: { text: string; color: string; active: boolean };
  preview?: string;
  meta?: React.ReactNode;
  /** 整张卡就是「离开」动作 */
  onClick?: () => void;
  clickTitle?: string;
  /** 一行动作按钮（交接卡：去浏览器 / 完成 / 取消） */
  actions?: React.ReactNode;
  lit?: boolean;
}) {
  const style: React.CSSProperties = {
    ...EXIT_CARD_STYLE,
    ...(props.lit === true ? LIT_STYLE : {}),
    ...(props.onClick !== undefined ? { width: "100%", textAlign: "left", cursor: "pointer", font: "inherit" } : {}),
  };
  const content = (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
        <span style={{ ...EXIT_CARD_KICKER, display: "inline-flex", alignItems: "center", gap: 4 }}>
          {props.icon !== undefined && <Icon name={props.icon} size={11} />}
          {props.kicker}
        </span>
        <span
          style={{
            fontWeight: "var(--weight-strong)",
            fontSize: "var(--font-size-base)",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {props.title}
        </span>
        {props.status !== undefined && (
          <span
            className={props.status.active ? "orbita-breath" : undefined}
            style={{
              marginLeft: "auto",
              flex: "0 0 auto",
              fontFamily: "var(--font-family-mono)",
              fontSize: "var(--font-size-xs)",
              color: props.status.color,
            }}
          >
            {props.status.text}
          </span>
        )}
      </div>
      {props.preview !== undefined && props.preview !== "" && (
        <p
          style={{
            margin: 0,
            fontSize: "var(--font-size-sm)",
            color: "var(--color-text-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {props.preview}
        </p>
      )}
      {props.meta !== undefined && (
        <span
          style={{
            fontFamily: "var(--font-family-mono)",
            fontSize: "var(--font-size-xs)",
            color: "var(--color-text-tertiary)",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {props.meta}
        </span>
      )}
      {props.actions !== undefined && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginTop: "var(--space-1)" }}>
          {props.actions}
        </div>
      )}
    </>
  );
  if (props.onClick === undefined || props.actions !== undefined) return <div style={style}>{content}</div>;
  return (
    <button type="button" onClick={props.onClick} title={props.clickTitle} style={style}>
      {content}
    </button>
  );
}
