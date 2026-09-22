import { Icon } from "../../shell/Icon";
import type { CarryoverDraft } from "./carryover-parse.ts";

/**
 * 收尾扫描回复的只读展示卡 —— 消息流内替代那条 fenced json 的 markdown 渲染。
 *
 * 扫描回答按 prompt 契约是一个 fenced json 块，直接渲染就是一大坨机器格式占屏
 * （2026-09-22 用户反馈）；人要看的只是「扫出了哪几条」。命中判定在
 * matchCarryoverMessage（严格形状，宁可不卡也不吞字），这里只负责展示：
 * 标题行报数量，条目列出 title 与摘录。**只读**——可编辑的确认面在收尾确认卡
 * （CarryoverChecklist），两者职责不混。
 *
 * 表面用消息流卡片的既有配方（chat 卡底 + 细边框），**不用玻璃**——玻璃是
 * 浮层配方（ApprovalBar 一类要求回答才继续的卡），这条卡只是流内内容。
 */
export function CarryoverScanCard(props: { drafts: readonly CarryoverDraft[] }) {
  const count = props.drafts.length;
  return (
    <section
      aria-label="Closing scan result"
      style={{
        width: "100%",
        minWidth: 0,
        display: "grid",
        gap: "var(--space-3)",
        padding: "var(--space-4)",
        background: "var(--color-chat-card-bg)",
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "var(--radius-lg)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <span style={{ display: "inline-flex", color: "var(--color-text-secondary)" }}>
          <Icon name="list-todo" size={14} />
        </span>
        <strong style={{ fontSize: "var(--font-size-control)", fontWeight: 600 }}>
          {count > 0
            ? `${count} item${count === 1 ? "" : "s"} to carry over`
            : "Nothing to carry over"}
        </strong>
      </div>
      {count > 0 && (
        <div
          style={{
            display: "grid",
            gap: "var(--space-2)",
            padding: "var(--space-2)",
            background: "var(--color-chat-muted-bg)",
            borderRadius: "var(--radius-md)",
          }}
        >
          {props.drafts.map((draft, index) => (
            <div key={index} style={{ display: "grid", gap: 2, minWidth: 0 }}>
              <span
                style={{
                  fontSize: "var(--font-size-chat)",
                  fontWeight: "var(--weight-medium)",
                  color: "var(--color-text-primary)",
                  overflowWrap: "anywhere",
                }}
              >
                {draft.title}
              </span>
              {draft.detail !== "" && (
                <span
                  title={draft.detail}
                  style={{
                    fontSize: "var(--font-size-micro)",
                    lineHeight: "var(--line-height-caption)",
                    color: "var(--color-text-tertiary)",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                    overflowWrap: "anywhere",
                  }}
                >
                  {draft.detail}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
