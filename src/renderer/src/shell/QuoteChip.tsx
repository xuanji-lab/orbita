import type { TextQuote } from "@shared/quote";
import { Icon } from "./Icon";
import { quoteMeta, quoteSummary } from "./quote-label.ts";
import { useT } from "../locale.ts";

/**
 * 一条文字引用的 chip。两种形态（Proma 调过的口径）：
 *
 * - **展开**（输入框里、或已发送消息点了「展开引用全文」）：上面一行 meta
 *   （来源 · 字数），下面是全文——保留换行，超长在 chip 内滚动。输入框里默认展开：
 *   发出去之前用户得能确认引的是不是完整的那一段。
 * - **收起**（已发送消息默认）：一行「来源 · 字数 · 前 20 字…」。
 *
 * 可跳（`onJump`）时 meta 行 / 收起的整行是按钮：跳回原文并高亮。原文不在这条会话里
 * （迁移来的引用、被压缩掉的历史）就不给 onJump，不画成可点的样子。
 * 颜色全用中性 token：引用是上下文，不是主操作，不染 accent。
 */
export function QuoteChip(props: {
  quote: TextQuote;
  expanded: boolean;
  onJump?: () => void;
  onRemove?: () => void;
}) {
  const t = useT();
  const { quote, onJump, onRemove } = props;
  const head = props.expanded ? quoteMeta(quote, t) : quoteSummary(quote, t);
  const headStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-1)",
    minWidth: 0,
    padding: 0,
    border: 0,
    background: "none",
    font: "inherit",
    color: "var(--color-text-secondary)",
    fontSize: "var(--font-size-caption)",
    textAlign: "left",
    cursor: onJump === undefined ? "default" : "pointer",
  };
  const headInner = (
    <>
      <Icon name="quote" size={12} strokeWidth={1.8} style={{ flex: "0 0 auto", color: "var(--color-text-tertiary)" }} />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{head}</span>
    </>
  );
  return (
    <div
      style={{
        position: "relative",
        display: "grid",
        gap: 2,
        minWidth: 0,
        maxWidth: "100%",
        padding: onRemove === undefined ? "5px 10px" : "5px 28px 5px 10px",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--color-border-subtle)",
        background: "var(--color-bg-muted)",
      }}
    >
      {onJump === undefined ? (
        <div style={headStyle}>{headInner}</div>
      ) : (
        <button type="button" title={t.quote.jump} aria-label={`${t.quote.jump}: ${head}`} onClick={onJump} style={headStyle}>
          {headInner}
        </button>
      )}
      {props.expanded && (
        <div
          style={{
            maxHeight: 160,
            overflowY: "auto",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            fontSize: "var(--font-size-control)",
            lineHeight: 1.55,
            color: "var(--color-text-primary)",
          }}
        >
          {quote.text}
        </div>
      )}
      {onRemove !== undefined && (
        <button
          type="button"
          aria-label={t.quote.remove}
          title={t.quote.remove}
          onClick={onRemove}
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            height: 18,
            padding: 0,
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-pill)",
            background: "var(--color-bg-panel)",
            color: "var(--color-text-secondary)",
            cursor: "pointer",
          }}
        >
          <Icon name="x" size={11} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
