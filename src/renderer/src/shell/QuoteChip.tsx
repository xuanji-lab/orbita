import type { TextQuote } from "@shared/quote";
import { Icon } from "./Icon";
import { quoteMeta, quotePreview } from "./quote-label.ts";
import { useT } from "../locale.ts";

/**
 * 一条文字引用的 chip：**一段连续的文字**——编号角标、meta（第几轮 · 谁 · 字数）、
 * 引用正文依次排在同一行里，一起折行。不另起一行放 meta、不放引号图标：
 * 编号角标已经说明「这是一条引用」，省下来的高度留给输入框与对话（wafo 2026-09-25：能省则省）。
 *
 * - **展开**（输入框里、或已发送消息点了眼睛）：正文全量、保留换行，超长 chip 内滚动——
 *   发出去之前用户得能确认引的是不是完整的那段。
 * - **收起**（已发送消息默认）：只留一行，正文取前 20 字加省略号。
 *
 * **编号角标**（`index`，1 起）就是发给模型的 `<quoted_context index="n">` 那个 n——
 * 用户按编号逐条回复；删掉一条，后面的跟着前移。
 *
 * 可跳（`onJump`）时整段文字是按钮：跳回原文并高亮。原文不在这条会话里
 * （迁移来的引用、被压缩掉的历史）就不给 onJump，不画成可点的样子。
 * 颜色全用中性 token：引用是上下文，不是主操作，不染 accent。
 */
export function QuoteChip(props: {
  index: number;
  quote: TextQuote;
  expanded: boolean;
  onJump?: () => void;
  onRemove?: () => void;
}) {
  const t = useT();
  const { quote, onJump, onRemove } = props;
  const meta = quoteMeta(quote, t);
  const body = props.expanded ? quote.text : quotePreview(quote);
  const lineStyle: React.CSSProperties = {
    display: "block",
    width: "100%",
    minWidth: 0,
    padding: 0,
    border: 0,
    background: "none",
    font: "inherit",
    textAlign: "left",
    fontSize: "var(--font-size-base)",
    lineHeight: "var(--line-height-ui)",
    color: "var(--color-text-primary)",
    cursor: onJump === undefined ? "default" : "pointer",
    ...(props.expanded
      ? { whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 120, overflowY: "auto" }
      : { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }),
  };
  const content = (
    <>
      <span
        aria-label={t.quote.number(props.index)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          minWidth: 16,
          height: 16,
          padding: "0 4px",
          marginRight: 6,
          verticalAlign: "1px",
          borderRadius: "var(--radius-pill)",
          background: "var(--color-bg-panel)",
          border: "1px solid var(--color-border-default)",
          fontFamily: "var(--font-family-mono)",
          fontSize: "var(--font-size-xs)",
          lineHeight: 1,
        }}
      >
        {props.index}
      </span>
      <span style={{ marginRight: 6, color: "var(--color-text-tertiary)", fontSize: "var(--font-size-sm)" }}>
        {meta}
      </span>
      {body}
    </>
  );
  return (
    <div
      style={{
        position: "relative",
        minWidth: 0,
        maxWidth: "100%",
        padding: onRemove === undefined ? "4px 8px" : "4px 26px 4px 8px",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--color-border-subtle)",
        background: "var(--color-bg-muted)",
      }}
    >
      {onJump === undefined ? (
        <div style={lineStyle}>{content}</div>
      ) : (
        <button type="button" title={t.quote.jump} aria-label={`${t.quote.jump}: ${meta}`} onClick={onJump} style={lineStyle}>
          {content}
        </button>
      )}
      {onRemove !== undefined && (
        <button
          type="button"
          aria-label={t.quote.remove}
          title={t.quote.remove}
          onClick={onRemove}
          style={{
            position: "absolute",
            top: 5,
            right: 5,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 16,
            height: 16,
            padding: 0,
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-pill)",
            background: "var(--color-bg-panel)",
            color: "var(--color-text-secondary)",
            cursor: "pointer",
          }}
        >
          <Icon name="x" size={10} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
