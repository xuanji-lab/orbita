import { Icon, type IconName } from "../../shell/Icon";

/**
 * 「要你点」的卡：聊天流里指向**聊天区之外**、或者要你动手的那一类（派出卡点了去子会话，交接卡要你去浏览器完成一步，
 * 自动化卡要你去面板看）。2026-11-22 用户：「统一成白卡」——骨架与结尾的产物卡、改文件卡同一个：
 * 白底淡边、左边一个图标、中间两行字（标题 · 说明）、右边状态与按钮；按钮是同一种描边小按钮。
 *
 * 整张卡可点（`onClick`）时渲染成 button；带动作按钮（`actions`）时根是 div——按钮里不能再套按钮。
 * `lit` 加 accent 描边：它指向的地方此刻正开着。
 */

/** 卡外框（还在等结果、没内容可画的占位卡也用它） */
export const EXIT_CARD_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  padding: "var(--space-2) var(--space-3)",
  borderRadius: "var(--radius-md)",
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
  /** 左边的图标（派出卡 bot、交接卡 user、自动化闹钟） */
  icon?: IconName;
  title: string;
  /** 标题后面的小标签（子会话的型号名） */
  titleSuffix?: React.ReactNode;
  /** 右侧状态：文字说话，颜色是第二信号；active 时呼吸 */
  status?: { text: string; color: string; active: boolean };
  preview?: string;
  meta?: React.ReactNode;
  /** 整张卡就是「离开」动作 */
  onClick?: () => void;
  clickTitle?: string;
  /** 右边的动作按钮（交接卡：去浏览器 / 完成 / 取消）；用 `.card-btn` */
  actions?: React.ReactNode;
  /** 卡内展开区（唤醒卡的指令全文）；有它时外框换行，仍保持同一张白卡 */
  below?: React.ReactNode;
  /** 窄容器响应式只改布局，不改 token；由调用方给容器查询一个类名 */
  className?: string;
  lit?: boolean;
}) {
  const style: React.CSSProperties = {
    ...EXIT_CARD_STYLE,
    ...(props.lit === true ? LIT_STYLE : {}),
    ...(props.below !== undefined ? { flexWrap: "wrap" } : {}),
    ...(props.onClick !== undefined ? { width: "100%", textAlign: "left", cursor: "pointer", font: "inherit" } : {}),
  };
  const sub = [props.preview ?? ""].filter((part) => part !== "");
  const content = (
    <>
      <span className="exit-card-icon">
        <Icon name={props.icon ?? "arrow-up-right"} size={18} strokeWidth={1.6} />
      </span>
      <span className="exit-card-text">
        <span className="exit-card-title">
          <span style={EXIT_CARD_KICKER}>{props.kicker}</span>
          <span className="exit-card-name">{props.title}</span>
          {props.titleSuffix}
        </span>
        {(sub.length > 0 || props.meta !== undefined) && (
          <span className="exit-card-sub">
            {sub.length > 0 && <span className="exit-card-preview">{sub.join("")}</span>}
            {props.meta !== undefined && (
              <>
                {sub.length > 0 && <span className="exit-card-separator"> · </span>}
                <span className="exit-card-meta">{props.meta}</span>
              </>
            )}
          </span>
        )}
      </span>
      {(props.status !== undefined || props.actions !== undefined) && (
        <span className="exit-card-side">
          {props.status !== undefined && (
            <span className={props.status.active ? "exit-card-status orbita-breath" : "exit-card-status"} style={{ color: props.status.color }}>
              {props.status.text}
            </span>
          )}
          {props.actions}
        </span>
      )}
    </>
  );
  if (props.onClick === undefined || props.actions !== undefined) {
    return (
      <div className={props.className} style={style}>
        {content}
        {props.below !== undefined && <div className="exit-card-below">{props.below}</div>}
      </div>
    );
  }
  return (
    <button type="button" className={props.className} onClick={props.onClick} title={props.clickTitle} style={style}>
      {content}
      {props.below !== undefined && <div className="exit-card-below">{props.below}</div>}
    </button>
  );
}
