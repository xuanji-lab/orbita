import React from "react";

/** Right-aligned narrow user message bubble. */
export function UserBubble({ children, time, delivery, attachments = [], style }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", width: "100%", minWidth: 0, ...style }}>
      {attachments.length ? (
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: "var(--space-2)", maxWidth: "var(--bubble-max-width)", marginBottom: "var(--space-2)" }}>
          {attachments.map((src, i) => (
            <img key={i} src={src} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border-subtle)" }} />
          ))}
        </div>
      ) : null}
      <div
        style={{
          width: "fit-content",
          maxWidth: "var(--bubble-max-width)",
          minWidth: 0,
          background: "var(--color-chat-card-bg)",
          border: "1px solid var(--color-border-subtle)",
          borderRadius: "var(--radius-bubble)",
          padding: "9px 13px",
          overflowWrap: "anywhere",
        }}
      >
        <div style={{ whiteSpace: "pre-wrap", lineHeight: "var(--line-height-bubble)", color: "var(--color-text-primary)", fontSize: "var(--font-size-chat)" }}>{children}</div>
      </div>
      {time || delivery ? (
        <div style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)", marginTop: "var(--space-1)", color: "var(--color-text-tertiary)", fontSize: "var(--font-size-micro)", fontVariantNumeric: "tabular-nums" }}>
          {delivery ? (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                height: 18,
                padding: "0 7px",
                borderRadius: "var(--radius-md)",
                fontFamily: "var(--font-family-business)",
                fontWeight: "var(--weight-semibold)",
                lineHeight: 1,
                border: delivery === "follow-up" ? "1px solid color-mix(in srgb, var(--color-info) 20%, var(--color-border-subtle))" : "1px solid color-mix(in srgb, var(--color-accent) 24%, var(--color-border-subtle))",
                background: delivery === "follow-up" ? "color-mix(in srgb, var(--color-info) 10%, var(--color-bg-panel))" : "var(--color-bg-muted)",
                color: delivery === "follow-up" ? "var(--color-info)" : "var(--color-accent)",
              }}
            >
              {delivery}
            </span>
          ) : null}
          {time ? <time style={{ fontFamily: "var(--font-family-business)" }}>{time}</time> : null}
        </div>
      ) : null}
    </div>
  );
}
